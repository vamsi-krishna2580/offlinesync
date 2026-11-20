import { Router } from 'express';
import type { ShopBusinessAdapter } from '../shop-adapter/ShopBusinessAdapter';
import { isValidId, sendApiError } from './validation';

export function createShopRouter(shopAdapter: ShopBusinessAdapter): Router {
  const router = Router();

  router.get('/products', (_req, res) => {
    res.json({ products: shopAdapter.listProducts() });
  });

  router.get('/products/:id', (req, res) => {
    if (!isValidId(req.params.id)) {
      sendApiError(res, 400, 'INVALID_PRODUCT_ID', 'Malformed product identifier');
      return;
    }
    const product = shopAdapter.productsCol.findById(req.params.id);
    if (!product) {
      sendApiError(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
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
    if (!isValidId(req.params.id)) {
      sendApiError(res, 400, 'INVALID_ORDER_ID', 'Malformed order identifier');
      return;
    }
    const order =
      shopAdapter.ordersCol.findById(req.params.id) ??
      shopAdapter.ordersCol.findByUniqueIndex('uniq_client_order_id', req.params.id);
    if (!order) {
      sendApiError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
      return;
    }
    res.json({ order });
  });

  return router;
}
