import type {
  ConnectionStatus,
  DeviceRecord,
  RegisterDeviceRequest,
} from '../../packages/offlinesync-types';
import type { DocumentCollection } from '../persistence/DocumentStore';

/**
 * Generic Device Registry managing device metadata, last sync checkpoint,
 * online/offline status, and pending operation telemetry.
 */
export class DeviceRegistry {
  private readonly devicesCol: DocumentCollection<DeviceRecord & Record<string, unknown>>;

  constructor(devicesCol: DocumentCollection<DeviceRecord & Record<string, unknown>>) {
    this.devicesCol = devicesCol;
  }

  register(req: RegisterDeviceRequest): { device: DeviceRecord; isNew: boolean } {
    const now = new Date().toISOString();
    const existing = this.devicesCol.findById(req.deviceId);
    if (existing) {
      const updated: DeviceRecord = {
        ...existing,
        deviceName: req.deviceName || existing.deviceName,
        appId: req.appId || existing.appId,
        platform: req.platform || existing.platform,
        lastSeenAt: now,
        connectionStatus: 'ONLINE',
      };
      this.devicesCol.upsertOne(updated as DeviceRecord & Record<string, unknown>);
      return { device: updated, isNew: false };
    }

    const created: DeviceRecord = {
      deviceId: req.deviceId,
      deviceName: req.deviceName || `Device ${req.deviceId.slice(0, 8)}`,
      appId: req.appId,
      platform: req.platform || 'web-indexeddb',
      registeredAt: now,
      lastSyncAt: null,
      lastSeenAt: now,
      connectionStatus: 'ONLINE',
      lastCursor: 0,
      pendingCount: 0,
    };
    this.devicesCol.insertOne(created as DeviceRecord & Record<string, unknown>);
    return { device: created, isNew: true };
  }

  touchSync(
    deviceId: string,
    appId: string,
    cursor: number,
    pendingCount = 0
  ): DeviceRecord {
    const now = new Date().toISOString();
    const existing = this.devicesCol.findById(deviceId);
    const updated: DeviceRecord = existing
      ? {
          ...existing,
          lastSyncAt: now,
          lastSeenAt: now,
          lastCursor: Math.max(existing.lastCursor, cursor),
          connectionStatus: 'ONLINE',
          pendingCount,
        }
      : {
          deviceId,
          deviceName: `Device ${deviceId.slice(0, 8)}`,
          appId,
          platform: 'web-indexeddb',
          registeredAt: now,
          lastSyncAt: now,
          lastSeenAt: now,
          connectionStatus: 'ONLINE',
          lastCursor: cursor,
          pendingCount,
        };
    this.devicesCol.upsertOne(updated as DeviceRecord & Record<string, unknown>);
    return updated;
  }

  setConnectionStatus(deviceId: string, status: ConnectionStatus): DeviceRecord | null {
    const existing = this.devicesCol.findById(deviceId);
    if (!existing) return null;
    const updated: DeviceRecord = {
      ...existing,
      connectionStatus: status,
      lastSeenAt: new Date().toISOString(),
    };
    this.devicesCol.upsertOne(updated as DeviceRecord & Record<string, unknown>);
    return updated;
  }

  getById(deviceId: string): DeviceRecord | null {
    return this.devicesCol.findById(deviceId);
  }

  listAll(): DeviceRecord[] {
    return this.devicesCol
      .find()
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
}
