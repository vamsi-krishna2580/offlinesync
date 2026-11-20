import React, { useCallback, useEffect, useState } from 'react';
import type { ConflictRecord } from '../../../packages/offlinesync-types';
import type { Product } from '../../../backend/shop-adapter/types';
import { monitorApi } from '../api/monitorApi';

export const ConflictsPage: React.FC = () => {
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [resolutionNote, setResolutionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Authoritative catalog mutation controls for testing Scenario G
  const [targetProductId, setTargetProductId] = useState('P101');
  const [newPrice, setNewPrice] = useState('');
  const [newStock, setNewStock] = useState('');

  const load = useCallback(async () => {
    const [list, prods] = await Promise.all([
      monitorApi.getConflicts(statusFilter),
      monitorApi.getProducts(),
    ]);
    setConflicts(list);
    setProducts(prods);
    if (!selectedId && list.length > 0) {
      setSelectedId(list[0].conflictId);
    }
  }, [selectedId, statusFilter]);

  useEffect(() => {
    void load();
    const unsub = monitorApi.subscribeEvents(() => {
      void load();
    });
    return unsub;
  }, [load]);

  const selected = conflicts.find((c) => c.conflictId === selectedId) ?? conflicts[0] ?? null;

  const handleResolve = async (choice: 'KEEP_SERVER' | 'APPLY_CLIENT') => {
    if (!selected || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await monitorApi.resolveConflict(selected.conflictId, {
        resolutionChoice: choice,
        expectedServerVersion: selected.remoteVersion,
        actor: 'monitor-operator',
        note: resolutionNote.trim() || `Operator chose ${choice}`,
      });
      setResolutionNote('');
      setFeedback(`Conflict ${selected.conflictId.slice(0, 12)} resolved (${choice}).`);
      await load();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Resolution failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSimulateConflict = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await monitorApi.simulateConflict();
      if (res.conflicts.length > 0) {
        setSelectedId(res.conflicts[0].conflictId);
      }
      setFeedback(
        `Simulated two devices modifying shared cart concurrently (${res.conflicts.length} conflict recorded).`
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  const handleCatalogMutation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await monitorApi.simulateCatalogChange({
        productId: targetProductId,
        price: newPrice !== '' ? Number(newPrice) : undefined,
        stock: newStock !== '' ? Number(newStock) : undefined,
      });
      setNewPrice('');
      setNewStock('');
      setFeedback(
        `Updated server authoritative ${res.product.productId} (${res.product.name}): price=$${res.product.price}, stock=${res.product.stock} (rev v${res.product.version}).`
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="font-monitor-display text-2xl font-bold text-slate-900">
            Conflict Center
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Policy-based conflict inspection, local vs. remote version diffing, and manual resolution workflow.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSimulateConflict()}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
          >
            Simulate 2-Device Conflict
          </button>

          <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
            {['ALL', 'OPEN', 'RESOLVED_AUTO', 'RESOLVED_MANUAL'].map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  statusFilter === st
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {st.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {feedback && (
        <div className="px-4 py-3 rounded-lg bg-slate-900 text-slate-100 text-xs font-medium">
          {feedback}
        </div>
      )}

      {/* Scenario G Trigger: Mutate Authoritative Server Price/Stock */}
      <form
        onSubmit={handleCatalogMutation}
        className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-end gap-4"
      >
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Server Authoritative Catalog Mutation (Test Scenario G: Invalid Offline Order)
          </label>
          <select
            value={targetProductId}
            onChange={(e) => setTargetProductId(e.target.value)}
            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
          >
            {products.map((p) => (
              <option key={p.productId} value={p.productId}>
                {p.productId} — {p.name} (${p.price}, stock {p.stock})
              </option>
            ))}
          </select>
        </div>

        <div className="w-32">
          <label className="block text-xs font-medium text-slate-600 mb-1">New Price ($)</label>
          <input
            type="number"
            min="1"
            step="1"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            placeholder="Keep"
            className="w-full px-3 py-2 text-xs font-mono-tabular border border-slate-300 rounded-lg"
          />
        </div>

        <div className="w-32">
          <label className="block text-xs font-medium text-slate-600 mb-1">New Stock</label>
          <input
            type="number"
            min="0"
            step="1"
            value={newStock}
            onChange={(e) => setNewStock(e.target.value)}
            placeholder="Keep"
            className="w-full px-3 py-2 text-xs font-mono-tabular border border-slate-300 rounded-lg"
          />
        </div>

        <button
          type="submit"
          disabled={busy || (newPrice === '' && newStock === '')}
          className="px-4 py-2 rounded-lg text-xs font-medium border border-slate-300 bg-slate-50 text-slate-900 hover:bg-slate-100 disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
        >
          Update Server Product
        </button>
      </form>

      {/* Main Split: Conflict List + Detail Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg overflow-hidden">
          {conflicts.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-medium text-slate-700">No conflicts recorded</p>
              <p className="text-xs text-slate-500 mt-1">
                Click "Simulate 2-Device Conflict" or submit an offline order after changing
                server price/stock.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
              {conflicts.map((c) => {
                const isSelected = selected?.conflictId === c.conflictId;
                return (
                  <li key={c.conflictId}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.conflictId)}
                      className={`w-full text-left p-4 transition-colors cursor-pointer ${
                        isSelected ? 'bg-slate-100' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono-tabular font-semibold text-slate-900">
                          {c.entityType}:{c.entityId}
                        </span>
                        <span
                          className={`font-medium ${
                            c.resolutionStatus === 'OPEN'
                              ? 'text-red-700'
                              : 'text-emerald-700'
                          }`}
                        >
                          {c.resolutionStatus}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 mt-1">
                        {c.conflictType} · Policy: {c.resolutionPolicy}
                      </p>
                      <p className="text-xs font-mono-tabular text-slate-400 mt-1">
                        Local v{c.localVersion} vs Server v{c.remoteVersion} ·{' '}
                        {new Date(c.detectedAt).toLocaleTimeString()}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Conflict Detail & Manual Resolution Panel */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6">
          {!selected ? (
            <p className="text-sm text-slate-500">Select a conflict to inspect version details.</p>
          ) : (
            <div className="space-y-6">
              <div className="pb-4 border-b border-slate-200">
                <p className="text-xs font-mono-tabular text-slate-500">
                  {selected.conflictId} · Operation {selected.operationId}
                </p>
                <h3 className="font-monitor-display text-lg font-bold text-slate-900 mt-1">
                  {selected.conflictType} on {selected.entityType}:{selected.entityId}
                </h3>
                <p className="text-xs text-slate-600 mt-1.5">
                  Policy: <span className="font-mono-tabular">{selected.resolutionPolicy}</span> ·
                  Local v{selected.localVersion} vs Remote v{selected.remoteVersion} · Status:{' '}
                  <span className="font-semibold">{selected.resolutionStatus}</span>
                </p>
                {selected.resolutionSummary && (
                  <p className="text-xs text-slate-700 mt-2">{selected.resolutionSummary}</p>
                )}
              </div>

              {/* Side-by-side Local vs Remote Payload Diff */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs font-semibold text-slate-700 mb-2">
                    Local Client Payload (base v{selected.localVersion})
                  </p>
                  <pre className="p-3.5 rounded-lg bg-slate-950 text-slate-100 text-xs font-mono-tabular overflow-x-auto max-h-56">
                    {JSON.stringify(selected.localPayload, null, 2)}
                  </pre>
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-700 mb-2">
                    Remote Server State (v{selected.remoteVersion})
                  </p>
                  <pre className="p-3.5 rounded-lg bg-slate-950 text-slate-100 text-xs font-mono-tabular overflow-x-auto max-h-56">
                    {JSON.stringify(selected.remoteState, null, 2)}
                  </pre>
                </div>
              </div>

              {/* Manual Resolution Workflow */}
              {selected.resolutionStatus === 'OPEN' && (
                <div className="pt-4 border-t border-slate-200 space-y-3">
                  <label className="block text-xs font-medium text-slate-700">
                    Resolution Note (recorded in audit history)
                  </label>
                  <input
                    type="text"
                    value={resolutionNote}
                    onChange={(e) => setResolutionNote(e.target.value)}
                    placeholder="Reason for selecting authoritative version..."
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleResolve('KEEP_SERVER')}
                      className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-900 text-white hover:bg-slate-800 cursor-pointer"
                    >
                      Keep Server State
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleResolve('APPLY_CLIENT')}
                      className="px-4 py-2 rounded-lg text-xs font-medium border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 cursor-pointer"
                    >
                      Apply Client Payload
                    </button>
                  </div>
                </div>
              )}

              {/* Resolution Audit History */}
              <div className="pt-4 border-t border-slate-200">
                <h4 className="text-xs font-semibold text-slate-700 mb-2">
                  Resolution Audit Trail
                </h4>
                <ul className="space-y-2 text-xs font-mono-tabular text-slate-600">
                  {selected.history.map((h, i) => (
                    <li key={i} className="flex flex-wrap gap-2">
                      <span className="text-slate-400">
                        {new Date(h.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="font-semibold text-slate-900">{h.action}</span>
                      <span>by {h.actor}</span>
                      {h.note && <span className="text-slate-500">— {h.note}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
