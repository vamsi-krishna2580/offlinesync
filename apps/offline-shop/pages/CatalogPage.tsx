import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { ProductCard } from '../components/ProductCard';
import { useShop } from '../context/ShopContext';

export const CatalogPage: React.FC = () => {
  const { ready, products, categories } = useShop();
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (selectedCategory !== 'All' && p.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.tagline.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q)
      );
    });
  }, [products, query, selectedCategory]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-8 border-b border-[#E6E5E0]">
        <div>
          <h1 className="font-shop-display text-3xl font-bold tracking-tight text-[#141413]">
            Product Catalog
          </h1>
          <p className="text-sm text-[#5C5B57] mt-1.5">
            Search and filter across locally cached products — fully functional offline.
          </p>
        </div>

        <div className="relative w-full md:w-80">
          <Search className="w-4 h-4 text-[#6B6A65] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, SKU, or category..."
            aria-label="Search cached products"
            className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-[#D4D2C9] rounded-lg focus:outline-none focus:border-[#0D6E52]"
          />
        </div>
      </div>

      {/* Category Filter Segmented Controls */}
      <div className="flex flex-wrap items-center gap-2 py-6">
        {categories.map((cat) => {
          const active = selectedCategory === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                active
                  ? 'bg-[#141413] text-white'
                  : 'bg-[#F0EFEA] text-[#5C5B57] hover:text-[#141413]'
              }`}
            >
              {cat}
            </button>
          );
        })}
        <span className="ml-auto text-xs font-mono-tabular text-[#6B6A65]">
          {filtered.length} {filtered.length === 1 ? 'item' : 'items'}
        </span>
      </div>

      {!ready ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <div
              key={n}
              className="h-80 rounded-xl bg-[#EEEDE8] animate-pulse border border-[#E6E5E0]"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-12 text-center bg-white border border-[#E6E5E0] rounded-xl">
          <p className="text-base font-medium text-[#141413]">No matching products found</p>
          <p className="text-sm text-[#5C5B57] mt-1">
            Try clearing your search query or switching categories.
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setSelectedCategory('All');
            }}
            className="mt-4 px-4 py-2 text-xs font-medium rounded-lg border border-[#D4D2C9] text-[#141413] hover:bg-[#F3F2EE] cursor-pointer"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filtered.map((product) => (
            <ProductCard key={product.productId} product={product} />
          ))}
        </div>
      )}
    </div>
  );
};
