import React, { useCallback, useEffect, useState } from 'react';
import type { SyncSessionRecord } from '../../../packages/offlinesync-types';
import { monitorApi } from '../api/monitorApi';

export const SessionsPage: React.FC = () => {
  const [sessions, setSessions] = useState<SyncSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const list = await monitorApi.getSessions();
      setSessions(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const unsub = monitorApi.subscribeEvents(() => {
      void load();
    });
    return unsub;
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-monitor-display text-2xl font-bold text-slate-900">
          Synchronization Sessions
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          Complete audit history of bidirectional push/pull sessions, batch outcomes, latency, and byte transfer.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-slate-700">No synchronization sessions yet</p>
            <p className="text-xs text-slate-500 mt-1">
              Sessions are logged automatically whenever a client device syncs with OfflineSync Core.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 px-4">Session ID</th>
                  <th className="py-3 px-4">Device ID</th>
                  <th className="py-3 px-4">Start Time</th>
                  <th className="py-3 px-4 text-right">Duration</th>
                  <th className="py-3 px-4 text-right">Sent</th>
                  <th className="py-3 px-4 text-right">Acked</th>
                  <th className="py-3 px-4 text-right">Rejected</th>
                  <th className="py-3 px-4 text-right">Bytes</th>
                  <th className="py-3 px-4">Result</th>
                  <th className="py-3 px-4">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sessions.map((s) => (
                  <tr key={s.sessionId} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono-tabular text-xs font-medium text-slate-900">
                      {s.sessionId.slice(0, 18)}
                    </td>
                    <td className="py-2.5 px-4 font-mono-tabular text-xs text-slate-600">
                      {s.deviceId.slice(0, 16)}
                    </td>
                    <td className="py-2.5 px-4 font-mono-tabular text-xs text-slate-500">
                      {new Date(s.startedAt).toLocaleTimeString()}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono-tabular text-xs">
                      {s.durationMs !== null ? `${s.durationMs} ms` : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono-tabular text-xs">
                      {s.operationsSent}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono-tabular text-xs text-emerald-700">
                      {s.operationsAcknowledged}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono-tabular text-xs text-amber-700">
                      {s.operationsRejected}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono-tabular text-xs text-slate-600">
                      {((s.bytesSent + s.bytesReceived) / 1024).toFixed(2)} KB
                    </td>
                    <td className="py-2.5 px-4 text-xs font-medium">
                      <span
                        className={
                          s.result === 'SUCCESS'
                            ? 'text-emerald-700'
                            : s.result === 'PARTIAL'
                            ? 'text-amber-700'
                            : 'text-red-700'
                        }
                      >
                        {s.result}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-xs text-slate-500 max-w-xs truncate">
                      {s.errors.length > 0 ? s.errors.join('; ') : 'None'}
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
