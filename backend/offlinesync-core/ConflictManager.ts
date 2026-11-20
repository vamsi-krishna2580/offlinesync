import crypto from 'crypto';
import type {
  ConflictRecord,
  ConflictResolutionPolicy,
  ConflictType,
  ResolveConflictRequest,
  SyncOperation,
} from '../../packages/offlinesync-types';
import type { DocumentCollection } from '../persistence/DocumentStore';

export class ConflictResolutionError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 409) {
    super(message);
    this.name = 'ConflictResolutionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ServerConflictDecision {
  conflict: ConflictRecord;
  autoResolved: boolean;
  winningPayload: Record<string, unknown> | null;
}

export type ServerDomainConflictHandler = (params: {
  operation: SyncOperation;
  remoteState: Record<string, unknown> | null;
  remoteVersion: number;
  conflictType: ConflictType;
}) => {
  autoResolve: boolean;
  winningPayload: Record<string, unknown> | null;
  summary: string;
};

/**
 * Server-side Policy-Based Conflict Detector and Resolver.
 * Supports:
 * - SERVER_AUTHORITATIVE (e.g. inventory, product prices)
 * - LAST_WRITE_WINS_DETERMINISTIC (version + timestamp + deviceId tie-breaking)
 * - MANUAL_RESOLUTION (recorded in Conflict Center with optimistic concurrency + idempotency guards)
 * - DOMAIN_CUSTOM (pluggable domain-specific resolvers such as cart delta merging)
 */
export class ConflictManager {
  private readonly conflictsCol: DocumentCollection<ConflictRecord & Record<string, unknown>>;
  private entityPolicies = new Map<string, ConflictResolutionPolicy>();
  private domainHandlers = new Map<string, ServerDomainConflictHandler>();

  constructor(conflictsCol: DocumentCollection<ConflictRecord & Record<string, unknown>>) {
    this.conflictsCol = conflictsCol;
  }

  registerPolicy(
    entityType: string,
    policy: ConflictResolutionPolicy,
    handler?: ServerDomainConflictHandler
  ): void {
    this.entityPolicies.set(entityType, policy);
    if (handler) {
      this.domainHandlers.set(entityType, handler);
    }
  }

  getPolicy(entityType: string): ConflictResolutionPolicy {
    return this.entityPolicies.get(entityType) ?? 'MANUAL_RESOLUTION';
  }

  detectVersionMismatch(baseVersion: number, currentServerVersion: number): boolean {
    return currentServerVersion > baseVersion;
  }

  recordAndEvaluate(params: {
    operation: SyncOperation;
    remoteVersion: number;
    remoteState: Record<string, unknown> | null;
    conflictType: ConflictType;
    overridePolicy?: ConflictResolutionPolicy;
    summary?: string;
  }): ServerConflictDecision {
    const now = new Date().toISOString();
    const policy = params.overridePolicy ?? this.getPolicy(params.operation.entityType);
    const conflictId = `conf-${crypto.randomUUID()}`;

    const baseRecord: ConflictRecord = {
      conflictId,
      operationId: params.operation.operationId,
      deviceId: params.operation.deviceId,
      appId: params.operation.appId,
      entityType: params.operation.entityType,
      entityId: params.operation.entityId,
      localVersion: params.operation.baseVersion,
      remoteVersion: params.remoteVersion,
      localPayload: params.operation.payload,
      remoteState: params.remoteState,
      conflictType: params.conflictType,
      resolutionStatus: 'OPEN',
      resolutionPolicy: policy,
      resolvedPayload: null,
      resolutionSummary: params.summary,
      detectedAt: now,
      resolvedAt: null,
      history: [
        {
          timestamp: now,
          actor: 'sync-core',
          action: 'CONFLICT_DETECTED',
          policy,
          note:
            params.summary ??
            `Local baseVersion ${params.operation.baseVersion} conflicts with server version ${params.remoteVersion}`,
        },
      ],
    };

    if (policy === 'SERVER_AUTHORITATIVE') {
      baseRecord.resolutionStatus = 'RESOLVED_AUTO';
      baseRecord.resolvedAt = now;
      baseRecord.resolutionChoice = 'KEEP_SERVER';
      baseRecord.resolvedPayload = params.remoteState;
      baseRecord.resolutionSummary =
        params.summary ?? 'Authoritative server version retained.';
      baseRecord.history.push({
        timestamp: now,
        actor: 'policy:SERVER_AUTHORITATIVE',
        action: 'AUTO_RESOLVED_KEEP_SERVER',
        policy,
        note: baseRecord.resolutionSummary,
      });
      this.conflictsCol.insertOne(baseRecord as ConflictRecord & Record<string, unknown>);
      return {
        conflict: baseRecord,
        autoResolved: true,
        winningPayload: params.remoteState,
      };
    }

    if (policy === 'LAST_WRITE_WINS_DETERMINISTIC') {
      const serverUpdatedAt =
        typeof params.remoteState?.updatedAt === 'string'
          ? params.remoteState.updatedAt
          : '';
      const clientWins =
        params.operation.createdAt > serverUpdatedAt ||
        (params.operation.createdAt === serverUpdatedAt &&
          params.operation.deviceId > 'server');

      const winning = clientWins ? params.operation.payload : params.remoteState;
      baseRecord.resolutionStatus = 'RESOLVED_AUTO';
      baseRecord.resolvedAt = now;
      baseRecord.resolutionChoice = clientWins ? 'APPLY_CLIENT' : 'KEEP_SERVER';
      baseRecord.resolvedPayload = winning;
      baseRecord.resolutionSummary = clientWins
        ? 'Deterministic LWW applied client payload.'
        : 'Deterministic LWW retained server state.';
      baseRecord.history.push({
        timestamp: now,
        actor: 'policy:LAST_WRITE_WINS_DETERMINISTIC',
        action: clientWins ? 'AUTO_RESOLVED_APPLY_CLIENT' : 'AUTO_RESOLVED_KEEP_SERVER',
        policy,
        note: baseRecord.resolutionSummary,
      });
      this.conflictsCol.insertOne(baseRecord as ConflictRecord & Record<string, unknown>);
      return { conflict: baseRecord, autoResolved: true, winningPayload: winning };
    }

    if (policy === 'DOMAIN_CUSTOM') {
      const handler = this.domainHandlers.get(params.operation.entityType);
      if (handler) {
        const res = handler({
          operation: params.operation,
          remoteState: params.remoteState,
          remoteVersion: params.remoteVersion,
          conflictType: params.conflictType,
        });
        if (res.autoResolve) {
          baseRecord.resolutionStatus = 'RESOLVED_AUTO';
          baseRecord.resolvedAt = now;
          baseRecord.resolvedPayload = res.winningPayload;
          baseRecord.resolutionSummary = res.summary;
          baseRecord.history.push({
            timestamp: now,
            actor: 'policy:DOMAIN_CUSTOM',
            action: 'AUTO_RESOLVED_DOMAIN',
            policy,
            note: res.summary,
          });
          this.conflictsCol.insertOne(
            baseRecord as ConflictRecord & Record<string, unknown>
          );
          return {
            conflict: baseRecord,
            autoResolved: true,
            winningPayload: res.winningPayload,
          };
        }
      }
    }

    this.conflictsCol.insertOne(baseRecord as ConflictRecord & Record<string, unknown>);
    return { conflict: baseRecord, autoResolved: false, winningPayload: null };
  }

  /**
   * Resolves an OPEN conflict manually with:
   * - Single-resolution enforcement (prevents inconsistent double-resolution)
   * - Idempotent replay when identical idempotencyKey or choice+payload is re-submitted
   * - Optimistic concurrency check (`currentServerVersion`) so newer server state
   *   is never blindly overwritten.
   */
  resolveManually(
    conflictId: string,
    req: ResolveConflictRequest,
    currentServerVersion?: number | null
  ): { conflict: ConflictRecord; idempotentReplay: boolean } {
    const existing = this.conflictsCol.findById(conflictId);
    if (!existing) {
      throw new ConflictResolutionError(
        `Conflict "${conflictId}" not found`,
        'CONFLICT_NOT_FOUND',
        404
      );
    }

    // 1. Check already-resolved conflicts for idempotency vs inconsistent re-resolution
    if (existing.resolutionStatus !== 'OPEN') {
      const sameIdempotencyKey =
        Boolean(req.idempotencyKey) &&
        existing.resolutionIdempotencyKey === req.idempotencyKey;

      const requestedPayload =
        req.resolutionChoice === 'KEEP_SERVER'
          ? existing.remoteState
          : req.resolutionChoice === 'APPLY_CLIENT'
          ? existing.localPayload
          : req.resolvedPayload ?? null;

      const sameDecision =
        existing.resolutionChoice === req.resolutionChoice &&
        JSON.stringify(existing.resolvedPayload ?? null) === JSON.stringify(requestedPayload);

      if (sameIdempotencyKey || sameDecision) {
        return { conflict: existing, idempotentReplay: true };
      }

      throw new ConflictResolutionError(
        `Conflict "${conflictId}" is already ${existing.resolutionStatus} (choice: ${existing.resolutionChoice ?? 'AUTO'}) and cannot be resolved inconsistently`,
        'CONFLICT_ALREADY_RESOLVED',
        409
      );
    }

    // 2. Validate CUSTOM payload requirement
    if (req.resolutionChoice === 'CUSTOM') {
      if (
        !req.resolvedPayload ||
        typeof req.resolvedPayload !== 'object' ||
        Array.isArray(req.resolvedPayload)
      ) {
        throw new ConflictResolutionError(
          'CUSTOM resolution requires a valid resolvedPayload object',
          'INVALID_CUSTOM_PAYLOAD',
          400
        );
      }
    }

    // 3. Optimistic concurrency check: refuse to blindly overwrite newer server state
    if (
      req.resolutionChoice !== 'KEEP_SERVER' &&
      typeof currentServerVersion === 'number' &&
      currentServerVersion > existing.remoteVersion
    ) {
      if (req.expectedServerVersion !== currentServerVersion) {
        throw new ConflictResolutionError(
          `Server entity "${existing.entityType}:${existing.entityId}" advanced from v${existing.remoteVersion} to v${currentServerVersion} since this conflict was detected. Reload latest server state and pass expectedServerVersion=${currentServerVersion} to confirm.`,
          'STALE_CONFLICT_RESOLUTION',
          409
        );
      }
    }

    const now = new Date().toISOString();
    let resolvedPayload: Record<string, unknown> | null = existing.remoteState;
    if (req.resolutionChoice === 'APPLY_CLIENT') {
      resolvedPayload = existing.localPayload;
    } else if (req.resolutionChoice === 'CUSTOM' && req.resolvedPayload) {
      resolvedPayload = req.resolvedPayload;
    }

    const updated: ConflictRecord = {
      ...existing,
      resolutionStatus: 'RESOLVED_MANUAL',
      resolutionChoice: req.resolutionChoice,
      resolvedAt: now,
      resolvedPayload,
      resolutionIdempotencyKey: req.idempotencyKey,
      resolutionSummary:
        req.note || `Manually resolved with strategy ${req.resolutionChoice}.`,
      history: [
        ...existing.history,
        {
          timestamp: now,
          actor: req.actor || 'monitor-operator',
          action: `MANUAL_${req.resolutionChoice}`,
          policy: existing.resolutionPolicy,
          note: req.note,
        },
      ],
    };

    this.conflictsCol.upsertOne(updated as ConflictRecord & Record<string, unknown>);
    return { conflict: updated, idempotentReplay: false };
  }

  getById(conflictId: string): ConflictRecord | null {
    return this.conflictsCol.findById(conflictId);
  }

  listAll(filter?: { status?: string; entityType?: string }): ConflictRecord[] {
    return this.conflictsCol
      .find((doc) => {
        if (filter?.status && filter.status !== 'ALL' && doc.resolutionStatus !== filter.status) {
          return false;
        }
        if (filter?.entityType && doc.entityType !== filter.entityType) return false;
        return true;
      })
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }
}
