import crypto from 'crypto';
import { Router } from 'express';
import type { SyncCoreEngine } from '../offlinesync-core/SyncCoreEngine';
import { runControlledExperiment } from '../services/ExperimentRunner';
import {
  OFFLINESHOP_APP_ID,
  type ShopBusinessAdapter,
} from '../shop-adapter/ShopBusinessAdapter';
import {
  isPlainObject,
  isValidId,
  requireMonitorAuth,
  sendApiError,
  validateExperimentRunBody,
} from './validation';

export function createMonitorRouter(
  core: SyncCoreEngine,
  shopAdapter: ShopBusinessAdapter
): Router {
  const router = Router();

  // Protect ALL Monitor observability, benchmark, and simulation endpoints
  router.use(requireMonitorAuth);

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
    const validated = validateExperimentRunBody(req.body);
    if (!validated.ok || !validated.value) {
      sendApiError(
        res,
        validated.statusCode ?? 400,
        validated.code ?? 'VALIDATION_ERROR',
        validated.error ?? 'Invalid experiment request'
      );
      return;
    }

    try {
      const run = await runControlledExperiment(core, validated.value);
      res.json({ experiment: run });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Experiment failed';
      sendApiError(res, 500, 'EXPERIMENT_FAILED', msg);
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
   * Protected demonstration helper: Simulates two registered devices editing
   * the same shared cart concurrently to produce a genuine OPEN conflict.
   */
  router.post('/simulate/conflict', (_req, res) => {
    const cartId = 'shared-demo-cart';
    const suffix = crypto.randomUUID().slice(0, 6);
    const devA = `sim-alpha-${suffix}`;
    const devB = `sim-beta-${suffix}`;

    core.registerDevice({
      deviceId: devA,
      deviceName: `Pixel 8 Field Client (${suffix}A)`,
      appId: OFFLINESHOP_APP_ID,
      platform: 'android-sim',
    });
    core.registerDevice({
      deviceId: devB,
      deviceName: `iPad Kiosk Client (${suffix}B)`,
      appId: OFFLINESHOP_APP_ID,
      platform: 'tablet-sim',
    });

    const currentCart = shopAdapter.cartsCol.findById(cartId);
    const baseVer = currentCart?.version ?? 0;

    core.process({
      deviceId: devA,
      appId: OFFLINESHOP_APP_ID,
      sessionId: `sim-sess-a-${suffix}`,
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

    const pushB = core.process({
      deviceId: devB,
      appId: OFFLINESHOP_APP_ID,
      sessionId: `sim-sess-b-${suffix}`,
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
          baseVersion: baseVer,
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
   * Protected authoritative server catalog mutation endpoint for Scenario G.
   */
  router.post('/simulate/catalog-change', (req, res) => {
    if (!isPlainObject(req.body)) {
      sendApiError(res, 400, 'INVALID_PAYLOAD', 'Request body must be a JSON object');
      return;
    }

    const productId = req.body.productId;
    if (!isValidId(productId)) {
      sendApiError(res, 400, 'INVALID_PRODUCT_ID', 'Valid productId is required');
      return;
    }

    const rawPrice = req.body.price;
    const rawStock = req.body.stock;
    if (rawPrice === undefined && rawStock === undefined) {
      sendApiError(res, 400, 'VALIDATION_ERROR', 'Provide at least one of price or stock');
      return;
    }
    if (
      rawPrice !== undefined &&
      (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice > 1_000_000)
    ) {
      sendApiError(res, 400, 'INVALID_PRICE', 'price must be a positive finite number');
      return;
    }
    if (
      rawStock !== undefined &&
      (typeof rawStock !== 'number' || !Number.isInteger(rawStock) || rawStock < 0 || rawStock > 100_000)
    ) {
      sendApiError(res, 400, 'INVALID_STOCK', 'stock must be a non-negative integer');
      return;
    }

    try {
      const updated = shopAdapter.updateProductAuthoritative(productId, {
        price: rawPrice as number | undefined,
        stock: rawStock as number | undefined,
      });

      if (!updated) {
        sendApiError(res, 404, 'PRODUCT_NOT_FOUND', `Product "${productId}" not found`);
        return;
      }
      res.json({ product: updated });
    } catch (err) {
      sendApiError(
        res,
        400,
        'CATALOG_UPDATE_FAILED',
        err instanceof Error ? err.message : 'Failed to update product'
      );
    }
  });

  return router;
}
