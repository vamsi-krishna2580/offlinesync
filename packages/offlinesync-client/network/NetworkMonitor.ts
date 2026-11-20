import type { ConnectionStatus } from '../../offlinesync-types';

export type NetworkChangeListener = (status: ConnectionStatus, reason: string) => void;

export interface NetworkMonitorOptions {
  healthCheckUrl?: string;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  fetchFn?: typeof fetch;
  enableBrowserListeners?: boolean;
}

/**
 * Connectivity monitor that does NOT rely solely on `navigator.onLine`.
 * Combines:
 * 1. Explicit simulated offline mode (for reproducible testing & demos)
 * 2. Browser online/offline events
 * 3. Active HTTP reachability probes against the sync server
 * 4. Passive request failure reporting when a sync request fails despite browser reporting online
 */
export class NetworkMonitor {
  private status: ConnectionStatus = 'ONLINE';
  private simulatedOffline = false;
  private listeners = new Set<NetworkChangeListener>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly healthCheckUrl: string;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly enableBrowserListeners: boolean;

  constructor(options?: NetworkMonitorOptions) {
    this.healthCheckUrl = options?.healthCheckUrl ?? '/api/sync/status';
    this.probeIntervalMs = options?.probeIntervalMs ?? 15000;
    this.probeTimeoutMs = options?.probeTimeoutMs ?? 4000;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.enableBrowserListeners =
      options?.enableBrowserListeners ?? typeof window !== 'undefined';

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.status = 'OFFLINE';
    }
  }

  private handleBrowserOnline = (): void => {
    if (this.simulatedOffline) return;
    void this.probeNow('browser_online_event');
  };

  private handleBrowserOffline = (): void => {
    this.updateStatus('OFFLINE', 'browser_offline_event');
  };

  start(): void {
    if (this.enableBrowserListeners && typeof window !== 'undefined') {
      window.addEventListener('online', this.handleBrowserOnline);
      window.addEventListener('offline', this.handleBrowserOffline);
    }

    if (this.probeIntervalMs > 0 && !this.probeTimer) {
      this.probeTimer = setInterval(() => {
        if (!this.simulatedOffline) {
          void this.probeNow('periodic_probe');
        }
      }, this.probeIntervalMs);
    }
  }

  stop(): void {
    if (this.enableBrowserListeners && typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleBrowserOnline);
      window.removeEventListener('offline', this.handleBrowserOffline);
    }
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  getStatus(): ConnectionStatus {
    return this.simulatedOffline ? 'OFFLINE' : this.status;
  }

  isOnline(): boolean {
    return this.getStatus() === 'ONLINE';
  }

  isSimulatedOffline(): boolean {
    return this.simulatedOffline;
  }

  setSimulatedOffline(offline: boolean): void {
    if (this.simulatedOffline === offline) return;
    this.simulatedOffline = offline;
    if (offline) {
      this.updateStatus('OFFLINE', 'simulated_offline_enabled');
    } else {
      // Immediately verify actual reachability when re-enabling network
      this.updateStatus('ONLINE', 'simulated_offline_disabled');
      void this.probeNow('simulated_offline_disabled');
    }
  }

  /**
   * Called by SyncCoordinator whenever a network request fails even if
   * navigator.onLine === true.
   */
  reportRequestFailure(reason: string): void {
    if (this.simulatedOffline) return;
    this.updateStatus('OFFLINE', `request_failed:${reason}`);
  }

  reportRequestSuccess(): void {
    if (this.simulatedOffline) return;
    if (this.status !== 'ONLINE') {
      this.updateStatus('ONLINE', 'request_succeeded');
    }
  }

  async probeNow(trigger = 'manual_probe'): Promise<boolean> {
    if (this.simulatedOffline) {
      this.updateStatus('OFFLINE', 'simulated_offline');
      return false;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.updateStatus('OFFLINE', 'navigator_offline');
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.probeTimeoutMs);
    try {
      const response = await this.fetchFn(this.healthCheckUrl, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.ok) {
        this.updateStatus('ONLINE', `${trigger}:ok`);
        return true;
      }
      this.updateStatus('DEGRADED', `${trigger}:http_${response.status}`);
      return false;
    } catch {
      this.updateStatus('OFFLINE', `${trigger}:unreachable`);
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  subscribe(listener: NetworkChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private updateStatus(next: ConnectionStatus, reason: string): void {
    const prev = this.status;
    this.status = next;
    if (prev !== next) {
      for (const listener of this.listeners) {
        listener(next, reason);
      }
    }
  }
}
