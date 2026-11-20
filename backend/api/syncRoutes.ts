import { Router } from 'express';
import type { SyncProcessRequest, SyncPushRequest } from '../../packages/offlinesync-types';
import { ConflictResolutionError } from '../offlinesync-core/ConflictManager';
import { DeviceAuthError } from '../offlinesync-core/DeviceRegistry';
import type { SyncCoreEngine } from '../offlinesync-core/SyncCoreEngine';
import { PersistenceError } from '../persistence/DocumentStore';
import {
  extractDeviceToken,
  isMonitorAuthorized,
  isValidId,
  requireMonitorAuth,
  sendApiError,
  validateRegisterDeviceBody,
  validateResolveConflictBody,
  validateSyncPullBody,
  validateSyncPushOrProcessBody,
} from './validation';

function handleRouteError(res: import('express').Response, err: unknown): void {
  if (err instanceof DeviceAuthError) {
    sendApiError(res, err.statusCode, err.code, err.message);
    return;
  }
  if (err instanceof ConflictResolutionError) {
    sendApiError(res, err.statusCode, err.code, err.message);
    return;
  }
  if (err instanceof PersistenceError) {
    sendApiError(res, 503, 'PERSISTENCE_FAILURE', err.message);
    return;
  }
  sendApiError(
    res,
    500,
    'INTERNAL_ERROR',
    err instanceof Error ? err.message : 'Unexpected server error'
  );
}

export function createSyncRouter(core: SyncCoreEngine): Router {
  const router = Router();

  // Lightweight unauthenticated reachability probe (exposes no sensitive data)
  router.get('/status', (_req, res) => {
    res.json({
      status: 'OK',
      serverTimestamp: new Date().toISOString(),
      currentCursor: core.reconciliation.getCurrentCursor(),
    });
  });

  // Device registration: issues per-device X-Device-Token; re-registering existing ID requires token
  router.post('/register-device', (req, res) => {
    const validated = validateRegisterDeviceBody(req.body, core);
    if (!validated.ok || !validated.value) {
      sendApiError(
        res,
        validated.statusCode ?? 400,
        validated.code ?? 'VALIDATION_ERROR',
        validated.error ?? 'Invalid request',
        validated.details
      );
      return;
    }

    try {
      const presentedToken = extractDeviceToken(req);
      const result = core.registerDevice(validated.value, presentedToken);
      res.json(result);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/push', (req, res) => {
    const validated = validateSyncPushOrProcessBody(req.body, core, false);
    if (!validated.ok || !validated.value) {
      sendApiError(
        res,
        validated.statusCode ?? 400,
        validated.code ?? 'VALIDATION_ERROR',
        validated.error ?? 'Invalid push request',
        validated.details
      );
      return;
    }

    try {
      const payload = validated.value as SyncPushRequest;
      core.devices.authenticateDevice(
        payload.deviceId,
        payload.appId,
        extractDeviceToken(req)
      );
      const bytesSent = Buffer.byteLength(JSON.stringify(payload), 'utf-8');
      const result = core.push(payload, bytesSent);
      res.json(result);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/pull', (req, res) => {
    const validated = validateSyncPullBody(req.body, core);
    if (!validated.ok || !validated.value) {
      sendApiError(
        res,
        validated.statusCode ?? 400,
        validated.code ?? 'VALIDATION_ERROR',
        validated.error ?? 'Invalid pull request',
        validated.details
      );
      return;
    }

    try {
      core.devices.authenticateDevice(
        validated.value.deviceId,
        validated.value.appId,
        extractDeviceToken(req)
      );
      const result = core.pull(validated.value);
      res.json(result);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/process', (req, res) => {
    const validated = validateSyncPushOrProcessBody(req.body, core, true);
    if (!validated.ok || !validated.value) {
      sendApiError(
        res,
        validated.statusCode ?? 400,
        validated.code ?? 'VALIDATION_ERROR',
        validated.error ?? 'Invalid process request',
        validated.details
      );
      return;
    }

    try {
      const payload = validated.value as SyncProcessRequest;
      core.devices.authenticateDevice(
        payload.deviceId,
        payload.appId,
        extractDeviceToken(req)
      );
      const bytesSent = Buffer.byteLength(JSON.stringify(payload), 'utf-8');
      const result = core.process(payload, bytesSent);
      res.json(result);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // Protected Monitor / Admin introspection endpoints
  router.get('/devices', requireMonitorAuth, (_req, res) => {
    res.json({ devices: core.devices.listAll() });
  });

  // Device detail: accessible by authorized Monitor OR by the owning device presenting its own token
  router.get('/devices/:id', (req, res) => {
    const deviceId = req.params.id;
    if (!isValidId(deviceId)) {
      sendApiError(res, 400, 'INVALID_DEVICE_ID', 'Malformed device ID');
      return;
    }

    const monitorOk = isMonitorAuthorized(req);
    if (!monitorOk) {
      try {
        core.devices.authenticateDevice(deviceId, null, extractDeviceToken(req));
      } catch (err) {
        handleRouteError(res, err);
        return;
      }
    }

    const device = core.devices.getById(deviceId);
    if (!device) {
      sendApiError(res, 404, 'DEVICE_NOT_FOUND', `Device "${deviceId}" not found`);
      return;
    }
    const operations = core.idempotency.listOperations({ deviceId: device.deviceId, limit: 100 });
    const sessions = core.listSessions({ deviceId: device.deviceId, limit: 50 });
    const logs = core.telemetry.listLogs({ deviceId: device.deviceId, limit: 100 });
    res.json({ device, operations, sessions, logs });
  });

  router.get('/operations', requireMonitorAuth, (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const operations = core.idempotency.listOperations({
      status,
      deviceId,
      entityType,
      limit: 250,
    });
    res.json({ operations });
  });

  router.get('/sessions', requireMonitorAuth, (req, res) => {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const sessions = core.listSessions({ deviceId, limit: 150 });
    res.json({ sessions });
  });

  router.get('/conflicts', requireMonitorAuth, (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const conflicts = core.conflicts.listAll({ status, entityType });
    res.json({ conflicts });
  });

  router.post('/conflicts/:id/resolve', requireMonitorAuth, (req, res) => {
    const conflictId = req.params.id;
    if (!isValidId(conflictId)) {
      sendApiError(res, 400, 'INVALID_CONFLICT_ID', 'Malformed conflict ID');
      return;
    }
    const validated = validateResolveConflictBody(req.body);
    if (!validated.ok || !validated.value) {
      sendApiError(
        res,
        validated.statusCode ?? 400,
        validated.code ?? 'VALIDATION_ERROR',
        validated.error ?? 'Invalid conflict resolution payload',
        validated.details
      );
      return;
    }

    try {
      const result = core.resolveConflict(conflictId, validated.value);
      res.json(result);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  return router;
}
