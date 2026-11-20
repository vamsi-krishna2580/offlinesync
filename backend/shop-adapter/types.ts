/**
 * OfflineShop domain data models.
 * Strictly isolated from `backend/offlinesync-core` and `packages/offlinesync-client`.
 */

export type OrderStatus =
  | 'PENDING_SYNC'
  | 'SYNCING'
  | 'SERVER_ACCEPTED'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'REQUIRES_ACTION'
  | 'CANCELLED';

export type PaymentMethod = 'COD';
export type PaymentStatus = 'NOT_PROCESSED' | 'COD_PENDING_DELIVERY' | 'CANCELLED';

export interface Product {
  productId: string;
  sku: string;
  name: string;
  category: string;
  tagline: string;
  description: string;
  price: number;
  stock: number;
  imageUrl: string;
  specs: Record<string, string>;
  version: number;
  updatedAt: string;
}

export interface CartItem {
  productId: string;
  name: string;
  imageUrl: string;
  quantity: number;
  cachedPrice: number;
}

export interface CartDocument {
  cartId: string;
  items: CartItem[];
  version: number;
  updatedAt: string;
}

export interface WishlistDocument {
  wishlistId: string;
  productIds: string[];
  version: number;
  updatedAt: string;
}

export interface DeliveryAddress {
  addressId: string;
  label: string;
  recipientName: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefault?: boolean;
  version: number;
  updatedAt: string;
}

export interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  priceAtCheckout: number;
  authoritativePrice?: number;
  availableStock?: number;
}

export interface OrderDiscrepancy {
  productId: string;
  productName: string;
  type: 'PRICE_CHANGED' | 'INSUFFICIENT_STOCK' | 'PRODUCT_UNAVAILABLE';
  clientPrice?: number;
  serverPrice?: number;
  requestedQty?: number;
  availableStock?: number;
  message: string;
}

export interface OrderDocument {
  orderId: string;
  clientOrderId: string;
  deviceId: string;
  status: OrderStatus;
  items: OrderItem[];
  deliveryAddressId: string;
  deliveryAddressSnapshot?: DeliveryAddress;
  paymentIntent: {
    method: PaymentMethod;
    status: PaymentStatus;
  };
  clientEstimatedTotal: number;
  authoritativeTotal: number | null;
  discrepancies: OrderDiscrepancy[];
  createdLocallyAt: string;
  syncedAt: string | null;
  syncStatus: 'PENDING' | 'SYNCING' | 'SYNCED' | 'REQUIRES_ACTION' | 'FAILED';
  version: number;
  updatedAt: string;
  notes?: string;
}
