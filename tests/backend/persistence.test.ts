import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackendApp } from '../../backend/api/createApp';
import {
  CorruptPersistenceError,
  DocumentStore,
  MultiProcessLockError,
  PersistenceError,
} from '../../backend/persistence/DocumentStore';
import { OFFLINESHOP_APP_ID } from '../../backend/shop-adapter/ShopBusinessAdapter';

const tempDirs: string[] = [];

function makeTempDbPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `offlinesync-${label}-`));
  tempDirs.push(dir);
  return path.join(dir, 'offlinesync_db.json');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup issues
    }
  }
});

describe('Phase C — DocumentStore Persistence, Crash Recovery, Transactions & Lockfile', () => {
  it('persists devices, orders, stock decrements, cursors, and idempotency records across server restart', () => {
    const dbPath = makeTempDbPath('restart');

    // Instance 1: register device, place order, close cleanly
    const app1 = createBackendApp({ persistPath: dbPath });
    const reg = app1.core.registerDevice({
      deviceId: 'dev-persist-srv',
      deviceName: 'Persistence Phone',
      appId: OFFLINESHOP_APP_ID,
    });
    const initialStock = app1.shopAdapter.productsCol.findById('P101')!.stock;
    const price = app1.shopAdapter.productsCol.findById('P101')!.price;

    const pushRes = app1.core.push({
      deviceId: 'dev-persist-srv',
      appId: OFFLINESHOP_APP_ID,
      sessionId: 'sess-restart-1',
      lastCursor: 0,
      operations: [
        {
          operationId: 'op-restart-order-1',
          deviceId: 'dev-persist-srv',
          appId: OFFLINESHOP_APP_ID,
          entityType: 'order',
          entityId: 'CLI-RESTART-1',
          operationType: 'ORDER_CREATE',
          sequence: 1,
          baseVersion: 0,
          createdAt: new Date().toISOString(),
          payload: {
            clientOrderId: 'CLI-RESTART-1',
            deliveryAddressId: 'ADDR-HOME',
            items: [{ productId: 'P101', name: 'Keyboard', quantity: 2, priceAtCheckout: price }],
          },
          status: 'PENDING',
          retryCount: 0,
        },
      ],
    });
    expect(pushRes.acknowledgedIds).toEqual(['op-restart-order-1']);
    const cursorAfterWrite = app1.core.reconciliation.getCurrentCursor(OFFLINESHOP_APP_ID);
    app1.store.close();

    // Instance 2 (simulated server restart): verify full consistency
    const app2 = createBackendApp({ persistPath: dbPath });
    try {
      // Device & token hash survived
      expect(() =>
        app2.core.devices.authenticateDevice('dev-persist-srv', OFFLINESHOP_APP_ID, reg.deviceToken)
      ).not.toThrow();

      // Stock decrement & order survived
      expect(app2.shopAdapter.productsCol.findById('P101')!.stock).toBe(initialStock - 2);
      const order = app2.shopAdapter.ordersCol.findByUniqueIndex('uniq_client_order_id', 'CLI-RESTART-1');
      expect(order?.status).toBe('CONFIRMED');

      // Cursor survived
      expect(app2.core.reconciliation.getCurrentCursor(OFFLINESHOP_APP_ID)).toBe(cursorAfterWrite);

      // Idempotency record survived: re-sending op-restart-order-1 is still deduplicated!
      const dupAfterRestart = app2.core.push({
        deviceId: 'dev-persist-srv',
        appId: OFFLINESHOP_APP_ID,
        sessionId: 'sess-restart-2',
        lastCursor: 0,
        operations: [
          {
            operationId: 'op-restart-order-1',
            deviceId: 'dev-persist-srv',
            appId: OFFLINESHOP_APP_ID,
            entityType: 'order',
            entityId: 'CLI-RESTART-1',
            operationType: 'ORDER_CREATE',
            sequence: 1,
            baseVersion: 0,
            createdAt: new Date().toISOString(),
            payload: {
              clientOrderId: 'CLI-RESTART-1',
              deliveryAddressId: 'ADDR-HOME',
              items: [{ productId: 'P101', name: 'Keyboard', quantity: 2, priceAtCheckout: price }],
            },
            status: 'PENDING',
            retryCount: 0,
          },
        ],
      });
      expect(dupAfterRestart.duplicateIds).toEqual(['op-restart-order-1']);
      expect(app2.shopAdapter.productsCol.findById('P101')!.stock).toBe(initialStock - 2);
    } finally {
      app2.store.close();
    }
  });

  it('quarantines corrupt primary persistence files and recovers automatically from verified .backup', () => {
    const dbPath = makeTempDbPath('corrupt-recover');

    // Create valid store with 2 commits so both primary and .backup exist
    const store1 = new DocumentStore(dbPath, { silentLogs: true });
    const col1 = store1.registerCollection<{ id: string; value: number }>('items', 'id');
    store1.runTransaction(() => {
      col1.insertOne({ id: 'k1', value: 100 });
    });
    store1.runTransaction(() => {
      col1.insertOne({ id: 'k2', value: 200 });
    });
    store1.close();

    // Corrupt the primary file on disk (truncated invalid JSON)
    fs.writeFileSync(dbPath, '{"version":2,"checksum":"bad", CORRUPTED', 'utf-8');

    // Reopen with default recoverFromCorruption=true -> quarantines corrupt file and recovers .backup
    const store2 = new DocumentStore(dbPath, { silentLogs: true });
    try {
      const col2 = store2.registerCollection<{ id: string; value: number }>('items', 'id');
      const loadRes = store2.loadFromDisk();
      expect(loadRes.loaded).toBe(true);
      expect(loadRes.recoveredFromBackup).toBe(true);
      expect(loadRes.quarantinedCorruptPath).toContain('.corrupt.');
      expect(col2.findById('k1')?.value).toBe(100);

      const dirFiles = fs.readdirSync(path.dirname(dbPath));
      expect(dirFiles.some((f) => f.includes('.corrupt.') && f.endsWith('.bak'))).toBe(true);
    } finally {
      store2.close();
    }
  });

  it('throws CorruptPersistenceError explicitly when corrupt file has no backup or recovery is disabled', () => {
    const dbPath = makeTempDbPath('corrupt-throw');
    fs.writeFileSync(dbPath, '{ not valid json at all', 'utf-8');

    const store = new DocumentStore(dbPath, { recoverFromCorruption: true, silentLogs: true });
    try {
      store.registerCollection<{ id: string }>('items', 'id');
      expect(() => store.loadFromDisk()).toThrow(CorruptPersistenceError);
    } finally {
      store.close();
    }
  });

  it('surfaces persistence write failures explicitly and rolls back all collections on mid-transaction failure', () => {
    const dbPath = makeTempDbPath('tx-rollback');
    let failDiskWrite = false;
    const store = new DocumentStore(dbPath, {
      silentLogs: true,
      beforeWriteHook: () => {
        if (failDiskWrite) {
          throw new Error('ENOSPC: no space left on device');
        }
      },
    });

    try {
      const accounts = store.registerCollection<{ id: string; balance: number }>('accounts', 'id');
      const ledger = store.registerCollection<{ id: string; amount: number }>('ledger', 'id');

      store.runTransaction(() => {
        accounts.insertOne({ id: 'A', balance: 500 });
      });

      // 1. Multi-collection business failure rolls back collection 1 mutation
      expect(() =>
        store.runTransaction(() => {
          accounts.upsertOne({ id: 'A', balance: 300 });
          ledger.insertOne({ id: 'L1', amount: 200 });
          throw new Error('Downstream invariant violated');
        })
      ).toThrow('Downstream invariant violated');

      expect(accounts.findById('A')?.balance).toBe(500);
      expect(ledger.findById('L1')).toBeNull();

      // 2. Disk persistence error during commit throws PersistenceError AND rolls back in-memory state!
      failDiskWrite = true;
      expect(() =>
        store.runTransaction(() => {
          accounts.upsertOne({ id: 'A', balance: 100 });
          ledger.insertOne({ id: 'L2', amount: 400 });
        })
      ).toThrow(PersistenceError);

      expect(accounts.findById('A')?.balance).toBe(500);
      expect(ledger.findById('L2')).toBeNull();
    } finally {
      failDiskWrite = false;
      store.close();
    }
  });

  it('rejects unsupported concurrent multi-process access via exclusive PID lockfile', () => {
    const dbPath = makeTempDbPath('lockfile');
    const store1 = new DocumentStore(dbPath);
    try {
      // Opening a second store against the exact same file while store1 holds the lock MUST throw
      expect(() => new DocumentStore(dbPath)).toThrow(MultiProcessLockError);
    } finally {
      store1.close();
    }

    // After store1 closes and releases lockfile, a new store can open cleanly
    const store2 = new DocumentStore(dbPath);
    store2.close();
  });
});
