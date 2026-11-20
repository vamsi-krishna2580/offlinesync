import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Heart } from 'lucide-react';
import { ProductCard } from '../components/ProductCard';
import { useShop } from '../context/ShopContext';

export const WishlistPage: React.FC = () => {
  const { products, wishlist } = useShop();
  const savedProducts = products.filter((p) => wishlist.productIds.includes(p.productId));

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <div className="pb-6 border-b border-[#E6E5E0]">
        <h1 className="font-shop-display text-3xl font-bold tracking-tight text-[#141413]">
          Wishlist
        </h1>
        <p className="text-sm text-[#5C5B57] mt-1">
          Saved items are stored in IndexedDB and synchronized automatically across sessions.
        </p>
      </div>

      {savedProducts.length === 0 ? (
        <div className="mt-10 p-14 text-center bg-white border border-[#E6E5E0] rounded-xl">
          <Heart className="w-8 h-8 text-[#8C8A82] mx-auto mb-3" />
          <h2 className="font-shop-display text-lg font-semibold text-[#141413]">
            No saved items yet
          </h2>
          <p className="text-sm text-[#5C5B57] mt-1">
            Tap the heart icon on any product to bookmark it for offline viewing.
          </p>
          <Link
            to="/catalog"
            className="inline-flex items-center gap-2 mt-6 px-5 py-2.5 rounded-lg bg-[#141413] text-white text-sm font-medium hover:bg-[#2C2C2A] transition-colors"
          >
            <span>Explore Catalog</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {savedProducts.map((product) => (
            <ProductCard key={product.productId} product={product} />
          ))}
        </div>
      )}
    </div>
  );
};
