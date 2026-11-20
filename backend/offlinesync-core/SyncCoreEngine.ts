import crypto from 'crypto';
import type {
  ConflictRecord,
  ConflictResolutionPolicy,
  ConflictType,
  DeviceRecord,
  ExperimentRunRecord,
  MonitorMetrics,
  OperationOutcome,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
  ResolveConflictRequest,
  SyncEventRecord,
  SyncMetadataRecord,
  SyncOperation,
  SyncProcessRequest,
  SyncProcessResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncSessionRecord,
} from '../../packages/offlinesync-types';
import type { DocumentCollection, DocumentStore } from '../persistence/DocumentStore';
import { ConflictManager, type ServerDomainConflictHandler } from './ConflictManager';
import { DeviceRegistry } from './DeviceRegistry';
import { IdempotencyService, type StoredProcessedOperation } from './IdempotencyService';
import { ReconciliationEngine, type ChangeLogDocument } from './ReconciliationEngine';
import { TelemetryService } from './TelemetryService';

export interface AdapterOperationContext {
  core: SyncCoreEngine;
  recordEntityChange: (params: {
    appId: string;
    entityType: string;
    entityId: string;
    version: number;
    changeType: 'UPSERT' | 'DELETE';
    data: Record<string, unknown> | null;
    sourceDeviceId?: string;
  }) => void;
  raiseConflict: (params: {
    operation: SyncOperation;
    remoteVersion: number;
    remoteState: Record<string, unknown> | null;
    conflictType: ConflictType;
    overridePolicy?: ConflictResolutionPolicy;
    summary?: string;
  }) => {
    conflict: ConflictRecord;
    autoResolved: boolean;
    winningPayload: Record<string, unknown> | null;
  };
}

/**
 * Clean pluggable adapter contract so any application (OfflineShop, field notes,
 * inventory scanner, clinical forms) can reuse SyncCoreEngine without placing
 * domain logic inside the generic synchronization core.
 */
export interface BusinessAdapter {
  appId: string;
  supportedEntityTypes: string[];
  registerPolicies?: (conflicts: ConflictManager) => void;
  processOperation(
    operation: SyncOperation,
    ctx: AdapterOperationContext
  ): OperationOutcome;
  applyManualConflictResolution?(
    conflict: ConflictRecord,
    resolvedPayload: Record<string, unknown> | null,
    ctx: AdapterOperationContext
  ): void;
}

/**
 * Generic, reusable OfflineSync Backend Core.
 * Contains ZERO e-commerce business logic.
 */
export class SyncCoreEngine {
  public readonly store: DocumentStore;
  public readonly devices: DeviceRegistry;
  public readonly idempotency: IdempotencyService;
  public readonly conflicts: ConflictManager;
  public readonly reconciliation: ReconciliationEngine;
  public readonly telemetry: TelemetryService;

  private readonly sessionsCol: DocumentCollection<SyncSessionRecord & Record<string, unknown>>;
  private readonly experimentsCol: DocumentCollection<ExperimentRunRecord & Record<string, unknown>>;
  private adapters = new Map<string, BusinessAdapter>();

  constructor(store: DocumentStore) {
    this.store = store;

    const devicesCol = store.registerCollection<DeviceRecord & Record<string, unknown>>(
      'devices',
      'deviceId'
    );
    const opsCol = store.registerCollection<StoredProcessedOperation>(
      'sync_operations',
      'operationId',
      [
        {
          name: 'uniq_operation_id',
          keyFn: (doc) => doc.operationId,
        },
      ]
    );
    const sessionsCol = store.registerCollection<SyncSessionRecord & Record<string, unknown>>(
      'sync_sessions',
      'sessionId'
    );
    const conflictsCol = store.registerCollection<ConflictRecord & Record<string, unknown>>(
      'conflicts',
      'conflictId'
    );
    const eventsCol = store.registerCollection<SyncEventRecord & Record<string, unknown>>(
      'sync_events',
      'eventId'
    );
    const changeLogCol = store.registerCollection<ChangeLogDocument>(
      'sync_changelog',
      'changeId'
    );
    const metaCol = store.registerCollection<SyncMetadataRecord & Record<string, unknown>>(
      'sync_metadata',
      'key'
    );
    const experimentsCol = store.registerCollection<
      ExperimentRunRecord & Record<string, unknown>
    >('sync_experiments', 'experimentId');

    this.devices = new DeviceRegistry(devicesCol);
    this.idempotency = new IdempotencyService(opsCol);
    this.conflicts = new ConflictManager(conflictsCol);
    this.reconciliation = new ReconciliationEngine(changeLogCol, metaCol);
    this.telemetry = new TelemetryService(eventsCol);
    this.sessionsCol = sessionsCol;
    this.experimentsCol = experimentsCol;
  }

  registerAdapter(adapter: BusinessAdapter): void {
    this.adapters.set(adapter.appId, adapter);
    if (adapter.registerPolicies) {
      adapter.registerPolicies(this.conflicts);
    }
  }

  registerConflictPolicy(
    entityType: string,
    policy: ConflictResolutionPolicy,
    handler?: ServerDomainConflictHandler
  ): void {
    this.conflicts.registerPolicy(entityType, policy, handler);
  }

  registerDevice(req: RegisterDeviceRequest): RegisterDeviceResponse {
    const { device, isNew } = this.devices.register(req);
    this.telemetry.emit({
      deviceId: device.deviceId,
      appId: device.appId,
      eventType: 'DEVICE_REGISTERED',
      severity: 'INFO',
      metadata: {
        deviceName: device.deviceName,
        platform: device.platform,
        isNew,
      },
    });
    return {
      device,
      serverTimestamp: new Date().toISOString(),
      currentCursor: this.reconciliation.getCurrentCursor(),
    };
  }

  push(req: SyncPushRequest, rawBytesSent = 0): SyncPushResponse {
    const started = performance.now();
    const sessionId = req.sessionId || `sess-${crypto.randomUUID()}`;
    const cursorBefore = req.lastCursor ?? 0;

    this.telemetry.emit({
      deviceId: req.deviceId,
      appId: req.appId,
      sessionId,
      eventType: 'BATCH_SENT',
      severity: 'INFO',
      metadata: { operationCount: req.operations.length },
    });

    const result = this.executeOperationBatch(req.deviceId, req.appId, sessionId, req.operations);
    const updatedCursor = this.reconciliation.getCurrentCursor();
    const durationMs = Math.round((performance.now() - started) * 100) / 100;

    this.recordSession({
      sessionId,
      deviceId: req.deviceId,
      appId: req.appId,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs,
      operationsSent: req.operations.length,
      operationsAcknowledged: result.acknowledgedIds.length + result.duplicateIds.length,
      operationsRejected: result.rejectedIds.length,
      duplicatesDetected: result.duplicateIds.length,
      conflictsDetected: result.conflicts.length,
      bytesSent: rawBytesSent,
      bytesReceived: 0,
      errors: result.errors,
      result: result.rejectedIds.length > 0 && result.acknowledgedIds.length === 0
        ? 'FAILED'
        : result.rejectedIds.length > 0
        ? 'PARTIAL'
        : 'SUCCESS',
      cursorBefore,
      cursorAfter: updatedCursor,
    });

    this.devices.touchSync(req.deviceId, req.appId, updatedCursor, 0);

    return {
      sessionId,
      acknowledgedIds: result.acknowledgedIds,
      duplicateIds: result.duplicateIds,
      rejectedIds: result.rejectedIds,
      outcomes: result.outcomes,
      conflicts: result.conflicts,
      updatedCursor,
      serverTimestamp: new Date().toISOString(),
    };
  }

  pull(req: SyncPullRequest): SyncPullResponse {
    const pulled = this.reconciliation.pullChanges({
      appId: req.appId,
      sinceCursor: req.lastCursor ?? 0,
      entityTypes: req.entityTypes,
      limit: req.limit ?? 100,
    });
    this.devices.touchSync(req.deviceId, req.appId, pulled.updatedCursor);
    return {
      sessionId: req.sessionId ?? null,
      changes: pulled.changes,
      updatedCursor: pulled.updatedCursor,
      hasMore: pulled.hasMore,
      serverTimestamp: new Date().toISOString(),
    };
  }

  /**
   * Combined bidirectional synchronization endpoint:
   * Push operations -> Idempotency & Business Adapter -> Pull incremental changes -> Session telemetry.
   */
  process(req: SyncProcessRequest, rawBytesSent = 0): SyncProcessResponse {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const sessionId = req.sessionId || `sess-${crypto.randomUUID()}`;
    const cursorBefore = req.lastCursor ?? 0;

    this.telemetry.emit({
      deviceId: req.deviceId,
      appId: req.appId,
      sessionId,
      eventType: 'SYNC_STARTED',
      severity: 'INFO',
      metadata: {
        operationsInBatch: req.operations.length,
        cursorBefore,
      },
    });

    if (req.operations.length > 0) {
      this.telemetry.emit({
        deviceId: req.deviceId,
        appId: req.appId,
        sessionId,
        eventType: 'BATCH_SENT',
        severity: 'INFO',
        metadata: {
          batchSize: req.operations.length,
          operationTypes: req.operations.map((o) => o.operationType),
        },
      });
    }

    const batchRes = this.executeOperationBatch(
      req.deviceId,
      req.appId,
      sessionId,
      req.operations
    );

    const pulled = this.reconciliation.pullChanges({
      appId: req.appId,
      sinceCursor: cursorBefore,
      entityTypes: req.entityTypes,
      limit: 150,
    });

    const durationMs = Math.round((performance.now() - t0) * 100) / 100;
    const endedAt = new Date().toISOString();

    const responseObj: SyncProcessResponse = {
      sessionId,
      acknowledgedIds: batchRes.acknowledgedIds,
      duplicateIds: batchRes.duplicateIds,
      rejectedIds: batchRes.rejectedIds,
      outcomes: batchRes.outcomes,
      conflicts: batchRes.conflicts,
      remoteChanges: pulled.changes,
      updatedCursor: pulled.updatedCursor,
      hasMore: pulled.hasMore,
      serverTimestamp: endedAt,
      durationMs,
    };

    const bytesReceived = Buffer.byteLength(JSON.stringify(responseObj), 'utf-8');

    const sessionResult =
      batchRes.rejectedIds.length > 0 && batchRes.acknowledgedIds.length === 0
        ? 'PARTIAL'
        : batchRes.rejectedIds.length > 0
        ? 'PARTIAL'
        : 'SUCCESS';

    this.recordSession({
      sessionId,
      deviceId: req.deviceId,
      appId: req.appId,
      startedAt,
      endedAt,
      durationMs,
      operationsSent: req.operations.length,
      operationsAcknowledged: batchRes.acknowledgedIds.length + batchRes.duplicateIds.length,
      operationsRejected: batchRes.rejectedIds.length,
      duplicatesDetected: batchRes.duplicateIds.length,
      conflictsDetected: batchRes.conflicts.length,
      bytesSent: rawBytesSent,
      bytesReceived,
      errors: batchRes.errors,
      result: sessionResult,
      cursorBefore,
      cursorAfter: pulled.updatedCursor,
    });

    this.devices.touchSync(
      req.deviceId,
      req.appId,
      pulled.updatedCursor,
      req.pendingRemaining ?? 0
    );

    this.telemetry.emit({
      deviceId: req.deviceId,
      appId: req.appId,
      sessionId,
      eventType: 'SYNC_COMPLETED',
      severity: 'INFO',
      metadata: {
        durationMs,
        operationsSent: req.operations.length,
        acknowledged: batchRes.acknowledgedIds.length,
        duplicates: batchRes.duplicateIds.length,
        rejected: batchRes.rejectedIds.length,
        conflicts: batchRes.conflicts.length,
        remoteChangesPulled: pulled.changes.length,
        updatedCursor: pulled.updatedCursor,
      },
    });

    return responseObj;
  }

  resolveConflict(
    conflictId: string,
    req: ResolveConflictRequest
  ): ConflictRecord | null {
    const resolved = this.conflicts.resolveManually(conflictId, req);
    if (!resolved) return null;

    const adapter = this.adapters.get(resolved.appId);
    if (adapter?.applyManualConflictResolution) {
      adapter.applyManualConflictResolution(
        resolved,
        resolved.resolvedPayload ?? null,
        this.buildAdapterContext()
      );
    }

    this.idempotency.updateOperationStatus(
      resolved.operationId,
      'ACKNOWLEDGED',
      `Resolved via conflict ${conflictId} (${req.resolutionChoice})`
    );

    this.telemetry.emit({
      deviceId: resolved.deviceId,
      appId: resolved.appId,
      eventType: 'CONFLICT_RESOLVED',
      severity: 'INFO',
      metadata: {
        conflictId: resolved.conflictId,
        entityType: resolved.entityType,
        entityId: resolved.entityId,
        resolutionChoice: req.resolutionChoice,
        actor: req.actor || 'monitor-operator',
      },
    });

    return resolved;
  }

  listSessions(filter?: { deviceId?: string; limit?: number }): SyncSessionRecord[] {
    const all = this.sessionsCol
      .find((doc) => {
        if (filter?.deviceId && doc.deviceId !== filter.deviceId) return false;
        return true;
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return filter?.limit ? all.slice(0, filter.limit) : all;
  }

  recordExperiment(run: ExperimentRunRecord): ExperimentRunRecord {
    this.experimentsCol.insertOne(run as ExperimentRunRecord & Record<string, unknown>);
    return run;
  }

  listExperiments(): ExperimentRunRecord[] {
    return this.experimentsCol
      .find()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Computes 100% genuine metrics strictly from stored backend collections.
   * Never fabricates metrics; returns 0 or null when no records exist.
   */
  getMonitorMetrics(): MonitorMetrics {
    const devices = this.devices.listAll();
    const ops = this.idempotency.listOperations();
    const sessions = this.listSessions();
    const conflicts = this.conflicts.listAll();

    const activeDevices = devices.filter((d) => d.connectionStatus === 'ONLINE').length;
    const offlineDevices = devices.filter((d) => d.connectionStatus === 'OFFLINE').length;

    const pendingFromDevices = devices.reduce((sum, d) => sum + (d.pendingCount || 0), 0);
    const pendingOps =
      ops.filter((o) => o.status === 'PENDING').length + pendingFromDevices;
    const processingOps = ops.filter((o) => o.status === 'PROCESSING').length;
    const successfulOps = ops.filter((o) => o.status === 'ACKNOWLEDGED').length;
    const failedOps = ops.filter((o) => o.status === 'FAILED').length;
    const requiresActionOps = ops.filter((o) => o.status === 'REQUIRES_ACTION').length;

    const openConflicts = conflicts.filter((c) => c.resolutionStatus === 'OPEN').length;
    const resolvedConflicts = conflicts.filter(
      (c) => c.resolutionStatus === 'RESOLVED_AUTO' || c.resolutionStatus === 'RESOLVED_MANUAL'
    ).length;

    const successfulSessions = sessions.filter((s) => s.result === 'SUCCESS').length;
    const syncSuccessRate =
      sessions.length > 0
        ? Math.round((successfulSessions / sessions.length) * 10000) / 100
        : null;

    const durations = sessions
      .map((s) => s.durationMs)
      .filter((v): v is number => typeof v === 'number');
    const averageLatencyMs =
      durations.length > 0
        ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 100) / 100
        : null;

    const lastSyncTime = sessions.length > 0 ? sessions[0].endedAt ?? sessions[0].startedAt : null;

    const totalBytesTransferred = sessions.reduce(
      (acc, s) => acc + (s.bytesSent || 0) + (s.bytesReceived || 0),
      0
    );

    return {
      totalDevices: devices.length,
      activeDevices,
      offlineDevices,
      pendingOperations: pendingOps,
      processingOperations: processingOps,
      successfulOperations: successfulOps,
      failedOperations: failedOps,
      requiresActionOperations: requiresActionOps,
      totalConflicts: conflicts.length,
      openConflicts,
      resolvedConflicts,
      totalSessions: sessions.length,
      successfulSessions,
      syncSuccessRate,
      averageLatencyMs,
      lastSyncTime,
      duplicatesPrevented: this.idempotency.totalDuplicatesPrevented(),
      totalBytesTransferred,
      currentServerCursor: this.reconciliation.getCurrentCursor(),
    };
  }

  private buildAdapterContext(): AdapterOperationContext {
    return {
      core: this,
      recordEntityChange: (params) => {
        this.reconciliation.recordChange(params);
      },
      raiseConflict: (params) => {
        const decision = this.conflicts.recordAndEvaluate(params);
        this.telemetry.emit({
          deviceId: params.operation.deviceId,
          appId: params.operation.appId,
          eventType: 'CONFLICT_DETECTED',
          severity: 'WARN',
          metadata: {
            conflictId: decision.conflict.conflictId,
            entityType: decision.conflict.entityType,
            entityId: decision.conflict.entityId,
            conflictType: decision.conflict.conflictType,
            policy: decision.conflict.resolutionPolicy,
            autoResolved: decision.autoResolved,
          },
        });
        if (decision.autoResolved) {
          this.telemetry.emit({
            deviceId: params.operation.deviceId,
            appId: params.operation.appId,
            eventType: 'CONFLICT_RESOLVED',
            severity: 'INFO',
            metadata: {
              conflictId: decision.conflict.conflictId,
              policy: decision.conflict.resolutionPolicy,
              summary: decision.conflict.resolutionSummary,
            },
          });
        }
        return decision;
      },
    };
  }

  private executeOperationBatch(
    deviceId: string,
    appId: string,
    sessionId: string,
    operations: SyncOperation[]
  ): {
    acknowledgedIds: string[];
    duplicateIds: string[];
    rejectedIds: string[];
    outcomes: OperationOutcome[];
    conflicts: ConflictRecord[];
    errors: string[];
  } {
    const acknowledgedIds: string[] = [];
    const duplicateIds: string[] = [];
    const rejectedIds: string[] = [];
    const outcomes: OperationOutcome[] = [];
    const conflicts: ConflictRecord[] = [];
    const errors: string[] = [];

    const adapter = this.adapters.get(appId);
    const adapterCtx = this.buildAdapterContext();

    // Order batch deterministically by client sequence number
    const ordered = [...operations].sort((a, b) => a.sequence - b.sequence);

    for (const op of ordered) {
      // 1. Validate envelope
      if (!op.operationId || !op.entityType || !op.entityId || !op.operationType) {
        const reason = 'Invalid operation envelope: missing required identifiers';
        rejectedIds.push(op.operationId || 'unknown');
        errors.push(reason);
        outcomes.push({
          operationId: op.operationId || 'unknown',
          status: 'REJECTED',
          reason,
        });
        continue;
      }

      // 2. Idempotency check (unique operationId)
      const existing = this.idempotency.checkExisting(op.operationId);
      if (existing) {
        this.idempotency.recordDuplicateHit(op.operationId);
        duplicateIds.push(op.operationId);
        const dupOutcome: OperationOutcome = {
          ...existing.serverOutcome,
          operationId: op.operationId,
          status: 'DUPLICATE',
          reason: 'Operation already processed (idempotent duplicate delivery)',
        };
        outcomes.push(dupOutcome);
        this.telemetry.emit({
          deviceId,
          appId,
          sessionId,
          eventType: 'DUPLICATE_DETECTED',
          severity: 'WARN',
          metadata: {
            operationId: op.operationId,
            operationType: op.operationType,
            entityId: op.entityId,
          },
        });
        continue;
      }

      // 3. Dispatch to registered business adapter
      if (!adapter) {
        const reason = `No business adapter registered for appId "${appId}"`;
        rejectedIds.push(op.operationId);
        errors.push(reason);
        const failOutcome: OperationOutcome = {
          operationId: op.operationId,
          status: 'REJECTED',
          reason,
        };
        this.idempotency.recordProcessed(op, failOutcome);
        outcomes.push(failOutcome);
        continue;
      }

      const outcome = adapter.processOperation(op, adapterCtx);
      this.idempotency.recordProcessed(op, outcome);
      outcomes.push(outcome);

      if (outcome.conflict) {
        conflicts.push(outcome.conflict);
      }

      if (outcome.status === 'ACKNOWLEDGED') {
        acknowledgedIds.push(op.operationId);
        this.telemetry.emit({
          deviceId,
          appId,
          sessionId,
          eventType: 'OPERATION_ACKNOWLEDGED',
          severity: 'INFO',
          metadata: {
            operationId: op.operationId,
            operationType: op.operationType,
            entityType: op.entityType,
            entityId: op.entityId,
            serverVersion: outcome.serverVersion,
          },
        });
      } else {
        rejectedIds.push(op.operationId);
        if (outcome.reason) errors.push(outcome.reason);
        this.telemetry.emit({
          deviceId,
          appId,
          sessionId,
          eventType: 'OPERATION_REJECTED',
          severity: outcome.status === 'REJECTED' ? 'ERROR' : 'WARN',
          metadata: {
            operationId: op.operationId,
            operationType: op.operationType,
            status: outcome.status,
            reason: outcome.reason,
          },
        });
      }
    }

    return {
      acknowledgedIds,
      duplicateIds,
      rejectedIds,
      outcomes,
      conflicts,
      errors,
    };
  }

  private recordSession(session: SyncSessionRecord): void {
    this.sessionsCol.upsertOne(session as SyncSessionRecord & Record<string, unknown>);
  }
}
