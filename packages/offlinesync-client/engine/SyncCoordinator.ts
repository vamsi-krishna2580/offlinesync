import type {
  ConflictRecord,
  ConflictResolutionPolicy,
  ConnectionStatus,
  OperationOutcome,
  RemoteChange,
  SyncEventRecord,
  SyncEventSeverity,
  SyncEventType,
  SyncOperation,
  SyncState,
} from '../../offlinesync-types';
import {
  ConflictPolicyRegistry,
  type ClientConflictResolverFn,
} from '../conflict/ConflictPolicyRegistry';
import { NetworkMonitor } from '../network/NetworkMonitor';
import { PersistentOperationQueue } from '../queue/OperationQueue';
import type { StoredEntity, SyncStorageAdapter } from '../storage/StorageAdapter';
import type { SyncTransport } from '../transport/HttpSyncTransport';

function generateId(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}-${raw}` : raw;
}

export interface EntityRegistration {
  entityType: string;
  conflictPolicy?: ConflictResolutionPolicy;
  customResolver?: ClientConflictResolverFn;
}

export interface ApplicationSyncAdapter {
  name: string;
  onRemoteChangeApplied?: (change: RemoteChange) => Promise<void> | void;
  onOperationOutcome?: (
    operation: SyncOperation,
    outcome: OperationOutcome
  ) => Promise<void> | void;
}

export interface OfflineSyncConfig {
  appId: string;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  storage: SyncStorageAdapter;
  transport: SyncTransport;
  networkMonitor?: NetworkMonitor;
  conflictResolver?: ConflictPolicyRegistry;
  batchSize?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  autoSyncOnReconnect?: boolean;
  backgroundSyncIntervalMs?: number;
}

export interface SyncStatusSnapshot {
  deviceId: string;
  appId: string;
  connectionStatus: ConnectionStatus;
  simulatedOffline: boolean;
  syncState: SyncState;
  pendingCount: number;
  failedCount: number;
  requiresActionCount: number;
  lastCursor: number;
  lastSyncAt: string | null;
  lastError: string | null;
  lastSyncLatencyMs: number | null;
  lastBytesTransferred: number;
  registered: boolean;
}

export interface SyncRunSummary {
  sessionId: string;
  success: boolean;
  operationsSent: number;
  acknowledgedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  conflictsCount: number;
  remoteChangesApplied: number;
  bytesSent: number;
  bytesReceived: number;
  latencyMs: number;
  error?: string;
}

export type SyncSubscriber = (
  snapshot: SyncStatusSnapshot,
  event?: SyncEventRecord
) => void;

/**
 * Reusable OfflineSync Client Engine.
 * Independent of any UI framework or domain (e.g. OfflineShop).
 */
export class OfflineSyncEngine {
  public readonly appId: string;
  public readonly storage: SyncStorageAdapter;
  public readonly queue: PersistentOperationQueue;
  public readonly network: NetworkMonitor;
  public readonly transport: SyncTransport;
  public readonly conflicts: ConflictPolicyRegistry;

  private deviceId: string;
  private deviceName: string;
  private platform: string;
  private batchSize: number;
  private autoSyncOnReconnect: boolean;
  private backgroundSyncIntervalMs: number;

  private syncState: SyncState = 'IDLE';
  private lastCursor = 0;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private lastSyncLatencyMs: number | null = null;
  private lastBytesTransferred = 0;
  private registered = false;

  private entities = new Map<string, EntityRegistration>();
  private adapters = new Map<string, ApplicationSyncAdapter>();
  private subscribers = new Set<SyncSubscriber>();
  private syncInProgress = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private bgTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeNetwork: (() => void) | null = null;
  private initialized = false;

  constructor(config: OfflineSyncConfig) {
    this.appId = config.appId;
    this.storage = config.storage;
    this.transport = config.transport;
    this.network = config.networkMonitor ?? new NetworkMonitor();
    this.conflicts = config.conflictResolver ?? new ConflictPolicyRegistry();
    this.queue = new PersistentOperationQueue(this.storage, {
      maxRetries: config.maxRetries ?? 5,
      baseBackoffMs: config.baseBackoffMs ?? 1000,
    });

    this.deviceId = config.deviceId ?? '';
    this.deviceName = config.deviceName ?? 'Web Client';
    this.platform = config.platform ?? 'web-indexeddb';
    this.batchSize = config.batchSize ?? 25;
    this.autoSyncOnReconnect = config.autoSyncOnReconnect ?? true;
    this.backgroundSyncIntervalMs = config.backgroundSyncIntervalMs ?? 0;
  }

  async initialize(): Promise<SyncStatusSnapshot> {
    if (this.initialized) return this.getStatus();

    const storedDeviceId = await this.storage.getMeta<string>('deviceId');
    if (this.deviceId) {
      await this.storage.setMeta('deviceId', this.deviceId);
    } else if (storedDeviceId) {
      this.deviceId = storedDeviceId;
    } else {
      this.deviceId = generateId('dev');
      await this.storage.setMeta('deviceId', this.deviceId);
    }

    const storedDeviceName = await this.storage.getMeta<string>('deviceName');
    if (storedDeviceName && this.deviceName === 'Web Client') {
      this.deviceName = storedDeviceName;
    } else {
      await this.storage.setMeta('deviceName', this.deviceName);
    }

    this.lastCursor = (await this.storage.getMeta<number>('lastCursor')) ?? 0;
    this.lastSyncAt = (await this.storage.getMeta<string | null>('lastSyncAt')) ?? null;
    this.registered = Boolean(await this.storage.getMeta<boolean>('deviceRegistered'));

    // Recover any operations left in PROCESSING from a prior tab close or crash
    const recovered = await this.queue.recoverInterruptedOperations();
    if (recovered.length > 0) {
      await this.recordEvent('RETRY_SCHEDULED', 'WARN', null, {
        reason: 'Recovered operations stranded in PROCESSING state on startup',
        recoveredCount: recovered.length,
      });
    }

    this.unsubscribeNetwork = this.network.subscribe((nextStatus, reason) => {
      if (nextStatus === 'OFFLINE') {
        this.syncState = 'OFFLINE';
        void this.recordEvent('NETWORK_OFFLINE', 'WARN', null, { reason });
      } else if (nextStatus === 'ONLINE') {
        if (this.syncState === 'OFFLINE') this.syncState = 'IDLE';
        void this.recordEvent('NETWORK_ONLINE', 'INFO', null, { reason });
        if (this.autoSyncOnReconnect) {
          void this.syncNow();
        }
      }
      void this.emitStatus();
    });

    this.network.start();

    if (this.backgroundSyncIntervalMs > 0) {
      this.bgTimer = setInterval(() => {
        if (this.network.isOnline() && !this.syncInProgress) {
          void this.syncNow();
        }
      }, this.backgroundSyncIntervalMs);
    }

    this.initialized = true;

    if (this.network.isOnline()) {
      await this.ensureDeviceRegistered();
    } else {
      this.syncState = 'OFFLINE';
    }

    return this.getStatus();
  }

  destroy(): void {
    this.network.stop();
    if (this.unsubscribeNetwork) {
      this.unsubscribeNetwork();
      this.unsubscribeNetwork = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.bgTimer) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
  }

  registerEntity(registration: EntityRegistration): void {
    this.entities.set(registration.entityType, registration);
    if (registration.conflictPolicy) {
      this.conflicts.registerPolicy(
        registration.entityType,
        registration.conflictPolicy,
        registration.customResolver
      );
    }
  }

  registerConflictPolicy(
    entityType: string,
    policy: ConflictResolutionPolicy,
    customResolver?: ClientConflictResolverFn
  ): void {
    this.conflicts.registerPolicy(entityType, policy, customResolver);
  }

  registerAdapter(adapter: ApplicationSyncAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  setSimulatedOffline(offline: boolean): void {
    this.network.setSimulatedOffline(offline);
  }

  subscribe(listener: SyncSubscriber): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  async getStatus(): Promise<SyncStatusSnapshot> {
    const [pending, failed, requiresAction] = await Promise.all([
      this.queue.getByStatus(['PENDING', 'PROCESSING']),
      this.queue.getByStatus(['FAILED']),
      this.queue.getByStatus(['REQUIRES_ACTION']),
    ]);

    return {
      deviceId: this.deviceId,
      appId: this.appId,
      connectionStatus: this.network.getStatus(),
      simulatedOffline: this.network.isSimulatedOffline(),
      syncState: this.network.isOnline() ? this.syncState : 'OFFLINE',
      pendingCount: pending.length,
      failedCount: failed.length,
      requiresActionCount: requiresAction.length,
      lastCursor: this.lastCursor,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastSyncLatencyMs: this.lastSyncLatencyMs,
      lastBytesTransferred: this.lastBytesTransferred,
      registered: this.registered,
    };
  }

  async getPendingOperations(): Promise<SyncOperation[]> {
    return this.queue.getByStatus(['PENDING', 'PROCESSING']);
  }

  async getAllOperations(): Promise<SyncOperation[]> {
    return this.queue.getAll();
  }

  async getLocalEntities<T = Record<string, unknown>>(
    entityType: string
  ): Promise<StoredEntity<T>[]> {
    return this.storage.getEntitiesByType<T>(entityType);
  }

  async getLocalEntity<T = Record<string, unknown>>(
    entityType: string,
    entityId: string
  ): Promise<StoredEntity<T> | undefined> {
    return this.storage.getEntity<T>(entityType, entityId);
  }

  async upsertLocalEntity<T = Record<string, unknown>>(
    entityType: string,
    entityId: string,
    data: T,
    options?: { version?: number; dirty?: boolean }
  ): Promise<StoredEntity<T>> {
    const existing = await this.storage.getEntity<T>(entityType, entityId);
    const record: StoredEntity<T> = {
      key: `${entityType}:${entityId}`,
      entityType,
      entityId,
      version: options?.version ?? existing?.version ?? 0,
      data,
      updatedAt: new Date().toISOString(),
      dirty: options?.dirty ?? true,
    };
    await this.storage.putEntity(record);
    return record;
  }

  /**
   * Create and persist a domain operation into the local operation queue.
   * Immediately returns after local persistence so UI remains responsive offline.
   */
  async createOperation<TPayload = Record<string, unknown>>(input: {
    operationId?: string;
    entityType: string;
    entityId: string;
    operationType: string;
    payload: TPayload;
    baseVersion?: number;
    dependsOn?: string[];
    triggerBackgroundSync?: boolean;
  }): Promise<{ operation: SyncOperation<TPayload>; localWriteMs: number }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const t0 = performance.now();
    const existingEntity = await this.storage.getEntity(input.entityType, input.entityId);
    const baseVersion = input.baseVersion ?? existingEntity?.version ?? 0;

    const op = await this.queue.enqueue<TPayload>({
      operationId: input.operationId,
      deviceId: this.deviceId,
      appId: this.appId,
      entityType: input.entityType,
      entityId: input.entityId,
      operationType: input.operationType,
      baseVersion,
      payload: input.payload,
      dependsOn: input.dependsOn,
    });

    const localWriteMs = Math.round((performance.now() - t0) * 100) / 100;

    await this.recordEvent('OPERATION_CREATED', 'INFO', null, {
      operationId: op.operationId,
      operationType: op.operationType,
      entityType: op.entityType,
      entityId: op.entityId,
      sequence: op.sequence,
      localWriteMs,
    });

    await this.emitStatus();

    if (input.triggerBackgroundSync !== false && this.network.isOnline()) {
      // Non-blocking background sync
      void this.syncNow();
    }

    return { operation: op, localWriteMs };
  }

  async ensureDeviceRegistered(): Promise<boolean> {
    if (!this.network.isOnline()) return false;
    try {
      const res = await this.transport.registerDevice({
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        appId: this.appId,
        platform: this.platform,
      });
      this.registered = true;
      await this.storage.setMeta('deviceRegistered', true);
      this.network.reportRequestSuccess();
      await this.recordEvent('DEVICE_REGISTERED', 'INFO', null, {
        deviceName: this.deviceName,
        serverCursor: res.data.currentCursor,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      this.lastError = msg;
      this.network.reportRequestFailure(msg);
      return false;
    }
  }

  /**
   * Pull remote changes incrementally from the last stored cursor without pushing operations.
   */
  async pullRemoteChanges(entityTypes?: string[]): Promise<{
    changes: RemoteChange[];
    updatedCursor: number;
    bytesTransferred: number;
  }> {
    if (!this.initialized) await this.initialize();
    if (!this.network.isOnline()) {
      return { changes: [], updatedCursor: this.lastCursor, bytesTransferred: 0 };
    }

    let cursor = this.lastCursor;
    const allChanges: RemoteChange[] = [];
    let hasMore = true;
    let totalBytes = 0;

    while (hasMore) {
      const res = await this.transport.pull({
        deviceId: this.deviceId,
        appId: this.appId,
        lastCursor: cursor,
        entityTypes,
      });
      totalBytes += res.bytesSent + res.bytesReceived;
      for (const change of res.data.changes) {
        await this.applyRemoteChange(change);
        allChanges.push(change);
      }
      cursor = res.data.updatedCursor;
      hasMore = res.data.hasMore;
    }

    this.lastCursor = cursor;
    this.lastSyncAt = new Date().toISOString();
    await this.storage.setMeta('lastCursor', this.lastCursor);
    await this.storage.setMeta('lastSyncAt', this.lastSyncAt);
    this.network.reportRequestSuccess();
    await this.emitStatus();

    return { changes: allChanges, updatedCursor: cursor, bytesTransferred: totalBytes };
  }

  /**
   * Execute a full bidirectional synchronization cycle:
   * 1. Recover any stranded PROCESSING operations
   * 2. Ensure device registration
   * 3. Push eligible batches of pending operations
   * 4. Reconcile acknowledgements, duplicates, rejections, and conflicts
   * 5. Pull incremental remote changes since lastCursor
   * 6. Persist updated cursor and notify subscribers
   */
  async syncNow(options?: {
    entityTypes?: string[];
    ignoreBackoff?: boolean;
  }): Promise<SyncRunSummary> {
    if (!this.initialized) await this.initialize();

    const sessionId = generateId('sess');
    const started = performance.now();

    if (!this.network.isOnline()) {
      this.syncState = 'OFFLINE';
      await this.emitStatus();
      return {
        sessionId,
        success: false,
        operationsSent: 0,
        acknowledgedCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        conflictsCount: 0,
        remoteChangesApplied: 0,
        bytesSent: 0,
        bytesReceived: 0,
        latencyMs: 0,
        error: 'Device is offline',
      };
    }

    if (this.syncInProgress) {
      return {
        sessionId,
        success: true,
        operationsSent: 0,
        acknowledgedCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        conflictsCount: 0,
        remoteChangesApplied: 0,
        bytesSent: 0,
        bytesReceived: 0,
        latencyMs: 0,
      };
    }

    this.syncInProgress = true;
    this.syncState = 'SYNCING';
    this.lastError = null;
    await this.recordEvent('SYNC_STARTED', 'INFO', sessionId, {
      lastCursor: this.lastCursor,
    });
    await this.emitStatus();

    let totalSent = 0;
    let totalAcked = 0;
    let totalDuplicates = 0;
    let totalRejected = 0;
    let totalConflicts = 0;
    let totalRemoteChanges = 0;
    let totalBytesSent = 0;
    let totalBytesReceived = 0;

    try {
      if (!this.registered) {
        await this.ensureDeviceRegistered();
      }

      const checkNow = options?.ignoreBackoff ? Number.MAX_SAFE_INTEGER : Date.now();
      let continueLoop = true;
      let loops = 0;

      while (continueLoop && loops < 50) {
        loops += 1;
        const batch = await this.queue.getNextBatch(this.batchSize, checkNow);
        const pendingAll = await this.queue.getPendingCount();
        const remainingAfterBatch = Math.max(0, pendingAll - batch.length);

        if (batch.length > 0) {
          await this.queue.markProcessing(batch.map((op) => op.operationId));
          await this.recordEvent('BATCH_SENT', 'INFO', sessionId, {
            batchSize: batch.length,
            operationIds: batch.map((op) => op.operationId),
          });
        }

        const transportRes = await this.transport.process({
          deviceId: this.deviceId,
          appId: this.appId,
          sessionId,
          lastCursor: this.lastCursor,
          operations: batch,
          entityTypes: options?.entityTypes,
          pendingRemaining: remainingAfterBatch,
        });

        totalBytesSent += transportRes.bytesSent;
        totalBytesReceived += transportRes.bytesReceived;
        totalSent += batch.length;

        const resData = transportRes.data;
        const batchMap = new Map(batch.map((op) => [op.operationId, op]));

        for (const outcome of resData.outcomes) {
          const originalOp = batchMap.get(outcome.operationId);

          if (outcome.status === 'ACKNOWLEDGED') {
            totalAcked += 1;
            await this.queue.markAcknowledged(
              outcome.operationId,
              outcome.serverVersion,
              outcome.serverData
            );
            await this.recordEvent('OPERATION_ACKNOWLEDGED', 'INFO', sessionId, {
              operationId: outcome.operationId,
              serverVersion: outcome.serverVersion,
            });
          } else if (outcome.status === 'DUPLICATE') {
            totalDuplicates += 1;
            await this.queue.markAcknowledged(
              outcome.operationId,
              outcome.serverVersion,
              outcome.serverData
            );
            await this.recordEvent('DUPLICATE_DETECTED', 'WARN', sessionId, {
              operationId: outcome.operationId,
            });
          } else if (outcome.status === 'CONFLICT' || outcome.status === 'REQUIRES_ACTION') {
            totalRejected += 1;
            if (outcome.conflict) {
              totalConflicts += 1;
              await this.handleConflictOutcome(outcome.conflict, sessionId);
            }
            await this.queue.markRequiresAction(
              outcome.operationId,
              outcome.reason ?? 'Requires user or operator action',
              outcome.conflict?.conflictId,
              outcome.serverData
            );
            await this.recordEvent('OPERATION_REJECTED', 'WARN', sessionId, {
              operationId: outcome.operationId,
              reason: outcome.reason,
              conflictId: outcome.conflict?.conflictId,
            });
          } else if (outcome.status === 'REJECTED') {
            totalRejected += 1;
            await this.queue.markPermanentFailure(
              outcome.operationId,
              outcome.reason ?? 'Rejected by server validation'
            );
            await this.recordEvent('OPERATION_REJECTED', 'ERROR', sessionId, {
              operationId: outcome.operationId,
              reason: outcome.reason,
            });
          }

          if (originalOp) {
            for (const adapter of this.adapters.values()) {
              if (adapter.onOperationOutcome) {
                await adapter.onOperationOutcome(originalOp, outcome);
              }
            }
          }
        }

        // Reconcile incremental remote changes pulled from server
        for (const change of resData.remoteChanges) {
          await this.applyRemoteChange(change);
          totalRemoteChanges += 1;
        }

        if (resData.updatedCursor > this.lastCursor) {
          this.lastCursor = resData.updatedCursor;
          await this.storage.setMeta('lastCursor', this.lastCursor);
        }

        const nextBatch = await this.queue.getNextBatch(this.batchSize, checkNow);
        continueLoop = nextBatch.length > 0 || resData.hasMore;
      }

      const latencyMs = Math.round((performance.now() - started) * 100) / 100;
      this.lastSyncAt = new Date().toISOString();
      this.lastSyncLatencyMs = latencyMs;
      this.lastBytesTransferred = totalBytesSent + totalBytesReceived;
      await this.storage.setMeta('lastSyncAt', this.lastSyncAt);

      this.syncState = 'IDLE';
      this.network.reportRequestSuccess();

      await this.recordEvent('SYNC_COMPLETED', 'INFO', sessionId, {
        operationsSent: totalSent,
        acknowledgedCount: totalAcked,
        duplicateCount: totalDuplicates,
        rejectedCount: totalRejected,
        conflictsCount: totalConflicts,
        remoteChangesApplied: totalRemoteChanges,
        bytesTransferred: this.lastBytesTransferred,
        latencyMs,
      });

      await this.emitStatus();

      return {
        sessionId,
        success: true,
        operationsSent: totalSent,
        acknowledgedCount: totalAcked,
        duplicateCount: totalDuplicates,
        rejectedCount: totalRejected,
        conflictsCount: totalConflicts,
        remoteChangesApplied: totalRemoteChanges,
        bytesSent: totalBytesSent,
        bytesReceived: totalBytesReceived,
        latencyMs,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown synchronization error';
      this.lastError = reason;

      // Any operations currently marked PROCESSING must be scheduled for exponential-backoff retry
      const inFlight = await this.queue.getByStatus(['PROCESSING']);
      let minBackoffMs: number | null = null;
      for (const op of inFlight) {
        const retryResult = await this.queue.scheduleRetry(op.operationId, reason);
        if (!retryResult.exhausted) {
          minBackoffMs =
            minBackoffMs === null
              ? retryResult.backoffMs
              : Math.min(minBackoffMs, retryResult.backoffMs);
          await this.recordEvent('RETRY_SCHEDULED', 'WARN', sessionId, {
            operationId: op.operationId,
            retryCount: retryResult.operation?.retryCount,
            backoffMs: retryResult.backoffMs,
            reason,
          });
        }
      }

      this.network.reportRequestFailure(reason);
      this.syncState = this.network.isOnline() ? 'ERROR' : 'OFFLINE';

      await this.recordEvent('SYNC_FAILED', 'ERROR', sessionId, {
        reason,
        interruptedOperations: inFlight.length,
      });

      if (minBackoffMs !== null && this.autoSyncOnReconnect) {
        this.scheduleBackgroundRetry(minBackoffMs);
      }

      await this.emitStatus();

      return {
        sessionId,
        success: false,
        operationsSent: totalSent,
        acknowledgedCount: totalAcked,
        duplicateCount: totalDuplicates,
        rejectedCount: totalRejected,
        conflictsCount: totalConflicts,
        remoteChangesApplied: totalRemoteChanges,
        bytesSent: totalBytesSent,
        bytesReceived: totalBytesReceived,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        error: reason,
      };
    } finally {
      this.syncInProgress = false;
    }
  }

  private scheduleBackgroundRetry(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.network.isOnline() && !this.syncInProgress) {
        void this.syncNow();
      }
    }, delayMs);
  }

  private async handleConflictOutcome(
    conflict: ConflictRecord,
    sessionId: string
  ): Promise<void> {
    await this.recordEvent('CONFLICT_DETECTED', 'WARN', sessionId, {
      conflictId: conflict.conflictId,
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      conflictType: conflict.conflictType,
      localVersion: conflict.localVersion,
      remoteVersion: conflict.remoteVersion,
    });

    const localStored = await this.storage.getEntity(
      conflict.entityType,
      conflict.entityId
    );
    const resolution = this.conflicts.resolve({
      conflict,
      localEntity: localStored?.data ?? null,
      remoteEntity: conflict.remoteState,
    });

    if (resolution.action === 'KEEP_REMOTE' && conflict.remoteState) {
      await this.storage.putEntity({
        key: `${conflict.entityType}:${conflict.entityId}`,
        entityType: conflict.entityType,
        entityId: conflict.entityId,
        version: conflict.remoteVersion,
        data: conflict.remoteState,
        updatedAt: new Date().toISOString(),
        dirty: false,
      });
    }
  }

  private async applyRemoteChange(change: RemoteChange): Promise<void> {
    if (change.changeType === 'DELETE' || change.data === null) {
      await this.storage.deleteEntity(change.entityType, change.entityId);
    } else {
      await this.storage.putEntity({
        key: `${change.entityType}:${change.entityId}`,
        entityType: change.entityType,
        entityId: change.entityId,
        version: change.version,
        data: change.data,
        updatedAt: change.updatedAt,
        dirty: false,
      });
    }

    for (const adapter of this.adapters.values()) {
      if (adapter.onRemoteChangeApplied) {
        await adapter.onRemoteChangeApplied(change);
      }
    }
  }

  private async recordEvent(
    eventType: SyncEventType,
    severity: SyncEventSeverity,
    sessionId: string | null,
    metadata: Record<string, unknown>
  ): Promise<SyncEventRecord> {
    const event: SyncEventRecord = {
      eventId: generateId('evt'),
      deviceId: this.deviceId || 'uninitialized',
      appId: this.appId,
      sessionId,
      eventType,
      timestamp: new Date().toISOString(),
      severity,
      metadata,
    };
    await this.storage.appendEvent(event);
    const status = await this.getStatus();
    for (const sub of this.subscribers) {
      sub(status, event);
    }
    return event;
  }

  private async emitStatus(): Promise<void> {
    const status = await this.getStatus();
    for (const sub of this.subscribers) {
      sub(status);
    }
  }
}

/**
 * Public factory API for creating a reusable OfflineSync engine instance.
 */
export function createOfflineSync(config: OfflineSyncConfig): OfflineSyncEngine {
  return new OfflineSyncEngine(config);
}
