import crypto from 'crypto';
import type {
  SyncEventRecord,
  SyncEventSeverity,
  SyncEventType,
} from '../../packages/offlinesync-types';
import type { DocumentCollection } from '../persistence/DocumentStore';

export type TelemetryListener = (event: SyncEventRecord) => void;

/**
 * Structured telemetry & real-time event broadcaster for OfflineSync Core.
 * Persists events to `sync_events` and streams them over SSE to OfflineSync Monitor.
 */
export class TelemetryService {
  private readonly eventsCol: DocumentCollection<SyncEventRecord & Record<string, unknown>>;
  private listeners = new Set<TelemetryListener>();

  constructor(eventsCol: DocumentCollection<SyncEventRecord & Record<string, unknown>>) {
    this.eventsCol = eventsCol;
  }

  emit(params: {
    deviceId: string;
    appId: string;
    sessionId?: string | null;
    eventType: SyncEventType;
    severity?: SyncEventSeverity;
    metadata?: Record<string, unknown>;
  }): SyncEventRecord {
    const event: SyncEventRecord = {
      eventId: `evt-${crypto.randomUUID()}`,
      deviceId: params.deviceId,
      appId: params.appId,
      sessionId: params.sessionId ?? null,
      eventType: params.eventType,
      timestamp: new Date().toISOString(),
      severity: params.severity ?? 'INFO',
      metadata: params.metadata ?? {},
    };
    this.eventsCol.insertOne(event as SyncEventRecord & Record<string, unknown>);
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  subscribe(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listLogs(filter?: {
    deviceId?: string;
    eventType?: string;
    severity?: string;
    limit?: number;
  }): SyncEventRecord[] {
    const all = this.eventsCol
      .find((doc) => {
        if (filter?.deviceId && doc.deviceId !== filter.deviceId) return false;
        if (filter?.eventType && doc.eventType !== filter.eventType) return false;
        if (filter?.severity && doc.severity !== filter.severity) return false;
        return true;
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return filter?.limit ? all.slice(0, filter.limit) : all.slice(0, 300);
  }
}
