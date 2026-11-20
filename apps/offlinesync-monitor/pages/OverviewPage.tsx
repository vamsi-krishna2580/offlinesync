import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MonitorMetrics, SyncSessionRecord } from '../../../packages/offlinesync-types';
import { monitorApi } from '../api/monitorApi';

export const OverviewPage: React.FC = () => {
  const [metrics, setMetrics] = useState<MonitorMetrics | null>(null);
  const [sessions, setSessions] = useState<SyncSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [m, s] = await Promise.all([
        monitorApi.getMetrics(),
        monitorApi.getSessions(),
      ]);
      setMetrics(m);
      setSessions(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    const unsub = monitorApi.subscribeEvents(() => {
      void loadData();
    });
    return unsub;
  }, [loadData]);

  if (loading && !metrics) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
          <div key={n} className="h-24 rounded-lg bg-slate-200/70 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 bg-white border border-red-200 rounded-lg text-sm text-red-700">
        {error}
      </div>
    );
  }

  const m = metrics!;
  const chartData = sessions
    .slice(0, 12)
    .reverse()
    .map((s) => ({
      session: s.sessionId.slice(0, 10),
      latencyMs: s.durationMs ?? 0,
      acked: s.operationsAcknowledged,
      rejected: s.operationsRejected,
    }));

  const statBlocks = [
    { label: 'Total Devices', value: String(m.totalDevices), sub: `${m.activeDevices} online · ${m.offlineDevices} offline` },
    { label: 'Pending Operations', value: String(m.pendingOperations), sub: `${m.processingOperations} processing` },
    { label: 'Successful Operations', value: String(m.successfulOperations), sub: `${m.duplicatesPrevented} duplicates prevented` },
    { label: 'Failed / Action Needed', value: `${m.failedOperations} / ${m.requiresActionOperations}`, sub: `${m.openConflicts} open conflicts` },
    { label: 'Sync Sessions', value: String(m.totalSessions), sub: `${m.successfulSessions} succeeded` },
    {
      label: 'Sync Success Rate',
      value: m.syncSuccessRate !== null ? `${m.syncSuccessRate.toFixed(1)}%` : 'Unavailable',
      sub: m.totalSessions === 0 ? 'No sessions recorded yet' : 'Across recorded sessions',
    },
    {
      label: 'Avg Sync Latency',
      value: m.averageLatencyMs !== null ? `${m.averageLatencyMs.toFixed(2)} ms` : 'Unavailable',
      sub: `${(m.totalBytesTransferred / 1024).toFixed(2)} KB total transferred`,
    },
    {
      label: 'Last Sync Time',
      value: m.lastSyncTime ? new Date(m.lastSyncTime).toLocaleTimeString() : 'Never',
      sub: `Server cursor #${m.currentServerCursor}`,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-monitor-display text-2xl font-bold text-slate-900">
            Synchronization Overview
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Live metrics aggregated directly from backend collections — zero synthetic values.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadData()}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Metrics</span>
        </button>
      </div>

      {/* KPI Grid (flat 1px border, tabular numerals) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statBlocks.map((stat) => (
          <div
            key={stat.label}
            className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col justify-between"
          >
            <span className="text-xs font-medium text-slate-500">{stat.label}</span>
            <span className="font-mono-tabular text-2xl font-semibold text-slate-900 mt-2">
              {stat.value}
            </span>
            <span className="text-xs text-slate-500 mt-1.5 font-mono-tabular">{stat.sub}</span>
          </div>
        ))}
      </div>

      {/* Real Session Latency Chart (only shown when real sessions exist) */}
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex items-center justify-between gap-4 mb-5">
          <div>
            <h3 className="font-monitor-display text-base font-semibold text-slate-900">
              Recent Synchronization Session Latency (ms)
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Measured end-to-end processing duration across the last {chartData.length} sessions.
            </p>
          </div>
          <Link
            to="/monitor/experiments"
            className="text-xs font-medium text-slate-700 hover:text-slate-950 underline"
          >
            Run Controlled Benchmark
          </Link>
        </div>

        {chartData.length === 0 ? (
          <div className="py-12 text-center border border-dashed border-slate-200 rounded-lg">
            <p className="text-sm font-medium text-slate-700">No synchronization sessions recorded yet</p>
            <p className="text-xs text-slate-500 mt-1">
              Interact with OfflineShop or run an experiment to observe real synchronization latency.
            </p>
          </div>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="session" tick={{ fontSize: 11, fill: '#64748B' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} unit="ms" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0F172A',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#F8FAFC',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="latencyMs" name="Latency (ms)" fill="#0F172A" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
};
