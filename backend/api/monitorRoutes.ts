import crypto from 'crypto';
import { Router } from 'express';
import type { ExperimentRunRecord } from '../../packages/offlinesync-types';
import type { SyncCoreEngine } from '../offlinesync-core/SyncCoreEngine';
import { runControlledExperiment } from '../services/ExperimentRunner';
import {
  OFFLINESHOP_APP_ID,
  type ShopBusinessAdapter,
} from '../shop-adapter/ShopBusinessAdapter';

export function createMonitorRouter(
  core: SyncCoreEngine,
  shopAdapter: ShopBusinessAdapter
): Router {
  const router = Router();

  router.get('/metrics', (_req, res) => {
    res.json({ metrics: core.getMonitorMetrics() });
  });

  router.get('/logs', (req, res) => {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const eventType = typeof req.query.eventType === 'string' ? req.query.eventType : undefined;
    const severity = typeof req.query.severity === 'string' ? req.query.severity : undefined;
    const logs = core.telemetry.listLogs({ deviceId, eventType, severity, limit: 250 });
    res.json({ logs });
  });

  /**
   * Server-Sent Events (SSE) live stream of real synchronization telemetry events.
   */
  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    const unsubscribe = core.telemetry.subscribe((event) => {
      res.write(`event: sync_event\ndata: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.get('/experiments', (_req, res) => {
    res.json({ experiments: core.listExperiments() });
  });

  router.post('/experiments/run', async (req, res) => {
    const body = req.body as {
      scenario?: ExperimentRunRecord['scenario'];
      operationCount?: number;
      batchSize?: number;
    };
    const scenario = body?.scenario ?? 'STABLE_CONNECTION';
    const operationCount = Number(body?.operationCount ?? 10);
    const batchSize = Number(body?.batchSize ?? 25);

    try {
      const run = await runControlledExperiment(core, {
        scenario,
        operationCount,
        batchSize,
      });
      res.json({ experiment: run });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Experiment failed';
      res.status(500).json({ error: msg });
    }
  });

  router.get('/experiments/export.csv', (_req, res) => {
    const runs = core.listExperiments();
    const headers = [
      'experimentId',
      'scenario',
      'operationCount',
      'batchSize',
      'startedAt',
      'completedAt',
      'syncLatencyMs',
      'localWriteAvgMs',
      'recoveryTimeMs',
      'successRate',
      'failureRate',
      'retryCount',
      'duplicatesPrevented',
      'conflictsDetected',
      'bytesTransferred',
      'acknowledgedCount',
      'rejectedCount',
      'notes',
    ];

    const escapeCsv = (val: unknown): string => {
      const s = val === null || val === undefined ? '' : String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [
      headers.join(','),
      ...runs.map((r) =>
        headers.map((h) => escapeCsv((r as unknown as Record<string, unknown>)[h])).join(',')
      ),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="offlinesync-experiments.csv"');
    res.send(lines.join('\n'));
  });

  /**
   * Demonstration helper: Simulates two devices editing the same shared cart concurrently
   * so evaluators can immediately inspect real conflict detection & manual resolution
   * inside OfflineSync Monitor.
   */
  router.post('/simulate/conflict', (_req, res) => {
    const cartId = 'shared-demo-cart';
    const devA = 'sim-device-alpha';
    const devB = 'sim-device-beta';

    core.registerDevice({
      deviceId: devA,
      deviceName: 'Pixel 8 Field Client (Sim A)',
      appId: OFFLINESHOP_APP_ID,
      platform: 'android-sim',
    });
    core.registerDevice({
      deviceId: devB,
      deviceName: 'iPad Kiosk Client (Sim B)',
      appId: OFFLINESHOP_APP_ID,
      platform: 'tablet-sim',
    });

    // Step 1: Device A pushes an update advancing cart version
    const currentCart = shopAdapter.cartsCol.findById(cartId);
    const baseVer = currentCart?.version ?? 0;

    core.process({
      deviceId: devA,
      appId: OFFLINESHOP_APP_ID,
      sessionId: `sim-sess-a-${crypto.randomUUID().slice(0, 6)}`,
      lastCursor: 0,
      operations: [
        {
          operationId: `op-sim-a-${crypto.randomUUID().slice(0, 8)}`,
          deviceId: devA,
          appId: OFFLINESHOP_APP_ID,
          entityType: 'cart',
          entityId: cartId,
          operationType: 'CART_ITEM_SET_QTY',
          sequence: 1,
          baseVersion: baseVer,
          createdAt: new Date().toISOString(),
          payload: { productId: 'P101', quantity: 2 },
          status: 'PENDING',
          retryCount: 0,
        },
      ],
    });

    // Step 2: Device B pushes an absolute overwrite using the stale baseVersion -> genuine conflict!
    const pushB = core.process({
      deviceId: devB,
      appId: OFFLINESHOP_APP_ID,
      sessionId: `sim-sess-b-${crypto.randomUUID().slice(0, 6)}`,
      lastCursor: 0,
      operations: [
        {
          operationId: `op-sim-b-${crypto.randomUUID().slice(0, 8)}`,
          deviceId: devB,
          appId: OFFLINESHOP_APP_ID,
          entityType: 'cart',
          entityId: cartId,
          operationType: 'CART_ITEM_SET_QTY',
          sequence: 1,
          baseVersion: baseVer, // Stale! Server is now at baseVer + 1
          createdAt: new Date().toISOString(),
          payload: { productId: 'P101', quantity: 5 },
          status: 'PENDING',
          retryCount: 0,
        },
      ],
    });

    res.json({
      message: 'Simulated concurrent two-device cart conflict',
      conflicts: pushB.conflicts,
    });
  });

  /**
   * Authoritative server catalog mutation endpoint for Scenario G testing
   * (change price or stock while client is offline, then sync client order intent).
   */
  router.post('/simulate/catalog-change', (req, res) => {
    const body = req.body as { productId?: string; price?: number; stock?: number };
    const productId = body?.productId || 'P101';
    const updated = shopAdapter.updateProductAuthoritative(productId, {
      price: body?.price !== undefined ? Number(body.price) : undefined,
      stock: body?.stock !== undefined ? Number(body.stock) : undefined,
    });

    if (!updated) {
      res.status(404).json({ error: `Product "${productId}" not found` });
      return;
    }
    res.json({ product: updated });
  });

  return router;
}
