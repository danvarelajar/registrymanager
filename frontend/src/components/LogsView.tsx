import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearLogs,
  getLogs,
  logsExportUrl,
  runDiagnostics,
  type DiagnosticStep,
  type DiagnosticsResult,
  type LogEntry,
  type LogFilter,
  type LogLevel,
} from '../api';

const LEVEL_STYLES: Record<LogLevel, string> = {
  debug: 'bg-slate-700/40 text-slate-400',
  info: 'bg-sky-500/15 text-sky-300',
  warn: 'bg-amber-500/15 text-amber-300',
  error: 'bg-red-500/15 text-red-300',
};

const PAGE_SIZE = 300;

export function LogsView() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [level, setLevel] = useState<LogLevel>('info');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [diag, setDiag] = useState<DiagnosticsResult | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const newestId = useRef(0);

  const filter: LogFilter = { level, category: category || undefined, q: debouncedQuery || undefined };
  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getLogs(JSON.parse(filterKey), { limit: PAGE_SIZE });
      setLogs(data.logs);
      setCategories(data.categories);
      setHasMore(data.logs.length === PAGE_SIZE);
      newestId.current = data.logs[0]?.id ?? 0;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [filterKey]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Live tail: fetch only entries newer than the newest one shown.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(async () => {
      try {
        const data = await getLogs(JSON.parse(filterKey), { afterId: newestId.current, limit: 1000 });
        setCategories(data.categories);
        if (data.logs.length) {
          newestId.current = data.logs[0].id;
          setLogs((prev) => [...data.logs, ...prev].slice(0, 5000));
        }
      } catch {
        /* next tick retries */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [live, filterKey]);

  const loadOlder = async () => {
    const oldest = logs[logs.length - 1];
    if (!oldest) return;
    try {
      const data = await getLogs(filter, { beforeId: oldest.id, limit: PAGE_SIZE });
      setLogs((prev) => [...prev, ...data.logs]);
      setHasMore(data.logs.length === PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load logs');
    }
  };

  const handleClear = async () => {
    if (!confirm('Delete all log entries? This cannot be undone.')) return;
    try {
      await clearLogs();
      setExpanded(new Set());
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear logs');
    }
  };

  const handleDiagnostics = async () => {
    setDiagRunning(true);
    setDiagError(null);
    try {
      setDiag(await runDiagnostics());
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : 'Diagnostics failed');
    } finally {
      setDiagRunning(false);
    }
  };

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const counts = logs.reduce(
    (acc, l) => {
      if (l.level === 'error') acc.error++;
      if (l.level === 'warn') acc.warn++;
      return acc;
    },
    { error: 0, warn: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Logs</h2>
          <p className="mt-1 text-sm text-slate-400">
            Pushes, Docker events, registry checks, scans and setting changes. Kept for 14 days.
          </p>
        </div>
        <button
          onClick={handleDiagnostics}
          disabled={diagRunning}
          className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-60"
        >
          {diagRunning ? 'Running diagnostics…' : 'Run diagnostics'}
        </button>
      </div>

      {diagError && <p className="text-sm text-red-400">{diagError}</p>}
      {diag && <DiagnosticsPanel result={diag} onClose={() => setDiag(null)} />}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-surface-800 bg-surface-900 p-3">
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as LogLevel)}
          className="rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-surface-200"
          aria-label="Minimum level"
        >
          <option value="debug">All levels (incl. debug)</option>
          <option value="info">Info and above</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors only</option>
        </select>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-surface-200"
          aria-label="Category"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search message or details (e.g. webui, timeout)"
          className="min-w-48 flex-1 rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-surface-200 placeholder:text-slate-500"
        />
        <label className="flex items-center gap-2 px-2 text-sm text-slate-300">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live
        </label>
        <button
          onClick={reload}
          className="rounded-lg bg-surface-800 px-3 py-2 text-sm text-surface-200 hover:bg-slate-700"
        >
          Refresh
        </button>
        <a
          href={logsExportUrl(filter)}
          className="rounded-lg bg-surface-800 px-3 py-2 text-sm text-surface-200 hover:bg-slate-700"
        >
          Download
        </a>
        <button
          onClick={handleClear}
          className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 hover:bg-red-500/20"
        >
          Clear
        </button>
      </div>

      <div className="flex gap-4 text-sm text-slate-400">
        <span>{logs.length} shown</span>
        {counts.error > 0 && <span className="text-red-300">{counts.error} errors</span>}
        {counts.warn > 0 && <span className="text-amber-300">{counts.warn} warnings</span>}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
        {loading && logs.length === 0 ? (
          <p className="p-6 text-sm text-slate-400">Loading…</p>
        ) : logs.length === 0 ? (
          <p className="p-6 text-sm text-slate-400">No log entries match these filters.</p>
        ) : (
          <ul className="divide-y divide-surface-800 font-mono text-xs">
            {logs.map((l) => {
              const hasContext = Object.keys(l.context || {}).length > 0;
              const isOpen = expanded.has(l.id);
              const hint = typeof l.context?.hint === 'string' ? l.context.hint : null;
              const err = l.context?.error as { message?: string } | undefined;
              return (
                <li key={l.id} className={l.level === 'error' ? 'bg-red-500/5' : ''}>
                  <button
                    onClick={() => hasContext && toggle(l.id)}
                    className={`flex w-full items-start gap-3 px-4 py-2 text-left ${
                      hasContext ? 'hover:bg-surface-800/60' : 'cursor-default'
                    }`}
                  >
                    <span className="shrink-0 text-slate-500" title={l.ts}>
                      {formatTime(l.ts)}
                    </span>
                    <span className={`w-12 shrink-0 rounded px-1.5 text-center uppercase ${LEVEL_STYLES[l.level]}`}>
                      {l.level}
                    </span>
                    <span className="w-20 shrink-0 truncate text-slate-400">{l.category}</span>
                    <span className="min-w-0 flex-1 break-words text-surface-200">
                      {l.message}
                      {err?.message && <span className="block text-red-300">{err.message}</span>}
                      {hint && <span className="block font-sans text-amber-200/90">→ {hint}</span>}
                    </span>
                    {hasContext && <span className="shrink-0 text-slate-500">{isOpen ? '▾' : '▸'}</span>}
                  </button>
                  {isOpen && (
                    <pre className="mx-4 mb-3 overflow-x-auto rounded-lg bg-surface-950 p-3 text-slate-300">
                      {JSON.stringify(l.context, null, 2)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {hasMore && (
          <div className="border-t border-surface-800 p-3 text-center">
            <button onClick={loadOlder} className="text-sm text-accent-500 hover:underline">
              Load older entries
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DiagnosticsPanel({ result, onClose }: { result: DiagnosticsResult; onClose: () => void }) {
  return (
    <div className="space-y-4 rounded-xl border border-surface-800 bg-surface-900 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white">Diagnostics</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">{new Date(result.startedAt).toLocaleString()}</span>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-white">
            Hide
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Network checks run from the app container. Pushes are made by the Docker daemon, which normally shares the same
        network on Docker Desktop.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {result.registries.map((r) => (
          <DiagCard key={r.id} title={r.name} subtitle={r.host} ok={r.ok} steps={r.steps} />
        ))}
        <DiagCard title="Docker" ok={result.docker.ok} steps={result.docker.steps} />
        <DiagCard title="Environment" ok={result.environment.ok} steps={result.environment.steps} />
      </div>
      {result.registries.length === 0 && (
        <p className="text-sm text-slate-400">No registries configured. Add one in Settings.</p>
      )}
    </div>
  );
}

function DiagCard({
  title,
  subtitle,
  ok,
  steps,
}: {
  title: string;
  subtitle?: string;
  ok: boolean;
  steps: DiagnosticStep[];
}) {
  return (
    <div className={`rounded-lg border p-3 ${ok ? 'border-emerald-500/30' : 'border-red-500/40'}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-white">{title}</p>
          {subtitle && <p className="truncate font-mono text-xs text-slate-400">{subtitle}</p>}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
            ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
          }`}
        >
          {ok ? 'OK' : 'Problem'}
        </span>
      </div>
      <ul className="space-y-1.5 text-sm">
        {steps.map((s) => (
          <li key={s.name} className="flex gap-2">
            <span className={`shrink-0 ${s.ok ? 'text-emerald-400' : 'text-red-400'}`}>{s.ok ? '✓' : '✕'}</span>
            <div className="min-w-0">
              <span className="text-surface-200">{s.name}</span>
              {s.ms != null && <span className="ml-2 font-mono text-xs text-slate-500">{s.ms} ms</span>}
              {s.detail && <p className="break-words text-xs text-slate-400">{s.detail}</p>}
              {s.hint && <p className="text-xs text-amber-200/90">→ {s.hint}</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour12: false });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
