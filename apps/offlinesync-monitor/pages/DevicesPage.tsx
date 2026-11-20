import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DeviceRecord } from '../../../packages/offlinesync-types';
import { monitorApi } from '../api/monitorApi';

export const DevicesPage: React.FC = () => {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const list = await monitorApi.getDevices();
        setDevices(list);
      } finally {
        setLoading(false);
      }
    };
    void load();
    const unsub = monitorApi.subscribeEvents(() => {
      void load();
    });
    return unsub;
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-monitor-display text-2xl font-bold text-slate-900">
          Registered Devices
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          Active and offline synchronization clients registered with OfflineSync Core.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading devices...</div>
        ) : devices.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-slate-700">No devices registered yet</p>
            <p className="text-xs text-slate-500 mt-1">
              Open OfflineShop in a browser tab to automatically register a client device.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 px-4">Device ID</th>
                  <th className="py-3 px-4">Device Name</th>
                  <th className="py-3 px-4">App ID</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Pending Ops</th>
                  <th className="py-3 px-4 text-right">Cursor</th>
                  <th className="py-3 px-4">Last Sync</th>
                  <th className="py-3 px-4">Registered</th>
                  <th className="py-3 px-4 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {devices.map((d) => (
                  <tr key={d.deviceId} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4 font-mono-tabular text-xs font-medium text-slate-900">
                      {d.deviceId}
                    </td>
                    <td className="py-3 px-4 text-slate-800">{d.deviceName}</td>
                    <td className="py-3 px-4 font-mono-tabular text-xs text-slate-600">
                      {d.appId}
                    </td>
                    <td className="py-3 px-4 text-xs font-medium">
                      <span
                        className={
                          d.connectionStatus === 'ONLINE'
                            ? 'text-emerald-700'
                            : d.connectionStatus === 'OFFLINE'
                            ? 'text-amber-700'
                            : 'text-red-700'
                        }
                      >
                        {d.connectionStatus}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono-tabular">{d.pendingCount}</td>
                    <td className="py-3 px-4 text-right font-mono-tabular">#{d.lastCursor}</td>
                    <td className="py-3 px-4 font-mono-tabular text-xs text-slate-500">
                      {d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : 'Never'}
                    </td>
                    <td className="py-3 px-4 font-mono-tabular text-xs text-slate-500">
                      {new Date(d.registeredAt).toLocaleDateString()}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Link
                        to={`/monitor/devices/${encodeURIComponent(d.deviceId)}`}
                        className="text-xs font-medium text-slate-900 underline hover:text-slate-600"
                      >
                        Inspect
                      </Link>
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
