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

/**
 * MongoDB-compatible document collection abstraction with unique index enforcement,
 * secondary index lookups, and atomic disk persistence.
 * Mirrors the schema & index constraints defined in `database/indexes/create_indexes.js`.
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

    // Validate all unique indexes prior to mutation
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

    // Validate unique indexes excluding self
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

    // Remove old index entries
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
  collections: Record<string, Record<string, unknown>[]>;
}

/**
 * Disk-backed document store supporting all 9 OfflineSync + OfflineShop collections.
 * Can run purely in-memory for automated tests (`persistPath: null`) or persist
 * durably to JSON on disk (`data/offlinesync_db.json`) across server restarts.
 */
export class DocumentStore {
  private readonly persistPath: string | null;
  private collections = new Map<string, DocumentCollection<Record<string, unknown>>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(persistPath: string | null = null) {
    this.persistPath = persistPath;
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
      () => this.scheduleFlush()
    );
    this.collections.set(
      name,
      collection as unknown as DocumentCollection<Record<string, unknown>>
    );
    return collection;
  }

  loadFromDisk(): boolean {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) {
      return false;
    }
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedDatabaseSnapshot;
      for (const [name, docs] of Object.entries(parsed.collections ?? {})) {
        const col = this.collections.get(name);
        if (col && Array.isArray(docs)) {
          col.loadRaw(docs);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  flushSync(): void {
    if (!this.persistPath) return;
    const dir = path.dirname(this.persistPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const snapshot: PersistedDatabaseSnapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      collections: {},
    };
    for (const [name, col] of this.collections.entries()) {
      snapshot.collections[name] = col.toArray();
    }
    const tmpPath = `${this.persistPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.persistPath);
  }

  private scheduleFlush(): void {
    if (!this.persistPath) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.flushSync();
      } catch {
        // Ignore transient write lock errors
      }
    }, 100);
  }
}
