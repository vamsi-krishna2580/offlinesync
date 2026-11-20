import type {
  RegisterDeviceRequest,
  RegisterDeviceResponse,
  SyncProcessRequest,
  SyncProcessResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../../offlinesync-types';

export interface TransportResult<T> {
  data: T;
  bytesSent: number;
  bytesReceived: number;
  latencyMs: number;
}

export interface SyncTransport {
  registerDevice(req: RegisterDeviceRequest): Promise<TransportResult<RegisterDeviceResponse>>;
  push(req: SyncPushRequest): Promise<TransportResult<SyncPushResponse>>;
  pull(req: SyncPullRequest): Promise<TransportResult<SyncPullResponse>>;
  process(req: SyncProcessRequest): Promise<TransportResult<SyncProcessResponse>>;
}

export interface HttpSyncTransportOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /**
   * Optional fault injection hook for reproducible interruption experiments and tests.
   * Return an Error to simulate mid-flight connection drops.
   */
  beforeRequest?: (endpoint: string, body: unknown) => Promise<void> | void;
}

function measureBytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

export class HttpSyncTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  public beforeRequest?: (endpoint: string, body: unknown) => Promise<void> | void;

  constructor(options?: HttpSyncTransportOptions) {
    this.baseUrl = (options?.baseUrl ?? '').replace(/\/$/, '');
    this.timeoutMs = options?.timeoutMs ?? 12000;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.beforeRequest = options?.beforeRequest;
  }

  private async postJson<TReq, TRes>(
    endpoint: string,
    payload: TReq
  ): Promise<TransportResult<TRes>> {
    if (this.beforeRequest) {
      await this.beforeRequest(endpoint, payload);
    }

    const bodyText = JSON.stringify(payload);
    const bytesSent = measureBytes(bodyText);
    const started = performance.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: bodyText,
        signal: controller.signal,
      });

      const responseText = await response.text();
      const bytesReceived = measureBytes(responseText);
      const latencyMs = Math.round((performance.now() - started) * 100) / 100;

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(responseText) as { error?: string; detail?: string };
          message = parsed.error ?? parsed.detail ?? message;
        } catch {
          // keep default
        }
        throw new Error(`Sync transport error on ${endpoint}: ${message}`);
      }

      const data = JSON.parse(responseText) as TRes;
      return { data, bytesSent, bytesReceived, latencyMs };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timeout (${this.timeoutMs}ms) on ${endpoint}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  registerDevice(req: RegisterDeviceRequest) {
    return this.postJson<RegisterDeviceRequest, RegisterDeviceResponse>(
      '/api/sync/register-device',
      req
    );
  }

  push(req: SyncPushRequest) {
    return this.postJson<SyncPushRequest, SyncPushResponse>('/api/sync/push', req);
  }

  pull(req: SyncPullRequest) {
    return this.postJson<SyncPullRequest, SyncPullResponse>('/api/sync/pull', req);
  }

  process(req: SyncProcessRequest) {
    return this.postJson<SyncProcessRequest, SyncProcessResponse>('/api/sync/process', req);
  }
}
