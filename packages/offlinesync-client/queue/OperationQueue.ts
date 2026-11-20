import type { OperationStatus, SyncOperation } from '../../offlinesync-types';
import type { SyncStorageAdapter } from '../storage/StorageAdapter';

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface EnqueueOperationInput<TPayload = Record<string, unknown>> {
  operationId?: string;
  deviceId: string;
  appId: string;
  entityType: string;
  entityId: string;
  operationType: string;
  baseVersion: number;
  payload: TPayload;
  dependsOn?: string[];
}

/**
 * Persistent FIFO operation queue backed by SyncStorageAdapter.
 * - Assigns globally unique operationIds and monotonic per-device sequence numbers.
 * - Preserves operations until the backend confirms their outcome.
 * - Recovers operations left in PROCESSING state after an interrupted sync or crash.
 * - Honors explicit operation dependencies (`dependsOn`).
 */
export class PersistentOperationQueue {
  private readonly storage: SyncStorageAdapter;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(
    storage: SyncStorageAdapter,
    options?: { maxRetries?: number; baseBackoffMs?: number }
  ) {
    this.storage = storage;
    this.maxRetries = options?.maxRetries ?? 5;
    this.baseBackoffMs = options?.baseBackoffMs ?? 1000;
  }

  async enqueue<TPayload = Record<string, unknown>>(
    input: EnqueueOperationInput<TPayload>
  ): Promise<SyncOperation<TPayload>> {
    const lastSeq = (await this.storage.getMeta<number>('lastSequence')) ?? 0;
    const nextSeq = lastSeq + 1;
    await this.storage.setMeta('lastSequence', nextSeq);

    const op: SyncOperation<TPayload> = {
      operationId: input.operationId ?? generateUuid(),
      deviceId: input.deviceId,
      appId: input.appId,
      entityType: input.entityType,
      entityId: input.entityId,
      operationType: input.operationType,
      sequence: nextSeq,
      baseVersion: input.baseVersion,
      createdAt: new Date().toISOString(),
      payload: input.payload,
      status: 'PENDING',
      retryCount: 0,
      dependsOn: input.dependsOn,
    };

    await this.storage.putOperation(op as SyncOperation);
    return op;
  }

  /**
   * Recover any operations stranded in PROCESSING state (e.g. browser closed
   * or network severed mid-flight) so they are safely re-attempted idempotently.
   */
  async recoverInterruptedOperations(): Promise<SyncOperation[]> {
    const stuck = await this.storage.getOperationsByStatus(['PROCESSING']);
    const recovered: SyncOperation[] = [];
    for (const op of stuck) {
      const updated = await this.storage.updateOperation(op.operationId, {
        status: 'PENDING',
        errorMessage: 'Recovered from interrupted synchronization',
      });
      if (updated) recovered.push(updated);
    }
    return recovered;
  }

  /**
   * Select a batch of eligible PENDING operations whose retry backoff window has elapsed
   * and whose explicit dependencies have been acknowledged.
   */
  async getNextBatch(batchSize: number, now = Date.now()): Promise<SyncOperation[]> {
    const all = await this.storage.getAllOperations();
    const ackedIds = new Set(
      all.filter((op) => op.status === 'ACKNOWLEDGED').map((op) => op.operationId)
    );

    const eligible: SyncOperation[] = [];
    for (const op of all) {
      if (op.status !== 'PENDING') continue;
      if (op.nextRetryAt && new Date(op.nextRetryAt).getTime() > now) continue;
      if (op.dependsOn && op.dependsOn.some((depId) => !ackedIds.has(depId))) {
        continue;
      }
      eligible.push(op);
      if (eligible.length >= batchSize) break;
    }
    return eligible;
  }

  async markProcessing(operationIds: string[]): Promise<void> {
    const nowIso = new Date().toISOString();
    for (const id of operationIds) {
      await this.storage.updateOperation(id, {
        status: 'PROCESSING',
        lastAttemptAt: nowIso,
      });
    }
  }

  async markAcknowledged(
    operationId: string,
    serverVersion?: number,
    resultData?: Record<string, unknown>
  ): Promise<SyncOperation | undefined> {
    return this.storage.updateOperation(operationId, {
      status: 'ACKNOWLEDGED',
      serverVersion,
      resultData,
      errorMessage: undefined,
      nextRetryAt: undefined,
    });
  }

  async markRequiresAction(
    operationId: string,
    reason: string,
    conflictId?: string,
    resultData?: Record<string, unknown>
  ): Promise<SyncOperation | undefined> {
    return this.storage.updateOperation(operationId, {
      status: 'REQUIRES_ACTION',
      errorMessage: reason,
      conflictId,
      resultData,
    });
  }

  async markPermanentFailure(
    operationId: string,
    reason: string
  ): Promise<SyncOperation | undefined> {
    return this.storage.updateOperation(operationId, {
      status: 'FAILED',
      errorMessage: reason,
    });
  }

  /**
   * Schedule a retry with exponential backoff up to `maxRetries`.
   * Prevents endless retry loops by transitioning to FAILED once exhausted.
   */
  async scheduleRetry(
    operationId: string,
    reason: string
  ): Promise<{ operation?: SyncOperation; exhausted: boolean; backoffMs: number }> {
    const op = await this.storage.getOperation(operationId);
    if (!op) return { exhausted: true, backoffMs: 0 };

    const nextRetryCount = op.retryCount + 1;
    if (nextRetryCount > this.maxRetries) {
      const failed = await this.storage.updateOperation(operationId, {
        status: 'FAILED',
        retryCount: nextRetryCount,
        errorMessage: `Max retries (${this.maxRetries}) exceeded: ${reason}`,
      });
      return { operation: failed, exhausted: true, backoffMs: 0 };
    }

    // Exponential backoff with deterministic bounded cap (30s)
    const backoffMs = Math.min(this.baseBackoffMs * Math.pow(2, nextRetryCount - 1), 30000);
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();

    const updated = await this.storage.updateOperation(operationId, {
      status: 'PENDING',
      retryCount: nextRetryCount,
      nextRetryAt,
      errorMessage: reason,
    });
    return { operation: updated, exhausted: false, backoffMs };
  }

  async getPendingCount(): Promise<number> {
    const ops = await this.storage.getOperationsByStatus(['PENDING', 'PROCESSING']);
    return ops.length;
  }

  async getByStatus(statuses: OperationStatus[]): Promise<SyncOperation[]> {
    return this.storage.getOperationsByStatus(statuses);
  }

  async getAll(): Promise<SyncOperation[]> {
    return this.storage.getAllOperations();
  }

  async removeAcknowledged(olderThanMs?: number): Promise<number> {
    const acked = await this.storage.getOperationsByStatus(['ACKNOWLEDGED']);
    const cutoff = olderThanMs ? Date.now() - olderThanMs : Number.MAX_SAFE_INTEGER;
    let removed = 0;
    for (const op of acked) {
      if (new Date(op.createdAt).getTime() <= cutoff) {
        await this.storage.deleteOperation(op.operationId);
        removed += 1;
      }
    }
    return removed;
  }
}
