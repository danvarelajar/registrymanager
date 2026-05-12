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

    CREATE TABLE IF NOT EXISTS http_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      headers_json TEXT NOT NULL DEFAULT '{}',
      response_headers_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_http_logs_created_at ON http_logs(created_at);

    INSERT OR IGNORE INTO scan_cache (id, files_json, last_scanned_at) VALUES (1, '[]', '');
  `);
  try {
    db.exec(`ALTER TABLE http_logs ADD COLUMN response_headers_json TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    /* column exists */
  }
}

export function getAllRegistries() {
  const d = init();
  const rows = d.prepare('SELECT id, name, hostname, port FROM registries ORDER BY name').all();
  return rows.map((r) => ({
    key: r.id,
    id: r.id,
    name: r.name,
    hostname: r.hostname,
    port: r.port,
    url: `https://${r.hostname}:${r.port}`,
  }));
}

export function getRegistryById(id) {
  const d = init();
  const r = d.prepare('SELECT id, name, hostname, port FROM registries WHERE id = ?').get(id);
  if (!r) return null;
  return {
    key: r.id,
    id: r.id,
    name: r.name,
    hostname: r.hostname,
    port: r.port,
    url: `https://${r.hostname}:${r.port}`,
  };
}

export function addRegistry(name, hostname, port) {
  const d = init();
  const id = `reg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  d.prepare('INSERT INTO registries (id, name, hostname, port) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    hostname,
    port
  );
  return getRegistryById(id);
}

export function updateRegistry(id, name, hostname, port) {
  const d = init();
  d.prepare(
    'UPDATE registries SET name = ?, hostname = ?, port = ? WHERE id = ?'
  ).run(name, hostname, port, id);
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

// --- HTTP logs ---
const MAX_HTTP_LOGS = 10_000;
const HTTP_LOG_RETENTION_DAYS = 7;

export function insertHttpLog(ip, method, path, status, durationMs, headers = {}, responseHeaders = {}) {
  const d = init();
  d.prepare(
    'INSERT INTO http_logs (ip, method, path, status, duration_ms, headers_json, response_headers_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(ip, method, path, status, durationMs, JSON.stringify(headers), JSON.stringify(responseHeaders));
  pruneHttpLogs(d);
}

function pruneHttpLogs(d) {
  const count = d.prepare('SELECT COUNT(*) as n FROM http_logs').get().n;
  if (count > MAX_HTTP_LOGS) {
    const toDelete = count - MAX_HTTP_LOGS;
    d.prepare(
      'DELETE FROM http_logs WHERE id IN (SELECT id FROM http_logs ORDER BY id LIMIT ?)'
    ).run(toDelete);
  }
  d.prepare(
    "DELETE FROM http_logs WHERE created_at < datetime('now', ?)"
  ).run(`-${HTTP_LOG_RETENTION_DAYS} days`);
}

export function getHttpLogs(limit = 100, offset = 0) {
  const d = init();
  const rows = d.prepare(
    'SELECT id, ip, method, path, status, duration_ms, headers_json, response_headers_json, created_at FROM http_logs ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  return rows.map((r) => ({
    id: r.id,
    ip: r.ip,
    method: r.method,
    path: r.path,
    status: r.status,
    durationMs: r.duration_ms,
    headers: JSON.parse(r.headers_json || '{}'),
    responseHeaders: JSON.parse(r.response_headers_json || '{}'),
    createdAt: r.created_at,
  }));
}

export function deleteAllHttpLogs() {
  const d = init();
  d.prepare('DELETE FROM http_logs').run();
}
