import React, { useCallback, useEffect, useState } from 'react';
import type { SyncOperation } from '../../../packages/offlinesync-types';
import { monitorApi } from '../api/monitorApi';

const STATUS_FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'PROCESSING', label: 'Processing' },
  { key: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'REQUIRES_ACTION', label: 'Requires Action' },
];

export const QueuePage: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [operations, setOperations] = useState<SyncOperation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const list = await monitorApi.getOperations(statusFilter);
      setOperations(list);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
    const unsub = monitorApi.subscribeEvents(() => {
      void load();
    });
    return unsub;
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="font-monitor-display text-2xl font-bold text-slate-900">
            Operation Queue Ledger
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Idempotent server-side ledger of received client operations keyed uniquely by operationId.
          </p>
        </div>

        {/* Functional Status Filter Bar */}
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatusFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                statusFilter === f.key
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading operations...</div>
        ) : operations.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-slate-700">
              No operations match filter "{statusFilter}"
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Perform actions in OfflineShop or run a benchmark in Experiments to inspect operations.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 px-4">Operation ID</th>
                  <th className="py-3 px-4">Device ID</th>
                  <th className="py-3 px-4">Op Type</th>
                  <th className="py-3 px-4">Entity</th>
                  <th className="py-3 px-4 text-right">Base Ver</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Retries</th>
                  <th className="py-3 px-4">Created At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {operations.map((op) => (
                  <tr key={op.operationId} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono-tabular text-xs text-slate-900">
                      {op.operationId.slice(0, 18)}
                    </td>
                    <td className="py-2.5 px-4 font-mono-tabular text-xs text-slate-600">
                      {op.deviceId.slice(0, 16)}
                    </td>
                    <td className="py-2.5 px-4 font-mono-tabular text-xs font-medium text-slate-800">
                      {op.operationType}
                    </td>
                    <td className="py-2.5 px-4 font-mono-tabular text-xs text-slate-600">
                      {op.entityType}:{op.entityId}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono-tabular text-xs">
                      v{op.baseVersion}
                    </td>
                    <td className="py-2.5 px-4 text-xs font-medium">
                      <span
                        className={
                          op.status === 'ACKNOWLEDGED'
                            ? 'text-emerald-700'
                            : op.status === 'FAILED'
                            ? 'text-red-700'
                            : op.status === 'REQUIRES_ACTION'
                            ? 'text-amber-700'
                            : 'text-slate-700'
                        }
                      >
                        {op.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono-tabular text-xs">
                      {op.retryCount}
                    </td>
                    <td className="py-2.5 px-4 font-mono-tabular text-xs text-slate-500">
                      {new Date(op.createdAt).toLocaleTimeString()}
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
