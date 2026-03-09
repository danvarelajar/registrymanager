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

    INSERT OR IGNORE INTO scan_cache (id, files_json, last_scanned_at) VALUES (1, '[]', '');
  `);
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
