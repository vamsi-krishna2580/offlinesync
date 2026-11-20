# OfflineSync

**Design and Development of a Reusable Offline-First Mobile Data Synchronization Framework with Conflict Resolution**, demonstrated through **OfflineShop** (e-commerce reference app) and **OfflineSync Monitor** (independent developer/admin observability dashboard).

---

## Architecture Overview

```
OfflineShop UI (React + TypeScript + Tailwind)
    |
    v
OfflineSync Client Engine (packages/offlinesync-client)
    +---- Local Database: IndexedDB (DexieStorageAdapter)
    +---- Persistent Operation Queue (UUIDs, ordering, dependencies, crash recovery)
    +---- Network Monitor (HTTP reachability probe + navigator.onLine + offline simulator)
    +---- Synchronization Coordinator (batch push, incremental pull, exponential backoff)
                |
                v
          REST + SSE Synchronization API (/api/sync/*, /api/monitor/*)
                |
                v
          OfflineSync Backend Core (backend/offlinesync-core) [Domain-Agnostic]
                +---- Device Registry
                +---- Idempotency Service (unique operationId index)
                +---- Conflict Manager (policy registry + manual resolution workflow)
                +---- Reconciliation Engine (monotonic cursor incremental change log)
                +---- Telemetry Service (structured sync_events + SSE stream)
                |
                +----> Pluggable Business Adapter: OfflineShop (backend/shop-adapter)
                |        +---- Authoritative Product Pricing & Stock Validation
                |        +---- Operation-Based Cart Delta Merging
                |        +---- Idempotent COD Order Intents (unique clientOrderId)
                |
                v
          Document Persistence Layer (MongoDB-compatible collections & unique indexes)

OfflineSync Monitor (apps/offlinesync-monitor) [Independent Developer Dashboard]
    +---- Overview | Devices | Operation Queue | Sync Sessions | Conflict Center | Live Logs | Experiments + CSV Export
```

---

## Project Structure

- `packages/offlinesync-types/` — Domain-agnostic synchronization protocol, queue, conflict, and telemetry TypeScript contracts.
- `packages/offlinesync-client/` — Reusable client synchronization engine (`createOfflineSync(...)`), zero dependency on OfflineShop.
- `backend/offlinesync-core/` — Reusable domain-agnostic server synchronization core (zero e-commerce logic).
- `backend/shop-adapter/` — OfflineShop business adapter enforcing authoritative prices, stock, cart deltas, and order validation.
- `backend/persistence/` — MongoDB-compatible document store enforcing unique indexes and durable JSON persistence (`data/offlinesync_db.json`).
- `backend/api/` — Express REST & SSE routes (`/api/sync/*`, `/api/monitor/*`, `/api/shop/*`).
- `database/schemas/` & `database/indexes/` — Formal MongoDB JSON schemas and `mongosh` unique/idempotency/timestamp index scripts.
- `apps/offline-shop/` — End-user offline-first e-commerce application (`/`).
- `apps/offlinesync-monitor/` — Independent developer/admin monitoring console (`/monitor`).
- `tests/` — Automated client unit tests, backend unit tests, and end-to-end integration tests covering Scenarios A–G.
- `docs/` — Architecture, Android Kotlin port guide, synchronization protocol specification, data models, demonstration scenarios, and experiment methodology.

---

## Local Installation & Running

Requirements: Node.js 20+ (runs comfortably on an 8 GB RAM Windows/macOS/Linux laptop without Docker).

```bash
npm install
npm run dev
```

Open in your browser:
- **OfflineShop**: `http://localhost:3000/`
- **OfflineSync Monitor**: `http://localhost:3000/monitor`

Run automated test suite (client + backend + Scenarios A–G):
```bash
npm test
```

Type-check and build for production:
```bash
npm run lint
npm run build
npm start
```

---

## Architecture, Reliability & Prototype Limitations

- **Persistence Layer (Single-Process JSON `DocumentStore`, NOT Live MongoDB)**: The running backend uses a local, single-process, JSON-backed `DocumentStore` (`data/offlinesync_db.json`) with SHA-256 checksums, atomic temp-file + `fsync` + `rename` writes, `.backup` rotation/recovery, corrupt-file quarantine (`.corrupt.<ts>.bak`), snapshot-based multi-collection transactional rollback (`runTransaction`), unique index enforcement (`operationId`, `clientOrderId`, `(appId, cursor)`), and an exclusive PID lockfile (`.lock`) that rejects concurrent multi-process access. **MongoDB is not connected or running in this live prototype**; formal MongoDB collection schemas (`database/schemas/mongodb_collections.json`) and index scripts (`database/indexes/create_indexes.js`) are provided as migration artifacts.
- **Concurrency Model**: Because Node.js executes synchronous business handlers on a single event-loop turn and wraps each operation and conflict resolution in `store.runTransaction(...)`, competing orders or concurrent cursor allocations are strictly serialized within a single server process without overselling or duplicate cursors. This does **not** scale horizontally across multiple Node processes or containers (the PID lockfile intentionally prevents multi-process corruption).
- **Cursor Strategy**: Cursors are monotonically allocated per `appId` inside the same transaction as `sync_changelog` insertion. Paginated pulls slice the raw `(sinceCursor, ...]` window before compacting duplicate entities in that slice, and entity-type-filtered pulls track an isolated client cursor key so filtered pulls never skip changes of other entity types. Limitation: full snapshot resync after log retention/compaction across long-offline devices is not yet implemented.
- **Lightweight Prototype Security**: Device registration issues a random 256-bit `deviceToken` (stored hashed via SHA-256 on the server) that clients must send via `X-Device-Token` on all `/api/sync/push`, `/pull`, `/process`, and re-registration requests, preventing simple `deviceId` spoofing or cross-device operation forgery. Administrative Monitor endpoints (`/api/monitor/*`, `/api/sync/devices`, `/operations`, `/sessions`, `/conflicts`, and conflict resolution) require `X-Monitor-Token` (configurable via `OFFLINESYNC_MONITOR_TOKEN`, defaulting to `offlinesync-local-monitor-token` for local demonstrations). This is a lightweight academic demonstration scheme — **not** full production OAuth2/OIDC user authentication, RBAC, TLS termination, or rate limiting.
- **Client Engine & Benchmarks**: The client engine (`packages/offlinesync-client`) is a portable web TypeScript package (not an Android SDK; see `docs/architecture/android-port-guide.md` for Kotlin/Room/WorkManager mapping). Interruption experiments use deterministic application-level fault injection rather than OS-level packet shaping (`tc`/`netem`).
