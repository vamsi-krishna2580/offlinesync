import crypto from 'crypto';
import type {
  ConflictRecord,
  OperationOutcome,
  ResolveConflictRequest,
  SyncOperation,
} from '../../packages/offlinesync-types';
import { ConflictResolutionError, type ConflictManager } from '../offlinesync-core/ConflictManager';
import type {
  AdapterOperationContext,
  BusinessAdapter,
  SyncCoreEngine,
} from '../offlinesync-core/SyncCoreEngine';
import type { DocumentCollection, DocumentStore } from '../persistence/DocumentStore';
import { SEED_ADDRESSES, SEED_PRODUCTS } from './seedData';
import type {
  CartDocument,
  DeliveryAddress,
  OrderDiscrepancy,
  OrderDocument,
  OrderItem,
  Product,
  WishlistDocument,
} from './types';

export const OFFLINESHOP_APP_ID = 'offline-shop';
const MAX_ITEM_QUANTITY = 1000;

function isValidPositiveIntegerQuantity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_ITEM_QUANTITY
  );
}

function isValidNonNegativeIntegerQuantity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_ITEM_QUANTITY
  );
}

function isValidPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

/**
 * OfflineShop Business Adapter.
 * Strictly isolated from `backend/offlinesync-core`.
 *
 * Atomicity & Inventory Guarantees (via `DocumentStore.runTransaction`):
 * - Aggregates duplicate `productId` lines before checking authoritative stock.
 * - Rejects zero, negative, fractional, NaN, oversized, or malformed quantities.
 * - Enforces a strict non-negative stock invariant inside the transaction.
 * - Rolls back both stock decrements and order creation if any failure occurs midway.
 */
export class ShopBusinessAdapter implements BusinessAdapter {
  public readonly appId = OFFLINESHOP_APP_ID;
  public readonly supportedEntityTypes = [
    'product',
    'cart',
    'wishlist',
    'address',
    'order',
  ];
  public readonly supportedOperationTypes: Record<string, string[]> = {
    cart: [
      'CART_ITEM_ADD',
      'CART_ITEM_INCREMENT',
      'CART_ITEM_DECREMENT',
      'CART_ITEM_SET_QTY',
      'CART_ITEM_REMOVE',
      'CART_CLEAR',
      'CART_SET_SNAPSHOT',
    ],
    wishlist: ['WISHLIST_ADD', 'WISHLIST_REMOVE'],
    order: ['ORDER_CREATE', 'ORDER_ACCEPT_REVISED', 'ORDER_CANCEL'],
    product: ['PRODUCT_UPDATE'],
  };

  public readonly productsCol: DocumentCollection<Product & Record<string, unknown>>;
  public readonly cartsCol: DocumentCollection<CartDocument & Record<string, unknown>>;
  public readonly wishlistsCol: DocumentCollection<WishlistDocument & Record<string, unknown>>;
  public readonly addressesCol: DocumentCollection<DeliveryAddress & Record<string, unknown>>;
  public readonly ordersCol: DocumentCollection<OrderDocument & Record<string, unknown>>;

  /**
   * Optional test-only fault-injection hook invoked AFTER decrementing product inventory
   * and BEFORE inserting the confirmed order record, allowing automated tests to verify
   * full transactional rollback on mid-order failures.
   */
  public afterStockDecrementHook?: (clientOrderId: string) => void;

  private core?: SyncCoreEngine;

  constructor(store: DocumentStore) {
    this.productsCol = store.registerCollection<Product & Record<string, unknown>>(
      'products',
      'productId'
    );
    this.cartsCol = store.registerCollection<CartDocument & Record<string, unknown>>(
      'carts',
      'cartId'
    );
    this.wishlistsCol = store.registerCollection<WishlistDocument & Record<string, unknown>>(
      'wishlists',
      'wishlistId'
    );
    this.addressesCol = store.registerCollection<DeliveryAddress & Record<string, unknown>>(
      'addresses',
      'addressId'
    );
    this.ordersCol = store.registerCollection<OrderDocument & Record<string, unknown>>(
      'orders',
      'orderId',
      [
        {
          name: 'uniq_client_order_id',
          keyFn: (doc) => doc.clientOrderId,
        },
      ]
    );
  }

  seedIfEmpty(core: SyncCoreEngine): void {
    this.core = core;
    if (this.productsCol.count() === 0 || this.addressesCol.count() === 0) {
      core.store.runTransaction(() => {
        if (this.productsCol.count() === 0) {
          for (const product of SEED_PRODUCTS) {
            this.productsCol.insertOne(product as Product & Record<string, unknown>);
            core.reconciliation.recordChange({
              appId: this.appId,
              entityType: 'product',
              entityId: product.productId,
              version: product.version,
              changeType: 'UPSERT',
              data: product as unknown as Record<string, unknown>,
            });
          }
        }
        if (this.addressesCol.count() === 0) {
          for (const addr of SEED_ADDRESSES) {
            this.addressesCol.insertOne(addr as DeliveryAddress & Record<string, unknown>);
            core.reconciliation.recordChange({
              appId: this.appId,
              entityType: 'address',
              entityId: addr.addressId,
              version: addr.version,
              changeType: 'UPSERT',
              data: addr as unknown as Record<string, unknown>,
            });
          }
        }
      });
    }
  }

  registerPolicies(conflicts: ConflictManager): void {
    conflicts.registerPolicy('product', 'SERVER_AUTHORITATIVE');
    conflicts.registerPolicy('order', 'MANUAL_RESOLUTION');
    conflicts.registerPolicy('wishlist', 'LAST_WRITE_WINS_DETERMINISTIC');
    conflicts.registerPolicy('cart', 'DOMAIN_CUSTOM', ({ operation, remoteState }) => {
      if (
        operation.operationType === 'CART_ITEM_INCREMENT' ||
        operation.operationType === 'CART_ITEM_DECREMENT' ||
        operation.operationType === 'CART_ITEM_ADD'
      ) {
        return {
          autoResolve: true,
          winningPayload: remoteState,
          summary:
            'Domain resolver merged operation-based cart quantity delta against latest server cart.',
        };
      }
      return {
        autoResolve: false,
        winningPayload: null,
        summary:
          'Concurrent absolute cart modification detected; escalated for operator/user conflict review.',
      };
    });
  }

  getCurrentEntityVersion(entityType: string, entityId: string): number | null {
    switch (entityType) {
      case 'cart':
        return this.cartsCol.findById(entityId)?.version ?? null;
      case 'order': {
        const ord =
          this.ordersCol.findByUniqueIndex('uniq_client_order_id', entityId) ??
          this.ordersCol.findById(entityId);
        return ord?.version ?? null;
      }
      case 'product':
        return this.productsCol.findById(entityId)?.version ?? null;
      case 'wishlist':
        return this.wishlistsCol.findById(entityId)?.version ?? null;
      default:
        return null;
    }
  }

  processOperation(
    operation: SyncOperation,
    ctx: AdapterOperationContext
  ): OperationOutcome {
    switch (operation.entityType) {
      case 'cart':
        return this.processCartOperation(operation, ctx);
      case 'wishlist':
        return this.processWishlistOperation(operation, ctx);
      case 'order':
        return this.processOrderOperation(operation, ctx);
      case 'product':
        return this.processProductClientAttempt(operation, ctx);
      default:
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Unsupported entityType "${operation.entityType}" for OfflineShop adapter`,
        };
    }
  }

  private processProductClientAttempt(
    operation: SyncOperation,
    ctx: AdapterOperationContext
  ): OperationOutcome {
    const product = this.productsCol.findById(operation.entityId);
    const decision = ctx.raiseConflict({
      operation,
      remoteVersion: product?.version ?? 1,
      remoteState: (product as unknown as Record<string, unknown>) ?? null,
      conflictType: 'VERSION_MISMATCH',
      overridePolicy: 'SERVER_AUTHORITATIVE',
      summary:
        'Client attempted to modify server-authoritative product catalog/inventory; server state retained.',
    });
    return {
      operationId: operation.operationId,
      status: 'CONFLICT',
      serverVersion: product?.version ?? 1,
      conflict: decision.conflict,
      reason: 'Server is authoritative for product pricing and inventory.',
      serverData: (product as unknown as Record<string, unknown>) ?? undefined,
    };
  }

  private processCartOperation(
    operation: SyncOperation,
    ctx: AdapterOperationContext
  ): OperationOutcome {
    const cartId = operation.entityId || 'default-cart';
    const existing = this.cartsCol.findById(cartId) ?? {
      cartId,
      items: [],
      version: 0,
      updatedAt: new Date().toISOString(),
    };

    const payload = operation.payload as {
      productId?: unknown;
      delta?: unknown;
      quantity?: unknown;
      items?: unknown;
    };

    const isAbsoluteOverwrite =
      operation.operationType === 'CART_ITEM_SET_QTY' ||
      operation.operationType === 'CART_SET_SNAPSHOT';

    if (
      isAbsoluteOverwrite &&
      existing.version > 0 &&
      operation.baseVersion < existing.version
    ) {
      const decision = ctx.raiseConflict({
        operation,
        remoteVersion: existing.version,
        remoteState: existing as unknown as Record<string, unknown>,
        conflictType: 'CONCURRENT_EDIT',
        overridePolicy: 'MANUAL_RESOLUTION',
        summary: `Cart "${cartId}" was modified concurrently (client baseVersion ${operation.baseVersion} < server version ${existing.version}).`,
      });

      return {
        operationId: operation.operationId,
        status: 'CONFLICT',
        serverVersion: existing.version,
        conflict: decision.conflict,
        reason: decision.conflict.resolutionSummary,
        serverData: existing as unknown as Record<string, unknown>,
      };
    }

    const nextItems = structuredClone(existing.items);

    if (
      operation.operationType === 'CART_ITEM_ADD' ||
      operation.operationType === 'CART_ITEM_INCREMENT' ||
      operation.operationType === 'CART_ITEM_DECREMENT'
    ) {
      if (typeof payload.productId !== 'string' || !payload.productId.trim()) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: 'Missing or invalid productId in cart delta operation',
        };
      }
      const product = this.productsCol.findById(payload.productId);
      if (!product) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Product "${payload.productId}" not found`,
        };
      }

      const rawAmount =
        payload.delta !== undefined
          ? payload.delta
          : payload.quantity !== undefined
          ? payload.quantity
          : 1;

      if (!isValidPositiveIntegerQuantity(rawAmount)) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Invalid cart delta quantity "${String(rawAmount)}": must be a positive integer between 1 and ${MAX_ITEM_QUANTITY}`,
        };
      }

      const signedDelta =
        operation.operationType === 'CART_ITEM_DECREMENT' ? -rawAmount : rawAmount;

      const idx = nextItems.findIndex((i) => i.productId === product.productId);
      if (idx >= 0) {
        const updatedQty = nextItems[idx].quantity + signedDelta;
        if (updatedQty <= 0) {
          nextItems.splice(idx, 1);
        } else {
          nextItems[idx].quantity = Math.min(updatedQty, Math.max(product.stock, 1));
          nextItems[idx].cachedPrice = product.price;
          nextItems[idx].name = product.name;
          nextItems[idx].imageUrl = product.imageUrl;
        }
      } else if (signedDelta > 0) {
        nextItems.push({
          productId: product.productId,
          name: product.name,
          imageUrl: product.imageUrl,
          quantity: Math.min(signedDelta, Math.max(product.stock, 1)),
          cachedPrice: product.price,
        });
      }

      if (existing.version > 0 && operation.baseVersion < existing.version) {
        ctx.raiseConflict({
          operation,
          remoteVersion: existing.version,
          remoteState: existing as unknown as Record<string, unknown>,
          conflictType: 'CONCURRENT_EDIT',
          overridePolicy: 'DOMAIN_CUSTOM',
          summary: `Merged cart delta (${signedDelta > 0 ? '+' : ''}${signedDelta} of ${product.productId}) onto server cart v${existing.version}.`,
        });
      }
    } else if (operation.operationType === 'CART_ITEM_SET_QTY') {
      if (typeof payload.productId !== 'string' || !payload.productId.trim()) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: 'Missing or invalid productId in CART_ITEM_SET_QTY',
        };
      }
      if (!isValidNonNegativeIntegerQuantity(payload.quantity)) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Invalid quantity "${String(payload.quantity)}": must be a non-negative integer`,
        };
      }
      const product = this.productsCol.findById(payload.productId);
      if (!product) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Product "${payload.productId}" not found`,
        };
      }
      const idx = nextItems.findIndex((i) => i.productId === product.productId);
      if (payload.quantity === 0) {
        if (idx >= 0) nextItems.splice(idx, 1);
      } else if (idx >= 0) {
        nextItems[idx].quantity = payload.quantity;
        nextItems[idx].cachedPrice = product.price;
      } else {
        nextItems.push({
          productId: product.productId,
          name: product.name,
          imageUrl: product.imageUrl,
          quantity: payload.quantity,
          cachedPrice: product.price,
        });
      }
    } else if (operation.operationType === 'CART_ITEM_REMOVE') {
      if (typeof payload.productId !== 'string' || !payload.productId.trim()) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: 'Missing productId in CART_ITEM_REMOVE',
        };
      }
      const idx = nextItems.findIndex((i) => i.productId === payload.productId);
      if (idx >= 0) nextItems.splice(idx, 1);
    } else if (operation.operationType === 'CART_CLEAR') {
      nextItems.length = 0;
    } else if (operation.operationType === 'CART_SET_SNAPSHOT') {
      if (!Array.isArray(payload.items)) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: 'CART_SET_SNAPSHOT requires an items array',
        };
      }
      const aggregated = new Map<string, number>();
      for (const rawItem of payload.items) {
        const entry = rawItem as { productId?: unknown; quantity?: unknown };
        if (
          typeof entry?.productId !== 'string' ||
          !isValidPositiveIntegerQuantity(entry.quantity)
        ) {
          return {
            operationId: operation.operationId,
            status: 'REJECTED',
            reason: 'Invalid item in CART_SET_SNAPSHOT: requires valid productId and positive integer quantity',
          };
        }
        aggregated.set(
          entry.productId,
          (aggregated.get(entry.productId) ?? 0) + entry.quantity
        );
      }
      nextItems.length = 0;
      for (const [productId, quantity] of aggregated.entries()) {
        const product = this.productsCol.findById(productId);
        if (!product) {
          return {
            operationId: operation.operationId,
            status: 'REJECTED',
            reason: `Product "${productId}" not found in CART_SET_SNAPSHOT`,
          };
        }
        nextItems.push({
          productId: product.productId,
          name: product.name,
          imageUrl: product.imageUrl,
          quantity,
          cachedPrice: product.price,
        });
      }
    } else {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: `Unknown cart operationType "${operation.operationType}"`,
      };
    }

    const updatedCart: CartDocument = {
      cartId,
      items: nextItems,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };

    this.cartsCol.upsertOne(updatedCart as CartDocument & Record<string, unknown>);
    ctx.recordEntityChange({
      appId: this.appId,
      entityType: 'cart',
      entityId: cartId,
      version: updatedCart.version,
      changeType: 'UPSERT',
      data: updatedCart as unknown as Record<string, unknown>,
      sourceDeviceId: operation.deviceId,
    });

    return {
      operationId: operation.operationId,
      status: 'ACKNOWLEDGED',
      serverVersion: updatedCart.version,
      serverData: updatedCart as unknown as Record<string, unknown>,
    };
  }

  private processWishlistOperation(
    operation: SyncOperation,
    ctx: AdapterOperationContext
  ): OperationOutcome {
    const wishlistId = operation.entityId || 'default-wishlist';
    const existing = this.wishlistsCol.findById(wishlistId) ?? {
      wishlistId,
      productIds: [],
      version: 0,
      updatedAt: new Date().toISOString(),
    };

    const payload = operation.payload as { productId?: unknown };
    if (typeof payload.productId !== 'string' || !payload.productId.trim()) {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: 'Missing or invalid productId in wishlist operation',
      };
    }

    if (
      operation.operationType === 'WISHLIST_ADD' &&
      !this.productsCol.findById(payload.productId)
    ) {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: `Product "${payload.productId}" does not exist`,
      };
    }

    const set = new Set(existing.productIds);
    if (operation.operationType === 'WISHLIST_ADD') {
      set.add(payload.productId);
    } else if (operation.operationType === 'WISHLIST_REMOVE') {
      set.delete(payload.productId);
    } else {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: `Unknown wishlist operationType "${operation.operationType}"`,
      };
    }

    const updated: WishlistDocument = {
      wishlistId,
      productIds: Array.from(set),
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };

    this.wishlistsCol.upsertOne(updated as WishlistDocument & Record<string, unknown>);
    ctx.recordEntityChange({
      appId: this.appId,
      entityType: 'wishlist',
      entityId: wishlistId,
      version: updated.version,
      changeType: 'UPSERT',
      data: updated as unknown as Record<string, unknown>,
      sourceDeviceId: operation.deviceId,
    });

    return {
      operationId: operation.operationId,
      status: 'ACKNOWLEDGED',
      serverVersion: updated.version,
      serverData: updated as unknown as Record<string, unknown>,
    };
  }

  private processOrderOperation(
    operation: SyncOperation,
    ctx: AdapterOperationContext
  ): OperationOutcome {
    const now = new Date().toISOString();

    if (operation.operationType === 'ORDER_CANCEL') {
      const payload = operation.payload as { clientOrderId?: unknown };
      const key =
        typeof payload.clientOrderId === 'string' && payload.clientOrderId
          ? payload.clientOrderId
          : operation.entityId;
      const existing =
        this.ordersCol.findByUniqueIndex('uniq_client_order_id', key) ??
        this.ordersCol.findById(key);
      if (!existing) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Order "${key}" not found for cancellation`,
        };
      }
      if (existing.status === 'CANCELLED') {
        return {
          operationId: operation.operationId,
          status: 'ACKNOWLEDGED',
          serverVersion: existing.version,
          serverData: existing as unknown as Record<string, unknown>,
        };
      }

      if (existing.status === 'CONFIRMED' || existing.status === 'SERVER_ACCEPTED') {
        for (const item of existing.items) {
          const prod = this.productsCol.findById(item.productId);
          if (prod) {
            const restored: Product = {
              ...prod,
              stock: prod.stock + item.quantity,
              version: prod.version + 1,
              updatedAt: now,
            };
            this.productsCol.upsertOne(restored as Product & Record<string, unknown>);
            ctx.recordEntityChange({
              appId: this.appId,
              entityType: 'product',
              entityId: restored.productId,
              version: restored.version,
              changeType: 'UPSERT',
              data: restored as unknown as Record<string, unknown>,
            });
          }
        }
      }

      const cancelled: OrderDocument = {
        ...existing,
        status: 'CANCELLED',
        syncStatus: 'SYNCED',
        paymentIntent: { ...existing.paymentIntent, status: 'CANCELLED' },
        version: existing.version + 1,
        updatedAt: now,
      };
      this.ordersCol.upsertOne(cancelled as OrderDocument & Record<string, unknown>);
      ctx.recordEntityChange({
        appId: this.appId,
        entityType: 'order',
        entityId: cancelled.clientOrderId,
        version: cancelled.version,
        changeType: 'UPSERT',
        data: cancelled as unknown as Record<string, unknown>,
        sourceDeviceId: operation.deviceId,
      });

      return {
        operationId: operation.operationId,
        status: 'ACKNOWLEDGED',
        serverVersion: cancelled.version,
        serverData: cancelled as unknown as Record<string, unknown>,
      };
    }

    if (operation.operationType === 'ORDER_ACCEPT_REVISED') {
      const payload = operation.payload as {
        clientOrderId?: unknown;
        items?: unknown;
      };
      const key =
        typeof payload.clientOrderId === 'string' && payload.clientOrderId
          ? payload.clientOrderId
          : operation.entityId;
      const existing = this.ordersCol.findByUniqueIndex('uniq_client_order_id', key);
      if (!existing) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: 'Order not found for revised confirmation',
        };
      }
      if (existing.status === 'CONFIRMED' || existing.status === 'CANCELLED') {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Order "${existing.orderId}" is already ${existing.status}`,
        };
      }
      return this.validateAndFinalizeOrder(
        operation,
        {
          clientOrderId: existing.clientOrderId,
          items: Array.isArray(payload.items)
            ? (payload.items as OrderItem[])
            : existing.items,
          deliveryAddressId: existing.deliveryAddressId,
          createdLocallyAt: existing.createdLocallyAt,
          notes: existing.notes,
        },
        existing,
        ctx
      );
    }

    if (operation.operationType !== 'ORDER_CREATE') {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: `Unsupported order operationType "${operation.operationType}"`,
      };
    }

    const payload = operation.payload as {
      clientOrderId?: unknown;
      items?: unknown;
      deliveryAddressId?: unknown;
      createdLocallyAt?: unknown;
      notes?: unknown;
    };

    const clientOrderId =
      typeof payload.clientOrderId === 'string' && payload.clientOrderId.trim()
        ? payload.clientOrderId.trim()
        : operation.entityId;

    if (
      !clientOrderId ||
      !Array.isArray(payload.items) ||
      payload.items.length === 0 ||
      typeof payload.deliveryAddressId !== 'string' ||
      !payload.deliveryAddressId.trim()
    ) {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: 'Order intent requires clientOrderId, deliveryAddressId, and at least one item',
      };
    }

    // Order-level idempotency via unique `clientOrderId` index
    const existingByClientId = this.ordersCol.findByUniqueIndex(
      'uniq_client_order_id',
      clientOrderId
    );
    if (existingByClientId) {
      return {
        operationId: operation.operationId,
        status: 'DUPLICATE',
        serverVersion: existingByClientId.version,
        reason: `Order with clientOrderId "${clientOrderId}" already exists on server`,
        serverData: existingByClientId as unknown as Record<string, unknown>,
      };
    }

    return this.validateAndFinalizeOrder(
      operation,
      {
        clientOrderId,
        items: payload.items as OrderItem[],
        deliveryAddressId: payload.deliveryAddressId.trim(),
        createdLocallyAt:
          typeof payload.createdLocallyAt === 'string' ? payload.createdLocallyAt : undefined,
        notes: typeof payload.notes === 'string' ? payload.notes : undefined,
      },
      null,
      ctx
    );
  }

  private validateAndFinalizeOrder(
    operation: SyncOperation,
    payload: {
      clientOrderId: string;
      items: OrderItem[];
      deliveryAddressId: string;
      createdLocallyAt?: string;
      notes?: string;
    },
    existingOrder: OrderDocument | null,
    ctx: AdapterOperationContext
  ): OperationOutcome {
    const now = new Date().toISOString();
    const clientOrderId = payload.clientOrderId || operation.entityId;
    const address = this.addressesCol.findById(payload.deliveryAddressId);

    if (!address) {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: `Delivery address "${payload.deliveryAddressId}" is invalid or not found`,
      };
    }

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: 'Order must contain at least one item',
      };
    }

    // STEP 1: Strictly validate every line item & aggregate duplicate productIds BEFORE stock checks
    const aggregatedMap = new Map<
      string,
      {
        productId: string;
        name: string;
        totalQuantity: number;
        clientPrices: number[];
        lineEstimatedSum: number;
      }
    >();

    for (const rawItem of payload.items) {
      const item = rawItem as Partial<OrderItem>;
      if (typeof item?.productId !== 'string' || !item.productId.trim()) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: 'Malformed order line: productId must be a non-empty string',
        };
      }
      if (!isValidPositiveIntegerQuantity(item.quantity)) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Invalid order quantity "${String(item.quantity)}" for product "${item.productId}": must be a positive integer between 1 and ${MAX_ITEM_QUANTITY}`,
        };
      }
      if (!isValidPrice(item.priceAtCheckout)) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Invalid priceAtCheckout "${String(item.priceAtCheckout)}" for product "${item.productId}"`,
        };
      }

      const pid = item.productId.trim();
      const prev = aggregatedMap.get(pid);
      if (prev) {
        const combinedQty = prev.totalQuantity + item.quantity;
        if (combinedQty > MAX_ITEM_QUANTITY) {
          return {
            operationId: operation.operationId,
            status: 'REJECTED',
            reason: `Aggregated quantity (${combinedQty}) for product "${pid}" exceeds maximum allowed (${MAX_ITEM_QUANTITY})`,
          };
        }
        prev.totalQuantity = combinedQty;
        prev.clientPrices.push(item.priceAtCheckout);
        prev.lineEstimatedSum += item.priceAtCheckout * item.quantity;
      } else {
        aggregatedMap.set(pid, {
          productId: pid,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : pid,
          totalQuantity: item.quantity,
          clientPrices: [item.priceAtCheckout],
          lineEstimatedSum: item.priceAtCheckout * item.quantity,
        });
      }
    }

    // STEP 2: Validate aggregated quantities and prices against authoritative server catalog
    const discrepancies: OrderDiscrepancy[] = [];
    const validatedItems: OrderItem[] = [];
    let clientEstimatedTotal = 0;
    let authoritativeTotal = 0;

    for (const agg of aggregatedMap.values()) {
      clientEstimatedTotal += agg.lineEstimatedSum;
      const product = this.productsCol.findById(agg.productId);
      const representativeClientPrice = agg.clientPrices[0];

      if (!product) {
        discrepancies.push({
          productId: agg.productId,
          productName: agg.name,
          type: 'PRODUCT_UNAVAILABLE',
          requestedQty: agg.totalQuantity,
          availableStock: 0,
          message: `Product "${agg.name}" (${agg.productId}) is no longer available.`,
        });
        validatedItems.push({
          productId: agg.productId,
          name: agg.name,
          quantity: agg.totalQuantity,
          priceAtCheckout: representativeClientPrice,
          availableStock: 0,
        });
        continue;
      }

      if (product.stock <= 0 || agg.totalQuantity > product.stock) {
        discrepancies.push({
          productId: product.productId,
          productName: product.name,
          type: 'INSUFFICIENT_STOCK',
          requestedQty: agg.totalQuantity,
          availableStock: product.stock,
          serverPrice: product.price,
          message: `Requested total of ${agg.totalQuantity} for ${product.name}, but only ${product.stock} in stock.`,
        });
      }

      const anyPriceMismatch = agg.clientPrices.some(
        (cp) => Math.abs(cp - product.price) > 0.001
      );
      if (anyPriceMismatch) {
        discrepancies.push({
          productId: product.productId,
          productName: product.name,
          type: 'PRICE_CHANGED',
          clientPrice: representativeClientPrice,
          serverPrice: product.price,
          requestedQty: agg.totalQuantity,
          availableStock: product.stock,
          message: `Price of ${product.name} changed from $${representativeClientPrice} to $${product.price}.`,
        });
      }

      authoritativeTotal += product.price * agg.totalQuantity;
      validatedItems.push({
        productId: product.productId,
        name: product.name,
        quantity: agg.totalQuantity,
        priceAtCheckout: representativeClientPrice,
        authoritativePrice: product.price,
        availableStock: product.stock,
      });
    }

    // STEP 3: Reject silent acceptance if ANY price/stock/availability discrepancy exists
    if (discrepancies.length > 0) {
      const hasStockIssue = discrepancies.some(
        (d) => d.type === 'INSUFFICIENT_STOCK' || d.type === 'PRODUCT_UNAVAILABLE'
      );
      const conflictType = hasStockIssue ? 'INSUFFICIENT_STOCK' : 'PRICE_CHANGED';

      const pendingOrder: OrderDocument = {
        orderId: existingOrder?.orderId ?? `ORD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        clientOrderId,
        deviceId: operation.deviceId,
        status: 'REQUIRES_ACTION',
        items: validatedItems,
        deliveryAddressId: address.addressId,
        deliveryAddressSnapshot: address,
        paymentIntent: {
          method: 'COD',
          status: 'NOT_PROCESSED',
        },
        clientEstimatedTotal: Math.round(clientEstimatedTotal * 100) / 100,
        authoritativeTotal: Math.round(authoritativeTotal * 100) / 100,
        discrepancies,
        createdLocallyAt: payload.createdLocallyAt ?? now,
        syncedAt: now,
        syncStatus: 'REQUIRES_ACTION',
        version: (existingOrder?.version ?? 0) + 1,
        updatedAt: now,
        notes: payload.notes,
      };

      this.ordersCol.upsertOne(pendingOrder as OrderDocument & Record<string, unknown>);
      ctx.recordEntityChange({
        appId: this.appId,
        entityType: 'order',
        entityId: clientOrderId,
        version: pendingOrder.version,
        changeType: 'UPSERT',
        data: pendingOrder as unknown as Record<string, unknown>,
        sourceDeviceId: operation.deviceId,
      });

      const decision = ctx.raiseConflict({
        operation,
        remoteVersion: pendingOrder.version,
        remoteState: {
          authoritativeTotal: pendingOrder.authoritativeTotal,
          discrepancies,
          orderStatus: pendingOrder.status,
        },
        conflictType,
        overridePolicy: 'MANUAL_RESOLUTION',
        summary: discrepancies.map((d) => d.message).join(' '),
      });

      return {
        operationId: operation.operationId,
        status: 'REQUIRES_ACTION',
        serverVersion: pendingOrder.version,
        conflict: decision.conflict,
        reason: discrepancies.map((d) => d.message).join(' '),
        serverData: pendingOrder as unknown as Record<string, unknown>,
      };
    }

    // STEP 4: Inside the enclosing `DocumentStore.runTransaction`, decrement authoritative
    // inventory with strict non-negative stock check and persist confirmed order.
    // Any exception here (including `afterStockDecrementHook` in tests or disk flush error)
    // rolls back ALL inventory decrements, order records, and changelog entries cleanly.
    for (const item of validatedItems) {
      const product = this.productsCol.findById(item.productId)!;
      const nextStock = product.stock - item.quantity;
      if (nextStock < 0) {
        throw new Error(
          `Negative stock invariant prevented for "${product.productId}": stock=${product.stock}, requested=${item.quantity}`
        );
      }
      const updatedProduct: Product = {
        ...product,
        stock: nextStock,
        version: product.version + 1,
        updatedAt: now,
      };
      this.productsCol.upsertOne(updatedProduct as Product & Record<string, unknown>);
      ctx.recordEntityChange({
        appId: this.appId,
        entityType: 'product',
        entityId: updatedProduct.productId,
        version: updatedProduct.version,
        changeType: 'UPSERT',
        data: updatedProduct as unknown as Record<string, unknown>,
      });
    }

    if (this.afterStockDecrementHook) {
      this.afterStockDecrementHook(clientOrderId);
    }

    const confirmedOrder: OrderDocument = {
      orderId: existingOrder?.orderId ?? `ORD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      clientOrderId,
      deviceId: operation.deviceId,
      status: 'CONFIRMED',
      items: validatedItems,
      deliveryAddressId: address.addressId,
      deliveryAddressSnapshot: address,
      paymentIntent: {
        method: 'COD',
        status: 'COD_PENDING_DELIVERY',
      },
      clientEstimatedTotal: Math.round(clientEstimatedTotal * 100) / 100,
      authoritativeTotal: Math.round(authoritativeTotal * 100) / 100,
      discrepancies: [],
      createdLocallyAt: payload.createdLocallyAt ?? now,
      syncedAt: now,
      syncStatus: 'SYNCED',
      version: (existingOrder?.version ?? 0) + 1,
      updatedAt: now,
      notes: payload.notes,
    };

    this.ordersCol.upsertOne(confirmedOrder as OrderDocument & Record<string, unknown>);
    ctx.recordEntityChange({
      appId: this.appId,
      entityType: 'order',
      entityId: clientOrderId,
      version: confirmedOrder.version,
      changeType: 'UPSERT',
      data: confirmedOrder as unknown as Record<string, unknown>,
      sourceDeviceId: operation.deviceId,
    });

    return {
      operationId: operation.operationId,
      status: 'ACKNOWLEDGED',
      serverVersion: confirmedOrder.version,
      serverData: confirmedOrder as unknown as Record<string, unknown>,
    };
  }

  /**
   * Applies validated manual conflict resolution and records an authoritative changelog
   * entry so clients reconcile cleanly on their next pull.
   */
  applyManualConflictResolution(
    conflict: ConflictRecord,
    resolutionChoice: ResolveConflictRequest['resolutionChoice'],
    resolvedPayload: Record<string, unknown> | null,
    ctx: AdapterOperationContext
  ): { operationFinalStatus: SyncOperation['status']; note?: string } {
    const now = new Date().toISOString();

    if (conflict.entityType === 'cart') {
      const existing = this.cartsCol.findById(conflict.entityId);

      if (resolutionChoice === 'KEEP_SERVER') {
        const authoritative: CartDocument = existing ?? {
          cartId: conflict.entityId,
          items: [],
          version: conflict.remoteVersion,
          updatedAt: now,
        };
        // Emit changelog record with bumped version so lagging clients pull the winning server state
        const republished: CartDocument = {
          ...authoritative,
          version: authoritative.version + 1,
          updatedAt: now,
        };
        this.cartsCol.upsertOne(republished as CartDocument & Record<string, unknown>);
        ctx.recordEntityChange({
          appId: this.appId,
          entityType: 'cart',
          entityId: republished.cartId,
          version: republished.version,
          changeType: 'UPSERT',
          data: republished as unknown as Record<string, unknown>,
        });
        return {
          operationFinalStatus: 'FAILED',
          note: `Conflict ${conflict.conflictId} resolved with KEEP_SERVER; client mutation discarded.`,
        };
      }

      // APPLY_CLIENT or CUSTOM — validate payload thoroughly before mutating cart
      if (!resolvedPayload || typeof resolvedPayload !== 'object') {
        throw new ConflictResolutionError(
          'Cart resolution requires a valid resolvedPayload object',
          'INVALID_RESOLUTION_PAYLOAD',
          400
        );
      }

      let nextItems: CartDocument['items'] = structuredClone(existing?.items ?? []);

      if (Array.isArray(resolvedPayload.items)) {
        const rebuilt: CartDocument['items'] = [];
        for (const raw of resolvedPayload.items) {
          const item = raw as { productId?: unknown; quantity?: unknown };
          if (
            typeof item?.productId !== 'string' ||
            !isValidPositiveIntegerQuantity(item.quantity)
          ) {
            throw new ConflictResolutionError(
              'Invalid cart item in manual resolution payload',
              'INVALID_RESOLUTION_PAYLOAD',
              400
            );
          }
          const product = this.productsCol.findById(item.productId);
          if (!product) {
            throw new ConflictResolutionError(
              `Unknown productId "${item.productId}" in manual resolution payload`,
              'INVALID_RESOLUTION_PAYLOAD',
              400
            );
          }
          rebuilt.push({
            productId: product.productId,
            name: product.name,
            imageUrl: product.imageUrl,
            quantity: item.quantity,
            cachedPrice: product.price,
          });
        }
        nextItems = rebuilt;
      } else if (
        typeof resolvedPayload.productId === 'string' &&
        resolvedPayload.quantity !== undefined
      ) {
        if (!isValidNonNegativeIntegerQuantity(resolvedPayload.quantity)) {
          throw new ConflictResolutionError(
            `Invalid quantity "${String(resolvedPayload.quantity)}" in manual cart resolution`,
            'INVALID_RESOLUTION_PAYLOAD',
            400
          );
        }
        const product = this.productsCol.findById(resolvedPayload.productId);
        if (!product) {
          throw new ConflictResolutionError(
            `Unknown productId "${resolvedPayload.productId}" in manual resolution payload`,
            'INVALID_RESOLUTION_PAYLOAD',
            400
          );
        }
        const idx = nextItems.findIndex((i) => i.productId === product.productId);
        if (resolvedPayload.quantity === 0) {
          if (idx >= 0) nextItems.splice(idx, 1);
        } else if (idx >= 0) {
          nextItems[idx].quantity = resolvedPayload.quantity;
          nextItems[idx].cachedPrice = product.price;
        } else {
          nextItems.push({
            productId: product.productId,
            name: product.name,
            imageUrl: product.imageUrl,
            quantity: resolvedPayload.quantity,
            cachedPrice: product.price,
          });
        }
      } else {
        throw new ConflictResolutionError(
          'Manual cart resolution payload must specify either "items" array or { productId, quantity }',
          'INVALID_RESOLUTION_PAYLOAD',
          400
        );
      }

      const updated: CartDocument = {
        cartId: conflict.entityId,
        items: nextItems,
        version: (existing?.version ?? conflict.remoteVersion) + 1,
        updatedAt: now,
      };
      this.cartsCol.upsertOne(updated as CartDocument & Record<string, unknown>);
      ctx.recordEntityChange({
        appId: this.appId,
        entityType: 'cart',
        entityId: updated.cartId,
        version: updated.version,
        changeType: 'UPSERT',
        data: updated as unknown as Record<string, unknown>,
      });
      return {
        operationFinalStatus: 'ACKNOWLEDGED',
        note: `Conflict ${conflict.conflictId} resolved with ${resolutionChoice}.`,
      };
    }

    if (conflict.entityType === 'order') {
      const existing =
        this.ordersCol.findByUniqueIndex('uniq_client_order_id', conflict.entityId) ??
        this.ordersCol.findById(conflict.entityId);
      if (!existing) {
        throw new ConflictResolutionError(
          `Order "${conflict.entityId}" not found`,
          'ORDER_NOT_FOUND',
          404
        );
      }

      if (resolutionChoice === 'APPLY_CLIENT') {
        throw new ConflictResolutionError(
          'APPLY_CLIENT is prohibited for order conflicts: client prices and insufficient stock cannot bypass authoritative server validation. Resolve via KEEP_SERVER or customer ORDER_ACCEPT_REVISED.',
          'AUTHORITATIVE_VALIDATION_REQUIRED',
          422
        );
      }

      const nextStatus =
        resolvedPayload?.orderStatus === 'CANCELLED' ? 'CANCELLED' : existing.status;

      const updated: OrderDocument = {
        ...existing,
        status: nextStatus,
        syncStatus: nextStatus === 'CANCELLED' ? 'SYNCED' : existing.syncStatus,
        version: existing.version + 1,
        updatedAt: now,
      };
      this.ordersCol.upsertOne(updated as OrderDocument & Record<string, unknown>);
      ctx.recordEntityChange({
        appId: this.appId,
        entityType: 'order',
        entityId: updated.clientOrderId,
        version: updated.version,
        changeType: 'UPSERT',
        data: updated as unknown as Record<string, unknown>,
      });
      return {
        operationFinalStatus: nextStatus === 'CANCELLED' ? 'FAILED' : 'REQUIRES_ACTION',
        note: `Order conflict ${conflict.conflictId} resolved (${resolutionChoice}).`,
      };
    }

    return { operationFinalStatus: 'ACKNOWLEDGED' };
  }

  updateProductAuthoritative(
    productId: string,
    patch: { price?: number; stock?: number }
  ): Product | null {
    const existing = this.productsCol.findById(productId);
    if (!existing) return null;

    if (patch.price !== undefined && (!Number.isFinite(patch.price) || patch.price <= 0)) {
      throw new Error('Product price must be a positive finite number');
    }
    if (
      patch.stock !== undefined &&
      (!Number.isInteger(patch.stock) || patch.stock < 0)
    ) {
      throw new Error('Product stock must be a non-negative integer');
    }

    const doUpdate = (): Product => {
      const updated: Product = {
        ...existing,
        price: patch.price !== undefined ? Math.round(patch.price * 100) / 100 : existing.price,
        stock: patch.stock !== undefined ? patch.stock : existing.stock,
        version: existing.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.productsCol.upsertOne(updated as Product & Record<string, unknown>);
      this.core?.reconciliation.recordChange({
        appId: this.appId,
        entityType: 'product',
        entityId: updated.productId,
        version: updated.version,
        changeType: 'UPSERT',
        data: updated as unknown as Record<string, unknown>,
      });
      return updated;
    };

    return this.core ? this.core.store.runTransaction(doUpdate) : doUpdate();
  }

  listProducts(): Product[] {
    return this.productsCol.find().sort((a, b) => a.productId.localeCompare(b.productId));
  }

  listAddresses(): DeliveryAddress[] {
    return this.addressesCol.find();
  }

  listOrders(): OrderDocument[] {
    return this.ordersCol
      .find()
      .sort((a, b) => b.createdLocallyAt.localeCompare(a.createdLocallyAt));
  }
}
