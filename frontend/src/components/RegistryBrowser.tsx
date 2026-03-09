import { useState, useEffect } from 'react';
import { getConfig, getCatalog, getTags, deleteTag } from '../api';
import type { Registry } from '../api';

export function RegistryBrowser() {
  const [registries, setRegistries] = useState<Registry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getConfig().then((c) => {
      const r = c.registries || [];
      setRegistries(r);
      if (r.length && !selected) setSelected(r[0].id);
    });
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    getCatalog(selected)
      .then(setRepos)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    setExpandedRepo(null);
    setTags([]);
  }, [selected]);

  const loadTags = async (repo: string) => {
    if (!selected) return;
    if (expandedRepo === repo) {
      setExpandedRepo(null);
      setTags([]);
      return;
    }
    setExpandedRepo(repo);
    try {
      const t = await getTags(selected, repo);
      setTags(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tags');
    }
  };

  const handleDelete = async (repo: string, tag: string) => {
    if (!selected || !confirm(`Delete ${repo}:${tag}?`)) return;
    setError(null);
    try {
      await deleteTag(selected, repo, tag);
      setTags((t) => t.filter((x) => x !== tag));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-white">Registry browser</h2>

      <div className="flex flex-wrap gap-2">
        {registries.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              selected === r.id
                ? 'bg-accent-600 text-white'
                : 'bg-surface-800 text-surface-400 hover:bg-surface-700 hover:text-surface-200'
            }`}
          >
            {r.name}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-surface-800 bg-surface-900 px-6 py-12 text-center text-surface-500">
          Loading catalog…
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
          <div className="max-h-[60vh] overflow-y-auto">
            {repos.length === 0 ? (
              <div className="px-6 py-12 text-center text-surface-500">
                No repositories found.
              </div>
            ) : (
              <div className="divide-y divide-surface-800">
                {repos.map((repo) => (
                  <div key={repo}>
                    <button
                      onClick={() => loadTags(repo)}
                      className="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-surface-800/50"
                    >
                      <span className="font-mono text-sm text-surface-200">
                        {repo}
                      </span>
                      <span className="text-surface-500">
                        {expandedRepo === repo ? '▼' : '▶'}
                      </span>
                    </button>
                    {expandedRepo === repo && (
                      <div className="border-t border-surface-800 bg-surface-950/50 px-6 py-4">
                        <div className="flex flex-wrap gap-2">
                          {tags.map((tag) => (
                            <span
                              key={tag}
                              className="group flex items-center gap-1 rounded bg-surface-800 px-3 py-1.5 font-mono text-sm"
                            >
                              {tag}
                              <button
                                onClick={() => handleDelete(repo, tag)}
                                className="ml-1 opacity-0 transition group-hover:opacity-100 text-red-400 hover:text-red-300"
                                title="Delete"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                        {tags.length === 0 && (
                          <p className="text-sm text-surface-500">
                            No tags
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
