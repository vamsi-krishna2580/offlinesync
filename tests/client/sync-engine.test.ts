import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  createOfflineSync,
  DexieStorageAdapter,
  MemoryStorageAdapter,
  PersistentOperationQueue,
  type SyncTransport,
} from '../../packages/offlinesync-client';
import type {
  RegisterDeviceRequest,
  SyncProcessRequest,
  SyncPullRequest,
  SyncPushRequest,
} from '../../packages/offlinesync-types';

function createStubTransport(options?: { failProcess?: boolean }): SyncTransport {
  let cursor = 0;
  return {
    async registerDevice(req: RegisterDeviceRequest) {
      return {
        data: {
          device: {
            deviceId: req.deviceId,
            deviceName: req.deviceName,
            appId: req.appId,
            platform: req.platform ?? 'test',
            registeredAt: new Date().toISOString(),
            lastSyncAt: null,
            lastSeenAt: new Date().toISOString(),
            connectionStatus: 'ONLINE',
            lastCursor: 0,
            pendingCount: 0,
          },
          deviceToken: `tok-${req.deviceId}`,
          serverTimestamp: new Date().toISOString(),
          currentCursor: cursor,
        },
        bytesSent: 50,
        bytesReceived: 120,
        latencyMs: 1,
      };
    },
    async push(req: SyncPushRequest) {
      cursor += req.operations.length;
      return {
        data: {
          sessionId: req.sessionId,
          acknowledgedIds: req.operations.map((o) => o.operationId),
          duplicateIds: [],
          rejectedIds: [],
          outcomes: req.operations.map((o) => ({
            operationId: o.operationId,
            status: 'ACKNOWLEDGED',
            serverVersion: o.baseVersion + 1,
          })),
          conflicts: [],
          updatedCursor: cursor,
          serverTimestamp: new Date().toISOString(),
        },
        bytesSent: 100,
        bytesReceived: 100,
        latencyMs: 1,
      };
    },
    async pull(req: SyncPullRequest) {
      return {
        data: {
          sessionId: req.sessionId ?? null,
          changes: [
            {
              cursor: cursor + 1,
              entityType: 'product',
              entityId: 'P101',
              version: 2,
              changeType: 'UPSERT',
              data: { productId: 'P101', name: 'Updated Item', price: 199 },
              updatedAt: new Date().toISOString(),
            },
          ],
          updatedCursor: cursor + 1,
          latestAppCursor: cursor + 1,
          hasMore: false,
          serverTimestamp: new Date().toISOString(),
        },
        bytesSent: 40,
        bytesReceived: 140,
        latencyMs: 1,
      };
    },
    async process(req: SyncProcessRequest) {
      if (options?.failProcess) {
        throw new Error('Simulated transport socket drop');
      }
      cursor += Math.max(1, req.operations.length);
      return {
        data: {
          sessionId: req.sessionId,
          acknowledgedIds: req.operations.map((o) => o.operationId),
          duplicateIds: [],
          rejectedIds: [],
          outcomes: req.operations.map((o) => ({
            operationId: o.operationId,
            status: 'ACKNOWLEDGED',
            serverVersion: o.baseVersion + 1,
          })),
          conflicts: [],
          remoteChanges: [
            {
              cursor,
              entityType: 'product',
              entityId: 'P999',
              version: 1,
              changeType: 'UPSERT',
              data: { productId: 'P999', name: 'Pulled Record' },
              updatedAt: new Date().toISOString(),
            },
          ],
          updatedCursor: cursor,
          latestAppCursor: cursor,
          hasMore: false,
          serverTimestamp: new Date().toISOString(),
          durationMs: 2,
        },
        bytesSent: 120,
        bytesReceived: 220,
        latencyMs: 2,
      };
    },
  };
}

describe('OfflineSync Client Engine (Unit Tests)', () => {
  it('persists cached entities, device token, and queued operations in IndexedDB across simulated reloads', async () => {
    const dbName = `test_dexie_${Date.now()}`;
    const storage1 = new DexieStorageAdapter(dbName);
    const engine1 = createOfflineSync({
      appId: 'test-app',
      deviceId: 'dev-persist-1',
      storage: storage1,
      transport: createStubTransport(),
      autoSyncOnReconnect: false,
    });

    await engine1.initialize();
    engine1.setSimulatedOffline(true);

    await engine1.upsertLocalEntity('product', 'P101', { productId: 'P101', price: 249 });
    await engine1.createOperation({
      entityType: 'cart',
      entityId: 'c1',
      operationType: 'CART_ITEM_ADD',
      payload: { productId: 'P101', delta: 2 },
      triggerBackgroundSync: false,
    });

    engine1.destroy();
    await storage1.close();

    // Simulate page reload by instantiating a brand new DexieStorageAdapter against same DB
    let attachedToken: string | null = null;
    const transport2: SyncTransport = {
      ...createStubTransport(),
      setDeviceToken(tok) {
        attachedToken = tok;
      },
    };
    const storage2 = new DexieStorageAdapter(dbName);
    const engine2 = createOfflineSync({
      appId: 'test-app',
      storage: storage2,
      transport: transport2,
      autoSyncOnReconnect: false,
    });
    engine2.setSimulatedOffline(true);
    await engine2.initialize();

    const cachedProduct = await engine2.getLocalEntity<{ price: number }>('product', 'P101');
    const pendingOps = await engine2.getPendingOperations();

    expect(engine2.getDeviceId()).toBe('dev-persist-1');
    expect(attachedToken).toBe('tok-dev-persist-1');
    expect(cachedProduct?.data.price).toBe(249);
    expect(pendingOps).toHaveLength(1);
    expect(pendingOps[0].operationType).toBe('CART_ITEM_ADD');

    engine2.destroy();
    await storage2.close();
  });

  it('enforces FIFO sequence ordering and explicit operation dependencies', async () => {
    const storage = new MemoryStorageAdapter();
    const queue = new PersistentOperationQueue(storage);

    const op1 = await queue.enqueue({
      deviceId: 'd1',
      appId: 'app',
      entityType: 'order',
      entityId: 'ord-1',
      operationType: 'ORDER_CREATE',
      baseVersion: 0,
      payload: {},
    });

    const op2 = await queue.enqueue({
      deviceId: 'd1',
      appId: 'app',
      entityType: 'cart',
      entityId: 'cart-1',
      operationType: 'CART_CLEAR',
      baseVersion: 1,
      payload: {},
      dependsOn: [op1.operationId],
    });

    const batch1 = await queue.getNextBatch(10);
    expect(batch1.map((o) => o.operationId)).toEqual([op1.operationId]);

    await queue.markAcknowledged(op1.operationId, 1);
    const batch2 = await queue.getNextBatch(10);
    expect(batch2.map((o) => o.operationId)).toEqual([op2.operationId]);
  });

  it('recovers stranded PROCESSING operations on engine startup and caps retries with backoff', async () => {
    const storage = new MemoryStorageAdapter();
    const queue = new PersistentOperationQueue(storage, { maxRetries: 2, baseBackoffMs: 10 });

    const op = await queue.enqueue({
      deviceId: 'd1',
      appId: 'app',
      entityType: 'cart',
      entityId: 'c1',
      operationType: 'CART_ITEM_ADD',
      baseVersion: 0,
      payload: { productId: 'P101' },
    });

    await queue.markProcessing([op.operationId]);
    const recovered = await queue.recoverInterruptedOperations();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('PENDING');

    const r1 = await queue.scheduleRetry(op.operationId, 'timeout 1');
    expect(r1.exhausted).toBe(false);
    expect(r1.backoffMs).toBe(10);

    const r2 = await queue.scheduleRetry(op.operationId, 'timeout 2');
    expect(r2.exhausted).toBe(false);
    expect(r2.backoffMs).toBe(20);

    const r3 = await queue.scheduleRetry(op.operationId, 'timeout 3');
    expect(r3.exhausted).toBe(true);
    expect(r3.operation?.status).toBe('FAILED');
  });

  it('reconciles remote pulled entities and clears pending operations upon acknowledgement', async () => {
    const storage = new MemoryStorageAdapter();
    const engine = createOfflineSync({
      appId: 'test-app',
      deviceId: 'dev-recon',
      storage,
      transport: createStubTransport(),
      autoSyncOnReconnect: false,
    });

    await engine.initialize();
    await engine.createOperation({
      entityType: 'cart',
      entityId: 'c1',
      operationType: 'CART_ITEM_ADD',
      payload: { productId: 'P101', delta: 1 },
      triggerBackgroundSync: false,
    });

    const summary = await engine.syncNow({ ignoreBackoff: true });
    expect(summary.success).toBe(true);
    expect(summary.acknowledgedCount).toBe(1);
    expect(summary.remoteChangesApplied).toBe(1);

    const pulled = await engine.getLocalEntity<{ name: string }>('product', 'P999');
    expect(pulled?.data.name).toBe('Pulled Record');
    expect(await engine.getPendingOperations()).toHaveLength(0);

    engine.destroy();
  });

  it('handles interrupted pull pagination safely without skipping changes or advancing past unapplied pages', async () => {
    const storage = new MemoryStorageAdapter();
    let failPage2Once = true;
    const requestedCursors: number[] = [];

    const baseStub = createStubTransport();
    const pagedTransport: SyncTransport = {
      ...baseStub,
      async pull(req: SyncPullRequest) {
        requestedCursors.push(req.lastCursor);
        if (req.lastCursor === 0) {
          return {
            data: {
              sessionId: null,
              changes: [
                {
                  cursor: 1,
                  entityType: 'product',
                  entityId: 'P1',
                  version: 1,
                  changeType: 'UPSERT',
                  data: { productId: 'P1', name: 'Page 1 Item' },
                  updatedAt: new Date().toISOString(),
                },
              ],
              updatedCursor: 1,
              latestAppCursor: 2,
              hasMore: true,
              serverTimestamp: new Date().toISOString(),
            },
            bytesSent: 20,
            bytesReceived: 80,
            latencyMs: 1,
          };
        }
        if (req.lastCursor === 1 && failPage2Once) {
          failPage2Once = false;
          throw new Error('Connection reset before page 2');
        }
        return {
          data: {
            sessionId: null,
            changes: [
              {
                cursor: 2,
                entityType: 'product',
                entityId: 'P2',
                version: 1,
                changeType: 'UPSERT',
                data: { productId: 'P2', name: 'Page 2 Item' },
                updatedAt: new Date().toISOString(),
              },
            ],
            updatedCursor: 2,
            latestAppCursor: 2,
            hasMore: false,
            serverTimestamp: new Date().toISOString(),
          },
          bytesSent: 20,
          bytesReceived: 80,
          latencyMs: 1,
        };
      },
    };

    const engine = createOfflineSync({
      appId: 'test-app',
      deviceId: 'dev-paged',
      storage,
      transport: pagedTransport,
      autoSyncOnReconnect: false,
    });
    await engine.initialize();

    await expect(engine.pullRemoteChanges()).rejects.toThrow('Connection reset before page 2');

    // Page 1 was applied and persisted; cursor must be 1 (NOT 0 and NOT 2)
    expect((await engine.getStatus()).lastCursor).toBe(1);
    expect(await engine.getLocalEntity('product', 'P1')).toBeDefined();
    expect(await engine.getLocalEntity('product', 'P2')).toBeUndefined();

    // Retry pull resumes at cursor 1 and applies page 2 cleanly
    const resumed = await engine.pullRemoteChanges();
    expect(resumed.updatedCursor).toBe(2);
    expect(await engine.getLocalEntity('product', 'P2')).toBeDefined();
    expect(requestedCursors).toEqual([0, 1, 1]);

    engine.destroy();
  });

  it('never advances cursor when applying a remote change fails locally, and isolates filtered pull cursors', async () => {
    const storage = new MemoryStorageAdapter();
    let shouldThrowOnApply = true;

    const engine = createOfflineSync({
      appId: 'test-app',
      deviceId: 'dev-cursor-safe',
      storage,
      transport: createStubTransport(),
      autoSyncOnReconnect: false,
    });
    engine.registerAdapter({
      name: 'faulty-adapter',
      onRemoteChangeApplied() {
        if (shouldThrowOnApply) {
          throw new Error('Local storage quota exceeded during apply');
        }
      },
    });
    await engine.initialize();

    // Pull fails during applyRemoteChange -> cursor MUST stay 0!
    await expect(engine.pullRemoteChanges()).rejects.toThrow('Local storage quota exceeded');
    expect((await engine.getStatus()).lastCursor).toBe(0);

    // Once local error clears, filtered pull advances only its isolated filter cursor, NOT unfiltered lastCursor
    shouldThrowOnApply = false;
    const filtered = await engine.pullRemoteChanges(['product']);
    expect(filtered.updatedCursor).toBe(1);
    expect((await engine.getStatus()).lastCursor).toBe(0);

    // Unfiltered pull then advances main lastCursor
    const unfiltered = await engine.pullRemoteChanges();
    expect(unfiltered.updatedCursor).toBe(1);
    expect((await engine.getStatus()).lastCursor).toBe(1);

    engine.destroy();
  });
});
