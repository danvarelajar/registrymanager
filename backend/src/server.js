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
import { imageDestination, isOcirHost, resolveDockerAuth, dockerConfigPath } from './docker-auth.js';
import { logger, hintFor } from './logger.js';
import { runDiagnostics } from './diagnostics.js';
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
    logger.info('settings', `Added registry ${r.name} (${r.hostname}:${r.port})`, { registry: r.name });
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
    logger.info('settings', `Updated registry ${r.name} (${r.hostname}:${r.port})`, { registry: r.name });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/registries/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.getRegistryById(id);
  if (!existing) {
    return res.status(404).json({ error: 'Registry not found' });
  }
  db.deleteRegistry(id);
  logger.info('settings', `Deleted registry ${existing.name} (${existing.hostname}:${existing.port})`);
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
  logger.info('push', `Push requested for ${path.basename(filePath)}`, { registries: registryNames(registries) });

  try {
    await pushTar(filePath, registries, (p) => {
      pushState.progress = p;
    }, signal);
    endPush(null);
  } catch (err) {
    if (isCancelledError(err)) {
      logger.warn('push', 'Push cancelled');
      endPush({ stage: 'cancelled', message: 'Push cancelled', progress: 0, elapsed: pushState.progress?.elapsed });
    } else {
      endPush({ stage: 'error', message: err.message, hint: hintFor(err.message) });
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
  const queueStart = Date.now();
  logger.info('push', `Queue started: ${items.length} image(s)`, {
    files: items.map((i) => path.basename(i.filePath)),
    registries: registryNames([...new Set(items.flatMap((i) => i.registries || []))]),
  });

  (async () => {
    let outcome = null;
    let done = 0;
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
        done++;
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
          outcome = {
            stage: 'error',
            message: err.message,
            hint: hintFor(err.message),
            queueIndex: i,
            queueTotal: items.length,
          };
        }
        break;
      }
    }
    const took = `${((Date.now() - queueStart) / 1000).toFixed(1)}s`;
    if (!outcome) {
      logger.info('push', `Queue finished: ${done}/${items.length} pushed in ${took}`);
    } else if (outcome.stage === 'cancelled') {
      logger.warn('push', `Queue cancelled after ${done}/${items.length} in ${took}`);
    } else {
      logger.error('push', `Queue stopped at ${path.basename(items[outcome.queueIndex].filePath)} after ${done}/${items.length} pushed in ${took}; remaining images were not pushed`, {
        error: new Error(outcome.message),
      });
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
  logger.warn('push', 'Cancel requested', { current: pushState.current ? path.basename(pushState.current) : undefined });
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

    const result = {};
    for (const { component, tag } of images) {
      if (!component || !tag) continue;
      result[`${component}:${tag}`] = Object.fromEntries(registries.map((r) => [r.id, false]));
    }
    const validImages = images.filter((image) => image?.component && image?.tag);

    // Each registry gets its own small pool, so one slow registry cannot hold up another.
    // Connections are reused (see registry.js), which keeps Docker Desktop from throttling bursts.
    const concurrency = Number(process.env.REGISTRY_CHECK_CONCURRENCY) || 4;
    const CONNECT_FAILURE = /connect ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/;

    await Promise.all(registries.map(async (r) => {
      const tagCache = new Map();
      const failure = { count: 0, images: [], error: null };
      let unreachable = null;
      let skipped = 0;

      await mapLimit(validImages, concurrency, async (image) => {
        const fullRepoTag = `${image.component}:${image.tag}`;
        if (unreachable) {
          skipped++;
          return;
        }
        try {
          const auth = await resolveDockerAuth(r.hostname, r.port);
          const dest = imageDestination(r, image.component, image.tag, auth);
          let tags = tagCache.get(dest.repository);
          if (!tags) {
            tags = registry.getTags(r.id, dest.repository);
            tagCache.set(dest.repository, tags);
          }
          result[fullRepoTag][r.id] = (await tags).includes(dest.tag);
        } catch (err) {
          const msg = err.message || '';
          const missing = /Tags list failed: 404/.test(msg)
            || (isOcirHost(r.hostname) && /Tags list failed: 403/.test(msg));
          if (missing) return;
          if (CONNECT_FAILURE.test(msg) || CONNECT_FAILURE.test(err.code || '')) unreachable = err;
          failure.count++;
          if (failure.images.length < 10) failure.images.push(fullRepoTag);
          failure.error = failure.error || err;
        }
      });

      if (unreachable) {
        logger.warn('registry', `${r.name} (${r.hostname}:${r.port}) is unreachable; skipped the remaining ${skipped} image(s) in this check`, {
          registry: r.name,
          failed: failure.count,
          skipped,
          error: unreachable,
        });
      } else if (failure.count) {
        logger.warn('registry', `Presence check failed for ${failure.count} image(s) on ${r.name} (${r.hostname}:${r.port})`, {
          registry: r.name,
          images: failure.images,
          error: failure.error,
        });
      }
    }));
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
    logger.warn('registry', `Catalog request failed for ${registryLabel(req.params.key)}`, { error: err });
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
    logger.warn('registry', `Tag list failed for ${repo} on ${registryLabel(req.params.key)}`, { error: err });
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
    logger.info('registry', `Deleted ${repo}:${tag} on ${registryLabel(req.params.key)}`);
    res.json({ deleted: true });
  } catch (err) {
    logger.error('registry', `Deleting ${repo}:${tag} on ${registryLabel(req.params.key)} failed`, { error: err });
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

// --- Logs & diagnostics ---
app.get('/api/logs', (req, res) => {
  const { level, category, q, limit, afterId, beforeId } = req.query;
  res.json({
    logs: db.getLogs({ minLevel: level, category, q, limit, afterId, beforeId }),
    categories: db.getLogCategories(),
  });
});

app.get('/api/logs/export', (req, res) => {
  const { level, category, q } = req.query;
  const rows = db.getLogs({ minLevel: level, category, q, limit: 5000 }).reverse();
  const text = rows
    .map((r) => {
      const ctx = Object.keys(r.context || {}).length ? ` ${JSON.stringify(r.context)}` : '';
      return `${r.ts} ${r.level.toUpperCase().padEnd(5)} [${r.category}] ${r.message}${ctx}`;
    })
    .join('\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fs-repo-manager-${stamp}.log"`);
  res.send(text + '\n');
});

app.delete('/api/logs', (req, res) => {
  db.clearLogs();
  logger.info('system', 'Logs cleared');
  res.json({ cleared: true });
});

app.post('/api/diagnostics', async (req, res) => {
  try {
    res.json(await runDiagnostics());
  } catch (err) {
    logger.error('diagnostics', 'Diagnostics failed to run', { error: err });
    res.status(500).json({ error: err.message });
  }
});

function registryLabel(id) {
  const r = db.getRegistryById(id);
  return r ? `${r.name} (${r.hostname}:${r.port})` : id;
}

function registryNames(ids = []) {
  return ids.map((id) => db.getRegistryById(id)?.name || id);
}

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
  logger.info('system', 'Server started', {
    port: Number(PORT),
    watchFolder: path.resolve(WATCH_FOLDER),
    dockerConfig: dockerConfigPath(),
    insecureTls: process.env.REGISTRY_INSECURE_TLS === '1' || process.env.REGISTRY_INSECURE_TLS === 'true',
    registries: db.getAllRegistries().map((r) => `${r.name} (${r.hostname}:${r.port})`),
  });
});
