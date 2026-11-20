import { Router } from 'express';
import type {
  RegisterDeviceRequest,
  ResolveConflictRequest,
  SyncProcessRequest,
  SyncPullRequest,
  SyncPushRequest,
} from '../../packages/offlinesync-types';
import type { SyncCoreEngine } from '../offlinesync-core/SyncCoreEngine';

export function createSyncRouter(core: SyncCoreEngine): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    res.json({
      status: 'OK',
      serverTimestamp: new Date().toISOString(),
      currentCursor: core.reconciliation.getCurrentCursor(),
    });
  });

  router.post('/register-device', (req, res) => {
    const body = req.body as RegisterDeviceRequest;
    if (!body?.deviceId || !body?.appId) {
      res.status(400).json({ error: 'deviceId and appId are required' });
      return;
    }
    const result = core.registerDevice(body);
    res.json(result);
  });

  router.post('/push', (req, res) => {
    const body = req.body as SyncPushRequest;
    if (!body?.deviceId || !body?.appId || !Array.isArray(body.operations)) {
      res.status(400).json({ error: 'deviceId, appId, and operations array are required' });
      return;
    }
    const bytesSent = Buffer.byteLength(JSON.stringify(body), 'utf-8');
    const result = core.push(body, bytesSent);
    res.json(result);
  });

  router.post('/pull', (req, res) => {
    const body = req.body as SyncPullRequest;
    if (!body?.deviceId || !body?.appId) {
      res.status(400).json({ error: 'deviceId and appId are required' });
      return;
    }
    const result = core.pull(body);
    res.json(result);
  });

  router.post('/process', (req, res) => {
    const body = req.body as SyncProcessRequest;
    if (!body?.deviceId || !body?.appId || !Array.isArray(body.operations)) {
      res.status(400).json({ error: 'deviceId, appId, and operations array are required' });
      return;
    }
    const bytesSent = Buffer.byteLength(JSON.stringify(body), 'utf-8');
    const result = core.process(body, bytesSent);
    res.json(result);
  });

  router.get('/devices', (_req, res) => {
    res.json({ devices: core.devices.listAll() });
  });

  router.get('/devices/:id', (req, res) => {
    const device = core.devices.getById(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    const operations = core.idempotency.listOperations({ deviceId: device.deviceId, limit: 100 });
    const sessions = core.listSessions({ deviceId: device.deviceId, limit: 50 });
    const logs = core.telemetry.listLogs({ deviceId: device.deviceId, limit: 100 });
    res.json({ device, operations, sessions, logs });
  });

  router.get('/operations', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const operations = core.idempotency.listOperations({ status, deviceId, entityType, limit: 250 });
    res.json({ operations });
  });

  router.get('/sessions', (req, res) => {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const sessions = core.listSessions({ deviceId, limit: 150 });
    res.json({ sessions });
  });

  router.get('/conflicts', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const conflicts = core.conflicts.listAll({ status, entityType });
    res.json({ conflicts });
  });

  router.post('/conflicts/:id/resolve', (req, res) => {
    const body = req.body as ResolveConflictRequest;
    if (!body?.resolutionChoice) {
      res.status(400).json({ error: 'resolutionChoice is required' });
      return;
    }
    const resolved = core.resolveConflict(req.params.id, body);
    if (!resolved) {
      res.status(404).json({ error: 'Conflict not found' });
      return;
    }
    res.json({ conflict: resolved });
  });

  return router;
}
