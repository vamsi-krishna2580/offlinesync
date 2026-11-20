import crypto from 'crypto';
import type {
  ConflictRecord,
  ConflictResolutionPolicy,
  ConflictType,
  ResolveConflictRequest,
  SyncOperation,
} from '../../packages/offlinesync-types';
import type { DocumentCollection } from '../persistence/DocumentStore';

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
 * - MANUAL_RESOLUTION (recorded in Conflict Center for human/operator review)
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
      // Deterministic tie-breaker: compare server updatedAt against operation createdAt,
      // then break equal timestamps lexicographically by deviceId vs 'server'.
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

    // MANUAL_RESOLUTION (or domain handler escalated to manual)
    this.conflictsCol.insertOne(baseRecord as ConflictRecord & Record<string, unknown>);
    return { conflict: baseRecord, autoResolved: false, winningPayload: null };
  }

  resolveManually(
    conflictId: string,
    req: ResolveConflictRequest
  ): ConflictRecord | null {
    const existing = this.conflictsCol.findById(conflictId);
    if (!existing) return null;

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
      resolvedAt: now,
      resolvedPayload,
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
    return updated;
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
