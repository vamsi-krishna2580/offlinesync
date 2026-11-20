import type { OperationOutcome, SyncOperation } from '../../packages/offlinesync-types';
import type { DocumentCollection } from '../persistence/DocumentStore';

export interface StoredProcessedOperation extends SyncOperation {
  processedAt: string;
  serverOutcome: OperationOutcome;
  duplicateHits: number;
  [key: string]: unknown;
}

/**
 * Idempotency Service backed by a unique index on `operationId`.
 * Guarantees that duplicate operation deliveries (e.g. after timeout or interrupted sync)
 * are detected safely and never cause duplicate business mutations.
 */
export class IdempotencyService {
  private readonly opsCol: DocumentCollection<StoredProcessedOperation>;

  constructor(opsCol: DocumentCollection<StoredProcessedOperation>) {
    this.opsCol = opsCol;
  }

  checkExisting(operationId: string): StoredProcessedOperation | null {
    return this.opsCol.findById(operationId);
  }

  recordDuplicateHit(operationId: string): StoredProcessedOperation | null {
    const existing = this.opsCol.findById(operationId);
    if (!existing) return null;
    const updated: StoredProcessedOperation = {
      ...existing,
      duplicateHits: (existing.duplicateHits ?? 0) + 1,
    };
    this.opsCol.upsertOne(updated);
    return updated;
  }

  recordProcessed(
    operation: SyncOperation,
    outcome: OperationOutcome
  ): StoredProcessedOperation {
    const statusMap: Record<OperationOutcome['status'], SyncOperation['status']> = {
      ACKNOWLEDGED: 'ACKNOWLEDGED',
      DUPLICATE: 'ACKNOWLEDGED',
      CONFLICT: 'REQUIRES_ACTION',
      REQUIRES_ACTION: 'REQUIRES_ACTION',
      REJECTED: 'FAILED',
    };

    const record: StoredProcessedOperation = {
      ...operation,
      status: statusMap[outcome.status],
      serverVersion: outcome.serverVersion,
      conflictId: outcome.conflict?.conflictId,
      errorMessage: outcome.reason,
      resultData: outcome.serverData,
      processedAt: new Date().toISOString(),
      serverOutcome: outcome,
      duplicateHits: 0,
    };

    this.opsCol.upsertOne(record);
    return record;
  }

  updateOperationStatus(
    operationId: string,
    status: SyncOperation['status'],
    note?: string
  ): StoredProcessedOperation | null {
    const existing = this.opsCol.findById(operationId);
    if (!existing) return null;
    const updated: StoredProcessedOperation = {
      ...existing,
      status,
      errorMessage: note ?? existing.errorMessage,
    };
    this.opsCol.upsertOne(updated);
    return updated;
  }

  listOperations(filter?: {
    deviceId?: string;
    status?: string;
    entityType?: string;
    limit?: number;
  }): StoredProcessedOperation[] {
    const all = this.opsCol
      .find((doc) => {
        if (filter?.deviceId && doc.deviceId !== filter.deviceId) return false;
        if (filter?.status && filter.status !== 'ALL' && doc.status !== filter.status) {
          return false;
        }
        if (filter?.entityType && doc.entityType !== filter.entityType) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return filter?.limit ? all.slice(0, filter.limit) : all;
  }

  totalDuplicatesPrevented(): number {
    return this.opsCol
      .find()
      .reduce((acc, op) => acc + (op.duplicateHits ?? 0), 0);
  }
}
