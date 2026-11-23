const API = '/api';

export type ScannedFile = {
  filename: string;
  filePath: string;
  folderPath?: string;
  component?: string;
  tag?: string;
  fullRepoTag?: string;
  error?: string;
};

export type Registry = {
  key: string;
  id: string;
  name: string;
  hostname: string;
  port: number;
  url: string;
};

export type RegistryPresence = Record<string, Record<string, boolean>>;

export type ScanResult = {
  files: ScannedFile[];
  lastScannedAt: string | null;
  error?: string;
};

export type PushProgress = {
  stage: string;
  progress: number;
  message: string;
  elapsed: number;
  target?: string;
  component?: string;
  tag?: string;
  queueIndex?: number;
  queueTotal?: number;
  hint?: string;
};

export type PushQueueItem = {
  filePath: string;
  registries: string[];
};

export type PushStatus = {
  status: 'idle' | 'pushing';
  current: string | null;
  progress: PushProgress | null;
  queueLength: number;
  queue?: { filePath: string; registries: string[] }[];
};

export async function getConfig() {
  const res = await fetch(`${API}/config`);
  if (!res.ok) throw new Error('Failed to load config');
  return res.json();
}

export async function getRegistries(): Promise<Registry[]> {
  const res = await fetch(`${API}/registries`);
  if (!res.ok) throw new Error('Failed to load registries');
  return res.json();
}

export async function addRegistry(name: string, hostname: string, port: number): Promise<Registry> {
  const res = await fetch(`${API}/registries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, hostname, port }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'Failed to add registry');
  }
  return res.json();
}

export async function updateRegistry(
  id: string,
  name: string,
  hostname: string,
  port: number
): Promise<Registry> {
  const res = await fetch(`${API}/registries/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, hostname, port }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'Failed to update registry');
  }
  return res.json();
}

export async function deleteRegistry(id: string): Promise<void> {
  const res = await fetch(`${API}/registries/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'Failed to delete registry');
  }
}

export async function scanFolder(force = false): Promise<ScanResult> {
  const url = force ? `${API}/scan?force=true` : API + '/scan';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Scan failed');
  return res.json();
}

export async function triggerScan(): Promise<ScanResult> {
  const res = await fetch(`${API}/scan`, { method: 'POST' });
  if (!res.ok) throw new Error('Scan failed');
  return res.json();
}

export async function pushImage(
  filePath: string,
  registries: string[]
): Promise<void> {
  const res = await fetch(`${API}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, registries }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'Push failed');
  }
}

export async function pushImageQueue(
  items: PushQueueItem[]
): Promise<void> {
  const res = await fetch(`${API}/push/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'Push failed');
  }
}

export async function getPushStatus(): Promise<PushStatus> {
  const res = await fetch(`${API}/push/status`);
  if (!res.ok) throw new Error('Failed to get status');
  return res.json();
}

export async function cancelPush(): Promise<void> {
  const res = await fetch(`${API}/push/cancel`, { method: 'POST' });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'Cancel failed');
  }
}

export async function checkRegistryPresence(
  images: { component: string; tag: string }[],
  registryIds?: string[]
): Promise<RegistryPresence> {
  const res = await fetch(`${API}/registry/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images, registryIds }),
  });
  if (!res.ok) throw new Error('Failed to check registry');
  return res.json();
}

async function errorFromResponse(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return body.error;
  } catch {
    /* response was not JSON */
  }
  return fallback;
}

export async function getCatalog(registryKey: string): Promise<string[]> {
  const res = await fetch(
    `${API}/registry/${encodeURIComponent(registryKey)}/catalog`
  );
  if (!res.ok) throw new Error(await errorFromResponse(res, 'Failed to load catalog'));
  const data = await res.json();
  return data.repositories || [];
}

export async function getTags(
  registryKey: string,
  repo: string
): Promise<string[]> {
  const params = new URLSearchParams({ repository: repo });
  const res = await fetch(
    `${API}/registry/${encodeURIComponent(registryKey)}/tags?${params}`
  );
  if (!res.ok) throw new Error(await errorFromResponse(res, 'Failed to load tags'));
  const data = await res.json();
  return data.tags || [];
}

export async function deleteTag(
  registryKey: string,
  repo: string,
  tag: string
): Promise<void> {
  const params = new URLSearchParams({ repository: repo, tag });
  const res = await fetch(
    `${API}/registry/${encodeURIComponent(registryKey)}/manifests?${params}`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'Delete failed');
  }
}

// --- Logs & diagnostics ---
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  id: number;
  ts: string;
  level: LogLevel;
  category: string;
  message: string;
  context: Record<string, unknown>;
};

export type LogFilter = {
  level?: LogLevel;
  category?: string;
  q?: string;
};

function logParams(filter: LogFilter, extra: Record<string, string | number | undefined> = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filter, ...extra })) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  return params;
}

export async function getLogs(
  filter: LogFilter,
  opts: { limit?: number; afterId?: number; beforeId?: number } = {}
): Promise<{ logs: LogEntry[]; categories: string[] }> {
  const res = await fetch(`${API}/logs?${logParams(filter, opts)}`);
  if (!res.ok) throw new Error(await errorFromResponse(res, 'Failed to load logs'));
  return res.json();
}

export function logsExportUrl(filter: LogFilter): string {
  return `${API}/logs/export?${logParams(filter)}`;
}

export async function clearLogs(): Promise<void> {
  const res = await fetch(`${API}/logs`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await errorFromResponse(res, 'Failed to clear logs'));
}

export type DiagnosticStep = {
  name: string;
  ok: boolean;
  ms?: number;
  detail?: string;
  code?: string;
  hint?: string;
};

export type DiagnosticsResult = {
  startedAt: string;
  environment: { ok: boolean; steps: DiagnosticStep[] };
  docker: { ok: boolean; steps: DiagnosticStep[] };
  registries: { id: string; name: string; host: string; ok: boolean; steps: DiagnosticStep[] }[];
};

export async function runDiagnostics(): Promise<DiagnosticsResult> {
  const res = await fetch(`${API}/diagnostics`, { method: 'POST' });
  if (!res.ok) throw new Error(await errorFromResponse(res, 'Diagnostics failed'));
  return res.json();
}
