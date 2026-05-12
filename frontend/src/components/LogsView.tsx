import { useState, useEffect, useMemo } from 'react';
import { getHttpLogs, deleteHttpLogs } from '../api';
import type { HttpLog } from '../api';

type FilterField = 'ip' | 'method' | 'path' | 'status';

type LogFilter = {
  field: FilterField;
  value: string;
  negate: boolean;
};

function matchesFilter(log: HttpLog, f: LogFilter): boolean {
  const v = f.value.trim().toLowerCase();
  if (!v) return true;
  let match = false;
  switch (f.field) {
    case 'ip':
      match = log.ip.toLowerCase().includes(v);
      break;
    case 'method':
      match = log.method.toLowerCase().includes(v);
      break;
    case 'path':
      match = log.path.toLowerCase().includes(v);
      break;
    case 'status':
      match = String(log.status).includes(v);
      break;
    default:
      match = true;
  }
  return f.negate ? !match : match;
}

export function LogsView() {
  const [logs, setLogs] = useState<HttpLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [filters, setFilters] = useState<LogFilter[]>([]);

  const filteredLogs = useMemo(() => {
    if (filters.length === 0) return logs;
    return logs.filter((log) => filters.every((f) => matchesFilter(log, f)));
  }, [logs, filters]);

  const updateFilter = (i: number, upd: Partial<LogFilter>) => {
    setFilters((prev) => prev.map((f, j) => (j === i ? { ...f, ...upd } : f)));
  };

  const addFilter = () => {
    setFilters((prev) => [...prev, { field: 'path', value: '', negate: false }]);
  };

  const removeFilter = (i: number) => {
    setFilters((prev) => prev.filter((_, j) => j !== i));
  };

  const load = () => {
    setLoading(true);
    setError(null);
    getHttpLogs(200)
      .then(setLogs)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load logs'))
      .finally(() => setLoading(false));
  };

  useEffect(() => load(), []);

  const handleDelete = async () => {
    if (!confirm('Remove all logs?')) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteHttpLogs();
      setLogs([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete logs');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">HTTP logs</h2>
          <p className="mt-1 text-sm text-surface-400">
            Request logs with IP, headers, and response status.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="rounded-lg border border-surface-600 bg-surface-800 px-4 py-2 text-sm font-medium text-surface-200 hover:bg-surface-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting || logs.length === 0}
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {deleting ? 'Removing…' : 'Remove logs'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-surface-800 bg-surface-900 p-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-surface-400">Filters</span>
          {filters.map((f, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2">
              <select
                value={f.field}
                onChange={(e) => updateFilter(i, { field: e.target.value as FilterField })}
                className="rounded border-0 bg-surface-700 text-sm text-surface-200"
              >
                <option value="ip">IP</option>
                <option value="method">Method</option>
                <option value="path">Path</option>
                <option value="status">Status</option>
              </select>
              <input
                type="text"
                value={f.value}
                onChange={(e) => updateFilter(i, { value: e.target.value })}
                placeholder="value…"
                className="w-32 rounded border border-surface-600 bg-surface-950 px-2 py-1 text-sm text-surface-200 placeholder:text-surface-500"
              />
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-surface-400">
                <input
                  type="checkbox"
                  checked={f.negate}
                  onChange={(e) => updateFilter(i, { negate: e.target.checked })}
                  className="rounded border-surface-600"
                />
                negate
              </label>
              <button
                onClick={() => removeFilter(i)}
                className="rounded p-1 text-surface-500 hover:bg-surface-700 hover:text-surface-300"
                title="Remove filter"
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={addFilter}
            className="rounded-lg border border-dashed border-surface-600 px-3 py-2 text-sm text-surface-500 hover:border-surface-500 hover:text-surface-400"
          >
            + Add filter
          </button>
        </div>
        <p className="mb-2 text-xs text-surface-500">
          {filteredLogs.length} of {logs.length} logs
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
        {loading ? (
          <div className="px-6 py-12 text-center text-surface-500">Loading…</div>
        ) : logs.length === 0 ? (
          <div className="px-6 py-12 text-center text-surface-500">No logs yet</div>
        ) : filteredLogs.length === 0 ? (
          <div className="px-6 py-12 text-center text-surface-500">No logs match filters</div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 border-b border-surface-800 bg-surface-900">
                <tr>
                  <th className="px-4 py-3 font-medium text-surface-400">Time</th>
                  <th className="px-4 py-3 font-medium text-surface-400">IP</th>
                  <th className="px-4 py-3 font-medium text-surface-400">Method</th>
                  <th className="px-4 py-3 font-medium text-surface-400">Path</th>
                  <th className="px-4 py-3 font-medium text-surface-400">Status</th>
                  <th className="px-4 py-3 font-medium text-surface-400">Duration</th>
                  <th className="px-4 py-3 font-medium text-surface-400">Request</th>
                  <th className="px-4 py-3 font-medium text-surface-400">Response</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-800">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-surface-800/50">
                    <td className="px-4 py-2 font-mono text-xs text-surface-500">
                      {log.createdAt}
                    </td>
                    <td className="px-4 py-2 font-mono text-surface-300">{log.ip}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                          log.method === 'GET'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : log.method === 'POST'
                              ? 'bg-blue-500/20 text-blue-400'
                              : log.method === 'DELETE'
                                ? 'bg-red-500/20 text-red-400'
                                : 'bg-surface-600 text-surface-300'
                        }`}
                      >
                        {log.method}
                      </span>
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-2 font-mono text-surface-300">{log.path}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`font-mono ${
                          log.status >= 500
                            ? 'text-red-400'
                            : log.status >= 400
                              ? 'text-amber-400'
                              : log.status >= 300
                                ? 'text-blue-400'
                                : 'text-surface-300'
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-surface-500">{log.durationMs}ms</td>
                    <td className="px-4 py-2">
                      <details className="cursor-pointer">
                        <summary className="text-surface-500 hover:text-surface-400">View</summary>
                        <pre className="mt-1 max-h-24 overflow-auto rounded bg-surface-950 p-2 text-xs text-surface-400">
                          {JSON.stringify(log.headers, null, 2)}
                        </pre>
                      </details>
                    </td>
                    <td className="px-4 py-2">
                      <details className="cursor-pointer">
                        <summary className="text-surface-500 hover:text-surface-400">View</summary>
                        <pre className="mt-1 max-h-24 overflow-auto rounded bg-surface-950 p-2 text-xs text-surface-400">
                          {JSON.stringify(log.responseHeaders ?? {}, null, 2)}
                        </pre>
                      </details>
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
}
