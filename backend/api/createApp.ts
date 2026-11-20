import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SyncCoreEngine } from '../offlinesync-core/SyncCoreEngine';
import { DocumentStore, type DocumentStoreOptions } from '../persistence/DocumentStore';
import { ShopBusinessAdapter } from '../shop-adapter/ShopBusinessAdapter';
import { createMonitorRouter } from './monitorRoutes';
import { createShopRouter } from './shopRoutes';
import { createSyncRouter } from './syncRoutes';
import { MAX_PAYLOAD_JSON_LIMIT, sendApiError } from './validation';

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
 * 3. Single-process transactional JSON DocumentStore (`backend/persistence`)
 */
export function createBackendApp(options?: {
  persistPath?: string | null;
  storeOptions?: DocumentStoreOptions;
}): OfflineSyncBackendContext {
  const app = express();
  app.use(express.json({ limit: MAX_PAYLOAD_JSON_LIMIT }));

  // Handle malformed JSON & oversized payloads consistently with structured JSON errors
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) {
      next();
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e.type === 'entity.too.large' || e.status === 413) {
      sendApiError(
        res,
        413,
        'PAYLOAD_TOO_LARGE',
        `Request payload exceeds maximum allowed size (${MAX_PAYLOAD_JSON_LIMIT})`
      );
      return;
    }
    if (e instanceof SyntaxError || e.type === 'entity.parse.failed' || e.status === 400) {
      sendApiError(res, 400, 'INVALID_JSON', 'Malformed JSON request body');
      return;
    }
    next(err);
  });

  const store = new DocumentStore(options?.persistPath ?? null, options?.storeOptions);
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
