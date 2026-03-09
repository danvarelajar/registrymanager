import fs from 'fs/promises';
import path from 'path';
import { parseTarManifest } from './tar-parser.js';
import { WATCH_FOLDER } from './config.js';
import { getScanCache, setScanCache } from './db.js';

/**
 * Recursively find all .tar files under dir.
 */
async function findTarFiles(baseDir, dir = baseDir, relPath = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];

  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      const subRel = relPath ? `${relPath}/${e.name}` : e.name;
      const subFiles = await findTarFiles(baseDir, fullPath, subRel);
      results.push(...subFiles);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.tar')) {
      results.push({
        filePath: fullPath,
        filename: e.name,
        folderPath: relPath,
      });
    }
  }
  return results;
}

/**
 * Perform a fresh filesystem scan. Does NOT read from cache.
 */
export async function scanFolder() {
  const absPath = path.resolve(WATCH_FOLDER);
  let tarFiles;
  try {
    tarFiles = await findTarFiles(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const result = { files: [], lastScannedAt: new Date().toISOString(), error: 'Folder does not exist' };
      setScanCache(result.files, result.lastScannedAt, result.error);
      return result;
    }
    throw err;
  }

  const results = [];

  for (const f of tarFiles) {
    try {
      const { component, tag, fullRepoTag } = await parseTarManifest(f.filePath);
      results.push({
        filename: f.filename,
        filePath: f.filePath,
        folderPath: f.folderPath,
        component,
        tag,
        fullRepoTag,
      });
    } catch (err) {
      results.push({
        filename: f.filename,
        filePath: f.filePath,
        folderPath: f.folderPath,
        error: err.message,
      });
    }
  }

  const lastScannedAt = new Date().toISOString();
  setScanCache(results, lastScannedAt, null);
  return { files: results, lastScannedAt };
}

export function getLastScannedAt() {
  const { lastScannedAt } = getScanCache();
  return lastScannedAt;
}
