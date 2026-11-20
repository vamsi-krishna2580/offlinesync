import type {
  OperationStatus,
  SyncEventRecord,
  SyncOperation,
} from '../../offlinesync-types';

export interface StoredEntity<TData = Record<string, unknown>> {
  key: string; // `${entityType}:${entityId}`
  entityType: string;
  entityId: string;
  version: number;
  data: TData;
  updatedAt: string;
  dirty: boolean;
}

/**
 * Storage-engine-agnostic persistence contract for OfflineSync.
 * Implemented by DexieStorageAdapter (IndexedDB in browsers) and
 * MemoryStorageAdapter (headless tests). Mirrors the DAO interface
 * intended for an Android Room/SQLite port.
 */
export interface SyncStorageAdapter {
  // Entity cache
  putEntity<TData = Record<string, unknown>>(entity: StoredEntity<TData>): Promise<void>;
  putEntitiesBulk(entities: StoredEntity[]): Promise<void>;
  getEntity<TData = Record<string, unknown>>(
    entityType: string,
    entityId: string
  ): Promise<StoredEntity<TData> | undefined>;
  getEntitiesByType<TData = Record<string, unknown>>(
    entityType: string
  ): Promise<StoredEntity<TData>[]>;
  deleteEntity(entityType: string, entityId: string): Promise<void>;
  clearEntities(entityType?: string): Promise<void>;

  // Persistent operation queue
  putOperation(operation: SyncOperation): Promise<void>;
  getOperation(operationId: string): Promise<SyncOperation | undefined>;
  getAllOperations(): Promise<SyncOperation[]>;
  getOperationsByStatus(statuses: OperationStatus[]): Promise<SyncOperation[]>;
  updateOperation(
    operationId: string,
    patch: Partial<SyncOperation>
  ): Promise<SyncOperation | undefined>;
  deleteOperation(operationId: string): Promise<void>;

  // Sync metadata (deviceId, cursor, sequence counter, lastSyncAt)
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta<T = unknown>(key: string, value: T): Promise<void>;

  // Local activity / telemetry event history
  appendEvent(event: SyncEventRecord): Promise<void>;
  getRecentEvents(limit?: number): Promise<SyncEventRecord[]>;
}
