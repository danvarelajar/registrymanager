import { useState, useEffect, useCallback } from 'react';
import {
  scanFolder,
  triggerScan,
  pushImage,
  pushImageQueue,
  checkRegistryPresence,
  getConfig,
} from '../api';
import type { ScannedFile, RegistryPresence, Registry } from '../api';

function groupByFolder(files: ScannedFile[]): Map<string, ScannedFile[]> {
  const map = new Map<string, ScannedFile[]>();
  for (const f of files) {
    const folder = f.folderPath ?? '';
    if (!map.has(folder)) map.set(folder, []);
    map.get(folder)!.push(f);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.filename.localeCompare(b.filename));
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function FolderView({ onPushStart }: { onPushStart: () => void }) {
  const [files, setFiles] = useState<ScannedFile[]>([]);
  const [presence, setPresence] = useState<RegistryPresence>({});
  const [registries, setRegistries] = useState<Registry[]>([]);
  const [lastScanned, setLastScanned] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [watchFolder, setWatchFolder] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRegistries, setBulkRegistries] = useState<string[]>([]);
  const [bulkPushing, setBulkPushing] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  const loadPresence = useCallback(
    async (fileList: ScannedFile[]) => {
      const valid = fileList.filter(
        (f): f is ScannedFile & { component: string; tag: string } =>
          !f.error && f.component != null && f.tag != null
      );
      if (valid.length === 0 || registries.length === 0) return {};
      try {
        return await checkRegistryPresence(
          valid.map((f) => ({ component: f.component!, tag: f.tag! })),
          registries.map((r) => r.id)
        );
      } catch {
        return {};
      }
    },
    [registries]
  );

  const doScan = useCallback(
    async (force = false) => {
      setLoading(true);
      setError(null);
      try {
        const result = force ? await triggerScan() : await scanFolder(false);
        setFiles(result.files);
        setLastScanned(result.lastScannedAt || null);
        if (result.error) setError(result.error);
        const pres = await loadPresence(result.files);
        setPresence(pres);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Scan failed');
      } finally {
        setLoading(false);
      }
    },
    [loadPresence]
  );

  const doScanNow = useCallback(() => doScan(true), [doScan]);

  useEffect(() => {
    getConfig().then((c: { watchFolder?: string; registries?: Registry[] }) => {
      setWatchFolder(c.watchFolder || '');
      const regs = c.registries || [];
      setRegistries(regs);
      setBulkRegistries((prev) => {
        if (prev.length === 0 && regs.length > 0) return regs.map((r: Registry) => r.id);
        return prev.filter((id) => regs.some((r: Registry) => r.id === id));
      });
    });
  }, []);

  useEffect(() => {
    if (registries.length > 0 || watchFolder) {
      doScan(false);
    }
  }, [registries.length, watchFolder]);

  const validFiles = files.filter((f) => !f.error && f.filePath);
  const selectedCount = validFiles.filter((f) => selected.has(f.filePath)).length;
  const grouped = groupByFolder(files);

  const toggleSelect = (filePath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(validFiles.map((f) => f.filePath)));
  };

  const selectNone = () => setSelected(new Set());

  const toggleFolder = (folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const handlePush = async (file: ScannedFile, regIds: string[]) => {
    if (file.error || !file.filePath) return;
    setError(null);
    onPushStart();
    try {
      await pushImage(file.filePath, regIds);
      doScan(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Push failed');
    }
  };

  const handleBulkPush = async () => {
    const toPush = validFiles.filter((f) => selected.has(f.filePath));
    if (toPush.length === 0 || bulkRegistries.length === 0) return;
    setError(null);
    setBulkPushing(true);
    onPushStart();
    try {
      await pushImageQueue(
        toPush.map((f) => ({ filePath: f.filePath!, registries: bulkRegistries }))
      );
      doScan(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Push failed');
    } finally {
      setBulkPushing(false);
    }
  };

  const toggleBulkRegistry = (id: string) => {
    setBulkRegistries((r) =>
      r.includes(id) ? r.filter((x) => x !== id) : [...r, id]
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Image folder</h2>
          <p className="mt-0.5 text-sm text-surface-400">
            {watchFolder || '(not configured)'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-surface-500">
            {lastScanned ? `Last scanned: ${new Date(lastScanned).toLocaleString()}` : '—'}
          </span>
          <button
            onClick={doScanNow}
            disabled={loading}
            className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-500 disabled:opacity-50"
          >
            {loading ? 'Scanning…' : 'Scan now'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
        {validFiles.length === 0 && !loading ? (
          <div className="px-6 py-12 text-center text-surface-500">
            No tar files found. Add .tar images to the folder and scan.
          </div>
        ) : (
          <>
            {validFiles.length > 0 && (
              <div className="flex flex-wrap items-center gap-4 border-b border-surface-800 bg-surface-800/50 px-6 py-4">
                <span className="text-sm text-surface-400">Select images to push:</span>
                <button
                  onClick={selectAll}
                  className="text-sm text-accent-400 hover:text-accent-300"
                >
                  Select all
                </button>
                <button
                  onClick={selectNone}
                  className="text-sm text-surface-500 hover:text-surface-300"
                >
                  Deselect all
                </button>
                <div className="ml-2 flex flex-wrap items-center gap-4">
                  {registries.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={bulkRegistries.includes(r.id)}
                        onChange={() => toggleBulkRegistry(r.id)}
                        className="rounded border-surface-600"
                      />
                      {r.name}
                    </label>
                  ))}
                </div>
                <button
                  onClick={handleBulkPush}
                  disabled={selectedCount === 0 || bulkRegistries.length === 0 || bulkPushing}
                  className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-500 disabled:opacity-50"
                >
                  {bulkPushing ? 'Pushing…' : `Push selected (${selectedCount})`}
                </button>
              </div>
            )}
            <div className="divide-y divide-surface-800">
              {Array.from(grouped.entries()).map(([folderPath, folderFiles]) => {
                const folderLabel = folderPath || '(root)';
                const isCollapsed = collapsedFolders.has(folderPath);
                const folderValidCount = folderFiles.filter((f) => !f.error).length;

                return (
                  <div key={folderPath || '__root__'} className="bg-surface-900">
                    <button
                      type="button"
                      onClick={() => toggleFolder(folderPath)}
                      className="flex w-full items-center gap-2 px-6 py-3 text-left font-medium text-surface-200 hover:bg-surface-800/50"
                    >
                      <span
                        className={`text-surface-500 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                      >
                        ▸
                      </span>
                      <span>{folderLabel}</span>
                      <span className="text-sm font-normal text-surface-500">
                        ({folderValidCount} image{folderValidCount !== 1 ? 's' : ''})
                      </span>
                    </button>
                    {!isCollapsed && (
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-surface-800 bg-surface-800/30">
                            <th className="w-10 px-4 py-2">
                              <input
                                type="checkbox"
                                checked={
                                  folderFiles
                                    .filter((f) => !f.error && f.filePath)
                                    .every((f) => selected.has(f.filePath)) &&
                                  folderValidCount > 0
                                }
                                onChange={(e) => {
                                  const valid = folderFiles.filter((f) => !f.error && f.filePath);
                                  if (e.target.checked) {
                                    setSelected((prev) => new Set([...prev, ...valid.map((f) => f.filePath)]));
                                  } else {
                                    setSelected((prev) => {
                                      const next = new Set(prev);
                                      valid.forEach((f) => next.delete(f.filePath));
                                      return next;
                                    });
                                  }
                                }}
                                aria-label={`Select all in ${folderLabel}`}
                                className="rounded border-surface-600"
                              />
                            </th>
                            <th className="px-6 py-2 text-left text-xs font-medium uppercase tracking-wider text-surface-400">
                              Filename
                            </th>
                            <th className="px-6 py-2 text-left text-xs font-medium uppercase tracking-wider text-surface-400">
                              Image (component:tag)
                            </th>
                            <th className="w-32 px-4 py-2 text-center text-xs font-medium uppercase tracking-wider text-surface-400">
                              In registries
                            </th>
                            <th className="px-6 py-2 text-right text-xs font-medium uppercase tracking-wider text-surface-400">
                              Actions
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-surface-800">
                          {folderFiles.map((f) => (
                            <tr
                              key={f.filePath}
                              className={`hover:bg-surface-800/50 ${selected.has(f.filePath) ? 'bg-accent-500/10' : ''}`}
                            >
                              <td className="w-10 px-4 py-3">
                                {!f.error && f.filePath && (
                                  <input
                                    type="checkbox"
                                    checked={selected.has(f.filePath)}
                                    onChange={() => toggleSelect(f.filePath)}
                                    aria-label={`Select ${f.filename}`}
                                    className="rounded border-surface-600"
                                  />
                                )}
                              </td>
                              <td className="px-6 py-4 font-mono text-sm">{f.filename}</td>
                              <td className="px-6 py-4">
                                {f.error ? (
                                  <span className="text-red-400">{f.error}</span>
                                ) : (
                                  <code className="rounded bg-surface-800 px-2 py-0.5 text-accent-400">
                                    {f.fullRepoTag}
                                  </code>
                                )}
                              </td>
                              <td className="w-32 px-4 py-4 text-center">
                                {!f.error && f.fullRepoTag && (
                                  <RegistryIcons
                                    presence={presence[f.fullRepoTag]}
                                    registries={registries}
                                    fullRepoTag={f.fullRepoTag}
                                  />
                                )}
                              </td>
                              <td className="px-6 py-4 text-right">
                                {!f.error && f.filePath && (
                                  <PushButton
                                    file={f}
                                    registries={registries}
                                    onPush={handlePush}
                                    onPushStart={onPushStart}
                                  />
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RegistryIcons({
  presence,
  registries,
  fullRepoTag,
}: {
  presence?: Record<string, boolean>;
  registries: Registry[];
  fullRepoTag: string;
}) {
  if (!presence || registries.length === 0) return <span className="text-surface-600">—</span>;
  const parts = registries.map((r) => {
    const ok = presence[r.id];
    const short = r.name.slice(0, 2).toUpperCase();
    return { key: r.id, ok, short, name: r.name };
  });
  const title = parts.map((p) => `${p.name}: ${p.ok ? 'pushed' : 'not pushed'}`).join(', ');
  return (
    <span className="inline-flex flex-wrap gap-1 text-sm" title={`${fullRepoTag}: ${title}`}>
      {parts.map((p) => (
        <span key={p.key} className={p.ok ? 'text-emerald-400' : 'text-surface-500'}>
          {p.short} {p.ok ? '✓' : '—'}
        </span>
      ))}
    </span>
  );
}

function PushButton({
  file,
  registries,
  onPush,
  onPushStart,
}: {
  file: ScannedFile;
  registries: Registry[];
  onPush: (f: ScannedFile, r: string[]) => void;
  onPushStart: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(() =>
    registries.length > 0 ? registries.map((r) => r.id) : []
  );
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    if (registries.length > 0 && selected.length === 0) {
      setSelected(registries.map((r) => r.id));
    }
  }, [registries]);

  const toggle = (id: string) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const handlePush = async () => {
    if (selected.length === 0) return;
    setPushing(true);
    onPushStart();
    try {
      await onPush(file, selected);
      setOpen(false);
    } finally {
      setPushing(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-lg border border-surface-700 bg-surface-800 px-4 py-2 text-sm font-medium text-surface-200 hover:bg-surface-700"
      >
        Push
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-lg border border-surface-700 bg-surface-800 p-4 shadow-xl">
            <p className="mb-3 text-xs font-medium text-surface-400">
              Push to registries
            </p>
            {registries.map((r) => (
              <label key={r.id} className="mb-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.includes(r.id)}
                  onChange={() => toggle(r.id)}
                  className="rounded border-surface-600"
                />
                {r.name}
              </label>
            ))}
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded px-3 py-1.5 text-sm text-surface-400 hover:text-surface-200"
              >
                Cancel
              </button>
              <button
                onClick={handlePush}
                disabled={selected.length === 0 || pushing}
                className="rounded bg-accent-600 px-3 py-1.5 text-sm text-white hover:bg-accent-500 disabled:opacity-50"
              >
                {pushing ? 'Pushing…' : 'Push'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
