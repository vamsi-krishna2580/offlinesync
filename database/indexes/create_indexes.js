/**
 * MongoDB Index Definitions for OfflineSync
 * Run with: mongosh mongodb://localhost:27017/offlinesync database/indexes/create_indexes.js
 */

// 1. Idempotency & Operation Queue Indexes
db.sync_operations.createIndex({ operationId: 1 }, { unique: true, name: 'uniq_operation_id' });
db.sync_operations.createIndex({ deviceId: 1, sequence: 1 }, { name: 'idx_device_sequence' });
db.sync_operations.createIndex({ status: 1, createdAt: -1 }, { name: 'idx_status_created' });
db.sync_operations.createIndex({ entityType: 1, entityId: 1 }, { name: 'idx_entity_lookup' });

// 2. Order Idempotency & Query Indexes
db.orders.createIndex({ clientOrderId: 1 }, { unique: true, name: 'uniq_client_order_id' });
db.orders.createIndex({ deviceId: 1, createdLocallyAt: -1 }, { name: 'idx_orders_device_date' });
db.orders.createIndex({ status: 1 }, { name: 'idx_orders_status' });

// 3. Devices Registry
db.devices.createIndex({ deviceId: 1 }, { unique: true, name: 'uniq_device_id' });
db.devices.createIndex({ appId: 1, connectionStatus: 1 }, { name: 'idx_devices_app_status' });

// 4. Synchronization Sessions & Change Log
db.sync_sessions.createIndex({ sessionId: 1 }, { unique: true, name: 'uniq_session_id' });
db.sync_sessions.createIndex({ deviceId: 1, startedAt: -1 }, { name: 'idx_sessions_device_time' });
db.sync_changelog.createIndex({ appId: 1, cursor: 1 }, { unique: true, name: 'uniq_app_cursor' });

// 5. Conflict Center
db.conflicts.createIndex({ conflictId: 1 }, { unique: true, name: 'uniq_conflict_id' });
db.conflicts.createIndex({ resolutionStatus: 1, detectedAt: -1 }, { name: 'idx_conflicts_status_time' });
db.conflicts.createIndex({ entityType: 1, entityId: 1 }, { name: 'idx_conflicts_entity' });

// 6. Telemetry Events
db.sync_events.createIndex({ eventId: 1 }, { unique: true, name: 'uniq_event_id' });
db.sync_events.createIndex({ timestamp: -1 }, { name: 'idx_events_timestamp' });
db.sync_events.createIndex({ deviceId: 1, eventType: 1, timestamp: -1 }, { name: 'idx_events_device_type' });

// 7. Catalog
db.products.createIndex({ productId: 1 }, { unique: true, name: 'uniq_product_id' });
db.products.createIndex({ sku: 1 }, { unique: true, name: 'uniq_product_sku' });
db.products.createIndex({ category: 1 }, { name: 'idx_product_category' });

print('OfflineSync MongoDB indexes created successfully.');
