# OfflineSync Synchronization Protocol Specification

## 1. Overview

OfflineSync uses a cursor-based, operation-oriented bidirectional HTTP/JSON synchronization protocol with real-time Server-Sent Events (SSE) telemetry for the Monitor dashboard.

## 2. Operation Envelope

Every client state mutation is persisted locally before transmission using the following schema:

```json
{
  "operationId": "uuid-v4",
  "deviceId": "dev-...",
  "appId": "offline-shop",
  "entityType": "cart",
  "entityId": "primary-cart",
  "operationType": "CART_ITEM_ADD",
  "sequence": 1,
  "baseVersion": 0,
  "createdAt": "2026-11-19T23:00:00.000Z",
  "payload": { "productId": "P101", "delta": 1 },
  "status": "PENDING",
  "retryCount": 0
}
```

### Status Lifecycle
- `PENDING` — Persisted in local IndexedDB queue awaiting sync.
- `PROCESSING` — Sent in an active batch; recovered back to `PENDING` if interrupted.
- `ACKNOWLEDGED` — Server confirmed processing (or recognized idempotent duplicate).
- `REQUIRES_ACTION` — Server detected a conflict or business validation mismatch (e.g. price/stock changed).
- `FAILED` — Permanently rejected or max retry limit exceeded.

## 3. REST Endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/sync/status` | Active reachability probe returning server timestamp & global cursor |
| `POST` | `/api/sync/register-device` | Register/update device metadata & retrieve baseline cursor |
| `POST` | `/api/sync/push` | Push ordered batch of operations with idempotent processing |
| `POST` | `/api/sync/pull` | Incremental cursor-based pull of remote entity changes (`cursor > lastCursor`) |
| `POST` | `/api/sync/process` | Combined bidirectional push + incremental pull + session audit |
| `GET` | `/api/sync/devices` | List registered devices (`GET /api/sync/devices/:id` for profile) |
| `GET` | `/api/sync/operations` | Query processed operation ledger with status/device filters |
| `GET` | `/api/sync/sessions` | Query sync session audit logs |
| `GET` | `/api/sync/conflicts` | List conflicts (`POST /api/sync/conflicts/:id/resolve` for manual resolution) |
| `GET` | `/api/monitor/metrics` | Real-time aggregated metrics computed strictly from stored collections |
| `GET` | `/api/monitor/logs` | Filterable structured synchronization event logs |
| `GET` | `/api/monitor/events` | Server-Sent Events (SSE) live telemetry stream |
| `POST` | `/api/monitor/experiments/run` | Execute reproducible controlled benchmark scenario |
| `GET` | `/api/monitor/experiments/export.csv` | Download collected benchmark measurements as CSV |

## 4. Conflict Resolution Policies

1. **`SERVER_AUTHORITATIVE`** (`product`, `address`): Server state always prevails. Client attempts to mutate authoritative stock or pricing are rejected and logged.
2. **`DOMAIN_CUSTOM`** (`cart`): Operation-based deltas (`CART_ITEM_ADD`, `CART_ITEM_INCREMENT`, `CART_ITEM_DECREMENT`) merge cleanly onto the latest server cart; stale absolute overwrites (`CART_ITEM_SET_QTY`) escalate to `MANUAL_RESOLUTION`.
3. **`MANUAL_RESOLUTION`** (`order`, conflicting `cart` snapshots): Recorded in the `conflicts` collection with full local payload, server state, and audit history. For orders whose prices or stock drifted while offline, status becomes `REQUIRES_ACTION` until the user explicitly confirms revised terms or cancels.
4. **`LAST_WRITE_WINS_DETERMINISTIC`** (`wishlist`): Deterministic tie-breaking using server revision, ISO timestamp, and lexicographical `deviceId` (never relies blindly on unsynchronized client clocks alone).
