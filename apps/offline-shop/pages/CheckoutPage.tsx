import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check } from 'lucide-react';
import { useShop } from '../context/ShopContext';

export const CheckoutPage: React.FC = () => {
  const navigate = useNavigate();
  const { cart, products, addresses, syncStatus, placeOfflineOrder } = useShop();

  const [selectedAddressId, setSelectedAddressId] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!selectedAddressId && addresses.length > 0) {
      const def = addresses.find((a) => a.isDefault) ?? addresses[0];
      setSelectedAddressId(def.addressId);
    }
  }, [addresses, selectedAddressId]);

  const isOnline = syncStatus ? syncStatus.connectionStatus === 'ONLINE' : true;

  const lineItems = cart.items.map((item) => {
    const prod = products.find((p) => p.productId === item.productId);
    const price = prod?.price ?? item.cachedPrice;
    return { ...item, price, total: price * item.quantity };
  });

  const estimatedTotal = lineItems.reduce((acc, i) => acc + i.total, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAddressId || lineItems.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const order = await placeOfflineOrder({
        deliveryAddressId: selectedAddressId,
        notes: notes.trim() || undefined,
      });
      navigate(`/orders/${order.clientOrderId}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (lineItems.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h1 className="font-shop-display text-2xl font-bold text-[#141413]">
          No items ready for checkout
        </h1>
        <p className="text-sm text-[#5C5B57] mt-2">
          Add products to your shopping bag before preparing an order.
        </p>
        <Link
          to="/catalog"
          className="inline-flex items-center gap-2 mt-6 px-5 py-2.5 rounded-lg bg-[#0D6E52] text-white text-sm font-medium"
        >
          Browse Catalog
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <Link
        to="/cart"
        className="inline-flex items-center gap-1.5 text-sm text-[#5C5B57] hover:text-[#141413] mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Bag</span>
      </Link>

      <div className="pb-6 border-b border-[#E6E5E0]">
        <h1 className="font-shop-display text-3xl font-bold tracking-tight text-[#141413]">
          {isOnline ? 'Checkout' : 'Offline Order Preparation'}
        </h1>
        <p className="text-sm text-[#5C5B57] mt-1">
          {isOnline
            ? 'Your Cash on Delivery order will be validated against authoritative server prices and inventory.'
            : 'Offline mode: Creating a local order intent. Payment is never falsely marked processed while offline.'}
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-10 items-start"
      >
        <div className="lg:col-span-7 space-y-8">
          {/* Cached Delivery Addresses */}
          <section className="bg-white border border-[#E6E5E0] rounded-xl p-6">
            <h2 className="font-shop-display text-base font-semibold text-[#141413] mb-4">
              01. Delivery Address (Cached Locally)
            </h2>
            {addresses.length === 0 ? (
              <p className="text-sm text-[#B91C1C]">
                No cached delivery addresses available. Connect once to sync addresses.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {addresses.map((addr) => {
                  const selected = selectedAddressId === addr.addressId;
                  return (
                    <button
                      key={addr.addressId}
                      type="button"
                      onClick={() => setSelectedAddressId(addr.addressId)}
                      className={`text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                        selected
                          ? 'border-[#0D6E52] bg-[#F2F8F5]'
                          : 'border-[#E6E5E0] bg-white hover:border-[#C9C7BF]'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-shop-display text-sm font-semibold text-[#141413]">
                          {addr.label}
                        </span>
                        {selected && <Check className="w-4 h-4 text-[#0D6E52]" />}
                      </div>
                      <p className="text-xs font-medium text-[#141413]">{addr.recipientName}</p>
                      <p className="text-xs text-[#5C5B57] mt-0.5">{addr.street}</p>
                      <p className="text-xs text-[#5C5B57]">
                        {addr.city}, {addr.state} {addr.postalCode}
                      </p>
                      <p className="text-xs font-mono-tabular text-[#6B6A65] mt-1">
                        {addr.phone}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Payment Terms */}
          <section className="bg-white border border-[#E6E5E0] rounded-xl p-6">
            <h2 className="font-shop-display text-base font-semibold text-[#141413] mb-3">
              02. Payment Method
            </h2>
            <div className="p-4 rounded-lg border border-[#0D6E52] bg-[#F2F8F5]">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[#141413]">
                  Cash on Delivery (COD)
                </span>
                <span className="text-xs font-mono-tabular text-[#0D6E52]">
                  Status: NOT_PROCESSED
                </span>
              </div>
              <p className="text-xs text-[#4A4945] mt-1.5 leading-relaxed">
                Pay upon physical delivery after the server validates product availability and
                authoritative pricing. Payment is never marked successful offline.
              </p>
            </div>

            <div className="mt-5">
              <label
                htmlFor="delivery-notes"
                className="block text-xs font-medium text-[#5C5B57] mb-1.5"
              >
                Delivery Instructions (Optional)
              </label>
              <textarea
                id="delivery-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Gate code, drop-off preference, or lab reception desk..."
                className="w-full px-3.5 py-2.5 text-sm border border-[#D4D2C9] rounded-lg focus:outline-none focus:border-[#0D6E52]"
              />
            </div>
          </section>
        </div>

        {/* Right Summary */}
        <aside className="lg:col-span-5 bg-white border border-[#E6E5E0] rounded-xl p-6">
          <h2 className="font-shop-display text-base font-semibold text-[#141413] mb-4">
            Order Intent Summary
          </h2>

          <ul className="divide-y divide-[#ECEBE6] text-sm">
            {lineItems.map((item) => (
              <li key={item.productId} className="py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-[#141413] truncate">{item.name}</p>
                  <p className="text-xs font-mono-tabular text-[#6B6A65]">
                    Qty {item.quantity} × ${item.price.toFixed(2)}
                  </p>
                </div>
                <span className="font-mono-tabular font-medium text-[#141413] shrink-0">
                  ${item.total.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-4 pt-4 border-t border-[#E6E5E0] flex items-baseline justify-between">
            <span className="text-sm font-semibold text-[#141413]">Estimated COD Total</span>
            <span className="font-mono-tabular text-xl font-bold text-[#141413]">
              ${estimatedTotal.toFixed(2)}
            </span>
          </div>

          <p className="text-xs text-[#6B6A65] mt-2 leading-relaxed">
            Final total is confirmed by the server using authoritative prices and stock levels.
            A unique <span className="font-mono-tabular">clientOrderId</span> prevents duplicate
            order creation across retries.
          </p>

          <button
            type="submit"
            disabled={submitting || !selectedAddressId}
            className="w-full mt-6 py-3 px-4 rounded-lg bg-[#0D6E52] text-white text-sm font-medium hover:bg-[#0A5942] disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            {submitting
              ? 'Saving Order Intent...'
              : isOnline
              ? 'Place COD Order'
              : 'Create Offline Order Intent'}
          </button>
        </aside>
      </form>
    </div>
  );
};
