# Android Kotlin Porting Guide

The TypeScript client engine (`packages/offlinesync-client`) is strictly decoupled from React, browser globals, and OfflineShop domain models so it can be ported 1:1 to Android (Kotlin + Coroutines).

> **Note:** The current runnable implementation is a TypeScript/Web package backed by IndexedDB (Dexie). It is **not** claimed to be a compiled Android SDK.

## Component-to-Android Mapping

| TypeScript Module (`packages/offlinesync-client`) | Android Kotlin Equivalent |
| :--- | :--- |
| `SyncStorageAdapter` interface | Room `@Dao` (`EntityDao`, `OperationDao`, `SyncMetaDao`) |
| `DexieStorageAdapter` | SQLite via AndroidX Room Database |
| `PersistentOperationQueue` | Room-backed transactional FIFO queue + UUID (`java.util.UUID`) |
| `NetworkMonitor` | `ConnectivityManager.NetworkCallback` + OkHttp `/api/sync/status` reachability probe |
| `HttpSyncTransport` | Retrofit / OkHttp with configurable timeouts and byte-counting interceptor |
| `SyncCoordinator` | Coroutine `SyncCoordinator` triggered by AndroidX `WorkManager` (`NetworkType.CONNECTED`) |
| `ConflictPolicyRegistry` | Sealed class `ConflictPolicy` + Kotlin interface `DomainConflictResolver` |
| `SyncSubscriber` | Kotlin `StateFlow<SyncStatusSnapshot>` and `SharedFlow<SyncEventRecord>` |

## Public API Parity

```kotlin
val syncEngine = OfflineSync.create(
    appId = "offline-shop",
    storage = RoomStorageAdapter(appDatabase),
    transport = OkHttpSyncTransport(baseUrl = "https://api.example.com"),
    conflictResolver = conflictPolicyRegistry
)
```
