import { Router } from 'express';
import type { ShopBusinessAdapter } from '../shop-adapter/ShopBusinessAdapter';

export function createShopRouter(shopAdapter: ShopBusinessAdapter): Router {
  const router = Router();

  router.get('/products', (_req, res) => {
    res.json({ products: shopAdapter.listProducts() });
  });

  router.get('/products/:id', (req, res) => {
    const product = shopAdapter.productsCol.findById(req.params.id);
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json({ product });
  });

  router.get('/addresses', (_req, res) => {
    res.json({ addresses: shopAdapter.listAddresses() });
  });

  router.get('/orders', (_req, res) => {
    res.json({ orders: shopAdapter.listOrders() });
  });

  router.get('/orders/:id', (req, res) => {
    const order =
      shopAdapter.ordersCol.findById(req.params.id) ??
      shopAdapter.ordersCol.findByUniqueIndex('uniq_client_order_id', req.params.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json({ order });
  });

  return router;
}
