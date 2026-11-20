import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type {
  CartDocument,
  DeliveryAddress,
  OrderDocument,
  OrderItem,
  Product,
  WishlistDocument,
} from '../../../backend/shop-adapter/types';
import type { SyncStatusSnapshot } from '../../../packages/offlinesync-client';
import type { OperationOutcome, SyncOperation } from '../../../packages/offlinesync-types';
import { getShopSyncEngine } from '../db/shopSyncClient';

const DEFAULT_CART_ID = 'primary-cart';
const DEFAULT_WISHLIST_ID = 'primary-wishlist';

interface ToastMessage {
  id: string;
  text: string;
  tone: 'neutral' | 'success' | 'warn';
}

interface ShopContextValue {
  ready: boolean;
  products: Product[];
  categories: string[];
  addresses: DeliveryAddress[];
  cart: CartDocument;
  wishlist: WishlistDocument;
  orders: OrderDocument[];
  syncStatus: SyncStatusSnapshot | null;
  toast: ToastMessage | null;
  dismissToast: () => void;
  addToCart: (product: Product, quantity?: number) => Promise<void>;
  incrementCartItem: (productId: string) => Promise<void>;
  decrementCartItem: (productId: string) => Promise<void>;
  removeCartItem: (productId: string) => Promise<void>;
  toggleWishlist: (productId: string) => Promise<void>;
  placeOfflineOrder: (params: {
    deliveryAddressId: string;
    notes?: string;
  }) => Promise<OrderDocument>;
  acceptRevisedOrder: (order: OrderDocument) => Promise<void>;
  cancelOrder: (order: OrderDocument) => Promise<void>;
  toggleSimulatedOffline: () => void;
  triggerSyncNow: () => Promise<void>;
}

const ShopContext = createContext<ShopContextValue | null>(null);

const EMPTY_CART: CartDocument = {
  cartId: DEFAULT_CART_ID,
  items: [],
  version: 0,
  updatedAt: '',
};

const EMPTY_WISHLIST: WishlistDocument = {
  wishlistId: DEFAULT_WISHLIST_ID,
  productIds: [],
  version: 0,
  updatedAt: '',
};

export const ShopProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const engine = useMemo(() => getShopSyncEngine(), []);

  const [ready, setReady] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [addresses, setAddresses] = useState<DeliveryAddress[]>([]);
  const [cart, setCart] = useState<CartDocument>(EMPTY_CART);
  const [wishlist, setWishlist] = useState<WishlistDocument>(EMPTY_WISHLIST);
  const [orders, setOrders] = useState<OrderDocument[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback(
    (text: string, tone: ToastMessage['tone'] = 'neutral') => {
      const id = `${Date.now()}-${Math.random()}`;
      setToast({ id, text, tone });
      setTimeout(() => {
        setToast((prev) => (prev?.id === id ? null : prev));
      }, 3600);
    },
    []
  );

  const dismissToast = useCallback(() => setToast(null), []);

  /**
   * Local-First Read Path:
   * Always hydrate UI state directly from IndexedDB first so the app works
   * instantaneously both online and offline, even after a full browser refresh.
   */
  const hydrateFromIndexedDB = useCallback(async () => {
    const [storedProducts, storedAddresses, storedCart, storedWishlist, storedOrders] =
      await Promise.all([
        engine.getLocalEntities<Product>('product'),
        engine.getLocalEntities<DeliveryAddress>('address'),
        engine.getLocalEntity<CartDocument>('cart', DEFAULT_CART_ID),
        engine.getLocalEntity<WishlistDocument>('wishlist', DEFAULT_WISHLIST_ID),
        engine.getLocalEntities<OrderDocument>('order'),
      ]);

    setProducts(
      storedProducts
        .map((e) => e.data)
        .sort((a, b) => a.productId.localeCompare(b.productId))
    );
    setAddresses(storedAddresses.map((e) => e.data));
    if (storedCart?.data) {
      setCart(storedCart.data);
    } else {
      setCart(EMPTY_CART);
    }
    if (storedWishlist?.data) {
      setWishlist(storedWishlist.data);
    } else {
      setWishlist(EMPTY_WISHLIST);
    }
    setOrders(
      storedOrders
        .map((e) => e.data)
        .sort((a, b) => b.createdLocallyAt.localeCompare(a.createdLocallyAt))
    );
  }, [engine]);

  useEffect(() => {
    let active = true;

    const handleOperationOutcome = async (
      op: SyncOperation,
      outcome: OperationOutcome
    ) => {
      if (op.entityType === 'order' && outcome.serverData) {
        const orderDoc = outcome.serverData as unknown as OrderDocument;
        await engine.upsertLocalEntity('order', orderDoc.clientOrderId, orderDoc, {
          version: orderDoc.version,
          dirty: false,
        });
        if (outcome.status === 'REQUIRES_ACTION') {
          showToast(
            `Order ${orderDoc.orderId} requires your confirmation due to catalog changes.`,
            'warn'
          );
        } else if (outcome.status === 'ACKNOWLEDGED') {
          showToast(`Order ${orderDoc.orderId} confirmed by server.`, 'success');
        }
      }
      if (active) {
        await hydrateFromIndexedDB();
      }
    };

    engine.registerAdapter({
      name: 'offline-shop-ui-reconciler',
      onRemoteChangeApplied: async () => {
        if (active) await hydrateFromIndexedDB();
      },
      onOperationOutcome: handleOperationOutcome,
    });

    const unsub = engine.subscribe((status) => {
      if (active) setSyncStatus(status);
    });

    (async () => {
      const initialStatus = await engine.initialize();
      if (!active) return;
      setSyncStatus(initialStatus);

      // 1. Read local IndexedDB immediately (zero network dependency)
      await hydrateFromIndexedDB();
      if (!active) return;
      setReady(true);

      // 2. Background sync to pull initial catalog or flush queued offline ops
      if (engine.network.isOnline()) {
        await engine.syncNow();
        if (active) {
          await hydrateFromIndexedDB();
        }
      }
    })();

    return () => {
      active = false;
      unsub();
    };
  }, [engine, hydrateFromIndexedDB, showToast]);

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category));
    return ['All', ...Array.from(set).sort()];
  }, [products]);

  const addToCart = useCallback(
    async (product: Product, quantity = 1) => {
      const existing = await engine.getLocalEntity<CartDocument>('cart', DEFAULT_CART_ID);
      const currentCart = existing?.data ?? EMPTY_CART;
      const nextItems = currentCart.items.map((i) => ({ ...i }));
      const idx = nextItems.findIndex((i) => i.productId === product.productId);
      if (idx >= 0) {
        nextItems[idx].quantity += quantity;
      } else {
        nextItems.push({
          productId: product.productId,
          name: product.name,
          imageUrl: product.imageUrl,
          quantity,
          cachedPrice: product.price,
        });
      }

      const updated: CartDocument = {
        cartId: DEFAULT_CART_ID,
        items: nextItems,
        version: currentCart.version,
        updatedAt: new Date().toISOString(),
      };

      await engine.upsertLocalEntity('cart', DEFAULT_CART_ID, updated, {
        version: currentCart.version,
        dirty: true,
      });
      setCart(updated);

      await engine.createOperation({
        entityType: 'cart',
        entityId: DEFAULT_CART_ID,
        operationType: 'CART_ITEM_ADD',
        baseVersion: currentCart.version,
        payload: { productId: product.productId, delta: quantity },
      });

      showToast(
        engine.network.isOnline()
          ? `Added ${product.name} to bag.`
          : `Added ${product.name} to bag (saved locally offline).`,
        'success'
      );
    },
    [engine, showToast]
  );

  const incrementCartItem = useCallback(
    async (productId: string) => {
      const existing = await engine.getLocalEntity<CartDocument>('cart', DEFAULT_CART_ID);
      const currentCart = existing?.data ?? EMPTY_CART;
      const nextItems = currentCart.items.map((item) =>
        item.productId === productId
          ? { ...item, quantity: item.quantity + 1 }
          : { ...item }
      );
      const updated: CartDocument = {
        ...currentCart,
        items: nextItems,
        updatedAt: new Date().toISOString(),
      };
      await engine.upsertLocalEntity('cart', DEFAULT_CART_ID, updated, {
        version: currentCart.version,
        dirty: true,
      });
      setCart(updated);

      await engine.createOperation({
        entityType: 'cart',
        entityId: DEFAULT_CART_ID,
        operationType: 'CART_ITEM_INCREMENT',
        baseVersion: currentCart.version,
        payload: { productId, delta: 1 },
      });
    },
    [engine]
  );

  const decrementCartItem = useCallback(
    async (productId: string) => {
      const existing = await engine.getLocalEntity<CartDocument>('cart', DEFAULT_CART_ID);
      const currentCart = existing?.data ?? EMPTY_CART;
      const nextItems = currentCart.items
        .map((item) =>
          item.productId === productId
            ? { ...item, quantity: item.quantity - 1 }
            : { ...item }
        )
        .filter((item) => item.quantity > 0);
      const updated: CartDocument = {
        ...currentCart,
        items: nextItems,
        updatedAt: new Date().toISOString(),
      };
      await engine.upsertLocalEntity('cart', DEFAULT_CART_ID, updated, {
        version: currentCart.version,
        dirty: true,
      });
      setCart(updated);

      await engine.createOperation({
        entityType: 'cart',
        entityId: DEFAULT_CART_ID,
        operationType: 'CART_ITEM_DECREMENT',
        baseVersion: currentCart.version,
        payload: { productId, delta: 1 },
      });
    },
    [engine]
  );

  const removeCartItem = useCallback(
    async (productId: string) => {
      const existing = await engine.getLocalEntity<CartDocument>('cart', DEFAULT_CART_ID);
      const currentCart = existing?.data ?? EMPTY_CART;
      const updated: CartDocument = {
        ...currentCart,
        items: currentCart.items.filter((i) => i.productId !== productId),
        updatedAt: new Date().toISOString(),
      };
      await engine.upsertLocalEntity('cart', DEFAULT_CART_ID, updated, {
        version: currentCart.version,
        dirty: true,
      });
      setCart(updated);

      await engine.createOperation({
        entityType: 'cart',
        entityId: DEFAULT_CART_ID,
        operationType: 'CART_ITEM_REMOVE',
        baseVersion: currentCart.version,
        payload: { productId },
      });
    },
    [engine]
  );

  const toggleWishlist = useCallback(
    async (productId: string) => {
      const existing = await engine.getLocalEntity<WishlistDocument>(
        'wishlist',
        DEFAULT_WISHLIST_ID
      );
      const current = existing?.data ?? EMPTY_WISHLIST;
      const exists = current.productIds.includes(productId);
      const nextIds = exists
        ? current.productIds.filter((id) => id !== productId)
        : [...current.productIds, productId];

      const updated: WishlistDocument = {
        wishlistId: DEFAULT_WISHLIST_ID,
        productIds: nextIds,
        version: current.version,
        updatedAt: new Date().toISOString(),
      };

      await engine.upsertLocalEntity('wishlist', DEFAULT_WISHLIST_ID, updated, {
        version: current.version,
        dirty: true,
      });
      setWishlist(updated);

      await engine.createOperation({
        entityType: 'wishlist',
        entityId: DEFAULT_WISHLIST_ID,
        operationType: exists ? 'WISHLIST_REMOVE' : 'WISHLIST_ADD',
        baseVersion: current.version,
        payload: { productId },
      });

      showToast(exists ? 'Removed from wishlist.' : 'Saved to wishlist.', 'neutral');
    },
    [engine, showToast]
  );

  const placeOfflineOrder = useCallback(
    async (params: { deliveryAddressId: string; notes?: string }): Promise<OrderDocument> => {
      const now = new Date().toISOString();
      const clientOrderId = `CLI-${Date.now().toString(36).toUpperCase()}-${Math.random()
        .toString(36)
        .slice(2, 6)
        .toUpperCase()}`;

      const selectedAddress = addresses.find(
        (a) => a.addressId === params.deliveryAddressId
      );

      const items: OrderItem[] = cart.items.map((item) => {
        const latestProd = products.find((p) => p.productId === item.productId);
        return {
          productId: item.productId,
          name: item.name,
          quantity: item.quantity,
          priceAtCheckout: latestProd?.price ?? item.cachedPrice,
        };
      });

      const estimatedTotal = items.reduce(
        (sum, item) => sum + item.priceAtCheckout * item.quantity,
        0
      );

      const localOrder: OrderDocument = {
        orderId: clientOrderId,
        clientOrderId,
        deviceId: engine.getDeviceId(),
        status: 'PENDING_SYNC',
        items,
        deliveryAddressId: params.deliveryAddressId,
        deliveryAddressSnapshot: selectedAddress,
        paymentIntent: {
          method: 'COD',
          status: 'NOT_PROCESSED',
        },
        clientEstimatedTotal: Math.round(estimatedTotal * 100) / 100,
        authoritativeTotal: null,
        discrepancies: [],
        createdLocallyAt: now,
        syncedAt: null,
        syncStatus: 'PENDING',
        version: 0,
        updatedAt: now,
        notes: params.notes,
      };

      // 1. Persist local order intent immediately in IndexedDB
      await engine.upsertLocalEntity('order', clientOrderId, localOrder, {
        version: 0,
        dirty: true,
      });

      // 2. Clear local cart immediately
      const emptyCart: CartDocument = {
        cartId: DEFAULT_CART_ID,
        items: [],
        version: cart.version,
        updatedAt: now,
      };
      await engine.upsertLocalEntity('cart', DEFAULT_CART_ID, emptyCart, {
        version: cart.version,
        dirty: true,
      });
      setCart(emptyCart);

      // 3. Enqueue ORDER_CREATE + dependent CART_CLEAR operations
      const { operation: orderOp } = await engine.createOperation({
        entityType: 'order',
        entityId: clientOrderId,
        operationType: 'ORDER_CREATE',
        baseVersion: 0,
        payload: {
          clientOrderId,
          items,
          deliveryAddressId: params.deliveryAddressId,
          createdLocallyAt: now,
          notes: params.notes,
        },
        triggerBackgroundSync: false,
      });

      await engine.createOperation({
        entityType: 'cart',
        entityId: DEFAULT_CART_ID,
        operationType: 'CART_CLEAR',
        baseVersion: cart.version,
        payload: {},
        dependsOn: [orderOp.operationId],
        triggerBackgroundSync: true,
      });

      await hydrateFromIndexedDB();

      showToast(
        engine.network.isOnline()
          ? 'Order intent submitted for server verification.'
          : 'Order intent saved offline. It will sync automatically when online.',
        engine.network.isOnline() ? 'success' : 'warn'
      );

      return localOrder;
    },
    [addresses, cart, engine, hydrateFromIndexedDB, products, showToast]
  );

  const acceptRevisedOrder = useCallback(
    async (order: OrderDocument) => {
      const revisedItems: OrderItem[] = order.items
        .map((item) => {
          const maxAvail =
            item.availableStock !== undefined ? item.availableStock : item.quantity;
          return {
            ...item,
            quantity: Math.min(item.quantity, maxAvail),
            priceAtCheckout: item.authoritativePrice ?? item.priceAtCheckout,
          };
        })
        .filter((i) => i.quantity > 0);

      if (revisedItems.length === 0) {
        showToast('No items remain in stock; please cancel this order.', 'warn');
        return;
      }

      const updatedLocal: OrderDocument = {
        ...order,
        items: revisedItems,
        status: 'SYNCING',
        syncStatus: 'SYNCING',
        updatedAt: new Date().toISOString(),
      };
      await engine.upsertLocalEntity('order', order.clientOrderId, updatedLocal, {
        version: order.version,
        dirty: true,
      });
      await hydrateFromIndexedDB();

      await engine.createOperation({
        entityType: 'order',
        entityId: order.clientOrderId,
        operationType: 'ORDER_ACCEPT_REVISED',
        baseVersion: order.version,
        payload: {
          clientOrderId: order.clientOrderId,
          items: revisedItems,
        },
      });
    },
    [engine, hydrateFromIndexedDB, showToast]
  );

  const cancelOrder = useCallback(
    async (order: OrderDocument) => {
      const updatedLocal: OrderDocument = {
        ...order,
        status: 'CANCELLED',
        syncStatus: engine.network.isOnline() ? 'SYNCING' : 'PENDING',
        paymentIntent: { ...order.paymentIntent, status: 'CANCELLED' },
        updatedAt: new Date().toISOString(),
      };
      await engine.upsertLocalEntity('order', order.clientOrderId, updatedLocal, {
        version: order.version,
        dirty: true,
      });
      await hydrateFromIndexedDB();

      await engine.createOperation({
        entityType: 'order',
        entityId: order.clientOrderId,
        operationType: 'ORDER_CANCEL',
        baseVersion: order.version,
        payload: { clientOrderId: order.clientOrderId },
      });

      showToast(`Cancellation queued for order ${order.orderId}.`, 'neutral');
    },
    [engine, hydrateFromIndexedDB, showToast]
  );

  const toggleSimulatedOffline = useCallback(() => {
    const nextOffline = !engine.network.isSimulatedOffline();
    engine.setSimulatedOffline(nextOffline);
    showToast(
      nextOffline
        ? 'Offline mode active. All browsing, cart, and checkout actions now persist locally in IndexedDB.'
        : 'Connection restored. Synchronizing queued operations in background.',
      nextOffline ? 'warn' : 'success'
    );
  }, [engine, showToast]);

  const triggerSyncNow = useCallback(async () => {
    const res = await engine.syncNow({ ignoreBackoff: true });
    await hydrateFromIndexedDB();
    if (!res.success && res.error) {
      showToast(`Sync deferred: ${res.error}`, 'warn');
    } else if (res.operationsSent > 0 || res.remoteChangesApplied > 0) {
      showToast(
        `Synchronized ${res.acknowledgedCount} ops and ${res.remoteChangesApplied} catalog updates.`,
        'success'
      );
    } else {
      showToast('Local state is up to date with server.', 'neutral');
    }
  }, [engine, hydrateFromIndexedDB, showToast]);

  const value: ShopContextValue = {
    ready,
    products,
    categories,
    addresses,
    cart,
    wishlist,
    orders,
    syncStatus,
    toast,
    dismissToast,
    addToCart,
    incrementCartItem,
    decrementCartItem,
    removeCartItem,
    toggleWishlist,
    placeOfflineOrder,
    acceptRevisedOrder,
    cancelOrder,
    toggleSimulatedOffline,
    triggerSyncNow,
  };

  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
};

export function useShop(): ShopContextValue {
  const ctx = useContext(ShopContext);
  if (!ctx) {
    throw new Error('useShop must be used within ShopProvider');
  }
  return ctx;
}
