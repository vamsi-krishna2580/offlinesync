import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface UniqueIndexSpec<T> {
  name: string;
  keyFn: (doc: T) => string | null | undefined;
}

export class DuplicateKeyError extends Error {
  public readonly indexName: string;
  public readonly duplicateKey: string;

  constructor(collectionName: string, indexName: string, duplicateKey: string) {
    super(
      `Duplicate key violation in collection "${collectionName}" on index "${indexName}": ${duplicateKey}`
    );
    this.name = 'DuplicateKeyError';
    this.indexName = indexName;
    this.duplicateKey = duplicateKey;
  }
}

export class PersistenceError extends Error {
  public readonly causeError?: unknown;

  constructor(message: string, causeError?: unknown) {
    super(message);
    this.name = 'PersistenceError';
    this.causeError = causeError;
  }
}

export class CorruptPersistenceError extends PersistenceError {
  public readonly quarantinedPath?: string;

  constructor(message: string, quarantinedPath?: string, causeError?: unknown) {
    super(message, causeError);
    this.name = 'CorruptPersistenceError';
    this.quarantinedPath = quarantinedPath;
  }
}

export class MultiProcessLockError extends PersistenceError {
  public readonly lockPath: string;
  public readonly ownerPid: number | null;

  constructor(lockPath: string, ownerPid: number | null) {
    super(
      `DocumentStore lock "${lockPath}" is currently held by another live process (PID ${ownerPid ?? 'unknown'}). ` +
        `This JSON-backed DocumentStore only supports single-process access.`
    );
    this.name = 'MultiProcessLockError';
    this.lockPath = lockPath;
    this.ownerPid = ownerPid;
  }
}

/**
 * Single-process in-memory document collection with unique index enforcement
 * and snapshot/restore primitives for transactional rollback.
 *
 * NOTE: This prototype persistence layer is JSON-file backed (not a live MongoDB server).
 * MongoDB collection schemas & index scripts are provided separately in `database/`.
 */
export class DocumentCollection<T extends Record<string, unknown>> {
  public readonly name: string;
  private docs = new Map<string, T>();
  private primaryKeyField: keyof T & string;
  private uniqueIndexes: UniqueIndexSpec<T>[];
  private uniqueLookup = new Map<string, Map<string, string>>();
  private onChange?: () => void;

  constructor(
    name: string,
    primaryKeyField: keyof T & string,
    uniqueIndexes: UniqueIndexSpec<T>[] = [],
    onChange?: () => void
  ) {
    this.name = name;
    this.primaryKeyField = primaryKeyField;
    this.uniqueIndexes = uniqueIndexes;
    this.onChange = onChange;
    for (const idx of uniqueIndexes) {
      this.uniqueLookup.set(idx.name, new Map());
    }
  }

  insertOne(doc: T): T {
    const pk = String(doc[this.primaryKeyField]);
    if (this.docs.has(pk)) {
      throw new DuplicateKeyError(this.name, `pk_${this.primaryKeyField}`, pk);
    }

    for (const idx of this.uniqueIndexes) {
      const val = idx.keyFn(doc);
      if (val !== null && val !== undefined) {
        const lookup = this.uniqueLookup.get(idx.name)!;
        if (lookup.has(val)) {
          throw new DuplicateKeyError(this.name, idx.name, val);
        }
      }
    }

    const cloned = structuredClone(doc);
    this.docs.set(pk, cloned);
    for (const idx of this.uniqueIndexes) {
      const val = idx.keyFn(cloned);
      if (val !== null && val !== undefined) {
        this.uniqueLookup.get(idx.name)!.set(val, pk);
      }
    }
    this.onChange?.();
    return structuredClone(cloned);
  }

  upsertOne(doc: T): T {
    const pk = String(doc[this.primaryKeyField]);
    const existing = this.docs.get(pk);
    if (!existing) {
      return this.insertOne(doc);
    }

    for (const idx of this.uniqueIndexes) {
      const nextVal = idx.keyFn(doc);
      if (nextVal !== null && nextVal !== undefined) {
        const lookup = this.uniqueLookup.get(idx.name)!;
        const ownerPk = lookup.get(nextVal);
        if (ownerPk && ownerPk !== pk) {
          throw new DuplicateKeyError(this.name, idx.name, nextVal);
        }
      }
    }

    for (const idx of this.uniqueIndexes) {
      const oldVal = idx.keyFn(existing);
      if (oldVal !== null && oldVal !== undefined) {
        this.uniqueLookup.get(idx.name)!.delete(oldVal);
      }
    }

    const cloned = structuredClone(doc);
    this.docs.set(pk, cloned);
    for (const idx of this.uniqueIndexes) {
      const nextVal = idx.keyFn(cloned);
      if (nextVal !== null && nextVal !== undefined) {
        this.uniqueLookup.get(idx.name)!.set(nextVal, pk);
      }
    }
    this.onChange?.();
    return structuredClone(cloned);
  }

  findById(id: string): T | null {
    const found = this.docs.get(id);
    return found ? structuredClone(found) : null;
  }

  findByUniqueIndex(indexName: string, value: string): T | null {
    const lookup = this.uniqueLookup.get(indexName);
    if (!lookup) return null;
    const pk = lookup.get(value);
    if (!pk) return null;
    return this.findById(pk);
  }

  find(predicate?: (doc: T) => boolean): T[] {
    const out: T[] = [];
    for (const doc of this.docs.values()) {
      if (!predicate || predicate(doc)) {
        out.push(structuredClone(doc));
      }
    }
    return out;
  }

  count(predicate?: (doc: T) => boolean): number {
    if (!predicate) return this.docs.size;
    let total = 0;
    for (const doc of this.docs.values()) {
      if (predicate(doc)) total += 1;
    }
    return total;
  }

  deleteById(id: string): boolean {
    const existing = this.docs.get(id);
    if (!existing) return false;
    for (const idx of this.uniqueIndexes) {
      const val = idx.keyFn(existing);
      if (val !== null && val !== undefined) {
        this.uniqueLookup.get(idx.name)!.delete(val);
      }
    }
    this.docs.delete(id);
    this.onChange?.();
    return true;
  }

  toArray(): T[] {
    return Array.from(this.docs.values()).map((d) => structuredClone(d));
  }

  loadRaw(docs: T[]): void {
    this.docs.clear();
    for (const lookup of this.uniqueLookup.values()) lookup.clear();
    for (const doc of docs) {
      const pk = String(doc[this.primaryKeyField]);
      this.docs.set(pk, structuredClone(doc));
      for (const idx of this.uniqueIndexes) {
        const val = idx.keyFn(doc);
        if (val !== null && val !== undefined) {
          this.uniqueLookup.get(idx.name)!.set(val, pk);
        }
      }
    }
  }
}

export interface PersistedDatabaseSnapshot {
  version: number;
  savedAt: string;
  checksum: string;
  collections: Record<string, Record<string, unknown>[]>;
}

export interface DocumentStoreOptions {
  /**
   * When true (default), corrupted primary persistence files are quarantined to
   * `<file>.corrupt.<ts>.bak` and recovery is attempted from `<file>.backup`.
   * When false, `loadFromDisk()` throws `CorruptPersistenceError` immediately.
   */
  recoverFromCorruption?: boolean;
  /**
   * Optional test hook invoked just before writing snapshot to disk so automated
   * tests can deterministically inject persistence failures and verify rollback.
   */
  beforeWriteHook?: (targetPath: string) => void;
  /**
   * Suppress console error logs during negative test runs if desired.
   */
  silentLogs?: boolean;
}

export interface LoadResult {
  loaded: boolean;
  recoveredFromBackup: boolean;
  quarantinedCorruptPath?: string;
}

function computeCollectionsChecksum(
  collections: Record<string, Record<string, unknown>[]>
): string {
  const canonical = JSON.stringify(collections);
  return crypto.createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

/**
 * Single-process transactional JSON-backed DocumentStore.
 *
 * Guarantees within a single Node.js process:
 * - Multi-collection atomicity via `runTransaction(...)`: pre-transaction snapshot
 *   is restored across ALL collections and unique indexes if any mutation OR durable
 *   disk commit fails.
 * - Serialized atomic disk commits (temp file -> fsync -> backup rotation -> rename).
 * - SHA-256 payload integrity verification with corruption quarantine & backup recovery.
 * - Exclusive PID lockfile rejecting unsupported multi-process concurrent access.
 *
 * Limitations (documented honestly):
 * - Single-process only (not a distributed database or live MongoDB cluster).
 * - Full-snapshot JSON persistence scales for academic prototypes (~thousands of docs),
 *   not high-throughput production workloads.
 */
export class DocumentStore {
  private readonly persistPath: string | null;
  private readonly backupPath: string | null;
  private readonly lockPath: string | null;
  private readonly options: DocumentStoreOptions;

  private collections = new Map<string, DocumentCollection<Record<string, unknown>>>();
  private transactionDepth = 0;
  private dirtyOutsideTransaction = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lockHeld = false;
  private lastPersistenceError: Error | null = null;
  private commitCounter = 0;

  constructor(persistPath: string | null = null, options: DocumentStoreOptions = {}) {
    this.persistPath = persistPath;
    this.backupPath = persistPath ? `${persistPath}.backup` : null;
    this.lockPath = persistPath ? `${persistPath}.lock` : null;
    this.options = {
      recoverFromCorruption: options.recoverFromCorruption ?? true,
      beforeWriteHook: options.beforeWriteHook,
      silentLogs: options.silentLogs ?? false,
    };

    if (this.persistPath) {
      this.acquireProcessLock();
    }
  }

  getLastPersistenceError(): Error | null {
    return this.lastPersistenceError;
  }

  getCommitCount(): number {
    return this.commitCounter;
  }

  setBeforeWriteHook(hook: ((targetPath: string) => void) | undefined): void {
    this.options.beforeWriteHook = hook;
  }

  registerCollection<T extends Record<string, unknown>>(
    name: string,
    primaryKeyField: keyof T & string,
    uniqueIndexes: UniqueIndexSpec<T>[] = []
  ): DocumentCollection<T> {
    const existing = this.collections.get(name);
    if (existing) {
      return existing as unknown as DocumentCollection<T>;
    }
    const collection = new DocumentCollection<T>(
      name,
      primaryKeyField,
      uniqueIndexes,
      () => this.onCollectionMutated()
    );
    this.collections.set(
      name,
      collection as unknown as DocumentCollection<Record<string, unknown>>
    );
    return collection;
  }

  /**
   * Executes a multi-collection mutation atomically within the single-threaded runtime.
   * - Takes a full snapshot of all registered collections prior to executing `fn`.
   * - Supports nested calls (only the outermost transaction commits to disk).
   * - On ANY error (business invariant violation, duplicate index violation, or disk
   *   persistence failure), rolls back EVERY collection to its pre-transaction state
   *   and rethrows the error.
   */
  runTransaction<T>(fn: () => T): T {
    const isOutermost = this.transactionDepth === 0;
    const preSnapshot = isOutermost ? this.captureMemorySnapshot() : null;
    this.transactionDepth += 1;

    try {
      const result = fn();
      this.transactionDepth -= 1;

      if (isOutermost) {
        if (this.persistPath) {
          this.flushSync();
        }
        this.dirtyOutsideTransaction = false;
      }
      return result;
    } catch (err) {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      if (isOutermost && preSnapshot) {
        this.restoreMemorySnapshot(preSnapshot);
      }
      throw err;
    }
  }

  loadFromDisk(): LoadResult {
    if (!this.persistPath) {
      return { loaded: false, recoveredFromBackup: false };
    }

    const primaryExists = fs.existsSync(this.persistPath);
    if (!primaryExists) {
      if (this.backupPath && fs.existsSync(this.backupPath)) {
        const parsedBackup = this.parseAndVerifyFile(this.backupPath);
        this.applyParsedSnapshot(parsedBackup);
        this.flushSync();
        return { loaded: true, recoveredFromBackup: true };
      }
      return { loaded: false, recoveredFromBackup: false };
    }

    try {
      const parsed = this.parseAndVerifyFile(this.persistPath);
      this.applyParsedSnapshot(parsed);
      return { loaded: true, recoveredFromBackup: false };
    } catch (primaryErr) {
      const quarantinedPath = this.quarantineCorruptFile(this.persistPath);
      this.logError(
        `Corrupted persistence file detected at "${this.persistPath}". Quarantined to "${quarantinedPath}".`,
        primaryErr
      );

      if (!this.options.recoverFromCorruption) {
        throw new CorruptPersistenceError(
          `Persistence file "${this.persistPath}" is corrupted and was quarantined to "${quarantinedPath}".`,
          quarantinedPath,
          primaryErr
        );
      }

      if (this.backupPath && fs.existsSync(this.backupPath)) {
        try {
          const parsedBackup = this.parseAndVerifyFile(this.backupPath);
          this.applyParsedSnapshot(parsedBackup);
          this.flushSync();
          return {
            loaded: true,
            recoveredFromBackup: true,
            quarantinedCorruptPath: quarantinedPath,
          };
        } catch (backupErr) {
          throw new CorruptPersistenceError(
            `Both primary persistence file and backup are corrupted. Primary quarantined to "${quarantinedPath}".`,
            quarantinedPath,
            backupErr
          );
        }
      }

      throw new CorruptPersistenceError(
        `Persistence file "${this.persistPath}" is corrupted (no valid backup available). Quarantined to "${quarantinedPath}".`,
        quarantinedPath,
        primaryErr
      );
    }
  }

  /**
   * Synchronously serializes all collections to disk using write-temp + fsync + backup + atomic rename.
   * Never swallows errors: logs explicitly, records `lastPersistenceError`, and throws `PersistenceError`.
   */
  flushSync(): void {
    if (!this.persistPath) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      if (this.options.beforeWriteHook) {
        this.options.beforeWriteHook(this.persistPath);
      }

      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const collectionsData = this.captureMemorySnapshot();
      const snapshot: PersistedDatabaseSnapshot = {
        version: 2,
        savedAt: new Date().toISOString(),
        checksum: computeCollectionsChecksum(collectionsData),
        collections: collectionsData,
      };

      const serialized = JSON.stringify(snapshot, null, 2);
      const tmpPath = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;

      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeFileSync(fd, serialized, 'utf-8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // Rotate previous known-good primary file to `.backup` before replacing primary
      if (this.backupPath && fs.existsSync(this.persistPath)) {
        try {
          fs.copyFileSync(this.persistPath, this.backupPath);
        } catch (backupErr) {
          this.logError(`Failed to rotate backup file "${this.backupPath}"`, backupErr);
        }
      }

      fs.renameSync(tmpPath, this.persistPath);
      this.commitCounter += 1;
      this.lastPersistenceError = null;
      this.dirtyOutsideTransaction = false;
    } catch (err) {
      const wrapped =
        err instanceof PersistenceError
          ? err
          : new PersistenceError(
              `Failed to persist DocumentStore snapshot to "${this.persistPath}": ${
                err instanceof Error ? err.message : String(err)
              }`,
              err
            );
      this.lastPersistenceError = wrapped;
      this.logError(wrapped.message, err);
      throw wrapped;
    }
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirtyOutsideTransaction && this.persistPath) {
      try {
        this.flushSync();
      } catch {
        // Already logged in flushSync
      }
    }
    this.releaseProcessLock();
  }

  private onCollectionMutated(): void {
    if (!this.persistPath) return;
    if (this.transactionDepth > 0) {
      // Outermost runTransaction() performs durable flush on commit
      return;
    }
    this.dirtyOutsideTransaction = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.persistPath || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.flushSync();
      } catch (err) {
        // Recorded in lastPersistenceError and explicitly logged in flushSync
        this.logError('Scheduled background flush failed', err);
      }
    }, 50);
  }

  private captureMemorySnapshot(): Record<string, Record<string, unknown>[]> {
    const snap: Record<string, Record<string, unknown>[]> = {};
    for (const [name, col] of this.collections.entries()) {
      snap[name] = col.toArray();
    }
    return snap;
  }

  private restoreMemorySnapshot(snap: Record<string, Record<string, unknown>[]>): void {
    for (const [name, col] of this.collections.entries()) {
      col.loadRaw(snap[name] ?? []);
    }
  }

  private parseAndVerifyFile(filePath: string): PersistedDatabaseSnapshot {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) {
      throw new Error(`Persistence file "${filePath}" is empty`);
    }
    const parsed = JSON.parse(raw) as Partial<PersistedDatabaseSnapshot>;
    if (!parsed || typeof parsed !== 'object' || !parsed.collections || typeof parsed.collections !== 'object') {
      throw new Error(`Persistence file "${filePath}" has invalid root schema`);
    }
    if (typeof parsed.checksum === 'string') {
      const expected = computeCollectionsChecksum(parsed.collections);
      if (expected !== parsed.checksum) {
        throw new Error(
          `Checksum mismatch in "${filePath}" (expected ${parsed.checksum}, got ${expected})`
        );
      }
    }
    return parsed as PersistedDatabaseSnapshot;
  }

  private applyParsedSnapshot(parsed: PersistedDatabaseSnapshot): void {
    for (const [name, docs] of Object.entries(parsed.collections)) {
      const col = this.collections.get(name);
      if (col && Array.isArray(docs)) {
        col.loadRaw(docs);
      }
    }
  }

  private quarantineCorruptFile(filePath: string): string {
    const quarantined = `${filePath}.corrupt.${Date.now()}.bak`;
    try {
      fs.renameSync(filePath, quarantined);
    } catch {
      // Fallback copy if rename fails
      fs.copyFileSync(filePath, quarantined);
    }
    return quarantined;
  }

  private acquireProcessLock(): void {
    if (!this.lockPath || !this.persistPath) return;
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tryCreate = (): boolean => {
      try {
        const fd = fs.openSync(this.lockPath!, 'wx');
        try {
          fs.writeFileSync(
            fd,
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            'utf-8'
          );
        } finally {
          fs.closeSync(fd);
        }
        this.lockHeld = true;
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EEXIST') throw err;
        return false;
      }
    };

    if (tryCreate()) return;

    // Lock exists — check if owner PID is still alive (or stale from crash)
    let ownerPid: number | null = null;
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf-8');
      const parsed = JSON.parse(raw) as { pid?: number };
      ownerPid = typeof parsed.pid === 'number' ? parsed.pid : null;
    } catch {
      ownerPid = null;
    }

    if (ownerPid !== null && isProcessAlive(ownerPid)) {
      throw new MultiProcessLockError(this.lockPath, ownerPid);
    }

    // Stale lock from crashed process — reclaim cleanly
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // ignore race
    }
    if (!tryCreate()) {
      throw new MultiProcessLockError(this.lockPath, ownerPid);
    }
  }

  private releaseProcessLock(): void {
    if (!this.lockHeld || !this.lockPath) return;
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch (err) {
      this.logError(`Failed to release lock "${this.lockPath}"`, err);
    } finally {
      this.lockHeld = false;
    }
  }

  private logError(message: string, err?: unknown): void {
    if (this.options.silentLogs) return;
    console.error(`[OfflineSync:DocumentStore] ${message}`, err ?? '');
  }
}
