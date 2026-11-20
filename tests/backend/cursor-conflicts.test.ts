import { describe, expect, it } from 'vitest';
import { createBackendApp } from '../../backend/api/createApp';
import { ConflictResolutionError } from '../../backend/offlinesync-core/ConflictManager';
import {
  type AdapterOperationContext,
  type BusinessAdapter,
} from '../../backend/offlinesync-core/SyncCoreEngine';
import { OFFLINESHOP_APP_ID } from '../../backend/shop-adapter/ShopBusinessAdapter';
import type { OperationOutcome, SyncOperation } from '../../packages/offlinesync-types';

function makeOp(partial: Partial<SyncOperation>): SyncOperation {
  return {
    operationId: partial.operationId ?? `op-${Math.random().toString(36).slice(2, 10)}`,
    deviceId: partial.deviceId ?? 'dev-1',
    appId: partial.appId ?? OFFLINESHOP_APP_ID,
    entityType: partial.entityType ?? 'cart',
    entityId: partial.entityId ?? 'cart-1',
    operationType: partial.operationType ?? 'CART_ITEM_ADD',
    sequence: partial.sequence ?? 1,
    baseVersion: partial.baseVersion ?? 0,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    payload: partial.payload ?? { productId: 'P101', delta: 1 },
    status: 'PENDING',
    retryCount: 0,
  };
}

describe('Phase B & F — Cursor Protocol, Pagination, App Scoping & Conflict Resolution', () => {
  it('allocates strictly monotonic unique cursors and never skips changes during paginated pulls with concurrent writes and compaction', () => {
    const { core } = createBackendApp({ persistPath: null });
    core.registerDevice({ deviceId: 'dev-puller', deviceName: 'Puller', appId: OFFLINESHOP_APP_ID });
    core.registerDevice({ deviceId: 'dev-writer', deviceName: 'Writer', appId: OFFLINESHOP_APP_ID });

    // Pull initial seeded catalog to establish baseline cursor
    const baseline = core.pull({
      deviceId: 'dev-puller',
      appId: OFFLINESHOP_APP_ID,
      lastCursor: 0,
      limit: 100,
    });
    let cursor = baseline.updatedCursor;

    // Writer pushes 4 operations updating 2 entities multiple times:
    // cart-X (c+1), cart-Y (c+2), cart-X again (c+3), cart-Z (c+4)
    core.push({
      deviceId: 'dev-writer',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'w1',
      lastCursor: 0,
      operations: [
        makeOp({ deviceId: 'dev-writer', entityId: 'cart-X', payload: { productId: 'P101', delta: 1 } }),
        makeOp({ deviceId: 'dev-writer', entityId: 'cart-Y', payload: { productId: 'P102', delta: 1 } }),
        makeOp({ deviceId: 'dev-writer', entityId: 'cart-X', payload: { productId: 'P101', delta: 2 } }),
        makeOp({ deviceId: 'dev-writer', entityId: 'cart-Z', payload: { productId: 'P103', delta: 1 } }),
      ],
    });

    // Pull page 1 with limit=2 -> must slice raw window [c+1, c+2] BEFORE compaction
    const page1 = core.pull({
      deviceId: 'dev-puller',
      appId: OFFLINESHOP_APP_ID,
      lastCursor: cursor,
      limit: 2,
    });
    expect(page1.changes.map((c) => c.entityId)).toEqual(['cart-X', 'cart-Y']);
    expect(page1.updatedCursor).toBe(cursor + 2);
    expect(page1.hasMore).toBe(true);

    // Concurrent write arrives WHILE puller is mid-pagination! (c+5)
    core.push({
      deviceId: 'dev-writer',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'w2',
      lastCursor: 0,
      operations: [
        makeOp({ deviceId: 'dev-writer', entityId: 'cart-CONCURRENT', payload: { productId: 'P104', delta: 1 } }),
      ],
    });

    // Pull remaining pages starting from page1.updatedCursor
    cursor = page1.updatedCursor;
    const seen = new Map<string, number>();
    for (const c of page1.changes) seen.set(c.entityId, c.version);

    let pages = 0;
    let hasMore = page1.hasMore;
    while (hasMore && pages < 20) {
      pages += 1;
      const next = core.pull({
        deviceId: 'dev-puller',
        appId: OFFLINESHOP_APP_ID,
        lastCursor: cursor,
        limit: 2,
      });
      for (const c of next.changes) {
        expect(c.cursor).toBeGreaterThan(cursor);
        seen.set(c.entityId, c.version);
      }
      cursor = next.updatedCursor;
      hasMore = next.hasMore;
    }

    // Puller must have received EVERY entity including the latest version of cart-X AND cart-CONCURRENT
    expect(seen.get('cart-X')).toBe(2);
    expect(seen.get('cart-Y')).toBe(1);
    expect(seen.get('cart-Z')).toBe(1);
    expect(seen.get('cart-CONCURRENT')).toBe(1);
    expect(cursor).toBe(baseline.updatedCursor + 5);
  });

  it('prevents entity-type-filtered pulls from skipping unseen entity types and isolates cursors per appId', () => {
    const { core } = createBackendApp({ persistPath: null });
    core.registerDevice({ deviceId: 'dev-filt', deviceName: 'Filter', appId: OFFLINESHOP_APP_ID });

    // Record a cart change followed by a wishlist change
    const beforeCursor = core.reconciliation.getCurrentCursor(OFFLINESHOP_APP_ID);
    core.push({
      deviceId: 'dev-filt',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'f1',
      lastCursor: 0,
      operations: [
        makeOp({
          deviceId: 'dev-filt',
          entityType: 'cart',
          entityId: 'cart-f',
          operationType: 'CART_ITEM_ADD',
          payload: { productId: 'P101', delta: 1 },
        }),
        makeOp({
          deviceId: 'dev-filt',
          entityType: 'wishlist',
          entityId: 'wish-f',
          operationType: 'WISHLIST_ADD',
          payload: { productId: 'P101' },
        }),
      ],
    });

    // Pull filtered for ONLY 'order' (which has 0 new entries) -> updatedCursor MUST stay at beforeCursor!
    const emptyFiltered = core.pull({
      deviceId: 'dev-filt',
      appId: OFFLINESHOP_APP_ID,
      lastCursor: beforeCursor,
      entityTypes: ['order'],
    });
    expect(emptyFiltered.changes).toHaveLength(0);
    expect(emptyFiltered.updatedCursor).toBe(beforeCursor);
    expect(emptyFiltered.latestAppCursor).toBe(beforeCursor + 2);

    // Pull filtered for ONLY 'cart' -> updatedCursor advances only to cart's cursor (beforeCursor + 1), NOT wishlist's!
    const cartOnly = core.pull({
      deviceId: 'dev-filt',
      appId: OFFLINESHOP_APP_ID,
      lastCursor: beforeCursor,
      entityTypes: ['cart'],
    });
    expect(cartOnly.changes).toHaveLength(1);
    expect(cartOnly.changes[0].entityType).toBe('cart');
    expect(cartOnly.updatedCursor).toBe(beforeCursor + 1);
    expect(cartOnly.latestAppCursor).toBe(beforeCursor + 2);

    // Register a second independent application adapter to verify app-scoped cursors
    const notesAdapter: BusinessAdapter = {
      appId: 'notes-app',
      supportedEntityTypes: ['note'],
      supportedOperationTypes: { note: ['NOTE_UPSERT'] },
      processOperation(op: SyncOperation, ctx: AdapterOperationContext): OperationOutcome {
        ctx.recordEntityChange({
          appId: 'notes-app',
          entityType: 'note',
          entityId: op.entityId,
          version: 1,
          changeType: 'UPSERT',
          data: op.payload,
        });
        return { operationId: op.operationId, status: 'ACKNOWLEDGED', serverVersion: 1 };
      },
      getCurrentEntityVersion: () => 1,
      applyManualConflictResolution: () => ({ operationFinalStatus: 'ACKNOWLEDGED' }),
    };
    core.registerAdapter(notesAdapter);
    core.registerDevice({ deviceId: 'dev-notes', deviceName: 'Notes', appId: 'notes-app' });

    const notePush = core.push({
      deviceId: 'dev-notes',
      appId: 'notes-app',
      sessionId: 'n1',
      lastCursor: 0,
      operations: [
        makeOp({
          deviceId: 'dev-notes',
          appId: 'notes-app',
          entityType: 'note',
          entityId: 'note-1',
          operationType: 'NOTE_UPSERT',
          payload: { text: 'Hello' },
        }),
      ],
    });
    expect(notePush.updatedCursor).toBe(1); // Own independent app cursor starting at 1!

    const notesPull = core.pull({
      deviceId: 'dev-notes',
      appId: 'notes-app',
      lastCursor: 0,
    });
    expect(notesPull.changes).toHaveLength(1);
    expect(notesPull.changes[0].entityType).toBe('note');
    // OfflineShop cursor was not affected by notes-app
    expect(core.reconciliation.getCurrentCursor(OFFLINESHOP_APP_ID)).toBe(beforeCursor + 2);
  });

  it('prevents blind overwrite of newer server state, blocks inconsistent double-resolution, supports idempotent replay, and reconciles clients', () => {
    const { core, shopAdapter } = createBackendApp({ persistPath: null });
    core.registerDevice({ deviceId: 'dev-A', deviceName: 'A', appId: OFFLINESHOP_APP_ID });
    core.registerDevice({ deviceId: 'dev-B', deviceName: 'B', appId: OFFLINESHOP_APP_ID });

    // Device A creates cart v1
    core.push({
      deviceId: 'dev-A',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's1',
      lastCursor: 0,
      operations: [
        makeOp({
          deviceId: 'dev-A',
          entityId: 'shared-cart-conf',
          operationType: 'CART_ITEM_SET_QTY',
          baseVersion: 0,
          payload: { productId: 'P101', quantity: 1 },
        }),
      ],
    });

    // Device B pushes stale baseVersion 0 -> OPEN conflict (remoteVersion = 1)
    const confRes = core.push({
      deviceId: 'dev-B',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's2',
      lastCursor: 0,
      operations: [
        makeOp({
          operationId: 'op-stale-b',
          deviceId: 'dev-B',
          entityId: 'shared-cart-conf',
          operationType: 'CART_ITEM_SET_QTY',
          baseVersion: 0,
          payload: { productId: 'P101', quantity: 5 },
        }),
      ],
    });
    expect(confRes.conflicts).toHaveLength(1);
    const conflict = confRes.conflicts[0];
    expect(conflict.remoteVersion).toBe(1);

    // BEFORE operator resolves conflict, Device A advances server state to v2!
    core.push({
      deviceId: 'dev-A',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's3',
      lastCursor: 0,
      operations: [
        makeOp({
          deviceId: 'dev-A',
          entityId: 'shared-cart-conf',
          operationType: 'CART_ITEM_SET_QTY',
          baseVersion: 1,
          payload: { productId: 'P101', quantity: 2 },
        }),
      ],
    });
    expect(shopAdapter.cartsCol.findById('shared-cart-conf')?.version).toBe(2);

    // 1. Blind resolution without matching expectedServerVersion MUST be rejected (STALE_CONFLICT_RESOLUTION 409)
    expect(() =>
      core.resolveConflict(conflict.conflictId, {
        resolutionChoice: 'APPLY_CLIENT',
        expectedServerVersion: 1,
        actor: 'admin',
      })
    ).toThrow(ConflictResolutionError);

    try {
      core.resolveConflict(conflict.conflictId, {
        resolutionChoice: 'APPLY_CLIENT',
        actor: 'admin',
      });
    } catch (err) {
      expect((err as ConflictResolutionError).code).toBe('STALE_CONFLICT_RESOLUTION');
      expect((err as ConflictResolutionError).statusCode).toBe(409);
    }

    // 2. Invalid CUSTOM manual payload (negative quantity) is rejected cleanly
    expect(() =>
      core.resolveConflict(conflict.conflictId, {
        resolutionChoice: 'CUSTOM',
        expectedServerVersion: 2,
        resolvedPayload: { productId: 'P101', quantity: -3 },
        actor: 'admin',
      })
    ).toThrow(ConflictResolutionError);

    // 3. Valid CUSTOM manual resolution acknowledging current server v2 succeeds and emits changelog!
    const cursorBeforeResolve = core.reconciliation.getCurrentCursor(OFFLINESHOP_APP_ID);
    const resolved = core.resolveConflict(conflict.conflictId, {
      resolutionChoice: 'CUSTOM',
      expectedServerVersion: 2,
      idempotencyKey: 'idem-res-1',
      resolvedPayload: { productId: 'P101', quantity: 4 },
      actor: 'admin',
      note: 'Merged to qty 4',
    });
    expect(resolved?.idempotentReplay).toBe(false);
    expect(resolved?.conflict.resolutionStatus).toBe('RESOLVED_MANUAL');
    expect(shopAdapter.cartsCol.findById('shared-cart-conf')?.items[0].quantity).toBe(4);
    expect(shopAdapter.cartsCol.findById('shared-cart-conf')?.version).toBe(3);

    // Linked operation status transitioned properly to ACKNOWLEDGED
    const linkedOp = core.idempotency.checkExisting('op-stale-b');
    expect(linkedOp?.status).toBe('ACKNOWLEDGED');

    // 4. Idempotent replay with same idempotencyKey returns cached conflict without bumping version again
    const replayed = core.resolveConflict(conflict.conflictId, {
      resolutionChoice: 'CUSTOM',
      expectedServerVersion: 2,
      idempotencyKey: 'idem-res-1',
      resolvedPayload: { productId: 'P101', quantity: 4 },
      actor: 'admin',
    });
    expect(replayed?.idempotentReplay).toBe(true);
    expect(shopAdapter.cartsCol.findById('shared-cart-conf')?.version).toBe(3);

    // 5. Inconsistent double-resolution attempt MUST fail with CONFLICT_ALREADY_RESOLVED (409)
    try {
      core.resolveConflict(conflict.conflictId, {
        resolutionChoice: 'KEEP_SERVER',
        actor: 'admin-2',
      });
      expect.unreachable('Should have rejected inconsistent double resolution');
    } catch (err) {
      expect((err as ConflictResolutionError).code).toBe('CONFLICT_ALREADY_RESOLVED');
      expect((err as ConflictResolutionError).statusCode).toBe(409);
    }

    // 6. Client B pulls since cursorBeforeResolve and reconciles directly to qty=4 (v3)
    const pullAfter = core.pull({
      deviceId: 'dev-B',
      appId: OFFLINESHOP_APP_ID,
      lastCursor: cursorBeforeResolve,
    });
    const reconciledCart = pullAfter.changes.find((c) => c.entityId === 'shared-cart-conf');
    expect(reconciledCart).toBeDefined();
    expect(reconciledCart?.version).toBe(3);
    expect((reconciledCart?.data as { items: Array<{ quantity: number }> }).items[0].quantity).toBe(4);
  });

  it('blocks APPLY_CLIENT on order conflicts so authoritative pricing/stock cannot be bypassed', () => {
    const { core, shopAdapter } = createBackendApp({ persistPath: null });
    core.registerDevice({ deviceId: 'dev-ord-conf', deviceName: 'Buyer', appId: OFFLINESHOP_APP_ID });

    shopAdapter.updateProductAuthoritative('P101', { price: 300 });
    const res = core.push({
      deviceId: 'dev-ord-conf',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's-ord',
      lastCursor: 0,
      operations: [
        makeOp({
          deviceId: 'dev-ord-conf',
          entityType: 'order',
          entityId: 'CLI-CONF-ORD-1',
          operationType: 'ORDER_CREATE',
          payload: {
            clientOrderId: 'CLI-CONF-ORD-1',
            deliveryAddressId: 'ADDR-HOME',
            items: [{ productId: 'P101', name: 'Keyboard', quantity: 1, priceAtCheckout: 249 }],
          },
        }),
      ],
    });
    const orderConflict = res.conflicts[0];
    expect(orderConflict).toBeDefined();

    try {
      core.resolveConflict(orderConflict.conflictId, {
        resolutionChoice: 'APPLY_CLIENT',
        actor: 'admin',
      });
      expect.unreachable('Should block APPLY_CLIENT on order conflict');
    } catch (err) {
      expect((err as ConflictResolutionError).code).toBe('AUTHORITATIVE_VALIDATION_REQUIRED');
    }
  });
});
