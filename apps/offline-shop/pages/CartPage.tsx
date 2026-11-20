import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { useShop } from '../context/ShopContext';

export const CartPage: React.FC = () => {
  const {
    cart,
    products,
    incrementCartItem,
    decrementCartItem,
    removeCartItem,
    syncStatus,
  } = useShop();

  const itemsWithLiveCache = cart.items.map((item) => {
    const prod = products.find((p) => p.productId === item.productId);
    const unitPrice = prod?.price ?? item.cachedPrice;
    return { ...item, unitPrice, lineTotal: unitPrice * item.quantity };
  });

  const subtotal = itemsWithLiveCache.reduce((acc, i) => acc + i.lineTotal, 0);
  const isOnline = syncStatus ? syncStatus.connectionStatus === 'ONLINE' : true;

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <div className="pb-6 border-b border-[#E6E5E0]">
        <h1 className="font-shop-display text-3xl font-bold tracking-tight text-[#141413]">
          Shopping Bag
        </h1>
        <p className="text-sm text-[#5C5B57] mt-1">
          Quantity adjustments are queued as operation-based deltas and survive offline refreshes.
        </p>
      </div>

      {itemsWithLiveCache.length === 0 ? (
        <div className="mt-10 p-14 text-center bg-white border border-[#E6E5E0] rounded-xl">
          <ShoppingBag className="w-8 h-8 text-[#8C8A82] mx-auto mb-3" />
          <h2 className="font-shop-display text-lg font-semibold text-[#141413]">
            Your bag is empty
          </h2>
          <p className="text-sm text-[#5C5B57] mt-1">
            Add products from the catalog — works identically whether online or offline.
          </p>
          <Link
            to="/catalog"
            className="inline-flex items-center gap-2 mt-6 px-5 py-2.5 rounded-lg bg-[#0D6E52] text-white text-sm font-medium hover:bg-[#0A5942] transition-colors"
          >
            <span>Browse Catalog</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          {/* Item List */}
          <div className="lg:col-span-8 bg-white border border-[#E6E5E0] rounded-xl divide-y divide-[#ECEBE6]">
            {itemsWithLiveCache.map((item) => (
              <div
                key={item.productId}
                className="p-5 flex flex-col sm:flex-row sm:items-center gap-5"
              >
                <Link
                  to={`/product/${item.productId}`}
                  className="w-24 h-20 rounded-lg overflow-hidden bg-[#EEEDE8] shrink-0 border border-[#E6E5E0]"
                >
                  <img
                    src={item.imageUrl}
                    alt={item.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </Link>

                <div className="flex-1 min-w-0">
                  <Link
                    to={`/product/${item.productId}`}
                    className="font-shop-display text-base font-semibold text-[#141413] hover:text-[#0D6E52] block truncate"
                  >
                    {item.name}
                  </Link>
                  <p className="text-xs font-mono-tabular text-[#6B6A65] mt-1">
                    ${item.unitPrice.toFixed(2)} each · ID {item.productId}
                  </p>
                </div>

                <div className="flex items-center justify-between sm:justify-end gap-5">
                  <div className="inline-flex items-center border border-[#D4D2C9] rounded-lg">
                    <button
                      type="button"
                      onClick={() => void decrementCartItem(item.productId)}
                      aria-label={`Decrease quantity of ${item.name}`}
                      className="p-2 text-[#5C5B57] hover:text-[#141413] cursor-pointer"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                    <span className="w-9 text-center font-mono-tabular text-sm font-medium">
                      {item.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => void incrementCartItem(item.productId)}
                      aria-label={`Increase quantity of ${item.name}`}
                      className="p-2 text-[#5C5B57] hover:text-[#141413] cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <span className="font-mono-tabular text-sm font-semibold text-[#141413] w-20 text-right">
                    ${item.lineTotal.toFixed(2)}
                  </span>

                  <button
                    type="button"
                    onClick={() => void removeCartItem(item.productId)}
                    aria-label={`Remove ${item.name}`}
                    className="p-2 text-[#7A7872] hover:text-[#B91C1C] transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Summary Panel */}
          <aside className="lg:col-span-4 bg-white border border-[#E6E5E0] rounded-xl p-6">
            <h2 className="font-shop-display text-base font-semibold text-[#141413]">
              Order Estimate
            </h2>
            <dl className="mt-4 space-y-3 text-sm border-b border-[#ECEBE6] pb-4">
              <div className="flex justify-between">
                <dt className="text-[#5C5B57]">Estimated Subtotal</dt>
                <dd className="font-mono-tabular font-medium text-[#141413]">
                  ${subtotal.toFixed(2)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[#5C5B57]">Delivery</dt>
                <dd className="text-[#0D6E52] font-medium">Complimentary</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[#5C5B57]">Payment Terms</dt>
                <dd className="text-[#141413]">Cash on Delivery (COD)</dd>
              </div>
            </dl>

            <div className="flex justify-between items-baseline py-4">
              <span className="text-sm font-semibold text-[#141413]">Estimated Total</span>
              <span className="font-mono-tabular text-xl font-bold text-[#141413]">
                ${subtotal.toFixed(2)}
              </span>
            </div>

            {!isOnline && (
              <p className="text-xs text-[#92400E] bg-[#FEF3C7] border border-[#F59E0B]/40 rounded-lg p-3 mb-4 leading-relaxed">
                You are offline. Checkout will record a local COD order intent and verify
                authoritative pricing &amp; stock once connectivity returns.
              </p>
            )}

            <Link
              to="/checkout"
              className="w-full inline-flex items-center justify-center gap-2 py-3 px-4 rounded-lg bg-[#0D6E52] text-white text-sm font-medium hover:bg-[#0A5942] transition-colors"
            >
              <span>Proceed to Checkout</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </aside>
        </div>
      )}
    </div>
  );
};
