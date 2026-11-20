# Demonstration Scenarios & Experimental Methodology

## Interactive Demonstration Walkthrough

1. **Scenario A — Online Shopping & Live Telemetry**:
   - Open OfflineShop (`/`), add products to Bag, adjust quantities, and open OfflineSync Monitor (`/monitor`) in a second tab.
   - Observe real-time `DEVICE_REGISTERED`, `SYNC_STARTED`, `BATCH_SENT`, `OPERATION_ACKNOWLEDGED`, and `SYNC_COMPLETED` events streaming over SSE.

2. **Scenario B & C — Genuine Offline Shopping, Refresh Persistence, and Reconnect**:
   - Click **Simulate Offline** in OfflineShop's status bar.
   - Search cached products, view product details, add items to Bag, toggle Wishlist, and complete **Offline Order Preparation** (COD intent marked `PENDING_SYNC`, payment `NOT_PROCESSED`).
   - **Refresh the browser page** (`F5`). Confirm the cached catalog, cart, local order intent, and pending operation count remain intact from IndexedDB.
   - Click **Reconnect Network** and watch OfflineSync automatically push queued operations, validate prices & stock on the server, and transition the order to `CONFIRMED`.

3. **Scenario D — Duplicate Delivery Prevention (Idempotency)**:
   - Navigate to `/monitor/experiments`, select **Duplicate Delivery (Idempotency)**, and click **Run Experiment**.
   - Observe `Duplicates Prevented` matching the re-delivered batch size with zero duplicate mutations.

4. **Scenario E — Interrupted Synchronization Recovery**:
   - In `/monitor/experiments`, select **Simulated Interruption & Retry** and run.
   - The harness injects mid-flight transport drops (`failNextProcessCalls = 2`), verifies pending operations remain persisted, retries with backoff, and measures real recovery time.

5. **Scenario F — Concurrent Two-Device Conflict & Manual Resolution**:
   - Navigate to `/monitor/conflicts` and click **Simulate 2-Device Conflict**.
   - Inspect side-by-side Local Payload vs. Remote Server State, enter an audit note, and resolve with **Keep Server State** or **Apply Client Payload**.

6. **Scenario G — Invalid Offline Order After Server Price/Stock Change**:
   - In OfflineShop, click **Simulate Offline**, add `Milled 65 Wireless Keyboard (P101)` to Bag, and create an offline COD order intent.
   - In `/monitor/conflicts`, use **Server Authoritative Catalog Mutation** to change `P101`'s price (e.g. `$249` → `$299`) or reduce stock.
   - Return to OfflineShop and click **Reconnect Network**.
   - OfflineSync flags the order as **`REQUIRES_ACTION`** without silently accepting stale pricing. Open the order detail page to inspect the discrepancy and either **Accept Updated Price / Available Stock** or **Cancel Order**.

## Experimental Limitations

- Simulated interruption benchmarks use deterministic application-level transport fault injection (`HttpSyncTransport.beforeRequest` / `DirectCoreTransport.failNextProcessCalls`) because OS-level network shaping (`tc`/`netem`) is unavailable in this sandbox environment.
- All latency, byte-transfer, retry, duplicate-prevention, and conflict counts in `/monitor/experiments` and the exported CSV (`offlinesync-experiments.csv`) are measured from real executions of `OfflineSyncEngine` and `SyncCoreEngine`.
