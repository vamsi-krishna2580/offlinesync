import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { ProductCard } from '../components/ProductCard';
import { useShop } from '../context/ShopContext';

export const HomePage: React.FC = () => {
  const { ready, products, syncStatus } = useShop();
  const featured = products.slice(0, 3);

  return (
    <div>
      {/* Section 1: Storefront Hero Split */}
      <section className="max-w-6xl mx-auto px-6 pt-12 pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          <div className="lg:col-span-5 flex flex-col justify-center">
            <p className="text-xs font-medium text-[#0D6E52] mb-3">
              Curated Industrial Objects · Cached Locally
            </p>
            <h1 className="font-shop-display text-4xl sm:text-5xl font-bold tracking-tight text-[#141413] leading-[1.1] [text-wrap:balance]">
              Essential hardware built for uninterrupted work.
            </h1>
            <p className="text-base text-[#5C5B57] mt-5 leading-relaxed max-w-md">
              Browse precision workspace tools, audio gear, and everyday carry. Your catalog,
              bag, and checkout intents remain available offline and synchronize cleanly when
              connectivity returns.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                to="/catalog"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-medium bg-[#0D6E52] text-white hover:bg-[#0A5942] transition-colors whitespace-nowrap shrink-0"
              >
                <span>Explore Catalog</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                to="/monitor"
                className="inline-flex items-center px-5 py-3 rounded-lg text-sm font-medium border border-[#D4D2C9] text-[#141413] hover:bg-white transition-colors whitespace-nowrap shrink-0"
              >
                Inspect Sync Engine
              </Link>
            </div>
          </div>

          <div className="lg:col-span-7">
            <div className="h-full min-h-[300px] rounded-2xl overflow-hidden border border-[#E6E5E0] bg-[#EEEDE8]">
              <img
                src="/src/assets/images/hero_offlineshop_collection_1795159061207.jpg"
                alt="Minimalist workspace keyboard, ceramic carafe, titanium flask, and studio headphones on travertine table"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Featured Collection */}
      <section className="max-w-6xl mx-auto px-6 py-12 border-t border-[#E6E5E0]">
        <div className="flex items-end justify-between gap-4 mb-8">
          <div>
            <h2 className="font-shop-display text-2xl font-bold tracking-tight text-[#141413]">
              Featured Collection
            </h2>
            <p className="text-sm text-[#5C5B57] mt-1">
              Served directly from your local IndexedDB store and verified against server inventory.
            </p>
          </div>
          <Link
            to="/catalog"
            className="text-sm font-medium text-[#0D6E52] hover:underline whitespace-nowrap shrink-0"
          >
            View all ({products.length})
          </Link>
        </div>

        {!ready ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="h-80 rounded-xl bg-[#EEEDE8] animate-pulse border border-[#E6E5E0]"
              />
            ))}
          </div>
        ) : featured.length === 0 ? (
          <div className="p-10 text-center bg-white border border-[#E6E5E0] rounded-xl">
            <p className="text-sm text-[#5C5B57]">
              No products cached locally yet. Connect to the server once to populate your local catalog.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {featured.map((product) => (
              <ProductCard key={product.productId} product={product} />
            ))}
          </div>
        )}
      </section>

      {/* Section 3: How Offline-First Shopping Works */}
      <section className="max-w-6xl mx-auto px-6 py-12 border-t border-[#E6E5E0]">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
          <div>
            <p className="font-mono-tabular text-xs text-[#0D6E52] font-medium mb-2">01</p>
            <h3 className="font-shop-display text-base font-semibold text-[#141413]">
              Instant Local Reads
            </h3>
            <p className="text-sm text-[#5C5B57] mt-2 leading-relaxed">
              Every product view, search query, cart adjustment, and wishlist update reads and
              persists in IndexedDB immediately without waiting on network round-trips.
            </p>
          </div>
          <div>
            <p className="font-mono-tabular text-xs text-[#0D6E52] font-medium mb-2">02</p>
            <h3 className="font-shop-display text-base font-semibold text-[#141413]">
              Idempotent Operation Queue
            </h3>
            <p className="text-sm text-[#5C5B57] mt-2 leading-relaxed">
              Offline changes are captured as ordered operations with unique UUIDs and survive
              browser refreshes. Re-delivered batches never create duplicate orders.
            </p>
          </div>
          <div>
            <p className="font-mono-tabular text-xs text-[#0D6E52] font-medium mb-2">03</p>
            <h3 className="font-shop-display text-base font-semibold text-[#141413]">
              Authoritative Server Verification
            </h3>
            <p className="text-sm text-[#5C5B57] mt-2 leading-relaxed">
              Offline checkouts create COD order intents. Upon reconnect, the server revalidates
              live prices and stock and prompts for action if anything changed.
            </p>
            {syncStatus && (
              <p className="text-xs font-mono-tabular text-[#6B6A65] mt-3">
                Device {syncStatus.deviceId.slice(0, 14)} · Cursor #{syncStatus.lastCursor}
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
