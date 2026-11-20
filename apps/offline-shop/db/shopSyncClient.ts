import {
  createOfflineSync,
  DexieStorageAdapter,
  HttpSyncTransport,
  NetworkMonitor,
  type OfflineSyncEngine,
} from '../../../packages/offlinesync-client';
import { OFFLINESHOP_APP_ID } from '../../../backend/shop-adapter/ShopBusinessAdapter';

let singletonEngine: OfflineSyncEngine | null = null;

/**
 * Instantiates OfflineShop's reusable OfflineSync client engine backed by Dexie (IndexedDB).
 * Notice that `offlinesync-client` has zero dependency on OfflineShop UI or domain models.
 */
export function getShopSyncEngine(): OfflineSyncEngine {
  if (singletonEngine) return singletonEngine;

  const storage = new DexieStorageAdapter('offlineshop_indexeddb_v1');
  const transport = new HttpSyncTransport({
    baseUrl: '',
    timeoutMs: 12000,
  });
  const networkMonitor = new NetworkMonitor({
    healthCheckUrl: '/api/sync/status',
    probeIntervalMs: 20000,
    probeTimeoutMs: 4000,
  });

  const engine = createOfflineSync({
    appId: OFFLINESHOP_APP_ID,
    deviceName:
      typeof navigator !== 'undefined'
        ? `OfflineShop Web (${navigator.platform || 'Browser'})`
        : 'OfflineShop Web Client',
    platform: 'web-indexeddb-dexie',
    storage,
    transport,
    networkMonitor,
    batchSize: 20,
    maxRetries: 5,
    baseBackoffMs: 1500,
    autoSyncOnReconnect: true,
    backgroundSyncIntervalMs: 30000,
  });

  engine.registerEntity({
    entityType: 'product',
    conflictPolicy: 'SERVER_AUTHORITATIVE',
  });
  engine.registerEntity({
    entityType: 'address',
    conflictPolicy: 'SERVER_AUTHORITATIVE',
  });
  engine.registerEntity({
    entityType: 'cart',
    conflictPolicy: 'DOMAIN_CUSTOM',
  });
  engine.registerEntity({
    entityType: 'wishlist',
    conflictPolicy: 'LAST_WRITE_WINS_DETERMINISTIC',
  });
  engine.registerEntity({
    entityType: 'order',
    conflictPolicy: 'MANUAL_RESOLUTION',
  });

  singletonEngine = engine;
  return engine;
}
