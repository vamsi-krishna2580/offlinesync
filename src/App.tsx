import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ShopLayout } from '../apps/offline-shop/components/ShopLayout';
import { ShopProvider } from '../apps/offline-shop/context/ShopContext';
import { CartPage } from '../apps/offline-shop/pages/CartPage';
import { CatalogPage } from '../apps/offline-shop/pages/CatalogPage';
import { CheckoutPage } from '../apps/offline-shop/pages/CheckoutPage';
import { HomePage } from '../apps/offline-shop/pages/HomePage';
import { OrderDetailPage } from '../apps/offline-shop/pages/OrderDetailPage';
import { OrdersPage } from '../apps/offline-shop/pages/OrdersPage';
import { ProductDetailPage } from '../apps/offline-shop/pages/ProductDetailPage';
import { WishlistPage } from '../apps/offline-shop/pages/WishlistPage';
import { MonitorLayout } from '../apps/offlinesync-monitor/components/MonitorLayout';
import { ConflictsPage } from '../apps/offlinesync-monitor/pages/ConflictsPage';
import { DeviceDetailPage } from '../apps/offlinesync-monitor/pages/DeviceDetailPage';
import { DevicesPage } from '../apps/offlinesync-monitor/pages/DevicesPage';
import { ExperimentsPage } from '../apps/offlinesync-monitor/pages/ExperimentsPage';
import { LogsPage } from '../apps/offlinesync-monitor/pages/LogsPage';
import { OverviewPage } from '../apps/offlinesync-monitor/pages/OverviewPage';
import { QueuePage } from '../apps/offlinesync-monitor/pages/QueuePage';
import { SessionsPage } from '../apps/offlinesync-monitor/pages/SessionsPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Component B: Independent OfflineSync Monitor Developer Dashboard */}
        <Route path="/monitor" element={<MonitorLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="devices/:deviceId" element={<DeviceDetailPage />} />
          <Route path="queue" element={<QueuePage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="conflicts" element={<ConflictsPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="experiments" element={<ExperimentsPage />} />
        </Route>

        {/* Component A: OfflineShop E-Commerce Application */}
        <Route
          path="/"
          element={
            <ShopProvider>
              <ShopLayout />
            </ShopProvider>
          }
        >
          <Route index element={<HomePage />} />
          <Route path="catalog" element={<CatalogPage />} />
          <Route path="product/:productId" element={<ProductDetailPage />} />
          <Route path="cart" element={<CartPage />} />
          <Route path="wishlist" element={<WishlistPage />} />
          <Route path="checkout" element={<CheckoutPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="orders/:orderId" element={<OrderDetailPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
