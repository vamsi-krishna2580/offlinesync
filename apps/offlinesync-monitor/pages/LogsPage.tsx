import React, { useCallback, useEffect, useState } from 'react';
import type { SyncEventRecord } from '../../../packages/offlinesync-types';
import { monitorApi } from '../api/monitorApi';

const EVENT_TYPES = [
  'ALL',
  'DEVICE_REGISTERED',
  'SYNC_STARTED',
  'BATCH_SENT',
  'OPERATION_ACKNOWLEDGED',
  'OPERATION_REJECTED',
  'DUPLICATE_DETECTED',
  'CONFLICT_DETECTED',
  'CONFLICT_RESOLVED',
  'SYNC_COMPLETED',
  'SYNC_FAILED',
];

export const LogsPage: React.FC = () => {
  const [logs, setLogs] = useState<SyncEventRecord[]>([]);
  const [eventType, setEventType] = useState('ALL');
  const [severity, setSeverity] = useState('ALL');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const list = await monitorApi.getLogs({ eventType, severity });
      setLogs(list);
    } finally {
      setLoading(false);
    }
  }, [eventType, severity]);

  useEffect(() => {
    void load();
    const unsub = monitorApi.subscribeEvents((newEvt) => {
      if (eventType !== 'ALL' && newEvt.eventType !== eventType) return;
      if (severity !== 'ALL' && newEvt.severity !== severity) return;
      setLogs((prev) => [newEvt, ...prev].slice(0, 250));
    });
    return unsub;
  }, [eventType, load, severity]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="font-monitor-display text-2xl font-bold text-slate-900">
            Synchronization Event Logs
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Live SSE-streamed telemetry events emitted by OfflineSync Core.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            aria-label="Filter by event type"
            className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'ALL' ? 'All Event Types' : t}
              </option>
            ))}
          </select>

          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            aria-label="Filter by severity"
            className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
          >
            <option value="ALL">All Severities</option>
            <option value="INFO">INFO</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
          </select>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading event stream...</div>
        ) : logs.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-slate-700">No synchronization events logged yet</p>
            <p className="text-xs text-slate-500 mt-1">
              Events appear here in real time as devices register, sync batches, or resolve conflicts.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left font-mono-tabular">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-sans font-medium">
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Severity</th>
                  <th className="py-3 px-4">Event Type</th>
                  <th className="py-3 px-4">Device</th>
                  <th className="py-3 px-4">Session</th>
                  <th className="py-3 px-4">Metadata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((evt) => (
                  <tr key={evt.eventId} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 text-slate-500 whitespace-nowrap">
                      {new Date(evt.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2.5 px-4 font-semibold">
                      <span
                        className={
                          evt.severity === 'ERROR'
                            ? 'text-red-700'
                            : evt.severity === 'WARN'
                            ? 'text-amber-700'
                            : 'text-slate-700'
                        }
                      >
                        {evt.severity}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 font-semibold text-slate-900 whitespace-nowrap">
                      {evt.eventType}
                    </td>
                    <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">
                      {evt.deviceId.slice(0, 16)}
                    </td>
                    <td className="py-2.5 px-4 text-slate-500 whitespace-nowrap">
                      {evt.sessionId ? evt.sessionId.slice(0, 12) : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-slate-600 max-w-md truncate">
                      {JSON.stringify(evt.metadata)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
