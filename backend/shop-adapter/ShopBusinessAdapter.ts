import crypto from 'crypto';
import type {
  ConflictRecord,
  OperationOutcome,
  SyncOperation,
} from '../../packages/offlinesync-types';
import type {
  AdapterOperationContext,
  BusinessAdapter,
  SyncCoreEngine,
} from '../offlinesync-core/SyncCoreEngine';
import type { ConflictManager } from '../offlinesync-core/ConflictManager';
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

/**
 * OfflineShop Business Adapter.
 * Enforces all e-commerce domain rules completely outside `backend/offlinesync-core`:
 * - Server is authoritative for product prices and inventory stock.
 * - Cart supports operation-based deltas (`CART_ITEM_INCREMENT`, `CART_ITEM_DECREMENT`,
 *   `CART_ITEM_ADD`) so concurrent quantity edits merge safely rather than blindly
 *   overwriting, while explicit versioned overwrites (`CART_SET_SNAPSHOT` /
 *   `CART_ITEM_SET_QTY`) detect concurrent conflicts!
 * - Orders enforce `clientOrderId` idempotency, revalidate prices & stock, never trust
 *   client totals or offline payment statuses, and transition mismatched orders to
 *   `REQUIRES_ACTION` with structured discrepancy records and conflict entries.
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

  public readonly productsCol: DocumentCollection<Product & Record<string, unknown>>;
  public readonly cartsCol: DocumentCollection<CartDocument & Record<string, unknown>>;
  public readonly wishlistsCol: DocumentCollection<WishlistDocument & Record<string, unknown>>;
  public readonly addressesCol: DocumentCollection<DeliveryAddress & Record<string, unknown>>;
  public readonly ordersCol: DocumentCollection<OrderDocument & Record<string, unknown>>;

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
  }

  registerPolicies(conflicts: ConflictManager): void {
    // Inventory & products are strictly server authoritative — client LWW is prohibited
    conflicts.registerPolicy('product', 'SERVER_AUTHORITATIVE');

    // Orders require manual/user-guided resolution when validation fails — never silently merged
    conflicts.registerPolicy('order', 'MANUAL_RESOLUTION');

    // Wishlist uses deterministic LWW / set semantics
    conflicts.registerPolicy('wishlist', 'LAST_WRITE_WINS_DETERMINISTIC');

    // Cart uses domain-custom delta merging for increment/decrement, and escalates
    // explicit conflicting absolute snapshot edits to MANUAL_RESOLUTION
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

  /**
   * Explicitly rejects client attempts to overwrite authoritative server inventory/prices.
   */
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
      productId?: string;
      delta?: number;
      quantity?: number;
      items?: Array<{ productId: string; quantity: number }>;
    };

    // Detect concurrent version conflict on absolute overwrites (CART_ITEM_SET_QTY / CART_SET_SNAPSHOT)
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
      const productId = payload.productId;
      if (!productId) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: 'Missing productId in cart delta operation',
        };
      }
      const product = this.productsCol.findById(productId);
      if (!product) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Product "${productId}" not found`,
        };
      }

      const rawDelta =
        operation.operationType === 'CART_ITEM_DECREMENT'
          ? -Math.abs(payload.delta ?? 1)
          : Math.abs(payload.delta ?? payload.quantity ?? 1);

      const idx = nextItems.findIndex((i) => i.productId === productId);
      if (idx >= 0) {
        const updatedQty = nextItems[idx].quantity + rawDelta;
        if (updatedQty <= 0) {
          nextItems.splice(idx, 1);
        } else {
          nextItems[idx].quantity = Math.min(updatedQty, Math.max(product.stock, 1));
          nextItems[idx].cachedPrice = product.price;
          nextItems[idx].name = product.name;
          nextItems[idx].imageUrl = product.imageUrl;
        }
      } else if (rawDelta > 0) {
        nextItems.push({
          productId: product.productId,
          name: product.name,
          imageUrl: product.imageUrl,
          quantity: Math.min(rawDelta, Math.max(product.stock, 1)),
          cachedPrice: product.price,
        });
      }

      // If client had a stale baseVersion, record a domain-resolved conflict audit entry
      if (existing.version > 0 && operation.baseVersion < existing.version) {
        ctx.raiseConflict({
          operation,
          remoteVersion: existing.version,
          remoteState: existing as unknown as Record<string, unknown>,
          conflictType: 'CONCURRENT_EDIT',
          overridePolicy: 'DOMAIN_CUSTOM',
          summary: `Merged cart delta (${rawDelta > 0 ? '+' : ''}${rawDelta} of ${productId}) onto server cart v${existing.version}.`,
        });
      }
    } else if (operation.operationType === 'CART_ITEM_SET_QTY') {
      const productId = payload.productId;
      const qty = Number(payload.quantity ?? 0);
      if (!productId) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: 'Missing productId in CART_ITEM_SET_QTY',
        };
      }
      const product = this.productsCol.findById(productId);
      if (!product) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: `Product "${productId}" not found`,
        };
      }
      const idx = nextItems.findIndex((i) => i.productId === productId);
      if (qty <= 0) {
        if (idx >= 0) nextItems.splice(idx, 1);
      } else if (idx >= 0) {
        nextItems[idx].quantity = qty;
        nextItems[idx].cachedPrice = product.price;
      } else {
        nextItems.push({
          productId: product.productId,
          name: product.name,
          imageUrl: product.imageUrl,
          quantity: qty,
          cachedPrice: product.price,
        });
      }
    } else if (operation.operationType === 'CART_ITEM_REMOVE') {
      const productId = payload.productId;
      const idx = nextItems.findIndex((i) => i.productId === productId);
      if (idx >= 0) nextItems.splice(idx, 1);
    } else if (operation.operationType === 'CART_CLEAR') {
      nextItems.length = 0;
    } else if (operation.operationType === 'CART_SET_SNAPSHOT' && Array.isArray(payload.items)) {
      nextItems.length = 0;
      for (const item of payload.items) {
        const product = this.productsCol.findById(item.productId);
        if (product && item.quantity > 0) {
          nextItems.push({
            productId: product.productId,
            name: product.name,
            imageUrl: product.imageUrl,
            quantity: item.quantity,
            cachedPrice: product.price,
          });
        }
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

    const payload = operation.payload as { productId?: string };
    if (!payload.productId) {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: 'Missing productId in wishlist operation',
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
      const payload = operation.payload as { clientOrderId?: string };
      const key = payload.clientOrderId || operation.entityId;
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

      // Restore reserved stock if order was previously confirmed
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
        clientOrderId: string;
        items: OrderItem[];
      };
      const existing = this.ordersCol.findByUniqueIndex(
        'uniq_client_order_id',
        payload.clientOrderId || operation.entityId
      );
      if (!existing) {
        return {
          operationId: operation.operationId,
          status: 'REJECTED',
          reason: 'Order not found for revised confirmation',
        };
      }
      return this.validateAndFinalizeOrder(
        operation,
        {
          clientOrderId: existing.clientOrderId,
          items: payload.items ?? existing.items,
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
      clientOrderId: string;
      items: OrderItem[];
      deliveryAddressId: string;
      createdLocallyAt?: string;
      notes?: string;
    };

    const clientOrderId = payload.clientOrderId || operation.entityId;
    if (!clientOrderId || !Array.isArray(payload.items) || payload.items.length === 0) {
      return {
        operationId: operation.operationId,
        status: 'REJECTED',
        reason: 'Order intent requires clientOrderId and at least one item',
      };
    }

    // Idempotency guard via unique clientOrderId index
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

    return this.validateAndFinalizeOrder(operation, payload, null, ctx);
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

    const discrepancies: OrderDiscrepancy[] = [];
    const validatedItems: OrderItem[] = [];
    let clientEstimatedTotal = 0;
    let authoritativeTotal = 0;

    for (const item of payload.items) {
      clientEstimatedTotal += Number(item.priceAtCheckout) * Number(item.quantity);
      const product = this.productsCol.findById(item.productId);

      if (!product) {
        discrepancies.push({
          productId: item.productId,
          productName: item.name,
          type: 'PRODUCT_UNAVAILABLE',
          requestedQty: item.quantity,
          availableStock: 0,
          message: `Product "${item.name}" is no longer available.`,
        });
        validatedItems.push({ ...item, availableStock: 0 });
        continue;
      }

      if (item.quantity <= 0 || item.quantity > product.stock) {
        discrepancies.push({
          productId: product.productId,
          productName: product.name,
          type: 'INSUFFICIENT_STOCK',
          requestedQty: item.quantity,
          availableStock: product.stock,
          serverPrice: product.price,
          message: `Requested ${item.quantity} of ${product.name}, but only ${product.stock} in stock.`,
        });
      }

      if (Math.abs(Number(item.priceAtCheckout) - product.price) > 0.001) {
        discrepancies.push({
          productId: product.productId,
          productName: product.name,
          type: 'PRICE_CHANGED',
          clientPrice: item.priceAtCheckout,
          serverPrice: product.price,
          requestedQty: item.quantity,
          availableStock: product.stock,
          message: `Price of ${product.name} changed from $${item.priceAtCheckout} to $${product.price}.`,
        });
      }

      authoritativeTotal += product.price * item.quantity;
      validatedItems.push({
        productId: product.productId,
        name: product.name,
        quantity: item.quantity,
        priceAtCheckout: item.priceAtCheckout,
        authoritativePrice: product.price,
        availableStock: product.stock,
      });
    }

    // If prices or stock changed while offline -> NEVER silently accept!
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

    // All validations passed -> atomically decrement authoritative inventory & confirm order
    for (const item of validatedItems) {
      const product = this.productsCol.findById(item.productId)!;
      const updatedProduct: Product = {
        ...product,
        stock: product.stock - item.quantity,
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

  applyManualConflictResolution(
    conflict: ConflictRecord,
    resolvedPayload: Record<string, unknown> | null,
    ctx: AdapterOperationContext
  ): void {
    const now = new Date().toISOString();

    if (conflict.entityType === 'cart' && resolvedPayload) {
      const existing = this.cartsCol.findById(conflict.entityId);
      const rawItems = Array.isArray(resolvedPayload.items)
        ? (resolvedPayload.items as CartDocument['items'])
        : existing?.items ?? [];

      const updated: CartDocument = {
        cartId: conflict.entityId,
        items: rawItems,
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
    } else if (conflict.entityType === 'order') {
      const existing =
        this.ordersCol.findByUniqueIndex('uniq_client_order_id', conflict.entityId) ??
        this.ordersCol.findById(conflict.entityId);
      if (existing) {
        const updated: OrderDocument = {
          ...existing,
          status:
            resolvedPayload?.orderStatus === 'CANCELLED' ? 'CANCELLED' : 'SERVER_ACCEPTED',
          syncStatus: 'SYNCED',
          discrepancies: [],
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
      }
    }
  }

  /**
   * Authoritative server-side catalog mutation helper (used in Scenario G tests
   * and OfflineSync Monitor simulation tools to trigger genuine price/stock discrepancies).
   */
  updateProductAuthoritative(
    productId: string,
    patch: { price?: number; stock?: number }
  ): Product | null {
    const existing = this.productsCol.findById(productId);
    if (!existing) return null;

    const updated: Product = {
      ...existing,
      price: patch.price !== undefined ? Math.max(1, patch.price) : existing.price,
      stock: patch.stock !== undefined ? Math.max(0, patch.stock) : existing.stock,
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
