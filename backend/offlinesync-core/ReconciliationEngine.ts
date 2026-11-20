import type { RemoteChange, SyncMetadataRecord } from '../../packages/offlinesync-types';
import type { DocumentCollection, DocumentStore } from '../persistence/DocumentStore';

export interface ChangeLogDocument extends RemoteChange {
  changeId: string;
  appId: string;
  [key: string]: unknown;
}

const APP_CURSOR_PREFIX = 'app_cursor:';

/**
 * App-Scoped Monotonic Cursor & Incremental Change-Log Engine.
 *
 * Guarantees (within single-process DocumentStore):
 * 1. Cursor allocation and change-log insertion execute together inside `store.runTransaction(...)`
 *    backed by a unique `(appId, cursor)` index so duplicate cursor numbers or lost entries
 *    cannot occur.
 * 2. Cursors are strictly app-scoped (`app_cursor:<appId>`), preventing cross-app leakage.
 * 3. Pagination slices the raw ordered changelog window `(sinceCursor, ...]` of size `limit`
 *    BEFORE compacting duplicate entity changes within that slice. `updatedCursor` is set
 *    strictly to the last raw entry included in the slice so compaction never skips changes.
 * 4. Entity-type-filtered pulls never advance `updatedCursor` past unmatched records of other
 *    entity types: `updatedCursor` advances only to the highest cursor actually returned in
 *    the filtered page (or stays at `sinceCursor` if none matched), while `latestAppCursor`
 *    is reported separately.
 */
export class ReconciliationEngine {
  private readonly store: DocumentStore;
  private readonly changeLogCol: DocumentCollection<ChangeLogDocument>;
  private readonly metaCol: DocumentCollection<SyncMetadataRecord & Record<string, unknown>>;

  constructor(
    store: DocumentStore,
    changeLogCol: DocumentCollection<ChangeLogDocument>,
    metaCol: DocumentCollection<SyncMetadataRecord & Record<string, unknown>>
  ) {
    this.store = store;
    this.changeLogCol = changeLogCol;
    this.metaCol = metaCol;
  }

  getAppCursor(appId: string): number {
    const rec = this.metaCol.findById(`${APP_CURSOR_PREFIX}${appId}`);
    return typeof rec?.value === 'number' && Number.isInteger(rec.value) && rec.value >= 0
      ? rec.value
      : 0;
  }

  /**
   * Returns highest cursor across all apps (for global monitoring display).
   */
  getCurrentCursor(appId?: string): number {
    if (appId) return this.getAppCursor(appId);
    const all = this.metaCol.find((doc) => doc.key.startsWith(APP_CURSOR_PREFIX));
    return all.reduce((max, rec) => {
      const val = typeof rec.value === 'number' ? rec.value : 0;
      return Math.max(max, val);
    }, 0);
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
    return this.store.runTransaction(() => {
      const nextCursor = this.getAppCursor(params.appId) + 1;
      const now = new Date().toISOString();

      this.metaCol.upsertOne({
        key: `${APP_CURSOR_PREFIX}${params.appId}`,
        value: nextCursor,
        updatedAt: now,
      });

      const doc: ChangeLogDocument = {
        changeId: `chg-${params.appId}-${nextCursor}`,
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

      // Enforces unique (appId, cursor) index
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
    });
  }

  /**
   * Pulls incremental changes strictly newer than `sinceCursor` for `appId`.
   * Pagination never skips entries during concurrent insertions or within-page compaction.
   */
  pullChanges(params: {
    appId: string;
    sinceCursor: number;
    entityTypes?: string[];
    limit?: number;
  }): {
    changes: RemoteChange[];
    updatedCursor: number;
    latestAppCursor: number;
    hasMore: boolean;
  } {
    const sinceCursor = Math.max(0, Math.floor(params.sinceCursor));
    const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 100)));
    const isFiltered = Boolean(params.entityTypes && params.entityTypes.length > 0);
    const entitySet = isFiltered ? new Set(params.entityTypes!) : null;
    const latestAppCursor = this.getAppCursor(params.appId);

    const matching = this.changeLogCol
      .find((doc) => {
        if (doc.appId !== params.appId) return false;
        if (doc.cursor <= sinceCursor) return false;
        if (entitySet && !entitySet.has(doc.entityType)) return false;
        return true;
      })
      .sort((a, b) => a.cursor - b.cursor);

    const hasMore = matching.length > limit;
    // Slice BEFORE compaction so `updatedCursor` reflects the exact raw page boundary
    const pageSlice = matching.slice(0, limit);

    // Compact duplicate updates to the same entity ONLY within this already-bounded page
    const latestByEntity = new Map<string, ChangeLogDocument>();
    for (const item of pageSlice) {
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

    // Cursor advancement rule:
    // - If pageSlice has entries, advance to the exact last raw entry inspected in pageSlice.
    // - If pageSlice is empty and pull was UNFILTERED, advance to latestAppCursor (safe because
    //   no unseen entries exist for this app up to latestAppCursor).
    // - If pageSlice is empty and pull was ENTITY-FILTERED, stay at sinceCursor so we never
    //   skip unseen records belonging to other entity types!
    const updatedCursor =
      pageSlice.length > 0
        ? pageSlice[pageSlice.length - 1].cursor
        : isFiltered
        ? sinceCursor
        : Math.max(sinceCursor, latestAppCursor);

    return {
      changes: compacted,
      updatedCursor,
      latestAppCursor,
      hasMore,
    };
  }
}
