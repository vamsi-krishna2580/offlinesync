import express, { type Express } from 'express';
import { SyncCoreEngine } from '../offlinesync-core/SyncCoreEngine';
import { DocumentStore } from '../persistence/DocumentStore';
import { ShopBusinessAdapter } from '../shop-adapter/ShopBusinessAdapter';
import { createMonitorRouter } from './monitorRoutes';
import { createShopRouter } from './shopRoutes';
import { createSyncRouter } from './syncRoutes';

export interface OfflineSyncBackendContext {
  app: Express;
  store: DocumentStore;
  core: SyncCoreEngine;
  shopAdapter: ShopBusinessAdapter;
}

/**
 * Composes the Express API server with cleanly separated:
 * 1. Generic OfflineSync Core (`backend/offlinesync-core`)
 * 2. Pluggable OfflineShop Business Adapter (`backend/shop-adapter`)
 * 3. MongoDB-compatible DocumentStore (`backend/persistence`)
 */
export function createBackendApp(options?: {
  persistPath?: string | null;
}): OfflineSyncBackendContext {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const store = new DocumentStore(options?.persistPath ?? null);
  const core = new SyncCoreEngine(store);
  const shopAdapter = new ShopBusinessAdapter(store);

  core.registerAdapter(shopAdapter);

  // Load persisted data from disk before seeding
  store.loadFromDisk();
  shopAdapter.seedIfEmpty(core);

  app.use('/api/sync', createSyncRouter(core));
  app.use('/api/monitor', createMonitorRouter(core, shopAdapter));
  app.use('/api/shop', createShopRouter(shopAdapter));

  return { app, store, core, shopAdapter };
}
