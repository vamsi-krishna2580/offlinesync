import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock } from 'lucide-react';
import { useShop } from '../context/ShopContext';

export const OrderDetailPage: React.FC = () => {
  const { orderId } = useParams<{ orderId: string }>();
  const { orders, acceptRevisedOrder, cancelOrder } = useShop();

  const order = orders.find(
    (o) => o.clientOrderId === orderId || o.orderId === orderId
  );

  if (!order) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-16 text-center">
        <h1 className="font-shop-display text-2xl font-bold text-[#141413]">
          Order record not found
        </h1>
        <Link
          to="/orders"
          className="inline-flex items-center gap-2 mt-6 px-4 py-2 rounded-lg bg-[#141413] text-white text-sm font-medium"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Orders</span>
        </Link>
      </div>
    );
  }

  const isPendingSync = order.status === 'PENDING_SYNC' || order.status === 'SYNCING';
  const requiresAction = order.status === 'REQUIRES_ACTION';
  const isConfirmed =
    order.status === 'CONFIRMED' || order.status === 'SERVER_ACCEPTED';

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <Link
        to="/orders"
        className="inline-flex items-center gap-1.5 text-sm text-[#5C5B57] hover:text-[#141413] mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Orders</span>
      </Link>

      <div className="bg-white border border-[#E6E5E0] rounded-2xl p-6 sm:p-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-6 border-b border-[#ECEBE6]">
          <div>
            <p className="text-xs font-mono-tabular text-[#6B6A65]">
              Client Idempotency Key: {order.clientOrderId}
            </p>
            <h1 className="font-shop-display text-2xl font-bold text-[#141413] mt-1">
              Order {order.orderId}
            </h1>
            <p className="text-xs font-mono-tabular text-[#5C5B57] mt-1">
              Created locally: {new Date(order.createdLocallyAt).toLocaleString()}
              {order.syncedAt && ` · Verified: ${new Date(order.syncedAt).toLocaleString()}`}
            </p>
          </div>

          <div className="inline-flex items-center gap-2 text-sm font-semibold">
            {isConfirmed && <CheckCircle2 className="w-5 h-5 text-[#0D6E52]" />}
            {isPendingSync && <Clock className="w-5 h-5 text-[#B45309]" />}
            {requiresAction && <AlertTriangle className="w-5 h-5 text-[#B91C1C]" />}
            <span
              className={
                isConfirmed
                  ? 'text-[#0D6E52]'
                  : requiresAction
                  ? 'text-[#B91C1C]'
                  : isPendingSync
                  ? 'text-[#B45309]'
                  : 'text-[#5C5B57]'
              }
            >
              {order.status.replace('_', ' ')}
            </span>
          </div>
        </div>

        {/* Action Required Banner when Server Price or Stock Changed */}
        {requiresAction && (
          <div className="mt-6 p-5 rounded-xl bg-[#FEF2F2] border border-[#FECACA]">
            <h2 className="font-shop-display text-sm font-semibold text-[#991B1B]">
              Server Validation Requires Your Confirmation
            </h2>
            <p className="text-xs text-[#7F1D1D] mt-1 leading-relaxed">
              Prices or inventory changed on the server while this order intent was offline.
              OfflineSync never silently overrides authoritative totals or inventory.
            </p>
            <ul className="mt-3 space-y-1.5 text-xs text-[#7F1D1D] list-disc pl-5">
              {order.discrepancies.map((d, idx) => (
                <li key={`${d.productId}-${idx}`}>{d.message}</li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void acceptRevisedOrder(order)}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-[#0D6E52] text-white hover:bg-[#0A5942] cursor-pointer"
              >
                Accept Updated Price / Available Stock
              </button>
              <button
                type="button"
                onClick={() => void cancelOrder(order)}
                className="px-4 py-2 rounded-lg text-xs font-medium border border-[#FCA5A5] bg-white text-[#991B1B] hover:bg-[#FEE2E2] cursor-pointer"
              >
                Cancel Order
              </button>
            </div>
          </div>
        )}

        {/* Offline Intent Notice */}
        {isPendingSync && (
          <div className="mt-6 p-4 rounded-xl bg-[#FFFBEB] border border-[#FDE68A] text-xs text-[#92400E] leading-relaxed">
            This is a local order intent persisted in IndexedDB. It is not yet confirmed by the
            server, and payment remains <span className="font-mono-tabular">NOT_PROCESSED</span>.
            Once online, OfflineSync will automatically validate prices and stock.
          </div>
        )}

        {/* Line Items */}
        <div className="mt-8">
          <h2 className="font-shop-display text-sm font-semibold text-[#141413] mb-3">
            Order Items
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-[#ECEBE6] text-xs text-[#6B6A65]">
                  <th className="py-2.5 font-medium">Product</th>
                  <th className="py-2.5 font-medium text-right">Qty</th>
                  <th className="py-2.5 font-medium text-right">Price at Checkout</th>
                  <th className="py-2.5 font-medium text-right">Server Price</th>
                  <th className="py-2.5 font-medium text-right">Line Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F3F2EE]">
                {order.items.map((item) => {
                  const unit = item.authoritativePrice ?? item.priceAtCheckout;
                  return (
                    <tr key={item.productId}>
                      <td className="py-3 font-medium text-[#141413]">
                        {item.name}
                        <span className="block text-xs font-mono-tabular text-[#6B6A65]">
                          {item.productId}
                        </span>
                      </td>
                      <td className="py-3 text-right font-mono-tabular">{item.quantity}</td>
                      <td className="py-3 text-right font-mono-tabular text-[#5C5B57]">
                        ${item.priceAtCheckout.toFixed(2)}
                      </td>
                      <td className="py-3 text-right font-mono-tabular">
                        {item.authoritativePrice !== undefined
                          ? `$${item.authoritativePrice.toFixed(2)}`
                          : 'Pending'}
                      </td>
                      <td className="py-3 text-right font-mono-tabular font-semibold">
                        ${(unit * item.quantity).toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Totals & Delivery Snapshot */}
        <div className="mt-8 pt-6 border-t border-[#ECEBE6] grid grid-cols-1 sm:grid-cols-2 gap-8">
          <div>
            <h3 className="font-shop-display text-sm font-semibold text-[#141413] mb-2">
              Delivery &amp; Payment
            </h3>
            {order.deliveryAddressSnapshot ? (
              <div className="text-xs text-[#5C5B57] space-y-0.5">
                <p className="font-medium text-[#141413]">
                  {order.deliveryAddressSnapshot.recipientName} (
                  {order.deliveryAddressSnapshot.label})
                </p>
                <p>{order.deliveryAddressSnapshot.street}</p>
                <p>
                  {order.deliveryAddressSnapshot.city}, {order.deliveryAddressSnapshot.state}{' '}
                  {order.deliveryAddressSnapshot.postalCode}
                </p>
                <p className="font-mono-tabular">{order.deliveryAddressSnapshot.phone}</p>
              </div>
            ) : (
              <p className="text-xs font-mono-tabular text-[#5C5B57]">
                Address ID: {order.deliveryAddressId}
              </p>
            )}
            <p className="text-xs text-[#5C5B57] mt-3">
              Payment: <span className="font-medium text-[#141413]">{order.paymentIntent.method}</span>{' '}
              · <span className="font-mono-tabular">{order.paymentIntent.status}</span>
            </p>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-[#5C5B57]">Client Estimated Total</span>
              <span className="font-mono-tabular">${order.clientEstimatedTotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-semibold text-base pt-2 border-t border-[#ECEBE6]">
              <span>Authoritative Server Total</span>
              <span className="font-mono-tabular">
                {order.authoritativeTotal !== null
                  ? `$${order.authoritativeTotal.toFixed(2)}`
                  : 'Awaiting Sync'}
              </span>
            </div>

            {order.status !== 'CANCELLED' && order.status !== 'REJECTED' && !requiresAction && (
              <div className="pt-4 text-right">
                <button
                  type="button"
                  onClick={() => void cancelOrder(order)}
                  className="text-xs font-medium text-[#7A7872] hover:text-[#B91C1C] underline cursor-pointer"
                >
                  Cancel Order
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
