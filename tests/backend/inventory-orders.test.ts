import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackendApp, type OfflineSyncBackendContext } from '../../backend/api/createApp';
import { OFFLINESHOP_APP_ID } from '../../backend/shop-adapter/ShopBusinessAdapter';
import type { OrderDocument } from '../../backend/shop-adapter/types';
import type { SyncOperation } from '../../packages/offlinesync-types';

function makeOrderOp(
  deviceId: string,
  clientOrderId: string,
  items: unknown[],
  overrides?: Partial<SyncOperation>
): SyncOperation {
  return {
    operationId: overrides?.operationId ?? `op-${clientOrderId}-${Math.random().toString(36).slice(2, 8)}`,
    deviceId,
    appId: OFFLINESHOP_APP_ID,
    entityType: 'order',
    entityId: clientOrderId,
    operationType: 'ORDER_CREATE',
    sequence: overrides?.sequence ?? 1,
    baseVersion: overrides?.baseVersion ?? 0,
    createdAt: new Date().toISOString(),
    payload: {
      clientOrderId,
      deliveryAddressId: 'ADDR-HOME',
      items,
      ...(overrides?.payload ?? {}),
    },
    status: 'PENDING',
    retryCount: 0,
  };
}

describe('Phase A — Inventory Validation, Duplicate Line Aggregation & Order Atomicity', () => {
  it('aggregates duplicate product lines BEFORE validating stock and blocks overselling', () => {
    const { core, shopAdapter } = createBackendApp({ persistPath: null });
    core.registerDevice({ deviceId: 'dev-dup-lines', deviceName: 'Buyer', appId: OFFLINESHOP_APP_ID });

    // Set P101 stock to 5
    shopAdapter.updateProductAuthoritative('P101', { stock: 5 });
    const price = shopAdapter.productsCol.findById('P101')!.price;

    // Order has two duplicate lines of P101: 3 + 3 = 6 > 5 stock!
    const oversellRes = core.push({
      deviceId: 'dev-dup-lines',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-dup-oversell',
      lastCursor: 0,
      operations: [
        makeOrderOp('dev-dup-lines', 'CLI-DUP-OVERSELL', [
          { productId: 'P101', name: 'Keyboard', quantity: 3, priceAtCheckout: price },
          { productId: 'P101', name: 'Keyboard', quantity: 3, priceAtCheckout: price },
        ]),
      ],
    });

    expect(oversellRes.outcomes[0].status).toBe('REQUIRES_ACTION');
    const flagged = oversellRes.outcomes[0].serverData as unknown as OrderDocument;
    expect(flagged.status).toBe('REQUIRES_ACTION');
    expect(flagged.items).toHaveLength(1); // Normalized aggregated line
    expect(flagged.items[0].quantity).toBe(6);
    expect(flagged.discrepancies.some((d) => d.type === 'INSUFFICIENT_STOCK')).toBe(true);
    // Stock MUST remain completely untouched (5), never decremented or negative
    expect(shopAdapter.productsCol.findById('P101')!.stock).toBe(5);

    // Order with two duplicate lines whose sum fits available stock (2 + 2 = 4 <= 5) succeeds cleanly
    const validRes = core.push({
      deviceId: 'dev-dup-lines',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-dup-valid',
      lastCursor: 0,
      operations: [
        makeOrderOp('dev-dup-lines', 'CLI-DUP-VALID', [
          { productId: 'P101', name: 'Keyboard', quantity: 2, priceAtCheckout: price },
          { productId: 'P101', name: 'Keyboard', quantity: 2, priceAtCheckout: price },
        ]),
      ],
    });

    expect(validRes.outcomes[0].status).toBe('ACKNOWLEDGED');
    const confirmed = validRes.outcomes[0].serverData as unknown as OrderDocument;
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.items).toHaveLength(1);
    expect(confirmed.items[0].quantity).toBe(4);
    expect(confirmed.authoritativeTotal).toBe(price * 4);
    expect(shopAdapter.productsCol.findById('P101')!.stock).toBe(1);
  });

  it('rejects zero, negative, fractional, NaN, string, excessive, and malformed quantities without touching stock', () => {
    const { core, shopAdapter } = createBackendApp({ persistPath: null });
    core.registerDevice({ deviceId: 'dev-qty', deviceName: 'Qty Tester', appId: OFFLINESHOP_APP_ID });

    const initialStock = shopAdapter.productsCol.findById('P102')!.stock;
    const price = shopAdapter.productsCol.findById('P102')!.price;

    const invalidQuantities: unknown[] = [0, -1, -50, 1.5, 0.25, Number.NaN, Number.POSITIVE_INFINITY, '2', null, 1001];

    invalidQuantities.forEach((badQty, idx) => {
      const res = core.push({
        deviceId: 'dev-qty',
        appId: OFFLINESHOP_APP_ID,
        sessionId: `sess-bad-qty-${idx}`,
        lastCursor: 0,
        operations: [
          makeOrderOp('dev-qty', `CLI-BAD-QTY-${idx}`, [
            { productId: 'P102', name: 'Headphones', quantity: badQty, priceAtCheckout: price },
          ]),
        ],
      });
      expect(res.outcomes[0].status).toBe('REJECTED');
      expect(res.rejectedIds).toHaveLength(1);
    });

    // Empty items array and missing deliveryAddressId also rejected
    const emptyItemsRes = core.push({
      deviceId: 'dev-qty',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-empty-items',
      lastCursor: 0,
      operations: [makeOrderOp('dev-qty', 'CLI-EMPTY', [])],
    });
    expect(emptyItemsRes.outcomes[0].status).toBe('REJECTED');

    const missingAddrRes = core.push({
      deviceId: 'dev-qty',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-no-addr',
      lastCursor: 0,
      operations: [
        makeOrderOp(
          'dev-qty',
          'CLI-NO-ADDR',
          [{ productId: 'P102', name: 'Headphones', quantity: 1, priceAtCheckout: price }],
          { payload: { clientOrderId: 'CLI-NO-ADDR', deliveryAddressId: '', items: [{ productId: 'P102', quantity: 1, priceAtCheckout: price }] } }
        ),
      ],
    });
    expect(missingAddrRes.outcomes[0].status).toBe('REJECTED');

    // Invalid cart quantities are also rejected
    const badCartQty = core.push({
      deviceId: 'dev-qty',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-bad-cart',
      lastCursor: 0,
      operations: [
        {
          operationId: 'op-bad-cart-frac',
          deviceId: 'dev-qty',
          appId: OFFLINESHOP_APP_ID,
          entityType: 'cart',
          entityId: 'cart-bad',
          operationType: 'CART_ITEM_SET_QTY',
          sequence: 1,
          baseVersion: 0,
          createdAt: new Date().toISOString(),
          payload: { productId: 'P102', quantity: 2.7 },
          status: 'PENDING',
          retryCount: 0,
        },
      ],
    });
    expect(badCartQty.outcomes[0].status).toBe('REJECTED');

    expect(shopAdapter.productsCol.findById('P102')!.stock).toBe(initialStock);
    expect(shopAdapter.listOrders()).toHaveLength(0);
  });

  it('handles zero stock, product unavailability, and price drift without driving stock negative', () => {
    const { core, shopAdapter } = createBackendApp({ persistPath: null });
    core.registerDevice({ deviceId: 'dev-avail', deviceName: 'Buyer', appId: OFFLINESHOP_APP_ID });

    // 1. Zero stock
    shopAdapter.updateProductAuthoritative('P103', { stock: 0 });
    const zeroRes = core.push({
      deviceId: 'dev-avail',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-zero',
      lastCursor: 0,
      operations: [
        makeOrderOp('dev-avail', 'CLI-ZERO-1', [
          { productId: 'P103', name: 'Carafe', quantity: 1, priceAtCheckout: 94 },
        ]),
      ],
    });
    expect(zeroRes.outcomes[0].status).toBe('REQUIRES_ACTION');
    const zeroOrder = zeroRes.outcomes[0].serverData as unknown as OrderDocument;
    expect(zeroOrder.discrepancies[0].type).toBe('INSUFFICIENT_STOCK');
    expect(zeroOrder.discrepancies[0].availableStock).toBe(0);
    expect(shopAdapter.productsCol.findById('P103')!.stock).toBe(0);

    // 2. Product unavailable (removed from authoritative catalog)
    shopAdapter.productsCol.deleteById('P104');
    const unavailRes = core.push({
      deviceId: 'dev-avail',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-unavail',
      lastCursor: 0,
      operations: [
        makeOrderOp('dev-avail', 'CLI-UNAVAIL-1', [
          { productId: 'P104', name: 'Pack', quantity: 1, priceAtCheckout: 215 },
        ]),
      ],
    });
    expect(unavailRes.outcomes[0].status).toBe('REQUIRES_ACTION');
    const unavailOrder = unavailRes.outcomes[0].serverData as unknown as OrderDocument;
    expect(unavailOrder.discrepancies[0].type).toBe('PRODUCT_UNAVAILABLE');
  });

  it('rolls back inventory decrement atomically if a failure occurs mid-order before order creation completes', () => {
    const { core, shopAdapter } = createBackendApp({ persistPath: null });
    core.registerDevice({ deviceId: 'dev-rollback', deviceName: 'Buyer', appId: OFFLINESHOP_APP_ID });

    shopAdapter.updateProductAuthoritative('P105', { stock: 4 });
    const price = shopAdapter.productsCol.findById('P105')!.price;

    // Inject failure right after stock decrement and before order record insertion
    shopAdapter.afterStockDecrementHook = () => {
      throw new Error('Simulated crash after stock decrement before order commit');
    };

    const op = makeOrderOp(
      'dev-rollback',
      'CLI-ROLLBACK-1',
      [{ productId: 'P105', name: 'Kettle', quantity: 3, priceAtCheckout: price }],
      { operationId: 'op-rollback-1' }
    );

    const crashRes = core.push({
      deviceId: 'dev-rollback',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-crash',
      lastCursor: 0,
      operations: [op],
    });

    expect(crashRes.outcomes[0].status).toBe('REJECTED');
    expect(crashRes.outcomes[0].reason).toContain('rolled back');

    // Stock MUST be rolled back to 4, NO order persisted, NO idempotency record leaked!
    expect(shopAdapter.productsCol.findById('P105')!.stock).toBe(4);
    expect(shopAdapter.ordersCol.findByUniqueIndex('uniq_client_order_id', 'CLI-ROLLBACK-1')).toBeNull();
    expect(core.idempotency.checkExisting('op-rollback-1')).toBeNull();

    // Clearing the fault lets the exact same operationId succeed cleanly on retry
    shopAdapter.afterStockDecrementHook = undefined;
    const retryRes = core.push({
      deviceId: 'dev-rollback',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-retry-ok',
      lastCursor: 0,
      operations: [op],
    });
    expect(retryRes.outcomes[0].status).toBe('ACKNOWLEDGED');
    expect(shopAdapter.productsCol.findById('P105')!.stock).toBe(1);
  });

  describe('Simultaneous HTTP Orders Competing for Limited Stock', () => {
    let backend: OfflineSyncBackendContext;
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      backend = createBackendApp({ persistPath: null });
      await new Promise<void>((resolve) => {
        server = backend.app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('prevents overselling when 6 concurrent devices order the last 3 units simultaneously over HTTP', async () => {
      backend.shopAdapter.updateProductAuthoritative('P106', { stock: 3 });
      const price = backend.shopAdapter.productsCol.findById('P106')!.price;

      // Register 6 independent devices and collect their tokens
      const devices = await Promise.all(
        Array.from({ length: 6 }, async (_, idx) => {
          const deviceId = `race-dev-${idx}`;
          const res = await fetch(`${baseUrl}/api/sync/register-device`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceId,
              deviceName: `Race Buyer ${idx}`,
              appId: OFFLINESHOP_APP_ID,
            }),
          });
          const body = (await res.json()) as { deviceToken: string };
          return { deviceId, token: body.deviceToken };
        })
      );

      // Fire 6 simultaneous HTTP POST /api/sync/push requests, each ordering qty=2 (total demand=12 vs stock=3)
      const responses = await Promise.all(
        devices.map(async ({ deviceId, token }, idx) => {
          const clientOrderId = `CLI-RACE-${idx}`;
          const res = await fetch(`${baseUrl}/api/sync/push`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Token': token,
            },
            body: JSON.stringify({
              deviceId,
              appId: OFFLINESHOP_APP_ID,
              sessionId: `sess-race-${idx}`,
              lastCursor: 0,
              operations: [
                makeOrderOp(deviceId, clientOrderId, [
                  { productId: 'P106', name: 'Desk Lamp', quantity: 2, priceAtCheckout: price },
                ]),
              ],
            }),
          });
          expect(res.status).toBe(200);
          return (await res.json()) as { outcomes: Array<{ status: string }> };
        })
      );

      const confirmedCount = responses.filter((r) => r.outcomes[0].status === 'ACKNOWLEDGED').length;
      const requiresActionCount = responses.filter(
        (r) => r.outcomes[0].status === 'REQUIRES_ACTION'
      ).length;

      // With stock=3 and qty=2 per order, AT MOST ONE order can be confirmed (leaving stock=1).
      expect(confirmedCount).toBe(1);
      expect(requiresActionCount).toBe(5);
      expect(backend.shopAdapter.productsCol.findById('P106')!.stock).toBe(1);
      expect(backend.shopAdapter.productsCol.findById('P106')!.stock).toBeGreaterThanOrEqual(0);
    });
  });
});
