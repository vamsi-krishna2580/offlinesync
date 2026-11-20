import type {
  OperationStatus,
  SyncEventRecord,
  SyncOperation,
} from '../../offlinesync-types';
import type { StoredEntity, SyncStorageAdapter } from './StorageAdapter';

/**
 * Deterministic in-memory storage adapter for headless unit tests,
 * integration benchmarks, and multi-device conflict simulations.
 */
export class MemoryStorageAdapter implements SyncStorageAdapter {
  private entities = new Map<string, StoredEntity>();
  private operations = new Map<string, SyncOperation>();
  private metadata = new Map<string, unknown>();
  private events: SyncEventRecord[] = [];

  async putEntity<TData = Record<string, unknown>>(
    entity: StoredEntity<TData>
  ): Promise<void> {
    this.entities.set(entity.key, structuredClone(entity) as StoredEntity);
  }

  async putEntitiesBulk(entities: StoredEntity[]): Promise<void> {
    for (const entity of entities) {
      this.entities.set(entity.key, structuredClone(entity));
    }
  }

  async getEntity<TData = Record<string, unknown>>(
    entityType: string,
    entityId: string
  ): Promise<StoredEntity<TData> | undefined> {
    const found = this.entities.get(`${entityType}:${entityId}`);
    return found ? (structuredClone(found) as StoredEntity<TData>) : undefined;
  }

  async getEntitiesByType<TData = Record<string, unknown>>(
    entityType: string
  ): Promise<StoredEntity<TData>[]> {
    const out: StoredEntity<TData>[] = [];
    for (const val of this.entities.values()) {
      if (val.entityType === entityType) {
        out.push(structuredClone(val) as StoredEntity<TData>);
      }
    }
    return out;
  }

  async deleteEntity(entityType: string, entityId: string): Promise<void> {
    this.entities.delete(`${entityType}:${entityId}`);
  }

  async clearEntities(entityType?: string): Promise<void> {
    if (!entityType) {
      this.entities.clear();
      return;
    }
    for (const [k, v] of this.entities.entries()) {
      if (v.entityType === entityType) this.entities.delete(k);
    }
  }

  async putOperation(operation: SyncOperation): Promise<void> {
    this.operations.set(operation.operationId, structuredClone(operation));
  }

  async getOperation(operationId: string): Promise<SyncOperation | undefined> {
    const found = this.operations.get(operationId);
    return found ? structuredClone(found) : undefined;
  }

  async getAllOperations(): Promise<SyncOperation[]> {
    return Array.from(this.operations.values())
      .map((op) => structuredClone(op))
      .sort((a, b) => a.sequence - b.sequence);
  }

  async getOperationsByStatus(statuses: OperationStatus[]): Promise<SyncOperation[]> {
    const set = new Set(statuses);
    return (await this.getAllOperations()).filter((op) => set.has(op.status));
  }

  async updateOperation(
    operationId: string,
    patch: Partial<SyncOperation>
  ): Promise<SyncOperation | undefined> {
    const existing = this.operations.get(operationId);
    if (!existing) return undefined;
    const updated: SyncOperation = { ...existing, ...patch };
    this.operations.set(operationId, structuredClone(updated));
    return structuredClone(updated);
  }

  async deleteOperation(operationId: string): Promise<void> {
    this.operations.delete(operationId);
  }

  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    const val = this.metadata.get(key);
    return val === undefined ? undefined : (structuredClone(val) as T);
  }

  async setMeta<T = unknown>(key: string, value: T): Promise<void> {
    this.metadata.set(key, structuredClone(value));
  }

  async appendEvent(event: SyncEventRecord): Promise<void> {
    this.events.push(structuredClone(event));
    if (this.events.length > 500) {
      this.events = this.events.slice(-500);
    }
  }

  async getRecentEvents(limit = 100): Promise<SyncEventRecord[]> {
    return this.events
      .slice(-limit)
      .reverse()
      .map((e) => structuredClone(e));
  }
}
