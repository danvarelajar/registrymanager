import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'fs-repo-manager.db');

let db;

function init() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  migrate();
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS registries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL,
      port INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scan_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      files_json TEXT NOT NULL DEFAULT '[]',
      last_scanned_at TEXT NOT NULL DEFAULT '',
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_app_logs_ts ON app_logs(ts);

    INSERT OR IGNORE INTO scan_cache (id, files_json, last_scanned_at) VALUES (1, '[]', '');
  `);
  try {
    db.exec(`ALTER TABLE registries ADD COLUMN repository TEXT NOT NULL DEFAULT ''`);
  } catch {
    /* column exists */
  }
  try {
    db.exec(`DROP TABLE IF EXISTS http_logs`);
  } catch {
    /* ignore */
  }
  // Path prefix was removed from settings; clear any leftover values.
  db.prepare(`UPDATE registries SET repository = '' WHERE repository != ''`).run();
}

function mapRegistry(r) {
  return {
    key: r.id,
    id: r.id,
    name: r.name,
    hostname: r.hostname,
    port: r.port,
    url: `https://${r.hostname}:${r.port}`,
  };
}

export function getAllRegistries() {
  const d = init();
  const rows = d.prepare('SELECT id, name, hostname, port FROM registries ORDER BY name').all();
  return rows.map(mapRegistry);
}

export function getRegistryById(id) {
  const d = init();
  const r = d.prepare('SELECT id, name, hostname, port FROM registries WHERE id = ?').get(id);
  if (!r) return null;
  return mapRegistry(r);
}

export function addRegistry(name, hostname, port) {
  const d = init();
  const id = `reg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  d.prepare('INSERT INTO registries (id, name, hostname, port, repository) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    hostname,
    port,
    ''
  );
  return getRegistryById(id);
}

export function updateRegistry(id, name, hostname, port) {
  const d = init();
  d.prepare(
    'UPDATE registries SET name = ?, hostname = ?, port = ?, repository = ? WHERE id = ?'
  ).run(name, hostname, port, '', id);
  return getRegistryById(id);
}

export function deleteRegistry(id) {
  const d = init();
  d.prepare('DELETE FROM registries WHERE id = ?').run(id);
}

export function getScanCache() {
  const d = init();
  const row = d.prepare('SELECT files_json, last_scanned_at, error FROM scan_cache WHERE id = 1').get();
  if (!row) return { files: [], lastScannedAt: null, error: null };
  try {
    const files = JSON.parse(row.files_json || '[]');
    return {
      files,
      lastScannedAt: row.last_scanned_at || null,
      error: row.error || null,
    };
  } catch {
    return { files: [], lastScannedAt: null, error: null };
  }
}

export function setScanCache(files, lastScannedAt, error = null) {
  const d = init();
  d.prepare(
    'UPDATE scan_cache SET files_json = ?, last_scanned_at = ?, error = ? WHERE id = 1'
  ).run(JSON.stringify(files), lastScannedAt || '', error || null);
}

// --- Application logs ---
const MAX_APP_LOGS = Number(process.env.LOG_MAX_ENTRIES) || 20_000;
const APP_LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 14;
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

export function insertLog(level, category, message, context = {}) {
  const d = init();
  d.prepare(
    'INSERT INTO app_logs (ts, level, category, message, context_json) VALUES (?, ?, ?, ?, ?)'
  ).run(new Date().toISOString(), level, category, String(message), JSON.stringify(context || {}));
}

export function pruneLogs() {
  const d = init();
  const cutoff = new Date(Date.now() - APP_LOG_RETENTION_DAYS * 86_400_000).toISOString();
  d.prepare('DELETE FROM app_logs WHERE ts < ?').run(cutoff);
  d.prepare(
    'DELETE FROM app_logs WHERE id <= (SELECT id FROM app_logs ORDER BY id DESC LIMIT 1 OFFSET ?)'
  ).run(MAX_APP_LOGS);
}

/**
 * Newest first. minLevel filters by severity; afterId returns only entries newer than that id.
 */
export function getLogs({ minLevel, category, q, limit = 500, afterId, beforeId } = {}) {
  const d = init();
  const where = [];
  const params = [];
  if (minLevel && LEVEL_RANK[minLevel] != null) {
    const levels = Object.keys(LEVEL_RANK).filter((l) => LEVEL_RANK[l] >= LEVEL_RANK[minLevel]);
    where.push(`level IN (${levels.map(() => '?').join(',')})`);
    params.push(...levels);
  }
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (q) {
    where.push('(message LIKE ? OR context_json LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (afterId) {
    where.push('id > ?');
    params.push(Number(afterId));
  }
  if (beforeId) {
    where.push('id < ?');
    params.push(Number(beforeId));
  }
  const sql = `SELECT id, ts, level, category, message, context_json FROM app_logs ${
    where.length ? `WHERE ${where.join(' AND ')}` : ''
  } ORDER BY id DESC LIMIT ?`;
  params.push(Math.min(Math.max(Number(limit) || 500, 1), 5000));
  return d.prepare(sql).all(...params).map((r) => {
    let context = {};
    try {
      context = JSON.parse(r.context_json || '{}');
    } catch {
      /* keep empty */
    }
    return { id: r.id, ts: r.ts, level: r.level, category: r.category, message: r.message, context };
  });
}

export function getLogCategories() {
  const d = init();
  return d.prepare('SELECT DISTINCT category FROM app_logs ORDER BY category').all().map((r) => r.category);
}

export function clearLogs() {
  const d = init();
  d.prepare('DELETE FROM app_logs').run();
}
