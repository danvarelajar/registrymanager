import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { scanFolder, getLastScannedAt } from './scanner.js';
import { pushTar, isCancelledError } from './pusher.js';
import * as registry from './registry.js';
import * as db from './db.js';
import { imageDestination, isOcirHost, resolveDockerAuth } from './docker-auth.js';
import { WATCH_FOLDER, PORT } from './config.js';

const app = express();

// Trust proxy for correct client IP behind Docker/nginx (X-Forwarded-For)
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// In-memory state for push progress (single-worker)
let pushState = { status: 'idle', current: null, queue: [], progress: null };
let pushAbort = null;

function beginPush() {
  pushAbort?.abort();
  pushAbort = new AbortController();
  return pushAbort.signal;
}

function endPush(progress = null) {
  pushState.status = 'idle';
  pushState.current = null;
  pushState.queue = [];
  pushState.progress = progress;
  pushAbort = null;
}

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

app.post('/api/registries', (req, res) => {
  const { name, hostname, port } = req.body;
  if (!name || !hostname || port == null) {
    return res.status(400).json({ error: 'name, hostname and port required' });
  }
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    return res.status(400).json({ error: 'port must be 1-65535' });
  }
  try {
    const r = db.addRegistry(String(name).trim(), String(hostname).trim(), p);
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
  try {
    const r = db.updateRegistry(id, String(name).trim(), String(hostname).trim(), p);
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

  const signal = beginPush();
  pushState.status = 'pushing';
  pushState.current = filePath;
  pushState.queue = [];
  pushState.progress = null;

  res.json({ accepted: true });

  try {
    await pushTar(filePath, registries, (p) => {
      pushState.progress = p;
    }, signal);
    endPush(null);
  } catch (err) {
    if (isCancelledError(err)) {
      endPush({ stage: 'cancelled', message: 'Push cancelled', progress: 0, elapsed: pushState.progress?.elapsed });
    } else {
      endPush({ stage: 'error', message: err.message });
    }
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

  const signal = beginPush();
  pushState.queue = items;
  pushState.status = 'pushing';
  pushState.progress = null;

  res.json({ accepted: true });

  (async () => {
    let outcome = null;
    for (let i = 0; i < items.length; i++) {
      if (signal.aborted) {
        outcome = { stage: 'cancelled', message: 'Push cancelled', queueIndex: i, queueTotal: items.length, progress: 0 };
        break;
      }
      const { filePath, registries } = items[i];
      pushState.current = filePath;
      try {
        await pushTar(filePath, registries, (p) => {
          pushState.progress = { ...p, queueIndex: i, queueTotal: items.length };
        }, signal);
      } catch (err) {
        if (isCancelledError(err)) {
          outcome = {
            stage: 'cancelled',
            message: 'Push cancelled',
            queueIndex: i,
            queueTotal: items.length,
            progress: 0,
            elapsed: pushState.progress?.elapsed,
          };
        } else {
          outcome = { stage: 'error', message: err.message, queueIndex: i, queueTotal: items.length };
        }
        break;
      }
    }
    endPush(outcome);
  })();
});

app.post('/api/push/cancel', (req, res) => {
  if (pushState.status !== 'pushing') {
    return res.status(409).json({ error: 'No push in progress' });
  }
  pushState.queue = [];
  pushState.progress = {
    ...(pushState.progress || {}),
    stage: 'cancelling',
    message: 'Cancelling…',
  };
  pushAbort?.abort();
  res.json({ accepted: true });
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

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) || 0 }, () => run());
  await Promise.all(workers);
  return results;
}

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

    const jobs = [];
    for (const image of images) {
      if (!image?.component || !image?.tag) continue;
      for (const r of registries) {
        jobs.push({ image, registry: r });
      }
    }

    const result = {};
    for (const { component, tag } of images) {
      if (!component || !tag) continue;
      result[`${component}:${tag}`] = Object.fromEntries(registries.map((r) => [r.id, false]));
    }

    // Unbounded parallel checks open too many sockets and time out even when the
    // registries are reachable. Keep a small pool so presence scans stay reliable.
    const concurrency = Number(process.env.REGISTRY_CHECK_CONCURRENCY) || 4;
    const tagCache = new Map();
    await mapLimit(jobs, concurrency, async ({ image, registry: r }) => {
      const fullRepoTag = `${image.component}:${image.tag}`;
      try {
        const auth = await resolveDockerAuth(r.hostname, r.port);
        const dest = imageDestination(r, image.component, image.tag, auth);
        const cacheKey = `${r.id}\n${dest.repository}`;
        let tags = tagCache.get(cacheKey);
        if (!tags) {
          tags = await registry.getTags(r.id, dest.repository);
          tagCache.set(cacheKey, tags);
        }
        result[fullRepoTag][r.id] = tags.includes(dest.tag);
      } catch (err) {
        result[fullRepoTag][r.id] = false;
        const missing = /Tags list failed: 404/.test(err.message || '')
          || (isOcirHost(r.hostname) && /Tags list failed: 403/.test(err.message || ''));
        if (!missing) {
          console.warn(`Presence check failed for ${r.hostname}/${image.component}: ${err.message}`);
        }
      }
    });
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
