import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type {
  ApiErrorResponse,
  ExperimentRunRecord,
  RegisterDeviceRequest,
  ResolveConflictRequest,
  SyncOperation,
  SyncProcessRequest,
  SyncPullRequest,
  SyncPushRequest,
} from '../../packages/offlinesync-types';
import type { SyncCoreEngine } from '../offlinesync-core/SyncCoreEngine';

export const MAX_BATCH_SIZE = 100;
export const MAX_PAYLOAD_JSON_LIMIT = '256kb';
export const DEFAULT_LOCAL_MONITOR_TOKEN = 'offlinesync-local-monitor-token';

const SAFE_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

export function getConfiguredMonitorToken(): string {
  return process.env.OFFLINESYNC_MONITOR_TOKEN || DEFAULT_LOCAL_MONITOR_TOKEN;
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function sendApiError(
  res: Response,
  statusCode: number,
  code: string,
  error: string,
  details?: string[]
): void {
  const payload: ApiErrorResponse = { error, code };
  if (details && details.length > 0) {
    payload.details = details;
  }
  res.status(statusCode).json(payload);
}

export function extractDeviceToken(req: Request): string | undefined {
  const headerVal = req.header('x-device-token');
  if (headerVal && headerVal.trim()) return headerVal.trim();
  const auth = req.header('authorization');
  if (auth?.startsWith('Device ')) {
    return auth.slice('Device '.length).trim();
  }
  return undefined;
}

export function extractMonitorToken(req: Request): string | undefined {
  const headerVal = req.header('x-monitor-token');
  if (headerVal && headerVal.trim()) return headerVal.trim();
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  if (typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }
  return undefined;
}

export function isMonitorAuthorized(req: Request): boolean {
  const token = extractMonitorToken(req);
  if (!token) return false;
  return timingSafeCompare(token, getConfiguredMonitorToken());
}

/**
 * Lightweight bearer-token middleware protecting administrative Monitor &
 * conflict resolution endpoints for this academic prototype.
 */
export function requireMonitorAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isMonitorAuthorized(req)) {
    sendApiError(
      res,
      401,
      'MONITOR_UNAUTHORIZED',
      'Missing or invalid Monitor authorization token (X-Monitor-Token)'
    );
    return;
  }
  next();
}

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_REGEX.test(value);
}

export function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && value.includes('T');
}

export function isValidCursor(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  code?: string;
  statusCode?: number;
  error?: string;
  details?: string[];
}

export function validateRegisterDeviceBody(
  body: unknown,
  core: SyncCoreEngine
): ValidationResult<RegisterDeviceRequest> {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_PAYLOAD',
      error: 'Request body must be a JSON object',
    };
  }
  const details: string[] = [];
  if (!isValidId(body.deviceId)) {
    details.push('deviceId must be 1–128 characters matching [A-Za-z0-9._:-]');
  }
  if (!isValidId(body.appId)) {
    details.push('appId must be 1–128 characters matching [A-Za-z0-9._:-]');
  } else if (!core.hasRegisteredApp(body.appId)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'UNKNOWN_APP_ID',
      error: `Application "${body.appId}" is not registered on this server`,
    };
  }
  if (
    body.deviceName !== undefined &&
    (typeof body.deviceName !== 'string' || body.deviceName.trim().length === 0 || body.deviceName.length > 120)
  ) {
    details.push('deviceName must be a non-empty string up to 120 characters');
  }
  if (
    body.platform !== undefined &&
    (typeof body.platform !== 'string' || body.platform.length > 64)
  ) {
    details.push('platform must be a string up to 64 characters');
  }

  if (details.length > 0) {
    return {
      ok: false,
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      error: 'Invalid device registration request',
      details,
    };
  }

  return {
    ok: true,
    value: {
      deviceId: body.deviceId as string,
      appId: body.appId as string,
      deviceName:
        typeof body.deviceName === 'string' && body.deviceName.trim()
          ? body.deviceName.trim()
          : `Device ${(body.deviceId as string).slice(0, 8)}`,
      platform: typeof body.platform === 'string' ? body.platform : 'web-indexeddb',
    },
  };
}

function validateOperationItem(
  raw: unknown,
  index: number,
  expectedDeviceId: string,
  expectedAppId: string,
  core: SyncCoreEngine
): { ok: true; op: SyncOperation } | { ok: false; statusCode: number; code: string; message: string } {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_OPERATION',
      message: `operations[${index}] must be a JSON object`,
    };
  }
  if (!isValidId(raw.operationId)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_OPERATION_ID',
      message: `operations[${index}].operationId is malformed`,
    };
  }
  if (!isValidId(raw.deviceId)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_DEVICE_ID',
      message: `operations[${index}].deviceId is malformed`,
    };
  }
  if (raw.deviceId !== expectedDeviceId) {
    return {
      ok: false,
      statusCode: 403,
      code: 'OPERATION_OWNERSHIP_VIOLATION',
      message: `operations[${index}].deviceId "${raw.deviceId}" does not match authenticated device "${expectedDeviceId}"`,
    };
  }
  if (!isValidId(raw.appId) || raw.appId !== expectedAppId) {
    return {
      ok: false,
      statusCode: 403,
      code: 'OPERATION_APP_MISMATCH',
      message: `operations[${index}].appId does not match request appId "${expectedAppId}"`,
    };
  }

  const adapter = core.getAdapter(expectedAppId);
  if (typeof raw.entityType !== 'string' || !adapter?.supportedEntityTypes.includes(raw.entityType)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_ENTITY_TYPE',
      message: `operations[${index}].entityType "${String(raw.entityType)}" is not supported for app "${expectedAppId}"`,
    };
  }
  if (!isValidId(raw.entityId)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_ENTITY_ID',
      message: `operations[${index}].entityId is malformed`,
    };
  }

  const allowedOps = adapter.supportedOperationTypes?.[raw.entityType];
  if (
    typeof raw.operationType !== 'string' ||
    !raw.operationType.trim() ||
    (allowedOps && !allowedOps.includes(raw.operationType))
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_OPERATION_TYPE',
      message: `operations[${index}].operationType "${String(raw.operationType)}" is invalid for entityType "${raw.entityType}"`,
    };
  }

  if (
    typeof raw.sequence !== 'number' ||
    !Number.isInteger(raw.sequence) ||
    raw.sequence < 1
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_SEQUENCE',
      message: `operations[${index}].sequence must be a positive integer`,
    };
  }
  if (
    typeof raw.baseVersion !== 'number' ||
    !Number.isInteger(raw.baseVersion) ||
    raw.baseVersion < 0
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_BASE_VERSION',
      message: `operations[${index}].baseVersion must be a non-negative integer`,
    };
  }
  if (!isValidIsoTimestamp(raw.createdAt)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_TIMESTAMP',
      message: `operations[${index}].createdAt must be a valid ISO-8601 timestamp`,
    };
  }
  if (!isPlainObject(raw.payload)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_OPERATION_PAYLOAD',
      message: `operations[${index}].payload must be a JSON object`,
    };
  }

  return { ok: true, op: raw as unknown as SyncOperation };
}

export function validateSyncPushOrProcessBody(
  body: unknown,
  core: SyncCoreEngine,
  isProcess: boolean
): ValidationResult<SyncProcessRequest | SyncPushRequest> {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_PAYLOAD',
      error: 'Request body must be a JSON object',
    };
  }
  if (!isValidId(body.deviceId)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_DEVICE_ID',
      error: 'deviceId is required and must be a valid identifier',
    };
  }
  if (!isValidId(body.appId) || !core.hasRegisteredApp(body.appId)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'UNKNOWN_APP_ID',
      error: `Invalid or unregistered appId "${String(body.appId)}"`,
    };
  }
  if (body.sessionId !== undefined && !isValidId(body.sessionId)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_SESSION_ID',
      error: 'sessionId must be a valid identifier',
    };
  }
  if (!isValidCursor(body.lastCursor)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_CURSOR',
      error: 'lastCursor must be a non-negative integer',
    };
  }
  if (!Array.isArray(body.operations)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_OPERATIONS',
      error: 'operations must be an array',
    };
  }
  if (body.operations.length > MAX_BATCH_SIZE) {
    return {
      ok: false,
      statusCode: 400,
      code: 'BATCH_TOO_LARGE',
      error: `Batch contains ${body.operations.length} operations; maximum allowed is ${MAX_BATCH_SIZE}`,
    };
  }

  const validatedOps: SyncOperation[] = [];
  for (let i = 0; i < body.operations.length; i++) {
    const check = validateOperationItem(
      body.operations[i],
      i,
      body.deviceId,
      body.appId,
      core
    );
    if (!check.ok) {
      return {
        ok: false,
        statusCode: check.statusCode,
        code: check.code,
        error: check.message,
      };
    }
    validatedOps.push(check.op);
  }

  if (isProcess) {
    const adapter = core.getAdapter(body.appId)!;
    if (body.entityTypes !== undefined) {
      if (
        !Array.isArray(body.entityTypes) ||
        body.entityTypes.some(
          (t) => typeof t !== 'string' || !adapter.supportedEntityTypes.includes(t)
        )
      ) {
        return {
          ok: false,
          statusCode: 400,
          code: 'INVALID_ENTITY_TYPES',
          error: 'entityTypes must be an array of supported entity types',
        };
      }
    }
    if (
      body.limit !== undefined &&
      (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 200)
    ) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_LIMIT',
        error: 'limit must be an integer between 1 and 200',
      };
    }
    if (
      body.pendingRemaining !== undefined &&
      (typeof body.pendingRemaining !== 'number' ||
        !Number.isInteger(body.pendingRemaining) ||
        body.pendingRemaining < 0)
    ) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_PENDING_REMAINING',
        error: 'pendingRemaining must be a non-negative integer',
      };
    }
  }

  return {
    ok: true,
    value: {
      deviceId: body.deviceId,
      appId: body.appId,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : `sess-${crypto.randomUUID()}`,
      lastCursor: body.lastCursor,
      operations: validatedOps,
      ...(isProcess
        ? {
            entityTypes: body.entityTypes as string[] | undefined,
            limit: body.limit as number | undefined,
            pendingRemaining: body.pendingRemaining as number | undefined,
          }
        : {}),
    },
  };
}

export function validateSyncPullBody(
  body: unknown,
  core: SyncCoreEngine
): ValidationResult<SyncPullRequest> {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_PAYLOAD',
      error: 'Request body must be a JSON object',
    };
  }
  if (!isValidId(body.deviceId)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_DEVICE_ID',
      error: 'deviceId is required and must be a valid identifier',
    };
  }
  if (!isValidId(body.appId) || !core.hasRegisteredApp(body.appId)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'UNKNOWN_APP_ID',
      error: `Invalid or unregistered appId "${String(body.appId)}"`,
    };
  }
  if (!isValidCursor(body.lastCursor)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_CURSOR',
      error: 'lastCursor must be a non-negative integer',
    };
  }
  if (
    body.limit !== undefined &&
    (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 200)
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_LIMIT',
      error: 'limit must be an integer between 1 and 200',
    };
  }

  const adapter = core.getAdapter(body.appId)!;
  if (body.entityTypes !== undefined) {
    if (
      !Array.isArray(body.entityTypes) ||
      body.entityTypes.some(
        (t) => typeof t !== 'string' || !adapter.supportedEntityTypes.includes(t)
      )
    ) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_ENTITY_TYPES',
        error: 'entityTypes must be an array of supported entity types',
      };
    }
  }

  return {
    ok: true,
    value: {
      deviceId: body.deviceId,
      appId: body.appId,
      sessionId: typeof body.sessionId === 'string' && isValidId(body.sessionId) ? body.sessionId : undefined,
      lastCursor: body.lastCursor,
      entityTypes: body.entityTypes as string[] | undefined,
      limit: body.limit as number | undefined,
    },
  };
}

export function validateResolveConflictBody(
  body: unknown
): ValidationResult<ResolveConflictRequest> {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_PAYLOAD',
      error: 'Request body must be a JSON object',
    };
  }

  const validChoices = new Set(['KEEP_SERVER', 'APPLY_CLIENT', 'CUSTOM']);
  if (typeof body.resolutionChoice !== 'string' || !validChoices.has(body.resolutionChoice)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_RESOLUTION_CHOICE',
      error: 'resolutionChoice must be one of KEEP_SERVER, APPLY_CLIENT, or CUSTOM',
    };
  }

  if (body.resolutionChoice === 'CUSTOM' && !isPlainObject(body.resolvedPayload)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_CUSTOM_PAYLOAD',
      error: 'CUSTOM resolutionChoice requires a JSON object resolvedPayload',
    };
  }

  if (
    body.expectedServerVersion !== undefined &&
    (typeof body.expectedServerVersion !== 'number' ||
      !Number.isInteger(body.expectedServerVersion) ||
      body.expectedServerVersion < 0)
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_EXPECTED_VERSION',
      error: 'expectedServerVersion must be a non-negative integer',
    };
  }

  if (
    body.idempotencyKey !== undefined &&
    !isValidId(body.idempotencyKey)
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_IDEMPOTENCY_KEY',
      error: 'idempotencyKey must be a valid identifier',
    };
  }

  return {
    ok: true,
    value: {
      resolutionChoice: body.resolutionChoice as ResolveConflictRequest['resolutionChoice'],
      resolvedPayload: isPlainObject(body.resolvedPayload) ? body.resolvedPayload : undefined,
      expectedServerVersion: body.expectedServerVersion as number | undefined,
      idempotencyKey: body.idempotencyKey as string | undefined,
      actor: typeof body.actor === 'string' ? body.actor.slice(0, 80) : undefined,
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined,
    },
  };
}

export function validateExperimentRunBody(body: unknown): ValidationResult<{
  scenario: ExperimentRunRecord['scenario'];
  operationCount: number;
  batchSize: number;
}> {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_PAYLOAD',
      error: 'Request body must be a JSON object',
    };
  }

  const validScenarios = new Set([
    'STABLE_CONNECTION',
    'SIMULATED_INTERRUPTION',
    'OFFLINE_BACKLOG',
    'DUPLICATE_DELIVERY',
    'CONCURRENT_MODIFICATION',
  ]);
  const scenario = body.scenario ?? 'STABLE_CONNECTION';
  if (typeof scenario !== 'string' || !validScenarios.has(scenario)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_SCENARIO',
      error: 'Invalid benchmark scenario',
    };
  }

  const operationCount = body.operationCount ?? 10;
  if (
    typeof operationCount !== 'number' ||
    !Number.isInteger(operationCount) ||
    operationCount < 1 ||
    operationCount > 500
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_OPERATION_COUNT',
      error: 'operationCount must be an integer between 1 and 500',
    };
  }

  const batchSize = body.batchSize ?? 25;
  if (
    typeof batchSize !== 'number' ||
    !Number.isInteger(batchSize) ||
    batchSize < 5 ||
    batchSize > 100
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_BATCH_SIZE',
      error: 'batchSize must be an integer between 5 and 100',
    };
  }

  return {
    ok: true,
    value: {
      scenario: scenario as ExperimentRunRecord['scenario'],
      operationCount,
      batchSize,
    },
  };
}
