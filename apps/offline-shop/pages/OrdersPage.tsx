import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Package } from 'lucide-react';
import type { OrderStatus } from '../../../backend/shop-adapter/types';
import { useShop } from '../context/ShopContext';

function statusMeta(status: OrderStatus): { label: string; colorClass: string } {
  switch (status) {
    case 'CONFIRMED':
    case 'SERVER_ACCEPTED':
      return { label: status.replace('_', ' '), colorClass: 'text-[#0D6E52]' };
    case 'REQUIRES_ACTION':
      return { label: 'Requires Action', colorClass: 'text-[#B91C1C]' };
    case 'PENDING_SYNC':
    case 'SYNCING':
      return {
        label: status === 'PENDING_SYNC' ? 'Pending Sync (Local Intent)' : 'Syncing...',
        colorClass: 'text-[#B45309]',
      };
    case 'REJECTED':
    case 'CANCELLED':
      return { label: status, colorClass: 'text-[#6B6A65]' };
    default:
      return { label: status, colorClass: 'text-[#141413]' };
  }
}

export const OrdersPage: React.FC = () => {
  const { orders } = useShop();

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <div className="pb-6 border-b border-[#E6E5E0]">
        <h1 className="font-shop-display text-3xl font-bold tracking-tight text-[#141413]">
          Orders &amp; Local Intents
        </h1>
        <p className="text-sm text-[#5C5B57] mt-1">
          Tracks local offline order intents through authoritative server validation and confirmation.
        </p>
      </div>

      {orders.length === 0 ? (
        <div className="mt-10 p-14 text-center bg-white border border-[#E6E5E0] rounded-xl">
          <Package className="w-8 h-8 text-[#8C8A82] mx-auto mb-3" />
          <h2 className="font-shop-display text-lg font-semibold text-[#141413]">
            No orders placed yet
          </h2>
          <p className="text-sm text-[#5C5B57] mt-1">
            Orders created online or offline will appear here immediately from IndexedDB.
          </p>
          <Link
            to="/catalog"
            className="inline-flex items-center gap-2 mt-6 px-5 py-2.5 rounded-lg bg-[#0D6E52] text-white text-sm font-medium"
          >
            <span>Start Shopping</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {orders.map((order) => {
            const meta = statusMeta(order.status);
            const total = order.authoritativeTotal ?? order.clientEstimatedTotal;
            return (
              <Link
                key={order.clientOrderId}
                to={`/orders/${order.clientOrderId}`}
                className="block bg-white border border-[#E6E5E0] rounded-xl p-6 hover:border-[#B8B6AE] transition-colors"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#6B6A65]">
                      <span className="font-mono-tabular font-semibold text-[#141413]">
                        {order.orderId}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono-tabular">
                        {new Date(order.createdLocallyAt).toLocaleString()}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className={`font-medium ${meta.colorClass}`}>{meta.label}</span>
                    </div>
                    <p className="text-sm text-[#141413] font-medium mt-2">
                      {order.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                    </p>
                    {order.discrepancies.length > 0 && (
                      <p className="inline-flex items-center gap-1.5 text-xs text-[#B91C1C] mt-2">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <span>{order.discrepancies[0].message}</span>
                      </p>
                    )}
                  </div>

                  <div className="text-left sm:text-right shrink-0">
                    <p className="font-mono-tabular text-lg font-bold text-[#141413]">
                      ${total.toFixed(2)}
                    </p>
                    <p className="text-xs text-[#6B6A65]">
                      {order.paymentIntent.method} · {order.paymentIntent.status}
                    </p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
};
