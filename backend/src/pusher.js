import Docker from 'dockerode';
import fs from 'fs';
import { getRegistryById } from './db.js';
import { parseTarManifest } from './tar-parser.js';
import { imageRegistryHost, imageDestination, resolveDockerAuth } from './docker-auth.js';

const docker = new Docker();

function explainRegistryError(message) {
  if (/\.ocir\.io\//.test(message) && /\b403\b/.test(message)) {
    return `${message} OCIR accepted the login, then denied the upload. This user needs permission to manage repos in the compartment that contains the repository.`;
  }
  return message;
}

function waitForProgress(stream) {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err, output) => {
      if (err) return reject(err);
      const failed = Array.isArray(output) ? output.find((event) => event && event.error) : null;
      if (failed) return reject(new Error(explainRegistryError(failed.error)));
      resolve(output);
    });
  });
}

function authconfigFor(auth, host) {
  if (!auth?.username || !auth.password) return {};
  return {
    username: auth.username,
    password: auth.password,
    serveraddress: host,
  };
}

async function removeImage(ref) {
  try {
    await docker.getImage(ref).remove();
  } catch (err) {
    if (err.statusCode !== 404) console.warn(`Failed to remove image ${ref}:`, err.message);
  }
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

  const targets = [];
  for (const key of registryKeys) {
    const registry = getRegistryById(key);
    if (!registry) throw new Error(`Unknown registry: ${key}`);
    const host = imageRegistryHost(registry);
    const auth = await resolveDockerAuth(registry.hostname, registry.port);
    const dest = imageDestination(registry, component, tag, auth);
    const remoteRepo = `${host}/${dest.repository}`;
    targets.push({
      name: registry.name,
      target: `${remoteRepo}:${dest.tag}`,
      remoteRepo,
      tag: dest.tag,
      authconfig: authconfigFor(auth, host),
    });
  }

  emit('loading', 5, 'Loading image into Docker...');
  const loadStream = await docker.loadImage(fs.createReadStream(filePath));
  await waitForProgress(loadStream);
  emit('loading', 20, 'Image loaded');

  const total = targets.length;
  const progressPerTarget = 75 / total;
  let pushed = 0;
  const pushedRefs = [];

  try {
    for (const target of targets) {
      emit('tagging', 20 + pushed * progressPerTarget, `Tagging for ${target.name}...`);
      const img = docker.getImage(loadedImageRef);
      await img.tag({ repo: target.remoteRepo, tag: target.tag });
      pushedRefs.push(target.target);

      const pct = 20 + (pushed + 0.5) * progressPerTarget;
      emit('pushing', pct, `Pushing to ${target.name}...`, { target: target.target });

      const pushStream = await docker.getImage(target.target).push({ authconfig: target.authconfig });
      await waitForProgress(pushStream);

      pushed++;
      emit('pushing', 20 + pushed * progressPerTarget, `Pushed to ${target.name}`);
    }
  } finally {
    emit('cleanup', 95, 'Removing Docker images...');
    const toRemove = new Set([...pushedRefs, loadedImageRef]);
    for (const ref of toRemove) {
      await removeImage(ref);
    }
  }

  emit('done', 100, 'Complete', { component, tag });
  return { component, tag, fullRepoTag };
}
