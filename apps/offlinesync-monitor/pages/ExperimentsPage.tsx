import React, { useCallback, useEffect, useState } from 'react';
import { Download, Play } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ExperimentRunRecord } from '../../../packages/offlinesync-types';
import { getExperimentsExportCsvUrl, monitorApi } from '../api/monitorApi';

const SCENARIOS: Array<{ value: ExperimentRunRecord['scenario']; label: string }> = [
  { value: 'STABLE_CONNECTION', label: 'Stable Connection' },
  { value: 'OFFLINE_BACKLOG', label: 'Offline Backlog Recovery' },
  { value: 'SIMULATED_INTERRUPTION', label: 'Simulated Interruption & Retry' },
  { value: 'DUPLICATE_DELIVERY', label: 'Duplicate Delivery (Idempotency)' },
  { value: 'CONCURRENT_MODIFICATION', label: 'Concurrent Modification (Conflicts)' },
];

const OP_COUNTS = [10, 50, 100, 500];

export const ExperimentsPage: React.FC = () => {
  const [runs, setRuns] = useState<ExperimentRunRecord[]>([]);
  const [scenario, setScenario] =
    useState<ExperimentRunRecord['scenario']>('STABLE_CONNECTION');
  const [operationCount, setOperationCount] = useState(50);
  const [batchSize, setBatchSize] = useState(25);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await monitorApi.getExperiments();
    setRuns(list);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      await monitorApi.runExperiment({ scenario, operationCount, batchSize });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Experiment failed');
    } finally {
      setRunning(false);
    }
  };

  const handleRunSuite = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      for (const count of [10, 50, 100]) {
        await monitorApi.runExperiment({
          scenario,
          operationCount: count,
          batchSize,
        });
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Benchmark suite failed');
    } finally {
      setRunning(false);
    }
  };

  const chartData = runs
    .slice(0, 12)
    .reverse()
    .map((r) => ({
      label: `${r.scenario.split('_')[0]} (${r.operationCount})`,
      latencyMs: r.syncLatencyMs,
      bytesKB: Math.round((r.bytesTransferred / 1024) * 100) / 100,
    }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="font-monitor-display text-2xl font-bold text-slate-900">
            Experimental Evaluation Harness
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Execute reproducible workloads through the real OfflineSync engine &amp; core to measure
            latency, retry recovery, idempotency, conflict detection, and byte transfer.
          </p>
        </div>

        <a
          href={getExperimentsExportCsvUrl()}
          download="offlinesync-experiments.csv"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export CSV</span>
        </a>
      </div>

      {/* Controls */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[220px]">
          <label className="block text-xs font-medium text-slate-600 mb-1">Scenario</label>
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value as ExperimentRunRecord['scenario'])}
            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
          >
            {SCENARIOS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div className="w-36">
          <label className="block text-xs font-medium text-slate-600 mb-1">Operations</label>
          <select
            value={operationCount}
            onChange={(e) => setOperationCount(Number(e.target.value))}
            className="w-full px-3 py-2 text-xs font-mono-tabular border border-slate-300 rounded-lg bg-white"
          >
            {OP_COUNTS.map((c) => (
              <option key={c} value={c}>
                {c} ops
              </option>
            ))}
          </select>
        </div>

        <div className="w-32">
          <label className="block text-xs font-medium text-slate-600 mb-1">Batch Size</label>
          <input
            type="number"
            min="5"
            max="100"
            value={batchSize}
            onChange={(e) => setBatchSize(Number(e.target.value))}
            className="w-full px-3 py-2 text-xs font-mono-tabular border border-slate-300 rounded-lg"
          />
        </div>

        <button
          type="button"
          disabled={running}
          onClick={() => void handleRun()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
        >
          <Play className="w-3.5 h-3.5" />
          <span>{running ? 'Running Benchmark...' : 'Run Experiment'}</span>
        </button>

        <button
          type="button"
          disabled={running}
          onClick={() => void handleRunSuite()}
          className="px-4 py-2 rounded-lg text-xs font-medium border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
        >
          Run 10 / 50 / 100 Scaling Suite
        </button>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Real Measurements Chart */}
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <h3 className="font-monitor-display text-base font-semibold text-slate-900 mb-1">
          Collected Benchmark Latency &amp; Payload Volume
        </h3>
        <p className="text-xs text-slate-500 mb-5">
          Plotted exclusively from executed benchmark runs recorded in the backend.
        </p>

        {chartData.length === 0 ? (
          <div className="py-12 text-center border border-dashed border-slate-200 rounded-lg">
            <p className="text-sm font-medium text-slate-700">No experiment measurements yet</p>
            <p className="text-xs text-slate-500 mt-1">
              Select a scenario above and click "Run Experiment" to collect real telemetry.
            </p>
          </div>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748B' }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#64748B' }} unit="ms" />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 11, fill: '#64748B' }}
                  unit="KB"
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0F172A',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#F8FAFC',
                    fontSize: '12px',
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar
                  yAxisId="left"
                  dataKey="latencyMs"
                  name="Sync Latency (ms)"
                  fill="#0F172A"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  yAxisId="right"
                  dataKey="bytesKB"
                  name="Bytes Transferred (KB)"
                  fill="#0D6E52"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Results Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {runs.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            Completed benchmark runs will be tabulated here and available for CSV export.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-medium">
                  <th className="py-3 px-4">Scenario</th>
                  <th className="py-3 px-4 text-right">Ops</th>
                  <th className="py-3 px-4 text-right">Batch</th>
                  <th className="py-3 px-4 text-right">Sync Latency</th>
                  <th className="py-3 px-4 text-right">Local Write Avg</th>
                  <th className="py-3 px-4 text-right">Recovery</th>
                  <th className="py-3 px-4 text-right">Success</th>
                  <th className="py-3 px-4 text-right">Retries</th>
                  <th className="py-3 px-4 text-right">Dup Prevented</th>
                  <th className="py-3 px-4 text-right">Conflicts</th>
                  <th className="py-3 px-4 text-right">Transferred</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono-tabular">
                {runs.map((r) => (
                  <tr key={r.experimentId} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-sans font-medium text-slate-900">
                      {r.scenario.replace(/_/g, ' ')}
                    </td>
                    <td className="py-2.5 px-4 text-right">{r.operationCount}</td>
                    <td className="py-2.5 px-4 text-right">{r.batchSize}</td>
                    <td className="py-2.5 px-4 text-right font-semibold">{r.syncLatencyMs} ms</td>
                    <td className="py-2.5 px-4 text-right">{r.localWriteAvgMs} ms</td>
                    <td className="py-2.5 px-4 text-right">
                      {r.recoveryTimeMs !== null ? `${r.recoveryTimeMs} ms` : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right text-emerald-700">{r.successRate}%</td>
                    <td className="py-2.5 px-4 text-right">{r.retryCount}</td>
                    <td className="py-2.5 px-4 text-right">{r.duplicatesPrevented}</td>
                    <td className="py-2.5 px-4 text-right">{r.conflictsDetected}</td>
                    <td className="py-2.5 px-4 text-right">
                      {(r.bytesTransferred / 1024).toFixed(2)} KB
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
