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

## Runtime Environment Note & Limitations

- The live runnable backend in this repository is implemented in **TypeScript + Express** with a **MongoDB-compatible disk-backed DocumentStore** (`data/offlinesync_db.json`) enforcing unique primary/idempotency indexes (`operationId`, `clientOrderId`), because the target AI Studio sandbox provides Node.js 22 on port 3000 without `pip` or a local `mongod` daemon.
- Complete MongoDB collection schemas (`database/schemas/mongodb_collections.json`) and executable index scripts (`database/indexes/create_indexes.js`) are included for direct MongoDB deployment.
- The client engine (`packages/offlinesync-client`) is designed as a portable web TypeScript package and is **not** an Android SDK yet; see `docs/architecture/android-port-guide.md` for the exact 1:1 Kotlin/Room/WorkManager mapping.
- Network interruption benchmarks in the Experiments module use deterministic application-level transport fault injection rather than OS-level packet shaping (`tc`/`netem`), documented in `docs/experiments/evaluation-methodology.md`.
