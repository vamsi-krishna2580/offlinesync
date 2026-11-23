import crypto from 'crypto';
import type {
  ConnectionStatus,
  DeviceRecord,
  RegisterDeviceRequest,
} from '../../packages/offlinesync-types';
import type { DocumentCollection } from '../persistence/DocumentStore';

export interface StoredDeviceRecord extends DeviceRecord {
  tokenHash: string;
  [key: string]: unknown;
}

export class DeviceAuthError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 401) {
    super(message);
    this.name = 'DeviceAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function toPublicDevice(doc: StoredDeviceRecord): DeviceRecord {
  return {
    deviceId: doc.deviceId,
    deviceName: doc.deviceName,
    appId: doc.appId,
    platform: doc.platform,
    registeredAt: doc.registeredAt,
    lastSyncAt: doc.lastSyncAt,
    lastSeenAt: doc.lastSeenAt,
    connectionStatus: doc.connectionStatus,
    lastCursor: doc.lastCursor,
    pendingCount: doc.pendingCount,
  };
}

/**
 * Generic Device Registry with per-device cryptographic bearer tokens (`X-Device-Token`).
 *
 * Security model (academic prototype):
 * - Initial registration issues a 256-bit random `deviceToken` and persists only its SHA-256 hash.
 * - Re-registering an existing `deviceId` requires presenting the valid token, preventing
 *   unauthenticated device ID takeover/spoofing.
 * - All sync endpoints validate both device existence, token match, and `appId` ownership.
 */
export class DeviceRegistry {
  private readonly devicesCol: DocumentCollection<StoredDeviceRecord>;

  constructor(devicesCol: DocumentCollection<StoredDeviceRecord>) {
    this.devicesCol = devicesCol;
  }

  register(
    req: RegisterDeviceRequest,
    presentedToken?: string
  ): { device: DeviceRecord; deviceToken?: string; isNew: boolean } {
    const now = new Date().toISOString();
    const existing = this.devicesCol.findById(req.deviceId);

    if (existing) {
      if (existing.appId !== req.appId) {
        throw new DeviceAuthError(
          `Device "${req.deviceId}" is registered to a different application`,
          'APP_OWNERSHIP_MISMATCH',
          403
        );
      }

      if (!presentedToken) {
        throw new DeviceAuthError(
          `Device "${req.deviceId}" is already registered; valid X-Device-Token required to re-register`,
          'DEVICE_TOKEN_REQUIRED',
          401
        );
      }
      if (!safeEqualHex(existing.tokenHash, hashToken(presentedToken))) {
        throw new DeviceAuthError(
          `Invalid X-Device-Token for registered device "${req.deviceId}"`,
          'DEVICE_TOKEN_INVALID',
          401
        );
      }

      const updated: StoredDeviceRecord = {
        ...existing,
        deviceName: req.deviceName || existing.deviceName,
        platform: req.platform || existing.platform,
        lastSeenAt: now,
        connectionStatus: 'ONLINE',
      };
      this.devicesCol.upsertOne(updated);
      return { device: toPublicDevice(updated), deviceToken: presentedToken, isNew: false };
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const created: StoredDeviceRecord = {
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
      tokenHash: hashToken(rawToken),
    };
    this.devicesCol.insertOne(created);
    return { device: toPublicDevice(created), deviceToken: rawToken, isNew: true };
  }

  /**
   * Authenticates a device request against registered devices and verifies application ownership.
   */
  authenticateDevice(deviceId: string, appId: string | null, token?: string): DeviceRecord {
    const existing = this.devicesCol.findById(deviceId);
    if (!existing) {
      throw new DeviceAuthError(
        `Device "${deviceId}" is not registered`,
        'UNREGISTERED_DEVICE',
        401
      );
    }
    if (!token || !safeEqualHex(existing.tokenHash, hashToken(token))) {
      throw new DeviceAuthError(
        `Invalid or missing X-Device-Token for device "${deviceId}"`,
        'INVALID_DEVICE_TOKEN',
        401
      );
    }
    if (appId !== null && existing.appId !== appId) {
      throw new DeviceAuthError(
        `Device "${deviceId}" does not belong to appId "${appId}"`,
        'APP_OWNERSHIP_MISMATCH',
        403
      );
    }
    return toPublicDevice(existing);
  }

  touchSync(
    deviceId: string,
    appId: string,
    cursor: number,
    pendingCount = 0
  ): DeviceRecord {
    const existing = this.devicesCol.findById(deviceId);
    if (!existing) {
      throw new DeviceAuthError(
        `Cannot update sync checkpoint for unregistered device "${deviceId}"`,
        'UNREGISTERED_DEVICE',
        401
      );
    }
    if (existing.appId !== appId) {
      throw new DeviceAuthError(
        `Device "${deviceId}" does not belong to appId "${appId}"`,
        'APP_OWNERSHIP_MISMATCH',
        403
      );
    }
    const now = new Date().toISOString();
    const updated: StoredDeviceRecord = {
      ...existing,
      lastSyncAt: now,
      lastSeenAt: now,
      lastCursor: Math.max(existing.lastCursor, cursor),
      connectionStatus: 'ONLINE',
      pendingCount: Math.max(0, Math.floor(pendingCount)),
    };
    this.devicesCol.upsertOne(updated);
    return toPublicDevice(updated);
  }

  setConnectionStatus(deviceId: string, status: ConnectionStatus): DeviceRecord | null {
    const existing = this.devicesCol.findById(deviceId);
    if (!existing) return null;
    const updated: StoredDeviceRecord = {
      ...existing,
      connectionStatus: status,
      lastSeenAt: new Date().toISOString(),
    };
    this.devicesCol.upsertOne(updated);
    return toPublicDevice(updated);
  }

  getById(deviceId: string): DeviceRecord | null {
    const doc = this.devicesCol.findById(deviceId);
    return doc ? toPublicDevice(doc) : null;
  }

  listAll(): DeviceRecord[] {
    return this.devicesCol
      .find()
      .map(toPublicDevice)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
}
