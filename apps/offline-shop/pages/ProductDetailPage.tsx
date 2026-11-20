import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Heart, Minus, Package, Plus } from 'lucide-react';
import { useShop } from '../context/ShopContext';

export const ProductDetailPage: React.FC = () => {
  const { productId } = useParams<{ productId: string }>();
  const { products, addToCart, toggleWishlist, wishlist } = useShop();
  const [qty, setQty] = useState(1);
  const [imgFailed, setImgFailed] = useState(false);

  const product = products.find((p) => p.productId === productId);

  if (!product) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-16 text-center">
        <h1 className="font-shop-display text-2xl font-bold text-[#141413]">
          Product not found in local cache
        </h1>
        <p className="text-sm text-[#5C5B57] mt-2">
          Return to the catalog to browse cached items.
        </p>
        <Link
          to="/catalog"
          className="inline-flex items-center gap-2 mt-6 px-4 py-2 rounded-lg bg-[#141413] text-white text-sm font-medium"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Catalog</span>
        </Link>
      </div>
    );
  }

  const isWishlisted = wishlist.productIds.includes(product.productId);
  const outOfStock = product.stock <= 0;

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <Link
        to="/catalog"
        className="inline-flex items-center gap-1.5 text-sm text-[#5C5B57] hover:text-[#141413] mb-8"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Catalog</span>
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
        {/* Left: Sticky Studio Photography */}
        <div className="lg:col-span-7 lg:sticky lg:top-24">
          <div className="aspect-[4/3] rounded-2xl overflow-hidden bg-[#EEEDE8] border border-[#E6E5E0]">
            {!imgFailed ? (
              <img
                src={product.imageUrl}
                alt={product.name}
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-[#5C5B57]">
                <Package className="w-10 h-10 mb-2 opacity-60" />
                <span className="text-sm">{product.name}</span>
              </div>
            )}
          </div>
        </div>

        {/* Right: Contiguous Purchase Module */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-[#6B6A65] mb-2">
              <span>{product.category}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">{product.sku}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">Rev v{product.version}</span>
            </div>
            <h1 className="font-shop-display text-3xl font-bold tracking-tight text-[#141413] [text-wrap:balance]">
              {product.name}
            </h1>
            <p className="font-mono-tabular text-2xl font-semibold text-[#141413] mt-4">
              ${product.price.toFixed(2)}
            </p>
            <p className="text-xs text-[#5C5B57] mt-1">
              {outOfStock
                ? 'Currently out of stock on last synced inventory snapshot.'
                : `${product.stock} units available (revalidated authoritatively on checkout sync).`}
            </p>
          </div>

          <p className="text-sm text-[#4A4945] leading-relaxed">{product.description}</p>

          {/* Quantity & Primary Purchase CTA */}
          <div className="pt-4 border-t border-[#E6E5E0] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-[#141413]">Quantity</span>
              <div className="inline-flex items-center border border-[#D4D2C9] rounded-lg bg-white">
                <button
                  type="button"
                  onClick={() => setQty((q) => Math.max(1, q - 1))}
                  aria-label="Decrease quantity"
                  className="p-2.5 text-[#5C5B57] hover:text-[#141413] cursor-pointer"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="w-10 text-center font-mono-tabular text-sm font-medium">
                  {qty}
                </span>
                <button
                  type="button"
                  onClick={() => setQty((q) => Math.min(Math.max(1, product.stock), q + 1))}
                  aria-label="Increase quantity"
                  className="p-2.5 text-[#5C5B57] hover:text-[#141413] cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={outOfStock}
                onClick={() => void addToCart(product, qty)}
                className="flex-1 py-3 px-5 rounded-lg text-sm font-medium bg-[#0D6E52] text-white hover:bg-[#0A5942] disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                {outOfStock ? 'Out of Stock' : `Add to Bag — $${(product.price * qty).toFixed(2)}`}
              </button>
              <button
                type="button"
                onClick={() => void toggleWishlist(product.productId)}
                aria-label={isWishlisted ? 'Remove from wishlist' : 'Save to wishlist'}
                className={`p-3 rounded-lg border transition-colors cursor-pointer ${
                  isWishlisted
                    ? 'border-[#141413] bg-[#141413] text-white'
                    : 'border-[#D4D2C9] bg-white text-[#141413] hover:bg-[#F3F2EE]'
                }`}
              >
                <Heart className={`w-5 h-5 ${isWishlisted ? 'fill-current' : ''}`} />
              </button>
            </div>
          </div>

          {/* Technical Specifications */}
          <div className="pt-6 border-t border-[#E6E5E0]">
            <h2 className="font-shop-display text-sm font-semibold text-[#141413] mb-3">
              Specifications
            </h2>
            <dl className="divide-y divide-[#ECEBE6] text-sm">
              {Object.entries(product.specs).map(([label, value]) => (
                <div key={label} className="py-2.5 flex items-center justify-between gap-4">
                  <dt className="text-[#6B6A65]">{label}</dt>
                  <dd className="text-[#141413] font-medium text-right">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
};
