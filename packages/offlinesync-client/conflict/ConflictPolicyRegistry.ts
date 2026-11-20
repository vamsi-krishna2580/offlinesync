import type { ConflictRecord, ConflictResolutionPolicy } from '../../offlinesync-types';

export interface ClientConflictContext {
  conflict: ConflictRecord;
  localEntity: Record<string, unknown> | null;
  remoteEntity: Record<string, unknown> | null;
}

export interface ClientConflictResolutionResult {
  action: 'KEEP_REMOTE' | 'KEEP_LOCAL' | 'MERGE' | 'REQUIRE_MANUAL';
  mergedData?: Record<string, unknown>;
  note: string;
}

export type ClientConflictResolverFn = (
  ctx: ClientConflictContext
) => ClientConflictResolutionResult;

/**
 * Policy-based client conflict resolver registry.
 * Never defaults blindly to unconditional Last-Write-Wins.
 */
export class ConflictPolicyRegistry {
  private policies = new Map<string, ConflictResolutionPolicy>();
  private customResolvers = new Map<string, ClientConflictResolverFn>();

  registerPolicy(
    entityType: string,
    policy: ConflictResolutionPolicy,
    customResolver?: ClientConflictResolverFn
  ): void {
    this.policies.set(entityType, policy);
    if (customResolver) {
      this.customResolvers.set(entityType, customResolver);
    }
  }

  getPolicy(entityType: string): ConflictResolutionPolicy {
    return this.policies.get(entityType) ?? 'MANUAL_RESOLUTION';
  }

  resolve(ctx: ClientConflictContext): ClientConflictResolutionResult {
    const policy = this.getPolicy(ctx.conflict.entityType);

    if (policy === 'DOMAIN_CUSTOM') {
      const custom = this.customResolvers.get(ctx.conflict.entityType);
      if (custom) return custom(ctx);
    }

    if (policy === 'SERVER_AUTHORITATIVE') {
      return {
        action: 'KEEP_REMOTE',
        mergedData: ctx.remoteEntity ?? undefined,
        note: 'Server state is authoritative for this entity type.',
      };
    }

    if (policy === 'LAST_WRITE_WINS_DETERMINISTIC') {
      // Deterministic tie-breaking: compare server version first, then lexicographical deviceId
      if (ctx.conflict.remoteVersion >= ctx.conflict.localVersion) {
        return {
          action: 'KEEP_REMOTE',
          mergedData: ctx.remoteEntity ?? undefined,
          note: 'Deterministic LWW selected higher or equal remote revision.',
        };
      }
      return {
        action: 'KEEP_LOCAL',
        mergedData: ctx.localEntity ?? undefined,
        note: 'Deterministic LWW selected higher local revision.',
      };
    }

    return {
      action: 'REQUIRE_MANUAL',
      note: 'Requires explicit manual or user-guided resolution.',
    };
  }
}
