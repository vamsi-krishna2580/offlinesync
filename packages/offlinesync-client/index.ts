export {
  createOfflineSync,
  OfflineSyncEngine,
  type ApplicationSyncAdapter,
  type EntityRegistration,
  type OfflineSyncConfig,
  type SyncRunSummary,
  type SyncStatusSnapshot,
  type SyncSubscriber,
} from './engine/SyncCoordinator';

export {
  ConflictPolicyRegistry,
  type ClientConflictContext,
  type ClientConflictResolutionResult,
  type ClientConflictResolverFn,
} from './conflict/ConflictPolicyRegistry';

export { NetworkMonitor, type NetworkMonitorOptions } from './network/NetworkMonitor';
export { PersistentOperationQueue, type EnqueueOperationInput } from './queue/OperationQueue';
export { DexieStorageAdapter } from './storage/DexieStorageAdapter';
export { MemoryStorageAdapter } from './storage/MemoryStorageAdapter';
export type { StoredEntity, SyncStorageAdapter } from './storage/StorageAdapter';
export {
  HttpSyncTransport,
  type HttpSyncTransportOptions,
  type SyncTransport,
  type TransportResult,
} from './transport/HttpSyncTransport';
