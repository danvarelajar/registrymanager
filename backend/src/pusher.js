import Docker from 'dockerode';
import fs from 'fs';
import { getRegistryById } from './db.js';
import { parseTarManifest } from './tar-parser.js';

const docker = new Docker();

/** Get registry host (host:port) for docker tag */
function getRegistryHost(registryKey) {
  const r = getRegistryById(registryKey);
  if (!r) return null;
  return r.url.replace(/^https?:\/\//, '').split('/')[0];
}

/** Get registry display name */
function getRegistryName(registryKey) {
  const r = getRegistryById(registryKey);
  return r ? r.name : String(registryKey);
}

/**
 * Push a single tar file to selected registries.
 * registryKeys: array of registry IDs
 */
export async function pushTar(filePath, registryKeys, onProgress) {
  const startTime = Date.now();

  const emit = (stage, progress, message, extra = {}) => {
    onProgress?.({ stage, progress, message, elapsed: Date.now() - startTime, ...extra });
  };

  emit('parsing', 0, 'Reading manifest...');
  const { component, tag, fullRepoTag, originalRepoTag } = await parseTarManifest(filePath);
  const loadedImageRef = originalRepoTag || `${component}:${tag}`;

  emit('loading', 5, 'Loading image into Docker...');
  const loadStream = await docker.loadImage(fs.createReadStream(filePath));

  await new Promise((resolve, reject) => {
    docker.modem.followProgress(loadStream, (err) => (err ? reject(err) : resolve()));
  });

  emit('loading', 20, 'Image loaded');

  const targets = registryKeys.map((key) => {
    const host = getRegistryHost(key);
    if (!host) throw new Error(`Unknown registry: ${key}`);
    return { key, target: `${host}/${component}:${tag}` };
  });

  let pushed = 0;
  const total = targets.length;
  const progressPerTarget = 75 / total;

  for (const { key, target } of targets) {
    const name = getRegistryName(key);
    emit('tagging', 20 + pushed * progressPerTarget, `Tagging for ${name}...`);
    const img = docker.getImage(loadedImageRef);
    await img.tag({ repo: target });

    const pct = 20 + (pushed + 0.5) * progressPerTarget;
    emit('pushing', pct, `Pushing to ${name}...`, { target });

    const pushStream = await docker.getImage(target).push({ authconfig: {} });
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(pushStream, (err) => (err ? reject(err) : resolve()));
    });

    pushed++;
    emit('pushing', 20 + pushed * progressPerTarget, `Pushed to ${name}`);
  }

  emit('cleanup', 95, 'Removing Docker images...');
  const toRemove = [...targets.map((t) => t.target), loadedImageRef];
  for (const ref of toRemove) {
    try {
      const img = docker.getImage(ref);
      await img.remove();
    } catch (err) {
      if (err.statusCode !== 404) console.warn(`Failed to remove image ${ref}:`, err.message);
    }
  }

  emit('done', 100, 'Complete', { component, tag });
  return { component, tag, fullRepoTag };
}
