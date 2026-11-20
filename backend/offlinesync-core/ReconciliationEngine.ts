import type { RemoteChange, SyncMetadataRecord } from '../../packages/offlinesync-types';
import type { DocumentCollection } from '../persistence/DocumentStore';

export interface ChangeLogDocument extends RemoteChange {
  changeId: string;
  appId: string;
  [key: string]: unknown;
}

/**
 * Cursor-based Incremental Change Log & Reconciliation Engine.
 * Assigns strictly monotonic server cursors to every authoritative entity mutation
 * so clients pull only incremental changes since their last checkpoint.
 */
export class ReconciliationEngine {
  private readonly changeLogCol: DocumentCollection<ChangeLogDocument>;
  private readonly metaCol: DocumentCollection<SyncMetadataRecord & Record<string, unknown>>;

  constructor(
    changeLogCol: DocumentCollection<ChangeLogDocument>,
    metaCol: DocumentCollection<SyncMetadataRecord & Record<string, unknown>>
  ) {
    this.changeLogCol = changeLogCol;
    this.metaCol = metaCol;
  }

  getCurrentCursor(): number {
    const rec = this.metaCol.findById('global_sync_cursor');
    return typeof rec?.value === 'number' ? rec.value : 0;
  }

  recordChange(params: {
    appId: string;
    entityType: string;
    entityId: string;
    version: number;
    changeType: 'UPSERT' | 'DELETE';
    data: Record<string, unknown> | null;
    sourceDeviceId?: string;
  }): RemoteChange {
    const nextCursor = this.getCurrentCursor() + 1;
    const now = new Date().toISOString();

    this.metaCol.upsertOne({
      key: 'global_sync_cursor',
      value: nextCursor,
      updatedAt: now,
    });

    const doc: ChangeLogDocument = {
      changeId: `chg-${nextCursor}`,
      appId: params.appId,
      cursor: nextCursor,
      entityType: params.entityType,
      entityId: params.entityId,
      version: params.version,
      changeType: params.changeType,
      data: params.data,
      updatedAt: now,
      sourceDeviceId: params.sourceDeviceId,
    };

    this.changeLogCol.insertOne(doc);

    return {
      cursor: doc.cursor,
      entityType: doc.entityType,
      entityId: doc.entityId,
      version: doc.version,
      changeType: doc.changeType,
      data: doc.data,
      updatedAt: doc.updatedAt,
      sourceDeviceId: doc.sourceDeviceId,
    };
  }

  /**
   * Pull incremental changes strictly newer than `sinceCursor`, compacted to the latest
   * revision per entity within the page while preserving cursor advancement.
   */
  pullChanges(params: {
    appId: string;
    sinceCursor: number;
    entityTypes?: string[];
    limit?: number;
  }): { changes: RemoteChange[]; updatedCursor: number; hasMore: boolean } {
    const limit = params.limit ?? 100;
    const entitySet =
      params.entityTypes && params.entityTypes.length > 0
        ? new Set(params.entityTypes)
        : null;

    const matching = this.changeLogCol
      .find((doc) => {
        if (doc.appId !== params.appId) return false;
        if (doc.cursor <= params.sinceCursor) return false;
        if (entitySet && !entitySet.has(doc.entityType)) return false;
        return true;
      })
      .sort((a, b) => a.cursor - b.cursor);

    const hasMore = matching.length > limit;
    const slice = matching.slice(0, limit);

    // Compact duplicate entity updates in the same page to the latest revision
    const latestByEntity = new Map<string, ChangeLogDocument>();
    for (const item of slice) {
      latestByEntity.set(`${item.entityType}:${item.entityId}`, item);
    }

    const compacted = Array.from(latestByEntity.values())
      .sort((a, b) => a.cursor - b.cursor)
      .map((doc) => ({
        cursor: doc.cursor,
        entityType: doc.entityType,
        entityId: doc.entityId,
        version: doc.version,
        changeType: doc.changeType,
        data: doc.data,
        updatedAt: doc.updatedAt,
        sourceDeviceId: doc.sourceDeviceId,
      }));

    const updatedCursor =
      slice.length > 0
        ? slice[slice.length - 1].cursor
        : Math.max(params.sinceCursor, this.getCurrentCursor());

    return { changes: compacted, updatedCursor, hasMore };
  }
}
