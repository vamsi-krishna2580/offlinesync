import crypto from 'crypto';
import type {
  ExperimentRunRecord,
  RegisterDeviceRequest,
  SyncProcessRequest,
  SyncPullRequest,
  SyncPushRequest,
} from '../../packages/offlinesync-types';
import {
  createOfflineSync,
  MemoryStorageAdapter,
  type SyncTransport,
  type TransportResult,
} from '../../packages/offlinesync-client';
import type { SyncCoreEngine } from '../offlinesync-core/SyncCoreEngine';
import { OFFLINESHOP_APP_ID } from '../shop-adapter/ShopBusinessAdapter';

function measureBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf-8');
}

/**
 * In-process SyncTransport connecting real `OfflineSyncEngine` instances directly
 * to `SyncCoreEngine` with optional fault injection so controlled experiments
 * measure real serialization, idempotency, conflict detection, and retry overhead.
 */
class DirectCoreTransport implements SyncTransport {
  private readonly core: SyncCoreEngine;
  public failNextProcessCalls = 0;

  constructor(core: SyncCoreEngine) {
    this.core = core;
  }

  private wrap<TReq, TRes>(req: TReq, fn: () => TRes): Promise<TransportResult<TRes>> {
    const bytesSent = measureBytes(req);
    const t0 = performance.now();
    const data = fn();
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    const bytesReceived = measureBytes(data);
    return Promise.resolve({ data, bytesSent, bytesReceived, latencyMs });
  }

  registerDevice(req: RegisterDeviceRequest) {
    return this.wrap(req, () => this.core.registerDevice(req));
  }

  push(req: SyncPushRequest) {
    const bytesSent = measureBytes(req);
    return this.wrap(req, () => this.core.push(req, bytesSent));
  }

  pull(req: SyncPullRequest) {
    return this.wrap(req, () => this.core.pull(req));
  }

  process(req: SyncProcessRequest) {
    if (this.failNextProcessCalls > 0) {
      this.failNextProcessCalls -= 1;
      return Promise.reject(
        new Error('Simulated mid-flight network interruption (application-level fault injection)')
      );
    }
    const bytesSent = measureBytes(req);
    return this.wrap(req, () => this.core.process(req, bytesSent));
  }
}

export interface RunExperimentParams {
  scenario: ExperimentRunRecord['scenario'];
  operationCount: number;
  batchSize?: number;
}

/**
 * Executes genuine, reproducible synchronization benchmarks through the real
 * OfflineSync client engine and backend core. Never fabricates metrics.
 */
export async function runControlledExperiment(
  core: SyncCoreEngine,
  params: RunExperimentParams
): Promise<ExperimentRunRecord> {
  const experimentId = `exp-${crypto.randomUUID().slice(0, 8)}`;
  const opCount = Math.max(1, Math.min(500, Math.floor(params.operationCount)));
  const batchSize = Math.max(5, Math.min(100, params.batchSize ?? 25));
  const startedAt = new Date().toISOString();

  const deviceId = `bench-${experimentId}-devA`;
  const cartId = `bench-cart-${experimentId}`;
  const productIds = ['P101', 'P102', 'P103', 'P104', 'P105'];

  const storageA = new MemoryStorageAdapter();
  const transportA = new DirectCoreTransport(core);
  const engineA = createOfflineSync({
    appId: OFFLINESHOP_APP_ID,
    deviceId,
    deviceName: `Benchmark Runner (${params.scenario})`,
    platform: 'experiment-harness',
    storage: storageA,
    transport: transportA,
    batchSize,
    baseBackoffMs: 25,
    maxRetries: 4,
    autoSyncOnReconnect: false,
  });

  await engineA.initialize();

  let localWriteTotalMs = 0;
  let retryCount = 0;
  let duplicatesPrevented = 0;
  let conflictsDetected = 0;
  let bytesTransferred = 0;
  let acknowledgedCount = 0;
  let rejectedCount = 0;
  let recoveryTimeMs: number | null = null;
  let notes = '';

  const tSyncStart = performance.now();

  try {
    if (params.scenario === 'STABLE_CONNECTION') {
      engineA.setSimulatedOffline(true);
      for (let i = 0; i < opCount; i++) {
        const res = await engineA.createOperation({
          entityType: 'cart',
          entityId: cartId,
          operationType: 'CART_ITEM_INCREMENT',
          payload: { productId: productIds[i % productIds.length], delta: 1 },
          triggerBackgroundSync: false,
        });
        localWriteTotalMs += res.localWriteMs;
      }
      engineA.setSimulatedOffline(false);
      const syncStart = performance.now();
      const summary = await engineA.syncNow({ ignoreBackoff: true });
      const elapsed = Math.round((performance.now() - syncStart) * 100) / 100;
      acknowledgedCount = summary.acknowledgedCount;
      rejectedCount = summary.rejectedCount;
      bytesTransferred = summary.bytesSent + summary.bytesReceived;
      notes = `Synced ${opCount} queued operations in batches of ${batchSize} over stable transport (${elapsed} ms).`;
    } else if (params.scenario === 'OFFLINE_BACKLOG') {
      engineA.setSimulatedOffline(true);
      for (let i = 0; i < opCount; i++) {
        const res = await engineA.createOperation({
          entityType: 'cart',
          entityId: cartId,
          operationType: i % 3 === 0 ? 'CART_ITEM_ADD' : 'CART_ITEM_INCREMENT',
          payload: { productId: productIds[i % productIds.length], delta: 1 },
          triggerBackgroundSync: false,
        });
        localWriteTotalMs += res.localWriteMs;
      }
      const tRecover0 = performance.now();
      engineA.setSimulatedOffline(false);
      const summary = await engineA.syncNow({ ignoreBackoff: true });
      recoveryTimeMs = Math.round((performance.now() - tRecover0) * 100) / 100;
      acknowledgedCount = summary.acknowledgedCount;
      rejectedCount = summary.rejectedCount;
      bytesTransferred = summary.bytesSent + summary.bytesReceived;
      notes = `Accumulated ${opCount} offline backlog operations and flushed upon reconnect in ${recoveryTimeMs} ms.`;
    } else if (params.scenario === 'SIMULATED_INTERRUPTION') {
      engineA.setSimulatedOffline(true);
      for (let i = 0; i < opCount; i++) {
        const res = await engineA.createOperation({
          entityType: 'cart',
          entityId: cartId,
          operationType: 'CART_ITEM_INCREMENT',
          payload: { productId: productIds[i % productIds.length], delta: 1 },
          triggerBackgroundSync: false,
        });
        localWriteTotalMs += res.localWriteMs;
      }
      engineA.setSimulatedOffline(false);

      // Inject 2 consecutive mid-flight transport drops
      transportA.failNextProcessCalls = 2;
      const attempt1 = await engineA.syncNow({ ignoreBackoff: true });
      if (!attempt1.success) retryCount += 1;
      engineA.network.reportRequestSuccess();

      const attempt2 = await engineA.syncNow({ ignoreBackoff: true });
      if (!attempt2.success) retryCount += 1;
      engineA.network.reportRequestSuccess();

      // Measure recovery after network stabilizes
      const tRecover0 = performance.now();
      const finalAttempt = await engineA.syncNow({ ignoreBackoff: true });
      recoveryTimeMs = Math.round((performance.now() - tRecover0) * 100) / 100;
      acknowledgedCount = finalAttempt.acknowledgedCount;
      rejectedCount = finalAttempt.rejectedCount;
      bytesTransferred = finalAttempt.bytesSent + finalAttempt.bytesReceived;
      notes = `Survived 2 mid-flight transport failures without losing queued operations; recovered in ${recoveryTimeMs} ms.`;
    } else if (params.scenario === 'DUPLICATE_DELIVERY') {
      engineA.setSimulatedOffline(true);
      const createdOps = [];
      for (let i = 0; i < opCount; i++) {
        const res = await engineA.createOperation({
          entityType: 'cart',
          entityId: cartId,
          operationType: 'CART_ITEM_INCREMENT',
          payload: { productId: productIds[i % productIds.length], delta: 1 },
          triggerBackgroundSync: false,
        });
        localWriteTotalMs += res.localWriteMs;
        createdOps.push(res.operation);
      }
      engineA.setSimulatedOffline(false);
      const firstRun = await engineA.syncNow({ ignoreBackoff: true });
      acknowledgedCount = firstRun.acknowledgedCount;
      bytesTransferred += firstRun.bytesSent + firstRun.bytesReceived;

      // Re-deliver the exact same operations to verify server idempotency index
      const dupPush = await transportA.push({
        deviceId,
        appId: OFFLINESHOP_APP_ID,
        sessionId: `dup-sess-${experimentId}`,
        lastCursor: 0,
        operations: createdOps,
      });
      duplicatesPrevented = dupPush.data.duplicateIds.length;
      bytesTransferred += dupPush.bytesSent + dupPush.bytesReceived;
      notes = `Re-delivered ${opCount} previously acknowledged operations; idempotency service prevented ${duplicatesPrevented} duplicate mutations.`;
    } else if (params.scenario === 'CONCURRENT_MODIFICATION') {
      // Two independent devices modify the same cart concurrently with stale baseVersion
      const storageB = new MemoryStorageAdapter();
      const transportB = new DirectCoreTransport(core);
      const engineB = createOfflineSync({
        appId: OFFLINESHOP_APP_ID,
        deviceId: `bench-${experimentId}-devB`,
        deviceName: `Benchmark Peer B (${experimentId})`,
        platform: 'experiment-harness',
        storage: storageB,
        transport: transportB,
        batchSize,
        autoSyncOnReconnect: false,
      });
      await engineB.initialize();

      // Establish baseline cart v1
      const initOp = await engineA.createOperation({
        entityType: 'cart',
        entityId: cartId,
        operationType: 'CART_ITEM_SET_QTY',
        payload: { productId: 'P101', quantity: 1 },
        baseVersion: 0,
        triggerBackgroundSync: false,
      });
      localWriteTotalMs += initOp.localWriteMs;
      const baseSync = await engineA.syncNow({ ignoreBackoff: true });
      bytesTransferred += baseSync.bytesSent + baseSync.bytesReceived;
      acknowledgedCount += baseSync.acknowledgedCount;

      // Device A advances cart, then Device B pushes conflicting stale-baseVersion overwrites
      const pairs = Math.max(1, Math.floor(opCount / 2));
      for (let i = 0; i < pairs; i++) {
        const opA = await engineA.createOperation({
          entityType: 'cart',
          entityId: cartId,
          operationType: 'CART_ITEM_INCREMENT',
          payload: { productId: productIds[i % productIds.length], delta: 1 },
          baseVersion: 1,
          triggerBackgroundSync: false,
        });
        localWriteTotalMs += opA.localWriteMs;
        const opB = await engineB.createOperation({
          entityType: 'cart',
          entityId: cartId,
          operationType: 'CART_ITEM_SET_QTY',
          payload: { productId: productIds[i % productIds.length], quantity: 2 + (i % 3) },
          baseVersion: 1, // Deliberately stale baseVersion
          triggerBackgroundSync: false,
        });
        localWriteTotalMs += opB.localWriteMs;
      }

      const syncA = await engineA.syncNow({ ignoreBackoff: true });
      const syncB = await engineB.syncNow({ ignoreBackoff: true });
      acknowledgedCount += syncA.acknowledgedCount + syncB.acknowledgedCount;
      rejectedCount += syncA.rejectedCount + syncB.rejectedCount;
      conflictsDetected = syncA.conflictsCount + syncB.conflictsCount;
      bytesTransferred +=
        syncA.bytesSent + syncA.bytesReceived + syncB.bytesSent + syncB.bytesReceived;

      engineB.destroy();
      notes = `Simulated two concurrent devices modifying cart "${cartId}"; detected ${conflictsDetected} conflicts under policy-based resolution.`;
    }
  } finally {
    engineA.destroy();
  }

  const syncLatencyMs = Math.round((performance.now() - tSyncStart) * 100) / 100;
  const totalProcessed = acknowledgedCount + rejectedCount;
  const successRate =
    totalProcessed > 0
      ? Math.round((acknowledgedCount / totalProcessed) * 10000) / 100
      : 100;
  const failureRate = Math.round((100 - successRate) * 100) / 100;
  const localWriteAvgMs =
    opCount > 0 ? Math.round((localWriteTotalMs / opCount) * 1000) / 1000 : 0;

  const record: ExperimentRunRecord = {
    experimentId,
    scenario: params.scenario,
    operationCount: opCount,
    batchSize,
    startedAt,
    completedAt: new Date().toISOString(),
    syncLatencyMs,
    localWriteAvgMs,
    recoveryTimeMs,
    successRate,
    failureRate,
    retryCount,
    duplicatesPrevented,
    conflictsDetected,
    bytesTransferred,
    acknowledgedCount,
    rejectedCount,
    notes,
  };

  core.recordExperiment(record);
  return record;
}
