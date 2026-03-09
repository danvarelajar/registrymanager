import { useState, useEffect } from 'react';
import { getRegistries, addRegistry, updateRegistry, deleteRegistry } from '../api';
import type { Registry } from '../api';

export function RegistrySettings() {
  const [registries, setRegistries] = useState<Registry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = () => {
    setLoading(true);
    getRegistries()
      .then(setRegistries)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => load(), []);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete registry "${name}"?`)) return;
    setError(null);
    try {
      await deleteRegistry(id);
      setRegistries((r) => r.filter((x) => x.id !== id));
      if (editing === id) setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const handleAdd = async (name: string, hostname: string, port: number) => {
    setError(null);
    try {
      const r = await addRegistry(name, hostname, port);
      setRegistries((prev) => [...prev, r]);
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed');
      throw e;
    }
  };

  const handleUpdate = async (id: string, name: string, hostname: string, port: number) => {
    setError(null);
    try {
      const r = await updateRegistry(id, name, hostname, port);
      setRegistries((prev) => prev.map((x) => (x.id === id ? r : x)));
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
      throw e;
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-white">Registry settings</h2>
      <p className="text-sm text-surface-400">
        Add or edit Docker registries by hostname and port. These are used for pushing images and browsing.
      </p>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
        {loading ? (
          <div className="px-6 py-12 text-center text-surface-500">Loading…</div>
        ) : (
          <div className="divide-y divide-surface-800">
            {registries.map((r) => (
              <div key={r.id} className="px-6 py-4">
                {editing === r.id ? (
                  <RegistryForm
                    name={r.name}
                    hostname={r.hostname}
                    port={r.port}
                    onSave={(name, hostname, port) => handleUpdate(r.id, name, hostname, port)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <span className="font-medium text-surface-200">{r.name}</span>
                      <span className="ml-2 font-mono text-sm text-surface-500">
                        {r.hostname}:{r.port}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditing(r.id)}
                        className="rounded px-3 py-1.5 text-sm text-surface-400 hover:bg-surface-800 hover:text-surface-200"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(r.id, r.name)}
                        className="rounded px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {adding ? (
              <div className="px-6 py-4">
                <RegistryForm
                  onSave={handleAdd}
                  onCancel={() => setAdding(false)}
                />
              </div>
            ) : (
              <div className="px-6 py-4">
                <button
                  onClick={() => setAdding(true)}
                  className="rounded-lg border border-dashed border-surface-600 px-4 py-2 text-sm text-surface-400 hover:border-surface-500 hover:text-surface-300"
                >
                  + Add registry
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RegistryForm({
  name: initialName = '',
  hostname: initialHostname = '',
  port: initialPort = 5000,
  onSave,
  onCancel,
}: {
  name?: string;
  hostname?: string;
  port?: number;
  onSave: (name: string, hostname: string, port: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [hostname, setHostname] = useState(initialHostname);
  const [port, setPort] = useState(String(initialPort));
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseInt(port, 10);
    if (!name.trim() || !hostname.trim() || isNaN(p) || p < 1 || p > 65535) {
      return;
    }
    setSaving(true);
    try {
      await onSave(name.trim(), hostname.trim(), p);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="mb-1 block text-xs text-surface-500">Display name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Europe"
          className="w-full rounded border border-surface-700 bg-surface-800 px-3 py-2 text-surface-200"
          required
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-surface-500">Hostname</label>
        <input
          type="text"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="registry.example.com"
          className="w-full rounded border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-surface-200"
          required
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-surface-500">Port</label>
        <input
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          min={1}
          max={65535}
          className="w-24 rounded border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-surface-200"
          required
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-accent-600 px-4 py-2 text-sm text-white hover:bg-accent-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-4 py-2 text-sm text-surface-400 hover:bg-surface-800 hover:text-surface-200"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
