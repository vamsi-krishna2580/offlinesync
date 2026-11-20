import type {
  ConflictRecord,
  DeviceRecord,
  ExperimentRunRecord,
  MonitorMetrics,
  ResolveConflictRequest,
  SyncEventRecord,
  SyncOperation,
  SyncSessionRecord,
} from '../../../packages/offlinesync-types';
import type { Product } from '../../../backend/shop-adapter/types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      // keep status
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const monitorApi = {
  async getMetrics(): Promise<MonitorMetrics> {
    const data = await getJson<{ metrics: MonitorMetrics }>('/api/monitor/metrics');
    return data.metrics;
  },

  async getDevices(): Promise<DeviceRecord[]> {
    const data = await getJson<{ devices: DeviceRecord[] }>('/api/sync/devices');
    return data.devices;
  },

  async getDeviceDetail(deviceId: string): Promise<{
    device: DeviceRecord;
    operations: SyncOperation[];
    sessions: SyncSessionRecord[];
    logs: SyncEventRecord[];
  }> {
    return getJson(`/api/sync/devices/${encodeURIComponent(deviceId)}`);
  },

  async getOperations(status?: string): Promise<SyncOperation[]> {
    const q = status && status !== 'ALL' ? `?status=${encodeURIComponent(status)}` : '';
    const data = await getJson<{ operations: SyncOperation[] }>(`/api/sync/operations${q}`);
    return data.operations;
  },

  async getSessions(): Promise<SyncSessionRecord[]> {
    const data = await getJson<{ sessions: SyncSessionRecord[] }>('/api/sync/sessions');
    return data.sessions;
  },

  async getConflicts(status?: string): Promise<ConflictRecord[]> {
    const q = status && status !== 'ALL' ? `?status=${encodeURIComponent(status)}` : '';
    const data = await getJson<{ conflicts: ConflictRecord[] }>(`/api/sync/conflicts${q}`);
    return data.conflicts;
  },

  async resolveConflict(
    conflictId: string,
    payload: ResolveConflictRequest
  ): Promise<ConflictRecord> {
    const data = await postJson<{ conflict: ConflictRecord }>(
      `/api/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`,
      payload
    );
    return data.conflict;
  },

  async getLogs(params?: { eventType?: string; severity?: string }): Promise<SyncEventRecord[]> {
    const search = new URLSearchParams();
    if (params?.eventType && params.eventType !== 'ALL') {
      search.set('eventType', params.eventType);
    }
    if (params?.severity && params.severity !== 'ALL') {
      search.set('severity', params.severity);
    }
    const qs = search.toString() ? `?${search.toString()}` : '';
    const data = await getJson<{ logs: SyncEventRecord[] }>(`/api/monitor/logs${qs}`);
    return data.logs;
  },

  async getExperiments(): Promise<ExperimentRunRecord[]> {
    const data = await getJson<{ experiments: ExperimentRunRecord[] }>(
      '/api/monitor/experiments'
    );
    return data.experiments;
  },

  async runExperiment(params: {
    scenario: ExperimentRunRecord['scenario'];
    operationCount: number;
    batchSize: number;
  }): Promise<ExperimentRunRecord> {
    const data = await postJson<{ experiment: ExperimentRunRecord }>(
      '/api/monitor/experiments/run',
      params
    );
    return data.experiment;
  },

  async simulateConflict(): Promise<{ message: string; conflicts: ConflictRecord[] }> {
    return postJson('/api/monitor/simulate/conflict', {});
  },

  async getProducts(): Promise<Product[]> {
    const data = await getJson<{ products: Product[] }>('/api/shop/products');
    return data.products;
  },

  async simulateCatalogChange(params: {
    productId: string;
    price?: number;
    stock?: number;
  }): Promise<{ product: Product }> {
    return postJson('/api/monitor/simulate/catalog-change', params);
  },

  subscribeEvents(onEvent: (evt: SyncEventRecord) => void): () => void {
    const es = new EventSource('/api/monitor/events');
    es.addEventListener('sync_event', (msg) => {
      try {
        const parsed = JSON.parse((msg as MessageEvent).data) as SyncEventRecord;
        onEvent(parsed);
      } catch {
        // ignore malformed frame
      }
    });
    return () => {
      es.close();
    };
  },
};
