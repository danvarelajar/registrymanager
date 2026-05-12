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

export async function getCatalog(registryKey: string): Promise<string[]> {
  const res = await fetch(
    `${API}/registry/${encodeURIComponent(registryKey)}/catalog`
  );
  if (!res.ok) throw new Error('Failed to load catalog');
  const data = await res.json();
  return data.repositories || [];
}

export async function getTags(
  registryKey: string,
  repo: string
): Promise<string[]> {
  const res = await fetch(
    `${API}/registry/${encodeURIComponent(registryKey)}/repositories/${encodeURIComponent(repo)}/tags`
  );
  if (!res.ok) throw new Error('Failed to load tags');
  const data = await res.json();
  return data.tags || [];
}

export type HttpLog = {
  id: number;
  ip: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  headers: Record<string, string>;
  responseHeaders: Record<string, string>;
  createdAt: string;
};

export async function getHttpLogs(limit = 100, offset = 0): Promise<HttpLog[]> {
  const res = await fetch(`${API}/logs?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error('Failed to load logs');
  return res.json();
}

export async function deleteHttpLogs(): Promise<void> {
  const res = await fetch(`${API}/logs`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete logs');
}

export async function deleteTag(
  registryKey: string,
  repo: string,
  tag: string
): Promise<void> {
  const res = await fetch(
    `${API}/registry/${encodeURIComponent(registryKey)}/manifests/${encodeURIComponent(repo)}/${encodeURIComponent(tag)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'Delete failed');
  }
}
