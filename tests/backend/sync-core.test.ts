import { describe, expect, it } from 'vitest';
import { createBackendApp } from '../../backend/api/createApp';
import { OFFLINESHOP_APP_ID } from '../../backend/shop-adapter/ShopBusinessAdapter';
import type { OrderDocument } from '../../backend/shop-adapter/types';
import type { SyncOperation } from '../../packages/offlinesync-types';

function makeOp(partial: Partial<SyncOperation>): SyncOperation {
  return {
    operationId: partial.operationId ?? `op-${Math.random().toString(36).slice(2)}`,
    deviceId: partial.deviceId ?? 'dev-unit-1',
    appId: partial.appId ?? OFFLINESHOP_APP_ID,
    entityType: partial.entityType ?? 'cart',
    entityId: partial.entityId ?? 'cart-unit',
    operationType: partial.operationType ?? 'CART_ITEM_ADD',
    sequence: partial.sequence ?? 1,
    baseVersion: partial.baseVersion ?? 0,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    payload: partial.payload ?? { productId: 'P101', delta: 1 },
    status: 'PENDING',
    retryCount: 0,
  };
}

describe('OfflineSync Backend Core & Shop Adapter (Unit Tests)', () => {
  it('registers devices, processes push operations, and pulls only incremental changes', () => {
    const { core } = createBackendApp({ persistPath: null });

    const reg = core.registerDevice({
      deviceId: 'dev-alpha',
      deviceName: 'Test Pixel',
      appId: OFFLINESHOP_APP_ID,
    });
    expect(reg.device.deviceId).toBe('dev-alpha');
    expect(reg.currentCursor).toBeGreaterThan(0);

    // Initial full pull from cursor 0 retrieves seeded products & addresses
    const initialPull = core.pull({
      deviceId: 'dev-alpha',
      appId: OFFLINESHOP_APP_ID,
      lastCursor: 0,
    });
    expect(initialPull.changes.length).toBeGreaterThanOrEqual(6);

    // Second pull from updatedCursor returns ZERO redundant changes
    const incrementalPull = core.pull({
      deviceId: 'dev-alpha',
      appId: OFFLINESHOP_APP_ID,
      lastCursor: initialPull.updatedCursor,
    });
    expect(incrementalPull.changes).toHaveLength(0);

    // Push a cart mutation and verify incremental pull returns ONLY the new cart change
    const pushRes = core.push({
      deviceId: 'dev-alpha',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-1',
      lastCursor: incrementalPull.updatedCursor,
      operations: [makeOp({ deviceId: 'dev-alpha', payload: { productId: 'P101', delta: 2 } })],
    });
    expect(pushRes.acknowledgedIds).toHaveLength(1);

    const deltaPull = core.pull({
      deviceId: 'dev-alpha',
      appId: OFFLINESHOP_APP_ID,
      lastCursor: incrementalPull.updatedCursor,
    });
    expect(deltaPull.changes).toHaveLength(1);
    expect(deltaPull.changes[0].entityType).toBe('cart');
  });

  it('prevents duplicate processing via unique operationId and clientOrderId idempotency', () => {
    const { core, shopAdapter } = createBackendApp({ persistPath: null });
    core.registerDevice({
      deviceId: 'dev-unit-1',
      deviceName: 'Unit Device 1',
      appId: OFFLINESHOP_APP_ID,
    });
    const initialStock = shopAdapter.productsCol.findById('P101')!.stock;

    const orderOp = makeOp({
      operationId: 'op-order-idempotent-1',
      deviceId: 'dev-unit-1',
      entityType: 'order',
      entityId: 'CLI-IDEM-001',
      operationType: 'ORDER_CREATE',
      payload: {
        clientOrderId: 'CLI-IDEM-001',
        deliveryAddressId: 'ADDR-HOME',
        items: [{ productId: 'P101', name: 'Milled 65 Wireless Keyboard', quantity: 2, priceAtCheckout: 249 }],
      },
    });

    const first = core.push({
      deviceId: 'dev-unit-1',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's1',
      lastCursor: 0,
      operations: [orderOp],
    });
    expect(first.acknowledgedIds).toEqual(['op-order-idempotent-1']);

    // Re-send exact same operationId
    const second = core.push({
      deviceId: 'dev-unit-1',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's2',
      lastCursor: 0,
      operations: [orderOp],
    });
    expect(second.duplicateIds).toEqual(['op-order-idempotent-1']);

    // Re-send DIFFERENT operationId but SAME clientOrderId -> still blocked by order idempotency index
    const third = core.push({
      deviceId: 'dev-unit-1',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's3',
      lastCursor: 0,
      operations: [{ ...orderOp, operationId: 'op-order-different-uuid-2' }],
    });
    expect(third.outcomes[0].status).toBe('DUPLICATE');

    // Stock decremented exactly once and only one order exists
    expect(shopAdapter.listOrders()).toHaveLength(1);
    expect(shopAdapter.productsCol.findById('P101')!.stock).toBe(initialStock - 2);
  });

  it('enforces server-authoritative inventory and detects/resolves concurrent cart conflicts', () => {
    const { core, shopAdapter } = createBackendApp({ persistPath: null });
    core.registerDevice({ deviceId: 'dev-rogue', deviceName: 'Rogue', appId: OFFLINESHOP_APP_ID });
    core.registerDevice({ deviceId: 'dev-A', deviceName: 'Device A', appId: OFFLINESHOP_APP_ID });
    core.registerDevice({ deviceId: 'dev-B', deviceName: 'Device B', appId: OFFLINESHOP_APP_ID });

    // 1. Client attempts to overwrite authoritative product stock -> rejected with SERVER_AUTHORITATIVE
    const stockTamper = core.push({
      deviceId: 'dev-rogue',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's-tamper',
      lastCursor: 0,
      operations: [
        makeOp({
          deviceId: 'dev-rogue',
          entityType: 'product',
          entityId: 'P101',
          operationType: 'PRODUCT_UPDATE',
          payload: { stock: 9999, price: 1 },
        }),
      ],
    });
    expect(stockTamper.conflicts).toHaveLength(1);
    expect(stockTamper.conflicts[0].resolutionPolicy).toBe('SERVER_AUTHORITATIVE');
    expect(shopAdapter.productsCol.findById('P101')!.price).toBe(249);

    // 2. Concurrent absolute cart edit -> MANUAL_RESOLUTION conflict -> resolved manually
    core.push({
      deviceId: 'dev-A',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's-a',
      lastCursor: 0,
      operations: [
        makeOp({
          deviceId: 'dev-A',
          entityId: 'shared-c',
          operationType: 'CART_ITEM_SET_QTY',
          baseVersion: 0,
          payload: { productId: 'P102', quantity: 1 },
        }),
      ],
    });

    const conflictPush = core.push({
      deviceId: 'dev-B',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's-b',
      lastCursor: 0,
      operations: [
        makeOp({
          deviceId: 'dev-B',
          entityId: 'shared-c',
          operationType: 'CART_ITEM_SET_QTY',
          baseVersion: 0, // Stale!
          payload: { productId: 'P102', quantity: 4 },
        }),
      ],
    });

    expect(conflictPush.conflicts).toHaveLength(1);
    const conflict = conflictPush.conflicts[0];
    expect(conflict.resolutionStatus).toBe('OPEN');

    const resolved = core.resolveConflict(conflict.conflictId, {
      resolutionChoice: 'KEEP_SERVER',
      actor: 'qa-engineer',
      note: 'Retain device A baseline quantity',
    });
    expect(resolved?.conflict.resolutionStatus).toBe('RESOLVED_MANUAL');
    expect(resolved?.conflict.history.length).toBeGreaterThanOrEqual(2);
  });

  it('flags offline orders with REQUIRES_ACTION when server price or stock changes', () => {
    const { core, shopAdapter } = createBackendApp({ persistPath: null });
    core.registerDevice({
      deviceId: 'dev-offline-buyer',
      deviceName: 'Offline Buyer',
      appId: OFFLINESHOP_APP_ID,
    });

    // Server increases price of P103 from $94 to $120 while client was offline
    shopAdapter.updateProductAuthoritative('P103', { price: 120 });

    const res = core.push({
      deviceId: 'dev-offline-buyer',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 's-price-drift',
      lastCursor: 0,
      operations: [
        makeOp({
          deviceId: 'dev-offline-buyer',
          entityType: 'order',
          entityId: 'CLI-DRIFT-1',
          operationType: 'ORDER_CREATE',
          payload: {
            clientOrderId: 'CLI-DRIFT-1',
            deliveryAddressId: 'ADDR-HOME',
            items: [{ productId: 'P103', name: 'Kuro Stoneware Carafe', quantity: 1, priceAtCheckout: 94 }],
          },
        }),
      ],
    });

    expect(res.outcomes[0].status).toBe('REQUIRES_ACTION');
    const savedOrder = res.outcomes[0].serverData as unknown as OrderDocument;
    expect(savedOrder.status).toBe('REQUIRES_ACTION');
    expect(savedOrder.authoritativeTotal).toBe(120);
    expect(savedOrder.discrepancies[0].type).toBe('PRICE_CHANGED');
  });
});
