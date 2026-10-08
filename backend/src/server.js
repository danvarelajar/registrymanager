import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { scanFolder, getLastScannedAt } from './scanner.js';
import { pushTar } from './pusher.js';
import * as registry from './registry.js';
import * as db from './db.js';
import { imageDestination, isOcirHost, resolveDockerAuth } from './docker-auth.js';
import { WATCH_FOLDER, PORT } from './config.js';

const app = express();

// Trust proxy for correct client IP behind Docker/nginx (X-Forwarded-For)
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// HTTP request logging: source IP, headers, response code (filtered)
const LOG_HEADERS = ['user-agent', 'host', 'referer', 'accept', 'content-type'];
const SKIP_EXT = /\.(js|css|map|ico|png|svg|woff2?|ttf|eot|webp)(\?|$)/i;
const SKIP_PATHS = ['/favicon.ico'];

app.use((req, res, next) => {
  if (SKIP_PATHS.includes(req.path) || SKIP_EXT.test(req.path)) return next();

  const start = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const headers = {};
  for (const k of LOG_HEADERS) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const responseHeaders = {};
    for (const [k, v] of Object.entries(res.getHeaders())) {
      responseHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    try {
      db.insertHttpLog(ip, req.method, req.path, res.statusCode, durationMs, headers, responseHeaders);
    } catch (err) {
      console.error('Failed to store http log:', err.message);
    }
  });
  next();
});

// In-memory state for push progress (single-worker)
let pushState = { status: 'idle', current: null, queue: [], progress: null };

// --- HTTP logs ---
app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json(db.getHttpLogs(limit, offset));
});

app.delete('/api/logs', (req, res) => {
  db.deleteAllHttpLogs();
  res.json({ deleted: true });
});

// --- Config ---
app.get('/api/config', (req, res) => {
  res.json({
    watchFolder: path.resolve(WATCH_FOLDER),
    registries: db.getAllRegistries(),
  });
});

// --- Registries CRUD ---
app.get('/api/registries', (req, res) => {
  res.json(db.getAllRegistries());
});

function normalizeRepository(value) {
  const repo = String(value || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!repo) return '';
  if (!/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/.test(repo)) {
    return null;
  }
  return repo;
}

app.post('/api/registries', (req, res) => {
  const { name, hostname, port } = req.body;
  if (!name || !hostname || port == null) {
    return res.status(400).json({ error: 'name, hostname and port required' });
  }
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    return res.status(400).json({ error: 'port must be 1-65535' });
  }
  const repository = normalizeRepository(req.body.repository);
  if (repository == null) {
    return res.status(400).json({ error: 'Repository must be a lowercase path' });
  }
  try {
    const r = db.addRegistry(String(name).trim(), String(hostname).trim(), p, repository);
    res.status(201).json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/registries/:id', (req, res) => {
  const { id } = req.params;
  const { name, hostname, port } = req.body;
  if (!name || !hostname || port == null) {
    return res.status(400).json({ error: 'name, hostname and port required' });
  }
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    return res.status(400).json({ error: 'port must be 1-65535' });
  }
  if (!db.getRegistryById(id)) {
    return res.status(404).json({ error: 'Registry not found' });
  }
  const repository = normalizeRepository(req.body.repository);
  if (repository == null) {
    return res.status(400).json({ error: 'Repository must be a lowercase path' });
  }
  try {
    const r = db.updateRegistry(id, String(name).trim(), String(hostname).trim(), p, repository);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/registries/:id', (req, res) => {
  const { id } = req.params;
  if (!db.getRegistryById(id)) {
    return res.status(404).json({ error: 'Registry not found' });
  }
  db.deleteRegistry(id);
  res.json({ deleted: true });
});

// --- Folder scan ---
app.get('/api/scan', async (req, res) => {
  const force = req.query.force === 'true' || req.query.force === '1';
  try {
    if (force) {
      const result = await scanFolder();
      return res.json(result);
    }
    const cached = db.getScanCache();
    if (cached.lastScannedAt && cached.files.length >= 0) {
      const hasMissingCachedPath = cached.files.some(
        (file) => file?.filePath && !existsSync(file.filePath)
      );
      if (hasMissingCachedPath) {
        const result = await scanFolder();
        return res.json(result);
      }
      return res.json({
        files: cached.files,
        lastScannedAt: cached.lastScannedAt,
        error: cached.error || undefined,
      });
    }
    const result = await scanFolder();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const result = await scanFolder();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scan/last', (req, res) => {
  res.json({ lastScannedAt: getLastScannedAt() });
});

// --- Push ---
app.post('/api/push', async (req, res) => {
  const { filePath, registries } = req.body;
  if (!filePath || !Array.isArray(registries) || registries.length === 0) {
    return res.status(400).json({ error: 'filePath and registries required' });
  }

  if (pushState.status === 'pushing') {
    return res.status(409).json({ error: 'Push already in progress' });
  }

  pushState.status = 'pushing';
  pushState.current = filePath;
  pushState.progress = null;

  res.json({ accepted: true });

  try {
    await pushTar(filePath, registries, (p) => {
      pushState.progress = p;
    });
    pushState.status = 'idle';
    pushState.current = null;
    pushState.progress = null;
  } catch (err) {
    pushState.progress = { stage: 'error', message: err.message };
    pushState.status = 'idle';
    pushState.current = null;
  }
});

app.post('/api/push/queue', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array required' });
  }

  if (pushState.status === 'pushing') {
    return res.status(409).json({ error: 'Push already in progress' });
  }

  pushState.queue = items;
  pushState.status = 'pushing';

  res.json({ accepted: true });

  (async () => {
    let lastError = null;
    for (let i = 0; i < items.length; i++) {
      const { filePath, registries } = items[i];
      if (pushState.status !== 'pushing') break;
      pushState.current = filePath;
      try {
        await pushTar(filePath, registries, (p) => {
          pushState.progress = { ...p, queueIndex: i, queueTotal: items.length };
        });
      } catch (err) {
        lastError = err;
        pushState.progress = { stage: 'error', message: err.message, queueIndex: i, queueTotal: items.length };
        break;
      }
    }
    pushState.status = 'idle';
    pushState.current = null;
    if (!lastError) {
      pushState.queue = [];
      pushState.progress = null;
    }
  })();
});

app.get('/api/push/status', (req, res) => {
  res.json({
    status: pushState.status,
    current: pushState.current,
    progress: pushState.progress,
    queueLength: pushState.queue.length,
    queue: pushState.queue,
  });
});

// --- Registry check (batch presence) ---
app.post('/api/registry/check', async (req, res) => {
  const { images, registryIds } = req.body;
  if (!Array.isArray(images) || images.length === 0) {
    return res.json({});
  }

  try {
    const registries = registryIds && registryIds.length > 0
      ? registryIds.map((id) => db.getRegistryById(id)).filter(Boolean)
      : db.getAllRegistries();

    const result = {};
    await Promise.all(
      images.map(async ({ component, tag }) => {
        const fullRepoTag = `${component}:${tag}`;
        const presence = {};
        await Promise.all(
          registries.map(async (r) => {
            try {
              const auth = await resolveDockerAuth(r.hostname, r.port);
              const dest = imageDestination(r, component, tag, auth);
              const tags = await registry.getTags(r.id, dest.repository);
              presence[r.id] = tags && tags.includes(dest.tag);
            } catch (err) {
              presence[r.id] = false;
              const missing = /Tags list failed: 404/.test(err.message || '')
                || (isOcirHost(r.hostname) && /Tags list failed: 403/.test(err.message || ''));
              if (!missing) {
                console.warn(`Presence check failed for ${r.hostname}/${component}: ${err.message}`);
              }
            }
          })
        );
        result[fullRepoTag] = presence;
      })
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Registry (catalog, tags, delete tag) ---
app.get('/api/registry/:key/catalog', async (req, res) => {
  try {
    const repos = await registry.getCatalog(req.params.key);
    res.json({ repositories: repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/registry/:key/tags', async (req, res) => {
  const repo = req.query.repository;
  if (!repo) return res.status(400).json({ error: 'repository required' });
  try {
    const tags = await registry.getTags(req.params.key, repo);
    res.json({ tags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/registry/:key/repositories/:repo/tags', async (req, res) => {
  try {
    const tags = await registry.getTags(req.params.key, req.params.repo);
    res.json({ tags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function deleteTag(registryKey, repo, tag) {
  const digest = await registry.getManifestDigest(registryKey, repo, tag);
  await registry.deleteManifest(registryKey, repo, digest);
}

app.delete('/api/registry/:key/manifests', async (req, res) => {
  const repo = req.query.repository;
  const tag = req.query.tag;
  if (!repo || !tag) return res.status(400).json({ error: 'repository and tag required' });
  try {
    await deleteTag(req.params.key, repo, tag);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/registry/:key/manifests/:repo/:tag', async (req, res) => {
  try {
    await deleteTag(req.params.key, req.params.repo, req.params.tag);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Static frontend (production) ---
const publicPath = path.join(__dirname, '..', '..', 'public');
if (existsSync(publicPath)) {
  app.use(express.static(publicPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(publicPath, 'index.html'));
  });
}

// Start
app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
