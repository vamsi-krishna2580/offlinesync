import 'fake-indexeddb/auto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackendApp, type OfflineSyncBackendContext } from '../../backend/api/createApp';
import { OFFLINESHOP_APP_ID } from '../../backend/shop-adapter/ShopBusinessAdapter';
import type { OrderDocument, Product } from '../../backend/shop-adapter/types';
import {
  createOfflineSync,
  DexieStorageAdapter,
  HttpSyncTransport,
  MemoryStorageAdapter,
  NetworkMonitor,
  type SyncStorageAdapter,
} from '../../packages/offlinesync-client';

describe('OfflineSync End-to-End Integration Scenarios (A through G)', () => {
  let backend: OfflineSyncBackendContext;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    backend = createBackendApp({ persistPath: null });
    await new Promise<void>((resolve) => {
      server = backend.app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function createTestClient(
    deviceId: string,
    storage: SyncStorageAdapter = new MemoryStorageAdapter(),
    transportOptions?: { beforeRequest?: (endpoint: string) => void }
  ) {
    const transport = new HttpSyncTransport({
      baseUrl,
      timeoutMs: 5000,
      beforeRequest: transportOptions?.beforeRequest,
    });
    const networkMonitor = new NetworkMonitor({
      healthCheckUrl: `${baseUrl}/api/sync/status`,
      probeIntervalMs: 0,
      enableBrowserListeners: false,
    });
    return {
      transport,
      engine: createOfflineSync({
        appId: OFFLINESHOP_APP_ID,
        deviceId,
        deviceName: `Integration Client ${deviceId}`,
        storage,
        transport,
        networkMonitor,
        autoSyncOnReconnect: false,
        baseBackoffMs: 10,
      }),
    };
  }

  it('Scenario A — Normal online synchronization', async () => {
    const { engine } = createTestClient('scen-a-dev');
    await engine.initialize();

    await engine.createOperation({
      entityType: 'cart',
      entityId: 'cart-scen-a',
      operationType: 'CART_ITEM_ADD',
      payload: { productId: 'P101', delta: 2 },
      triggerBackgroundSync: false,
    });

    const summary = await engine.syncNow({ ignoreBackoff: true });
    expect(summary.success).toBe(true);
    expect(summary.acknowledgedCount).toBe(1);
    expect(await engine.getPendingOperations()).toHaveLength(0);

    const serverCart = backend.shopAdapter.cartsCol.findById('cart-scen-a');
    expect(serverCart?.items[0].quantity).toBe(2);
    engine.destroy();
  });

  it('Scenario B & C — Offline shopping, browser reload persistence (IndexedDB), and reconnect sync', async () => {
    const dbName = `scen_bc_dexie_${Date.now()}`;
    const storage1 = new DexieStorageAdapter(dbName);
    const client1 = createTestClient('scen-bc-dev', storage1);
    await client1.engine.initialize();

    // Step 1: Online pull caches products & addresses into IndexedDB
    await client1.engine.pullRemoteChanges();
    const cachedProducts = await client1.engine.getLocalEntities<Product>('product');
    expect(cachedProducts.length).toBeGreaterThanOrEqual(6);

    // Step 2: Disconnect network
    client1.engine.setSimulatedOffline(true);

    // Step 3: Perform offline cart & order intent creation
    await client1.engine.createOperation({
      entityType: 'cart',
      entityId: 'cart-scen-bc',
      operationType: 'CART_ITEM_ADD',
      payload: { productId: 'P102', delta: 1 },
      triggerBackgroundSync: false,
    });

    const clientOrderId = 'CLI-SCEN-BC-1';
    await client1.engine.createOperation({
      entityType: 'order',
      entityId: clientOrderId,
      operationType: 'ORDER_CREATE',
      payload: {
        clientOrderId,
        deliveryAddressId: 'ADDR-HOME',
        items: [{ productId: 'P102', name: 'Reference Headphones', quantity: 1, priceAtCheckout: 389 }],
      },
      triggerBackgroundSync: false,
    });

    // Step 4: Simulate browser refresh by tearing down client1 & closing IndexedDB
    client1.engine.destroy();
    await storage1.close();

    // Step 5: Reopen IndexedDB on fresh client instance while still offline -> verify persistence
    const storage2 = new DexieStorageAdapter(dbName);
    const client2 = createTestClient('scen-bc-dev', storage2);
    client2.engine.setSimulatedOffline(true);
    await client2.engine.initialize();

    expect((await client2.engine.getPendingOperations()).length).toBe(2);
    expect((await client2.engine.getLocalEntities('product')).length).toBeGreaterThanOrEqual(6);

    // Step 6 (Scenario C): Reconnect and synchronize
    client2.engine.setSimulatedOffline(false);
    const syncRes = await client2.engine.syncNow({ ignoreBackoff: true });
    expect(syncRes.success).toBe(true);
    expect(syncRes.acknowledgedCount).toBe(2);
    expect(await client2.engine.getPendingOperations()).toHaveLength(0);

    const serverOrder = backend.shopAdapter.ordersCol.findByUniqueIndex(
      'uniq_client_order_id',
      clientOrderId
    );
    expect(serverOrder?.status).toBe('CONFIRMED');
    expect(serverOrder?.authoritativeTotal).toBe(389);

    client2.engine.destroy();
    await storage2.close();
  });

  it('Scenario D — Duplicate operation delivery is safely deduplicated', async () => {
    const { engine, transport } = createTestClient('scen-d-dev');
    await engine.initialize();

    const { operation } = await engine.createOperation({
      entityType: 'cart',
      entityId: 'cart-scen-d',
      operationType: 'CART_ITEM_ADD',
      payload: { productId: 'P103', delta: 1 },
      triggerBackgroundSync: false,
    });

    await engine.syncNow({ ignoreBackoff: true });

    // Explicitly re-deliver the exact same operation over HTTP
    const dupPush = await transport.push({
      deviceId: 'scen-d-dev',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'dup-test-sess',
      lastCursor: 0,
      operations: [operation],
    });

    expect(dupPush.data.duplicateIds).toEqual([operation.operationId]);
    expect(backend.shopAdapter.cartsCol.findById('cart-scen-d')?.items[0].quantity).toBe(1);
    engine.destroy();
  });

  it('Scenario E — Interrupted synchronization preserves queue and completes on retry', async () => {
    let shouldFail = true;
    const { engine } = createTestClient('scen-e-dev', new MemoryStorageAdapter(), {
      beforeRequest: (endpoint) => {
        if (endpoint === '/api/sync/process' && shouldFail) {
          throw new Error('Simulated mid-flight connection reset');
        }
      },
    });
    await engine.initialize();

    await engine.createOperation({
      entityType: 'wishlist',
      entityId: 'wish-scen-e',
      operationType: 'WISHLIST_ADD',
      payload: { productId: 'P104' },
      triggerBackgroundSync: false,
    });

    // Attempt 1 fails mid-flight -> pending operation must remain in queue with retryCount = 1
    const failedRun = await engine.syncNow({ ignoreBackoff: true });
    expect(failedRun.success).toBe(false);
    const pendingAfterFail = await engine.getPendingOperations();
    expect(pendingAfterFail).toHaveLength(1);
    expect(pendingAfterFail[0].retryCount).toBe(1);

    // Recover connectivity & retry
    shouldFail = false;
    engine.network.reportRequestSuccess();
    const recoveredRun = await engine.syncNow({ ignoreBackoff: true });
    expect(recoveredRun.success).toBe(true);
    expect(recoveredRun.acknowledgedCount).toBe(1);
    expect(await engine.getPendingOperations()).toHaveLength(0);
    expect(backend.shopAdapter.wishlistsCol.findById('wish-scen-e')?.productIds).toContain('P104');
    engine.destroy();
  });

  it('Scenario F — Concurrent two-device modification detects conflict and resolves cleanly', async () => {
    const clientA = createTestClient('scen-f-devA');
    const clientB = createTestClient('scen-f-devB');
    await clientA.engine.initialize();
    await clientB.engine.initialize();

    const sharedCart = 'cart-scen-f';
    await clientA.engine.createOperation({
      entityType: 'cart',
      entityId: sharedCart,
      operationType: 'CART_ITEM_SET_QTY',
      baseVersion: 0,
      payload: { productId: 'P105', quantity: 1 },
      triggerBackgroundSync: false,
    });
    await clientA.engine.syncNow({ ignoreBackoff: true });

    // Device B pushes stale baseVersion 0 against server version 1 -> conflict!
    await clientB.engine.createOperation({
      entityType: 'cart',
      entityId: sharedCart,
      operationType: 'CART_ITEM_SET_QTY',
      baseVersion: 0,
      payload: { productId: 'P105', quantity: 3 },
      triggerBackgroundSync: false,
    });
    const resB = await clientB.engine.syncNow({ ignoreBackoff: true });
    expect(resB.conflictsCount).toBe(1);

    const openConflicts = backend.core.conflicts.listAll({ status: 'OPEN' });
    const target = openConflicts.find((c) => c.entityId === sharedCart);
    expect(target).toBeDefined();

    // Resolve manually via HTTP endpoint
    const resolveResp = await fetch(
      `${baseUrl}/api/sync/conflicts/${target!.conflictId}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolutionChoice: 'KEEP_SERVER',
          actor: 'integration-test',
          note: 'Preserve Device A quantity',
        }),
      }
    );
    expect(resolveResp.ok).toBe(true);
    expect(backend.core.conflicts.getById(target!.conflictId)?.resolutionStatus).toBe(
      'RESOLVED_MANUAL'
    );

    clientA.engine.destroy();
    clientB.engine.destroy();
  });

  it('Scenario G — Invalid offline order after server stock/price change returns REQUIRES_ACTION and resolves on user confirmation', async () => {
    const { engine } = createTestClient('scen-g-dev');
    await engine.initialize();
    await engine.pullRemoteChanges();

    // Client goes offline and creates an order intent using cached price $215 for P104
    engine.setSimulatedOffline(true);
    const clientOrderId = 'CLI-SCEN-G-1';
    await engine.createOperation({
      entityType: 'order',
      entityId: clientOrderId,
      operationType: 'ORDER_CREATE',
      payload: {
        clientOrderId,
        deliveryAddressId: 'ADDR-LAB',
        items: [{ productId: 'P104', name: 'Arcane 22L Pack', quantity: 2, priceAtCheckout: 215 }],
      },
      triggerBackgroundSync: false,
    });

    // Server authoritatively changes price from $215 to $235 while client is offline
    backend.shopAdapter.updateProductAuthoritative('P104', { price: 235 });

    // Reconnect and sync -> Server rejects silent acceptance and flags REQUIRES_ACTION
    engine.setSimulatedOffline(false);
    const firstSync = await engine.syncNow({ ignoreBackoff: true });
    expect(firstSync.conflictsCount).toBe(1);

    const flagged = backend.shopAdapter.ordersCol.findByUniqueIndex(
      'uniq_client_order_id',
      clientOrderId
    ) as OrderDocument;
    expect(flagged.status).toBe('REQUIRES_ACTION');
    expect(flagged.authoritativeTotal).toBe(470);
    expect(flagged.discrepancies[0].type).toBe('PRICE_CHANGED');

    // User accepts revised price ($235) -> Order confirmed authoritatively
    await engine.createOperation({
      entityType: 'order',
      entityId: clientOrderId,
      operationType: 'ORDER_ACCEPT_REVISED',
      baseVersion: flagged.version,
      payload: {
        clientOrderId,
        items: [{ productId: 'P104', name: 'Arcane 22L Pack', quantity: 2, priceAtCheckout: 235 }],
      },
      triggerBackgroundSync: false,
    });

    const confirmSync = await engine.syncNow({ ignoreBackoff: true });
    expect(confirmSync.acknowledgedCount).toBe(1);
    const confirmed = backend.shopAdapter.ordersCol.findByUniqueIndex(
      'uniq_client_order_id',
      clientOrderId
    );
    expect(confirmed?.status).toBe('CONFIRMED');
    expect(confirmed?.authoritativeTotal).toBe(470);

    engine.destroy();
  });
});
