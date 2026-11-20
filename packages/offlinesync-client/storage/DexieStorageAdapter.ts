import Dexie, { type Table } from 'dexie';
import type {
  OperationStatus,
  SyncEventRecord,
  SyncOperation,
} from '../../offlinesync-types';
import type { StoredEntity, SyncStorageAdapter } from './StorageAdapter';

interface MetaRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

class OfflineSyncDexieDB extends Dexie {
  entities!: Table<StoredEntity, string>;
  operations!: Table<SyncOperation, string>;
  metadata!: Table<MetaRow, string>;
  events!: Table<SyncEventRecord, string>;

  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      entities: 'key, entityType, entityId, updatedAt, dirty',
      operations: 'operationId, status, sequence, entityType, entityId, createdAt',
      metadata: 'key',
      events: 'eventId, timestamp, eventType',
    });
  }
}

/**
 * Genuine IndexedDB persistence adapter built on Dexie.
 * Persists cached entities, operation queue, sync checkpoints, and local
 * event logs across page reloads and browser restarts.
 */
export class DexieStorageAdapter implements SyncStorageAdapter {
  private readonly db: OfflineSyncDexieDB;

  constructor(dbName = 'offlinesync_local_db') {
    this.db = new OfflineSyncDexieDB(dbName);
  }

  async putEntity<TData = Record<string, unknown>>(
    entity: StoredEntity<TData>
  ): Promise<void> {
    await this.db.entities.put(entity as StoredEntity);
  }

  async putEntitiesBulk(entities: StoredEntity[]): Promise<void> {
    if (entities.length === 0) return;
    await this.db.entities.bulkPut(entities);
  }

  async getEntity<TData = Record<string, unknown>>(
    entityType: string,
    entityId: string
  ): Promise<StoredEntity<TData> | undefined> {
    const key = `${entityType}:${entityId}`;
    const row = await this.db.entities.get(key);
    return row as StoredEntity<TData> | undefined;
  }

  async getEntitiesByType<TData = Record<string, unknown>>(
    entityType: string
  ): Promise<StoredEntity<TData>[]> {
    const rows = await this.db.entities
      .where('entityType')
      .equals(entityType)
      .toArray();
    return rows as StoredEntity<TData>[];
  }

  async deleteEntity(entityType: string, entityId: string): Promise<void> {
    await this.db.entities.delete(`${entityType}:${entityId}`);
  }

  async clearEntities(entityType?: string): Promise<void> {
    if (!entityType) {
      await this.db.entities.clear();
      return;
    }
    await this.db.entities.where('entityType').equals(entityType).delete();
  }

  async putOperation(operation: SyncOperation): Promise<void> {
    await this.db.operations.put(operation);
  }

  async getOperation(operationId: string): Promise<SyncOperation | undefined> {
    return this.db.operations.get(operationId);
  }

  async getAllOperations(): Promise<SyncOperation[]> {
    return this.db.operations.orderBy('sequence').toArray();
  }

  async getOperationsByStatus(statuses: OperationStatus[]): Promise<SyncOperation[]> {
    const all = await this.db.operations.orderBy('sequence').toArray();
    const set = new Set(statuses);
    return all.filter((op) => set.has(op.status));
  }

  async updateOperation(
    operationId: string,
    patch: Partial<SyncOperation>
  ): Promise<SyncOperation | undefined> {
    const existing = await this.db.operations.get(operationId);
    if (!existing) return undefined;
    const updated: SyncOperation = { ...existing, ...patch };
    await this.db.operations.put(updated);
    return updated;
  }

  async deleteOperation(operationId: string): Promise<void> {
    await this.db.operations.delete(operationId);
  }

  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.db.metadata.get(key);
    return row?.value as T | undefined;
  }

  async setMeta<T = unknown>(key: string, value: T): Promise<void> {
    await this.db.metadata.put({
      key,
      value,
      updatedAt: new Date().toISOString(),
    });
  }

  async appendEvent(event: SyncEventRecord): Promise<void> {
    await this.db.events.put(event);
    // Keep local history bounded so browser storage remains lightweight
    const count = await this.db.events.count();
    if (count > 500) {
      const oldest = await this.db.events.orderBy('timestamp').limit(count - 500).toArray();
      await this.db.events.bulkDelete(oldest.map((e) => e.eventId));
    }
  }

  async getRecentEvents(limit = 100): Promise<SyncEventRecord[]> {
    return this.db.events.orderBy('timestamp').reverse().limit(limit).toArray();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
