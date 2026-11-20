import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type {
  DeviceRecord,
  SyncEventRecord,
  SyncOperation,
  SyncSessionRecord,
} from '../../../packages/offlinesync-types';
import { monitorApi } from '../api/monitorApi';

export const DeviceDetailPage: React.FC = () => {
  const { deviceId } = useParams<{ deviceId: string }>();
  const [data, setData] = useState<{
    device: DeviceRecord;
    operations: SyncOperation[];
    sessions: SyncSessionRecord[];
    logs: SyncEventRecord[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId) return;
    monitorApi
      .getDeviceDetail(deviceId)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Not found'));
  }, [deviceId]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          to="/monitor/devices"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Devices</span>
        </Link>
        <div className="p-6 bg-white border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="text-sm text-slate-500">Loading device profile...</div>;
  }

  const { device, operations, sessions, logs } = data;

  return (
    <div className="space-y-6">
      <Link
        to="/monitor/devices"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back to Devices</span>
      </Link>

      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-mono-tabular text-slate-500">{device.deviceId}</p>
            <h2 className="font-monitor-display text-xl font-bold text-slate-900 mt-1">
              {device.deviceName}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              App: <span className="font-mono-tabular">{device.appId}</span> · Platform:{' '}
              <span className="font-mono-tabular">{device.platform}</span> · Registered:{' '}
              <span className="font-mono-tabular">
                {new Date(device.registeredAt).toLocaleString()}
              </span>
            </p>
          </div>
          <div className="text-right font-mono-tabular text-xs">
            <p className="font-semibold text-emerald-700">{device.connectionStatus}</p>
            <p className="text-slate-500 mt-1">Last Cursor: #{device.lastCursor}</p>
            <p className="text-slate-500">Pending Reported: {device.pendingCount}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h3 className="font-monitor-display text-sm font-semibold text-slate-900 mb-3">
            Recent Operations ({operations.length})
          </h3>
          {operations.length === 0 ? (
            <p className="text-xs text-slate-500">No operations recorded for this device.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-xs">
              {operations.slice(0, 12).map((op) => (
                <li key={op.operationId} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono-tabular font-medium text-slate-900 truncate">
                      {op.operationType} · {op.entityType}:{op.entityId}
                    </p>
                    <p className="font-mono-tabular text-slate-500 truncate">
                      {op.operationId}
                    </p>
                  </div>
                  <span className="font-mono-tabular font-medium shrink-0">{op.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h3 className="font-monitor-display text-sm font-semibold text-slate-900 mb-3">
            Recent Sessions ({sessions.length})
          </h3>
          {sessions.length === 0 ? (
            <p className="text-xs text-slate-500">No sync sessions recorded for this device.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-xs">
              {sessions.slice(0, 12).map((s) => (
                <li key={s.sessionId} className="py-2.5 flex items-center justify-between gap-3">
                  <div>
                    <p className="font-mono-tabular font-medium text-slate-900">{s.sessionId}</p>
                    <p className="font-mono-tabular text-slate-500">
                      Sent {s.operationsSent} · Ack {s.operationsAcknowledged} · Rej{' '}
                      {s.operationsRejected}
                    </p>
                  </div>
                  <div className="text-right font-mono-tabular">
                    <p className="font-medium">{s.result}</p>
                    <p className="text-slate-500">{s.durationMs ?? 0} ms</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <h3 className="font-monitor-display text-sm font-semibold text-slate-900 mb-3">
          Device Telemetry Events ({logs.length})
        </h3>
        {logs.length === 0 ? (
          <p className="text-xs text-slate-500">No events logged yet.</p>
        ) : (
          <div className="divide-y divide-slate-100 text-xs font-mono-tabular">
            {logs.slice(0, 20).map((evt) => (
              <div key={evt.eventId} className="py-2 flex flex-wrap items-center gap-3">
                <span className="text-slate-400">
                  {new Date(evt.timestamp).toLocaleTimeString()}
                </span>
                <span className="font-semibold text-slate-900">{evt.eventType}</span>
                <span className="text-slate-500 truncate">{JSON.stringify(evt.metadata)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
