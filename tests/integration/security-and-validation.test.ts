import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackendApp, type OfflineSyncBackendContext } from '../../backend/api/createApp';
import { DEFAULT_LOCAL_MONITOR_TOKEN, MAX_BATCH_SIZE } from '../../backend/api/validation';
import { OFFLINESHOP_APP_ID } from '../../backend/shop-adapter/ShopBusinessAdapter';
import {
  createOfflineSync,
  HttpSyncTransport,
  MemoryStorageAdapter,
  NetworkMonitor,
} from '../../packages/offlinesync-client';

describe('Phase D, E & G — API Security, Device Identity, Input Validation & Retry-After-Process Recovery', () => {
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

  async function registerDeviceHttp(deviceId: string) {
    const res = await fetch(`${baseUrl}/api/sync/register-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        deviceName: `Device ${deviceId}`,
        appId: OFFLINESHOP_APP_ID,
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { deviceToken: string; currentCursor: number };
  }

  it('prevents device ID spoofing, rejects unregistered devices, and enforces operation ownership', async () => {
    const devA = await registerDeviceHttp('sec-dev-A');
    const devB = await registerDeviceHttp('sec-dev-B');

    // 1. Re-registering existing deviceId without its token -> 401 DEVICE_TOKEN_REQUIRED
    const takeoverRes = await fetch(`${baseUrl}/api/sync/register-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'sec-dev-A',
        deviceName: 'Attacker Clone',
        appId: OFFLINESHOP_APP_ID,
      }),
    });
    expect(takeoverRes.status).toBe(401);
    const takeoverBody = (await takeoverRes.json()) as { code: string };
    expect(takeoverBody.code).toBe('DEVICE_TOKEN_REQUIRED');

    // Re-registering existing deviceId with wrong token -> 401 DEVICE_TOKEN_INVALID
    const badTokTakeover = await fetch(`${baseUrl}/api/sync/register-device`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': devB.deviceToken,
      },
      body: JSON.stringify({
        deviceId: 'sec-dev-A',
        deviceName: 'Attacker Clone',
        appId: OFFLINESHOP_APP_ID,
      }),
    });
    expect(badTokTakeover.status).toBe(401);
    expect(((await badTokTakeover.json()) as { code: string }).code).toBe('DEVICE_TOKEN_INVALID');

    // 2. Pushing without X-Device-Token -> 401
    const noTokenPush = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'sec-dev-A',
        appId: OFFLINESHOP_APP_ID,
        sessionId: 's-no-tok',
        lastCursor: 0,
        operations: [],
      }),
    });
    expect(noTokenPush.status).toBe(401);

    // 3. Pushing with Device B's token while claiming deviceId = sec-dev-A -> 401
    const wrongTokenPush = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': devB.deviceToken,
      },
      body: JSON.stringify({
        deviceId: 'sec-dev-A',
        appId: OFFLINESHOP_APP_ID,
        sessionId: 's-wrong-tok',
        lastCursor: 0,
        operations: [],
      }),
    });
    expect(wrongTokenPush.status).toBe(401);

    // 4. Unregistered device -> 401 UNREGISTERED_DEVICE
    const unregPull = await fetch(`${baseUrl}/api/sync/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': 'arbitrary-token',
      },
      body: JSON.stringify({
        deviceId: 'never-registered-device',
        appId: OFFLINESHOP_APP_ID,
        lastCursor: 0,
      }),
    });
    expect(unregPull.status).toBe(401);
    expect(((await unregPull.json()) as { code: string }).code).toBe('UNREGISTERED_DEVICE');

    // 5. Authenticated Device A tries to submit an operation claiming deviceId = sec-dev-B -> 403
    const spoofedOpPush = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': devA.deviceToken,
      },
      body: JSON.stringify({
        deviceId: 'sec-dev-A',
        appId: OFFLINESHOP_APP_ID,
        sessionId: 's-op-spoof',
        lastCursor: 0,
        operations: [
          {
            operationId: 'op-spoof-1',
            deviceId: 'sec-dev-B', // Forged owner!
            appId: OFFLINESHOP_APP_ID,
            entityType: 'cart',
            entityId: 'cart-spoof',
            operationType: 'CART_ITEM_ADD',
            sequence: 1,
            baseVersion: 0,
            createdAt: new Date().toISOString(),
            payload: { productId: 'P101', delta: 1 },
          },
        ],
      }),
    });
    expect(spoofedOpPush.status).toBe(403);
    expect(((await spoofedOpPush.json()) as { code: string }).code).toBe('OPERATION_OWNERSHIP_VIOLATION');

    // 6. Device B cannot read Device A's detail endpoint -> 401; Device A can read its own -> 200
    const crossRead = await fetch(`${baseUrl}/api/sync/devices/sec-dev-A`, {
      headers: { 'X-Device-Token': devB.deviceToken },
    });
    expect(crossRead.status).toBe(401);

    const selfRead = await fetch(`${baseUrl}/api/sync/devices/sec-dev-A`, {
      headers: { 'X-Device-Token': devA.deviceToken },
    });
    expect(selfRead.status).toBe(200);
  });

  it('protects Monitor, conflict resolution, and administrative simulation endpoints with X-Monitor-Token', async () => {
    const protectedGetEndpoints = [
      '/api/monitor/metrics',
      '/api/monitor/logs',
      '/api/monitor/experiments',
      '/api/monitor/experiments/export.csv',
      '/api/sync/devices',
      '/api/sync/operations',
      '/api/sync/sessions',
      '/api/sync/conflicts',
    ];

    for (const ep of protectedGetEndpoints) {
      const unauth = await fetch(`${baseUrl}${ep}`);
      expect(unauth.status).toBe(401);

      const auth = await fetch(`${baseUrl}${ep}`, {
        headers: { 'X-Monitor-Token': DEFAULT_LOCAL_MONITOR_TOKEN },
      });
      expect(auth.status).toBe(200);
    }

    // Protected POST endpoints reject missing/wrong monitor token
    const unauthSim = await fetch(`${baseUrl}/api/monitor/simulate/conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(unauthSim.status).toBe(401);

    const unauthCat = await fetch(`${baseUrl}/api/monitor/simulate/catalog-change`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monitor-Token': 'wrong-token',
      },
      body: JSON.stringify({ productId: 'P101', price: 1 }),
    });
    expect(unauthCat.status).toBe(401);

    const unauthResolve = await fetch(`${baseUrl}/api/sync/conflicts/nonexistent/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolutionChoice: 'KEEP_SERVER' }),
    });
    expect(unauthResolve.status).toBe(401);
  });

  it('rejects malformed payloads, invalid appId, invalid cursors, invalid timestamps, invalid entity/op types, oversized batches, and oversized JSON', async () => {
    const dev = await registerDeviceHttp('val-dev-1');
    const authHeaders = {
      'Content-Type': 'application/json',
      'X-Device-Token': dev.deviceToken,
    };

    // 1. Malformed JSON -> 400 INVALID_JSON
    const badJson = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: authHeaders,
      body: '{"broken": ',
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { code: string }).code).toBe('INVALID_JSON');

    // 2. Oversized payload (> 256kb) -> 413 PAYLOAD_TOO_LARGE
    const hugeBody = JSON.stringify({
      deviceId: 'val-dev-1',
      appId: OFFLINESHOP_APP_ID,
      lastCursor: 0,
      operations: [],
      padding: 'x'.repeat(300 * 1024),
    });
    const tooLarge = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: authHeaders,
      body: hugeBody,
    });
    expect(tooLarge.status).toBe(413);
    expect(((await tooLarge.json()) as { code: string }).code).toBe('PAYLOAD_TOO_LARGE');

    // 3. Unknown appId -> 400 UNKNOWN_APP_ID
    const badApp = await fetch(`${baseUrl}/api/sync/register-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-x', deviceName: 'X', appId: 'evil-app' }),
    });
    expect(badApp.status).toBe(400);
    expect(((await badApp.json()) as { code: string }).code).toBe('UNKNOWN_APP_ID');

    // 4. Negative cursor -> 400 INVALID_CURSOR
    const badCursor = await fetch(`${baseUrl}/api/sync/pull`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ deviceId: 'val-dev-1', appId: OFFLINESHOP_APP_ID, lastCursor: -5 }),
    });
    expect(badCursor.status).toBe(400);
    expect(((await badCursor.json()) as { code: string }).code).toBe('INVALID_CURSOR');

    // 5. Invalid entityType -> 400 INVALID_ENTITY_TYPE
    const badEntity = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        deviceId: 'val-dev-1',
        appId: OFFLINESHOP_APP_ID,
        lastCursor: 0,
        operations: [
          {
            operationId: 'op-bad-ent',
            deviceId: 'val-dev-1',
            appId: OFFLINESHOP_APP_ID,
            entityType: 'admin_users',
            entityId: 'u1',
            operationType: 'DROP_ALL',
            sequence: 1,
            baseVersion: 0,
            createdAt: new Date().toISOString(),
            payload: {},
          },
        ],
      }),
    });
    expect(badEntity.status).toBe(400);
    expect(((await badEntity.json()) as { code: string }).code).toBe('INVALID_ENTITY_TYPE');

    // 6. Invalid operationType -> 400 INVALID_OPERATION_TYPE
    const badOpType = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        deviceId: 'val-dev-1',
        appId: OFFLINESHOP_APP_ID,
        lastCursor: 0,
        operations: [
          {
            operationId: 'op-bad-optype',
            deviceId: 'val-dev-1',
            appId: OFFLINESHOP_APP_ID,
            entityType: 'cart',
            entityId: 'c1',
            operationType: 'CART_TELEPORT',
            sequence: 1,
            baseVersion: 0,
            createdAt: new Date().toISOString(),
            payload: {},
          },
        ],
      }),
    });
    expect(badOpType.status).toBe(400);
    expect(((await badOpType.json()) as { code: string }).code).toBe('INVALID_OPERATION_TYPE');

    // 7. Invalid timestamp -> 400 INVALID_TIMESTAMP
    const badTs = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        deviceId: 'val-dev-1',
        appId: OFFLINESHOP_APP_ID,
        lastCursor: 0,
        operations: [
          {
            operationId: 'op-bad-ts',
            deviceId: 'val-dev-1',
            appId: OFFLINESHOP_APP_ID,
            entityType: 'cart',
            entityId: 'c1',
            operationType: 'CART_ITEM_ADD',
            sequence: 1,
            baseVersion: 0,
            createdAt: 'not-a-timestamp',
            payload: { productId: 'P101', delta: 1 },
          },
        ],
      }),
    });
    expect(badTs.status).toBe(400);
    expect(((await badTs.json()) as { code: string }).code).toBe('INVALID_TIMESTAMP');

    // 8. Excessive batch size (> MAX_BATCH_SIZE) -> 400 BATCH_TOO_LARGE
    const hugeBatch = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
      operationId: `op-batch-${i}`,
      deviceId: 'val-dev-1',
      appId: OFFLINESHOP_APP_ID,
      entityType: 'cart',
      entityId: 'c1',
      operationType: 'CART_ITEM_ADD',
      sequence: i + 1,
      baseVersion: 0,
      createdAt: new Date().toISOString(),
      payload: { productId: 'P101', delta: 1 },
    }));
    const batchTooLarge = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        deviceId: 'val-dev-1',
        appId: OFFLINESHOP_APP_ID,
        lastCursor: 0,
        operations: hugeBatch,
      }),
    });
    expect(batchTooLarge.status).toBe(400);
    expect(((await batchTooLarge.json()) as { code: string }).code).toBe('BATCH_TOO_LARGE');

    // 9. Invalid conflict resolution choice -> 400 INVALID_RESOLUTION_CHOICE
    const badResolveChoice = await fetch(`${baseUrl}/api/sync/conflicts/conf-1/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monitor-Token': DEFAULT_LOCAL_MONITOR_TOKEN,
      },
      body: JSON.stringify({ resolutionChoice: 'DELETE_DATABASE' }),
    });
    expect(badResolveChoice.status).toBe(400);
    expect(((await badResolveChoice.json()) as { code: string }).code).toBe('INVALID_RESOLUTION_CHOICE');
  });

  it('recovers idempotently when the server processes an order but the response drops before client acknowledgment', async () => {
    const initialStock = backend.shopAdapter.productsCol.findById('P101')!.stock;
    const price = backend.shopAdapter.productsCol.findById('P101')!.price;

    // Wrap fetch so the FIRST /api/sync/process actually reaches the server & commits,
    // then simulates a dropped socket BEFORE returning the HTTP response to the client!
    let dropAckOnce = true;
    const ackDroppingFetch: typeof fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/sync/process') && dropAckOnce) {
        dropAckOnce = false;
        // Consume server response to confirm server actually committed it, then throw network error
        expect(response.status).toBe(200);
        throw new Error('ECONNRESET after server committed before client received ACK');
      }
      return response;
    };

    const transport = new HttpSyncTransport({
      baseUrl,
      timeoutMs: 5000,
      fetchFn: ackDroppingFetch,
    });
    const engine = createOfflineSync({
      appId: OFFLINESHOP_APP_ID,
      deviceId: 'dev-ack-drop',
      deviceName: 'ACK Drop Client',
      storage: new MemoryStorageAdapter(),
      transport,
      networkMonitor: new NetworkMonitor({
        healthCheckUrl: `${baseUrl}/api/sync/status`,
        probeIntervalMs: 0,
        enableBrowserListeners: false,
      }),
      autoSyncOnReconnect: false,
      baseBackoffMs: 5,
    });

    await engine.initialize();
    await engine.createOperation({
      entityType: 'order',
      entityId: 'CLI-ACK-DROP-1',
      operationType: 'ORDER_CREATE',
      payload: {
        clientOrderId: 'CLI-ACK-DROP-1',
        deliveryAddressId: 'ADDR-HOME',
        items: [{ productId: 'P101', name: 'Keyboard', quantity: 2, priceAtCheckout: price }],
      },
      triggerBackgroundSync: false,
    });

    // Attempt 1: Server commits order & decrements stock, then response drops before client gets ACK
    const attempt1 = await engine.syncNow({ ignoreBackoff: true });
    expect(attempt1.success).toBe(false);
    expect(await engine.getPendingOperations()).toHaveLength(1);
    expect(backend.shopAdapter.productsCol.findById('P101')!.stock).toBe(initialStock - 2);

    // Attempt 2: Client retries exact same operation -> server returns DUPLICATE, stock NOT decremented again!
    engine.network.reportRequestSuccess();
    const attempt2 = await engine.syncNow({ ignoreBackoff: true });
    expect(attempt2.success).toBe(true);
    expect(attempt2.duplicateCount).toBe(1);
    expect(await engine.getPendingOperations()).toHaveLength(0);
    expect(backend.shopAdapter.productsCol.findById('P101')!.stock).toBe(initialStock - 2);
    expect(
      backend.shopAdapter.ordersCol.find((o) => o.clientOrderId === 'CLI-ACK-DROP-1')
    ).toHaveLength(1);

    engine.destroy();
  });
});
