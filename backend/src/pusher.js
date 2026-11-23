import Docker from 'dockerode';
import fs from 'fs';
import { getRegistryById } from './db.js';
import { parseTarManifest } from './tar-parser.js';
import path from 'path';
import { imageRegistryHost, imageDestination, resolveDockerAuth, dockerConfigPath } from './docker-auth.js';
import { logger } from './logger.js';

const docker = new Docker();

export function cancelledError() {
  const err = new Error('Push cancelled');
  err.code = 'PUSH_CANCELLED';
  return err;
}

export function isCancelledError(err) {
  return err?.code === 'PUSH_CANCELLED' || /push cancelled/i.test(err?.message || '');
}

function explainRegistryError(message) {
  if (/\.ocir\.io\//.test(message) && /\b403\b/.test(message)) {
    return `${message} OCIR accepted the login, then denied the upload. This user needs permission to manage repos in the compartment that contains the repository.`;
  }
  return message;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

function waitForProgress(stream, signal, onEvent) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(arg);
    };
    const onAbort = () => {
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      finish(reject, cancelledError());
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    docker.modem.followProgress(
      stream,
      (err, output) => {
        if (signal?.aborted) return finish(reject, cancelledError());
        if (err) return finish(reject, err);
        const failed = Array.isArray(output) ? output.find((event) => event && event.error) : null;
        if (failed) return finish(reject, new Error(explainRegistryError(failed.error)));
        finish(resolve, output);
      },
      (event) => {
        try {
          onEvent?.(event);
        } catch {
          /* logging must never break a push */
        }
      }
    );
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

async function removeImage(ref, ctx) {
  try {
    await docker.getImage(ref).remove();
    logger.debug('docker', `Removed local image ${ref}`, ctx);
  } catch (err) {
    if (err.statusCode !== 404) logger.warn('docker', `Failed to remove local image ${ref}`, { ...ctx, error: err });
  }
}

// Docker push/load stream events worth keeping. Per-chunk progress lines are skipped.
const NOISY_STATUS = /^(Pushing|Preparing|Waiting|Loading layer)$/;

function streamEventLogger(ctx, step) {
  const seen = new Set();
  return (event) => {
    if (!event) return;
    if (event.error) {
      logger.error('docker', `Docker ${step} error: ${event.error}`, { ...ctx, layer: event.id });
      return;
    }
    const status = String(event.status || event.stream || '').trim();
    if (!status || NOISY_STATUS.test(status)) return;
    const key = `${event.id || ''}|${status}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (/^Retrying in/i.test(status)) {
      logger.warn('docker', `Layer ${event.id || '?'}: ${status}`, { ...ctx, step });
    } else if (/digest: sha256/i.test(status)) {
      logger.info('docker', status, { ...ctx, step });
    } else {
      logger.debug('docker', event.id ? `Layer ${event.id}: ${status}` : status, { ...ctx, step });
    }
  };
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Push a single tar file to selected registries.
 * registryKeys: array of registry IDs
 * signal: optional AbortSignal to cancel mid-push
 */
export async function pushTar(filePath, registryKeys, onProgress, signal) {
  const startTime = Date.now();

  const emit = (stage, progress, message, extra = {}) => {
    onProgress?.({ stage, progress, message, elapsed: Date.now() - startTime, ...extra });
  };

  const file = path.basename(filePath);
  let sizeBytes;
  try {
    sizeBytes = fs.statSync(filePath).size;
  } catch {
    /* reported by the load step */
  }
  const baseCtx = { file, filePath, sizeMB: sizeBytes != null ? Math.round(sizeBytes / 1048576) : undefined };

  throwIfAborted(signal);
  emit('parsing', 0, 'Reading manifest...');
  let manifest;
  try {
    manifest = await parseTarManifest(filePath);
  } catch (err) {
    logger.error('push', `Could not read image manifest from ${file}`, { ...baseCtx, step: 'parse', error: err });
    throw err;
  }
  const { component, tag, fullRepoTag, originalRepoTag } = manifest;
  const loadedImageRef = originalRepoTag || `${component}:${tag}`;
  const ctx = { ...baseCtx, image: `${component}:${tag}` };
  logger.info('push', `Starting push of ${component}:${tag}`, { ...ctx, sourceRef: loadedImageRef, registries: registryKeys });

  const targets = [];
  for (const key of registryKeys) {
    throwIfAborted(signal);
    const registry = getRegistryById(key);
    if (!registry) throw new Error(`Unknown registry: ${key}`);
    const host = imageRegistryHost(registry);
    const auth = await resolveDockerAuth(registry.hostname, registry.port);
    let dest;
    try {
      dest = imageDestination(registry, component, tag, auth);
    } catch (err) {
      logger.error('push', `Cannot work out destination on ${registry.name}`, {
        ...ctx,
        registry: registry.name,
        host,
        dockerConfig: dockerConfigPath(),
        error: err,
      });
      throw err;
    }
    logger.debug('auth', auth?.username
      ? `Using docker login for ${host} as ${auth.username}`
      : `No docker login found for ${host}; pushing anonymously`, {
      ...ctx,
      registry: registry.name,
      host,
      dockerConfig: dockerConfigPath(),
    });
    const remoteRepo = `${host}/${dest.repository}`;
    targets.push({
      name: registry.name,
      target: `${remoteRepo}:${dest.tag}`,
      remoteRepo,
      tag: dest.tag,
      authconfig: authconfigFor(auth, host),
    });
  }

  throwIfAborted(signal);
  emit('loading', 5, 'Loading image into Docker...');
  const loadStart = Date.now();
  logger.info('push', `Loading ${file} into Docker`, { ...ctx, step: 'load' });
  const fileStream = fs.createReadStream(filePath);
  const abortFile = () => {
    try {
      fileStream.destroy();
    } catch {
      /* ignore */
    }
  };
  signal?.addEventListener('abort', abortFile, { once: true });
  try {
    const loadStream = await docker.loadImage(fileStream);
    await waitForProgress(loadStream, signal, streamEventLogger(ctx, 'load'));
  } catch (err) {
    if (!isCancelledError(err)) logger.error('push', `Loading ${file} into Docker failed`, { ...ctx, step: 'load', error: err });
    throw err;
  } finally {
    signal?.removeEventListener('abort', abortFile);
  }
  logger.info('push', `Loaded ${loadedImageRef} in ${seconds(Date.now() - loadStart)}`, { ...ctx, step: 'load' });
  emit('loading', 20, 'Image loaded');

  const total = targets.length;
  const progressPerTarget = 75 / total;
  let pushed = 0;
  const pushedRefs = [];

  try {
    for (const target of targets) {
      throwIfAborted(signal);
      const tctx = { ...ctx, registry: target.name, target: target.target };
      emit('tagging', 20 + pushed * progressPerTarget, `Tagging for ${target.name}...`);
      try {
        const img = docker.getImage(loadedImageRef);
        await img.tag({ repo: target.remoteRepo, tag: target.tag });
      } catch (err) {
        logger.error('push', `Tagging ${loadedImageRef} as ${target.target} failed`, { ...tctx, step: 'tag', error: err });
        throw err;
      }
      pushedRefs.push(target.target);

      throwIfAborted(signal);
      const pct = 20 + (pushed + 0.5) * progressPerTarget;
      emit('pushing', pct, `Pushing to ${target.name}...`, { target: target.target });

      const pushStart = Date.now();
      logger.info('push', `Pushing ${target.target}`, { ...tctx, step: 'push' });
      try {
        const pushStream = await docker.getImage(target.target).push({ authconfig: target.authconfig });
        await waitForProgress(pushStream, signal, streamEventLogger(tctx, 'push'));
      } catch (err) {
        if (isCancelledError(err)) {
          logger.warn('push', `Push of ${target.target} cancelled after ${seconds(Date.now() - pushStart)}`, { ...tctx, step: 'push' });
        } else {
          logger.error('push', `Push of ${target.target} failed after ${seconds(Date.now() - pushStart)}`, {
            ...tctx,
            step: 'push',
            error: err,
          });
        }
        throw err;
      }
      logger.info('push', `Pushed ${target.target} in ${seconds(Date.now() - pushStart)}`, { ...tctx, step: 'push' });

      pushed++;
      emit('pushing', 20 + pushed * progressPerTarget, `Pushed to ${target.name}`);
    }
  } finally {
    emit('cleanup', 95, 'Removing Docker images...');
    const toRemove = new Set([...pushedRefs, loadedImageRef]);
    for (const ref of toRemove) {
      await removeImage(ref, ctx);
    }
  }

  throwIfAborted(signal);
  logger.info('push', `Finished ${component}:${tag} in ${seconds(Date.now() - startTime)}`, ctx);
  emit('done', 100, 'Complete', { component, tag });
  return { component, tag, fullRepoTag };
}
