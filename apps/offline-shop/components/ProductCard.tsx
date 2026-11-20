import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Package, Plus } from 'lucide-react';
import type { Product } from '../../../backend/shop-adapter/types';
import { useShop } from '../context/ShopContext';

interface ProductCardProps {
  product: Product;
}

export const ProductCard: React.FC<ProductCardProps> = ({ product }) => {
  const { addToCart, toggleWishlist, wishlist } = useShop();
  const [imgFailed, setImgFailed] = useState(false);

  const isWishlisted = wishlist.productIds.includes(product.productId);
  const outOfStock = product.stock <= 0;

  return (
    <article className="group flex flex-col bg-white border border-[#E6E5E0] rounded-xl overflow-hidden transition-transform duration-200 hover:-translate-y-0.5">
      <Link
        to={`/product/${product.productId}`}
        className="relative block aspect-[4/3] bg-[#F3F2EE] overflow-hidden"
      >
        {!imgFailed ? (
          <img
            src={product.imageUrl}
            alt={product.name}
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-[#EEEDE8] text-[#5C5B57]">
            <Package className="w-8 h-8 mb-2 opacity-60" />
            <span className="text-xs font-medium">{product.name}</span>
          </div>
        )}
      </Link>

      <div className="p-5 flex-1 flex flex-col justify-between gap-4">
        <div>
          <div className="flex items-center justify-between gap-2 text-xs text-[#6B6A65] mb-1.5">
            <span>{product.category}</span>
            <span className="font-mono-tabular">
              {outOfStock ? 'Out of stock' : `${product.stock} in stock`}
            </span>
          </div>
          <Link
            to={`/product/${product.productId}`}
            className="font-shop-display text-base font-semibold text-[#141413] hover:text-[#0D6E52] transition-colors block leading-snug"
          >
            {product.name}
          </Link>
          <p className="text-xs text-[#6B6A65] mt-1.5 line-clamp-2 leading-relaxed">
            {product.tagline}
          </p>
        </div>

        <div className="pt-3 border-t border-[#F0EFEA] flex items-center justify-between gap-3">
          <span className="font-mono-tabular text-base font-semibold text-[#141413]">
            ${product.price.toFixed(2)}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void toggleWishlist(product.productId)}
              aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
              className={`p-2 rounded-lg border transition-colors cursor-pointer ${
                isWishlisted
                  ? 'border-[#141413] bg-[#141413] text-white'
                  : 'border-[#E6E5E0] text-[#5C5B57] hover:text-[#141413] hover:border-[#C9C7BF]'
              }`}
            >
              <Heart className={`w-4 h-4 ${isWishlisted ? 'fill-current' : ''}`} />
            </button>
            <button
              type="button"
              disabled={outOfStock}
              onClick={() => void addToCart(product, 1)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-[#0D6E52] text-white hover:bg-[#0A5942] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add to Bag</span>
            </button>
          </div>
        </div>
      </div>
    </article>
  );
};
