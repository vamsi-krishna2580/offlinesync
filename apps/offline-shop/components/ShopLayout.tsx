import React from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { RefreshCw, ShoppingBag, Wifi, WifiOff, X } from 'lucide-react';
import { useShop } from '../context/ShopContext';

export const ShopLayout: React.FC = () => {
  const {
    cart,
    syncStatus,
    toast,
    dismissToast,
    toggleSimulatedOffline,
    triggerSyncNow,
  } = useShop();

  const cartCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  const isOnline = syncStatus ? syncStatus.connectionStatus === 'ONLINE' : true;
  const isSyncing = syncStatus?.syncState === 'SYNCING';
  const pendingCount = syncStatus?.pendingCount ?? 0;
  const requiresActionCount = syncStatus?.requiresActionCount ?? 0;

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm font-medium transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
      isActive
        ? 'text-[#141413] border-b border-[#141413]'
        : 'text-[#5C5B57] hover:text-[#141413]'
    }`;

  return (
    <div className="min-h-screen flex flex-col bg-[#FAFAF8] text-[#141413]">
      {/* Strict 3-zone Top Bar Contract */}
      <header className="sticky top-0 z-30 bg-[#FAFAF8]/95 backdrop-blur border-b border-[#E6E5E0]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-element brand wordmark */}
          <Link
            to="/"
            className="font-shop-display text-lg font-bold tracking-tight text-[#141413] whitespace-nowrap shrink-0"
          >
            OfflineShop
          </Link>

          {/* Zone 2: Concise single-line navigation links */}
          <nav className="hidden md:flex items-center gap-7">
            <NavLink to="/" end className={navLinkClass}>
              Home
            </NavLink>
            <NavLink to="/catalog" className={navLinkClass}>
              Catalog
            </NavLink>
            <NavLink to="/wishlist" className={navLinkClass}>
              Wishlist
            </NavLink>
            <NavLink to="/orders" className={navLinkClass}>
              Orders
            </NavLink>
            <Link
              to="/monitor"
              className="text-sm font-medium text-[#5C5B57] hover:text-[#0D6E52] transition-colors whitespace-nowrap shrink-0"
            >
              Sync Monitor
            </Link>
          </nav>

          {/* Zone 3: Single primary action */}
          <div className="flex items-center shrink-0">
            <Link
              to="/cart"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-[#141413] text-white hover:bg-[#2C2C2A] transition-colors whitespace-nowrap shrink-0"
            >
              <ShoppingBag className="w-4 h-4" />
              <span>Bag</span>
              <span className="font-mono-tabular text-xs opacity-90">({cartCount})</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Functional Connectivity & Background Sync Strip (genuine telemetry) */}
      <div
        className={`border-b text-xs transition-colors ${
          !isOnline
            ? 'bg-[#FEF3C7] border-[#F59E0B]/40 text-[#92400E]'
            : requiresActionCount > 0
            ? 'bg-[#FEE2E2] border-[#EF4444]/30 text-[#991B1B]'
            : 'bg-[#F3F2EE] border-[#E6E5E0] text-[#5C5B57]'
        }`}
      >
        <div className="max-w-6xl mx-auto px-6 py-2 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 font-medium">
              {isOnline ? (
                <Wifi className="w-3.5 h-3.5 text-[#0D6E52]" />
              ) : (
                <WifiOff className="w-3.5 h-3.5 text-[#B45309]" />
              )}
              <span>{isOnline ? 'Connected' : 'Offline — Reading from IndexedDB cache'}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">
              {isSyncing
                ? 'Synchronizing...'
                : pendingCount > 0
                ? `${pendingCount} queued locally`
                : 'All local changes synced'}
            </span>
            {requiresActionCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <Link to="/orders" className="underline font-medium">
                  {requiresActionCount} order requires confirmation
                </Link>
              </>
            )}
          </div>

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={toggleSimulatedOffline}
              className="font-medium underline underline-offset-2 hover:opacity-80 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
            >
              {syncStatus?.simulatedOffline ? 'Reconnect Network' : 'Simulate Offline'}
            </button>
            <button
              type="button"
              onClick={() => void triggerSyncNow()}
              disabled={!isOnline || isSyncing}
              className="inline-flex items-center gap-1.5 font-medium text-[#141413] disabled:opacity-40 hover:text-[#0D6E52] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>Sync Now</span>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile secondary nav */}
      <div className="md:hidden border-b border-[#E6E5E0] bg-white px-6 py-2.5 flex items-center gap-5 overflow-x-auto text-sm">
        <NavLink to="/" end className={navLinkClass}>
          Home
        </NavLink>
        <NavLink to="/catalog" className={navLinkClass}>
          Catalog
        </NavLink>
        <NavLink to="/wishlist" className={navLinkClass}>
          Wishlist
        </NavLink>
        <NavLink to="/orders" className={navLinkClass}>
          Orders
        </NavLink>
        <Link to="/monitor" className="text-[#5C5B57] whitespace-nowrap shrink-0">
          Sync Monitor
        </Link>
      </div>

      {/* Main Content */}
      <main className="flex-1">
        <Outlet />
      </main>

      {/* Clean Quiet Footer */}
      <footer className="border-t border-[#E6E5E0] bg-white mt-20">
        <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 text-sm text-[#5C5B57]">
          <div>
            <p className="font-shop-display font-semibold text-[#141413]">OfflineShop</p>
            <p className="text-xs mt-1">
              Reference storefront demonstrating the OfflineSync local-first synchronization framework.
            </p>
          </div>
          <div className="flex items-center gap-6 text-xs">
            <Link to="/catalog" className="hover:text-[#141413] transition-colors">
              Catalog
            </Link>
            <Link to="/orders" className="hover:text-[#141413] transition-colors">
              Orders
            </Link>
            <Link to="/monitor" className="hover:text-[#0D6E52] font-medium transition-colors">
              Open OfflineSync Monitor
            </Link>
          </div>
        </div>
      </footer>

      {/* Non-intrusive action feedback toast */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 z-50 max-w-sm px-4 py-3 rounded-lg border shadow-md flex items-center justify-between gap-3 text-sm ${
            toast.tone === 'warn'
              ? 'bg-[#FEF3C7] border-[#F59E0B] text-[#78350F]'
              : toast.tone === 'success'
              ? 'bg-[#141413] border-[#141413] text-white'
              : 'bg-white border-[#E6E5E0] text-[#141413]'
          }`}
        >
          <span>{toast.text}</span>
          <button
            type="button"
            onClick={dismissToast}
            aria-label="Dismiss notification"
            className="opacity-70 hover:opacity-100 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};
