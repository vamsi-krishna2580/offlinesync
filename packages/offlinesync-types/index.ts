/**
 * @offlinesync/types
 * Core domain-agnostic synchronization protocol, queue, conflict, and telemetry types.
 * Zero dependency on any application (such as OfflineShop) so the framework can be
 * reused across web apps and ported directly to Android Kotlin data classes.
 */

export type OperationStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'ACKNOWLEDGED'
  | 'FAILED'
  | 'REQUIRES_ACTION';

export type SyncState = 'IDLE' | 'SYNCING' | 'OFFLINE' | 'ERROR';

export type ConnectionStatus = 'ONLINE' | 'OFFLINE' | 'DEGRADED';

export type ConflictType =
  | 'VERSION_MISMATCH'
  | 'PRICE_CHANGED'
  | 'INSUFFICIENT_STOCK'
  | 'CONCURRENT_EDIT'
  | 'ENTITY_DELETED'
  | 'VALIDATION_FAILED';

export type ConflictResolutionPolicy =
  | 'SERVER_AUTHORITATIVE'
  | 'LAST_WRITE_WINS_DETERMINISTIC'
  | 'MANUAL_RESOLUTION'
  | 'DOMAIN_CUSTOM';

export type ConflictResolutionStatus = 'OPEN' | 'RESOLVED_AUTO' | 'RESOLVED_MANUAL' | 'DISMISSED';

export type SyncEventSeverity = 'INFO' | 'WARN' | 'ERROR';

export type SyncEventType =
  | 'DEVICE_REGISTERED'
  | 'NETWORK_OFFLINE'
  | 'NETWORK_ONLINE'
  | 'OPERATION_CREATED'
  | 'OPERATION_QUEUED'
  | 'SYNC_STARTED'
  | 'BATCH_SENT'
  | 'OPERATION_ACKNOWLEDGED'
  | 'OPERATION_REJECTED'
  | 'DUPLICATE_DETECTED'
  | 'CONFLICT_DETECTED'
  | 'CONFLICT_RESOLVED'
  | 'RETRY_SCHEDULED'
  | 'SYNC_COMPLETED'
  | 'SYNC_FAILED';

export type SessionResult = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'INTERRUPTED';

export interface ApiErrorResponse {
  error: string;
  code: string;
  details?: string[];
}

export interface SyncOperation<TPayload = Record<string, unknown>> {
  operationId: string;
  deviceId: string;
  appId: string;
  entityType: string;
  entityId: string;
  operationType: string;
  sequence: number;
  baseVersion: number;
  createdAt: string;
  payload: TPayload;
  status: OperationStatus;
  retryCount: number;
  dependsOn?: string[];
  lastAttemptAt?: string;
  nextRetryAt?: string;
  errorMessage?: string;
  conflictId?: string;
  serverVersion?: number;
  resultData?: Record<string, unknown>;
}

export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  appId: string;
  platform: string;
  registeredAt: string;
  lastSyncAt: string | null;
  lastSeenAt: string;
  connectionStatus: ConnectionStatus;
  lastCursor: number;
  pendingCount: number;
}

export interface ConflictHistoryEntry {
  timestamp: string;
  actor: string;
  action: string;
  policy: ConflictResolutionPolicy;
  note?: string;
}

export interface ConflictRecord {
  conflictId: string;
  operationId: string;
  deviceId: string;
  appId: string;
  entityType: string;
  entityId: string;
  localVersion: number;
  remoteVersion: number;
  localPayload: Record<string, unknown>;
  remoteState: Record<string, unknown> | null;
  conflictType: ConflictType;
  resolutionStatus: ConflictResolutionStatus;
  resolutionPolicy: ConflictResolutionPolicy;
  resolutionChoice?: 'KEEP_SERVER' | 'APPLY_CLIENT' | 'CUSTOM';
  resolvedPayload?: Record<string, unknown> | null;
  resolutionSummary?: string;
  resolutionIdempotencyKey?: string;
  detectedAt: string;
  resolvedAt: string | null;
  history: ConflictHistoryEntry[];
}

export interface SyncSessionRecord {
  sessionId: string;
  deviceId: string;
  appId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  operationsSent: number;
  operationsAcknowledged: number;
  operationsRejected: number;
  duplicatesDetected: number;
  conflictsDetected: number;
  bytesSent: number;
  bytesReceived: number;
  errors: string[];
  result: SessionResult;
  cursorBefore: number;
  cursorAfter: number;
}

export interface SyncEventRecord {
  eventId: string;
  deviceId: string;
  appId: string;
  sessionId: string | null;
  eventType: SyncEventType;
  timestamp: string;
  severity: SyncEventSeverity;
  metadata: Record<string, unknown>;
}

export interface RemoteChange {
  cursor: number;
  entityType: string;
  entityId: string;
  version: number;
  changeType: 'UPSERT' | 'DELETE';
  data: Record<string, unknown> | null;
  updatedAt: string;
  sourceDeviceId?: string;
}

export interface OperationOutcome {
  operationId: string;
  status: 'ACKNOWLEDGED' | 'DUPLICATE' | 'REJECTED' | 'CONFLICT' | 'REQUIRES_ACTION';
  serverVersion?: number;
  conflict?: ConflictRecord;
  reason?: string;
  serverData?: Record<string, unknown>;
}

// ============================================================================
// Synchronization Protocol Request / Response Contracts
// ============================================================================

export interface RegisterDeviceRequest {
  deviceId: string;
  deviceName: string;
  appId: string;
  platform?: string;
}

export interface RegisterDeviceResponse {
  device: DeviceRecord;
  /**
   * Bearer/device token issued on initial registration (or verified on re-registration).
   * Clients must persist this token locally and send it in `X-Device-Token` on sync calls.
   */
  deviceToken?: string;
  serverTimestamp: string;
  currentCursor: number;
}

export interface SyncPushRequest {
  deviceId: string;
  appId: string;
  sessionId: string;
  lastCursor: number;
  operations: SyncOperation[];
}

export interface SyncPushResponse {
  sessionId: string;
  acknowledgedIds: string[];
  duplicateIds: string[];
  rejectedIds: string[];
  outcomes: OperationOutcome[];
  conflicts: ConflictRecord[];
  updatedCursor: number;
  serverTimestamp: string;
}

export interface SyncPullRequest {
  deviceId: string;
  appId: string;
  sessionId?: string;
  lastCursor: number;
  entityTypes?: string[];
  limit?: number;
}

export interface SyncPullResponse {
  sessionId: string | null;
  changes: RemoteChange[];
  updatedCursor: number;
  latestAppCursor: number;
  hasMore: boolean;
  serverTimestamp: string;
}

export interface SyncProcessRequest {
  deviceId: string;
  appId: string;
  sessionId: string;
  lastCursor: number;
  operations: SyncOperation[];
  entityTypes?: string[];
  limit?: number;
  pendingRemaining?: number;
}

export interface SyncProcessResponse {
  sessionId: string;
  acknowledgedIds: string[];
  duplicateIds: string[];
  rejectedIds: string[];
  outcomes: OperationOutcome[];
  conflicts: ConflictRecord[];
  remoteChanges: RemoteChange[];
  updatedCursor: number;
  latestAppCursor: number;
  hasMore: boolean;
  serverTimestamp: string;
  durationMs: number;
}

export interface ResolveConflictRequest {
  resolutionChoice: 'KEEP_SERVER' | 'APPLY_CLIENT' | 'CUSTOM';
  resolvedPayload?: Record<string, unknown>;
  expectedServerVersion?: number;
  idempotencyKey?: string;
  actor?: string;
  note?: string;
}

export interface ResolveConflictResponse {
  conflict: ConflictRecord;
  idempotentReplay: boolean;
}

export interface MonitorMetrics {
  totalDevices: number;
  activeDevices: number;
  offlineDevices: number;
  pendingOperations: number;
  processingOperations: number;
  successfulOperations: number;
  failedOperations: number;
  requiresActionOperations: number;
  totalConflicts: number;
  openConflicts: number;
  resolvedConflicts: number;
  totalSessions: number;
  successfulSessions: number;
  syncSuccessRate: number | null;
  averageLatencyMs: number | null;
  lastSyncTime: string | null;
  duplicatesPrevented: number;
  totalBytesTransferred: number;
  currentServerCursor: number;
}

export interface ExperimentRunRecord {
  experimentId: string;
  scenario:
    | 'STABLE_CONNECTION'
    | 'SIMULATED_INTERRUPTION'
    | 'OFFLINE_BACKLOG'
    | 'DUPLICATE_DELIVERY'
    | 'CONCURRENT_MODIFICATION';
  operationCount: number;
  batchSize: number;
  startedAt: string;
  completedAt: string;
  syncLatencyMs: number;
  localWriteAvgMs: number;
  recoveryTimeMs: number | null;
  successRate: number;
  failureRate: number;
  retryCount: number;
  duplicatesPrevented: number;
  conflictsDetected: number;
  bytesTransferred: number;
  acknowledgedCount: number;
  rejectedCount: number;
  notes: string;
}

export interface SyncMetadataRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}
