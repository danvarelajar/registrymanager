import dns from 'dns/promises';
import net from 'net';
import https from 'https';
import fs from 'fs';
import path from 'path';
import Docker from 'dockerode';
import { getAllRegistries } from './db.js';
import { resolveDockerAuth, dockerConfigPath, isOcirHost } from './docker-auth.js';
import { WATCH_FOLDER } from './config.js';
import { logger, hintFor } from './logger.js';

const docker = new Docker();
const TIMEOUT_MS = 8000;
const INSECURE_TLS = process.env.REGISTRY_INSECURE_TLS === '1' || process.env.REGISTRY_INSECURE_TLS === 'true';

function timed(fn) {
  const start = Date.now();
  return fn().then(
    (value) => ({ ok: true, ms: Date.now() - start, value }),
    (error) => ({ ok: false, ms: Date.now() - start, error })
  );
}

function tcpConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: TIMEOUT_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(Object.assign(new Error(`connect ETIMEDOUT ${host}:${port}`), { code: 'ETIMEDOUT' }));
    });
    socket.once('error', reject);
  });
}

function httpsV2(host, port) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, port, path: '/v2/', method: 'GET', timeout: TIMEOUT_MS, rejectUnauthorized: !INSECURE_TLS },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, authenticate: res.headers['www-authenticate'] || '' });
      }
    );
    req.once('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error(`HTTPS request to ${host}:${port} timed out`), { code: 'ETIMEDOUT' }));
    });
    req.once('error', reject);
    req.end();
  });
}

function stepFromError(name, r) {
  const message = r.error?.message || String(r.error);
  return { name, ok: false, ms: r.ms, detail: message, code: r.error?.code, hint: hintFor(message) };
}

async function checkRegistry(registry) {
  const host = registry.hostname;
  const port = Number(registry.port);
  const steps = [];

  const lookup = await timed(() => dns.lookup(host, { all: true }));
  if (!lookup.ok) {
    steps.push(stepFromError('DNS lookup', lookup));
  } else {
    steps.push({ name: 'DNS lookup', ok: true, ms: lookup.ms, detail: lookup.value.map((a) => a.address).join(', ') });

    const tcp = await timed(() => tcpConnect(host, port));
    if (!tcp.ok) {
      steps.push(stepFromError(`TCP connect :${port}`, tcp));
    } else {
      steps.push({ name: `TCP connect :${port}`, ok: true, ms: tcp.ms, detail: 'Port is open' });

      const v2 = await timed(() => httpsV2(host, port));
      if (!v2.ok) {
        steps.push(stepFromError('HTTPS /v2/', v2));
      } else {
        const { status } = v2.value;
        const ok = status === 200 || status === 401;
        steps.push({
          name: 'HTTPS /v2/',
          ok,
          ms: v2.ms,
          detail: `HTTP ${status}${status === 401 ? ' (registry is up and asks for login, as expected)' : ''}`,
          hint: ok ? undefined : 'The server answered but does not look like a Docker v2 registry.',
        });
      }
    }
  }

  const auth = await resolveDockerAuth(host, port).catch(() => null);
  steps.push({
    name: 'Docker login',
    ok: Boolean(auth?.username) || !isOcirHost(host),
    detail: auth?.username
      ? `Found login as ${auth.username}`
      : `No login in ${dockerConfigPath()}${isOcirHost(host) ? ' (OCIR requires one)' : ' (fine if the registry allows anonymous push)'}`,
  });

  return {
    id: registry.id,
    name: registry.name,
    host: `${host}:${port}`,
    ok: steps.every((s) => s.ok),
    steps,
  };
}

async function checkDocker() {
  const steps = [];
  const ping = await timed(() => docker.ping());
  if (!ping.ok) {
    steps.push({
      ...stepFromError('Docker daemon', ping),
      hint: 'The app cannot reach Docker through /var/run/docker.sock. Is Docker running and the socket mounted?',
    });
    return { ok: false, steps };
  }
  steps.push({ name: 'Docker daemon', ok: true, ms: ping.ms, detail: 'Reachable' });

  const info = await timed(() => docker.info());
  if (info.ok) {
    const i = info.value;
    const proxy = [i.HttpProxy && `http=${i.HttpProxy}`, i.HttpsProxy && `https=${i.HttpsProxy}`, i.NoProxy && `no=${i.NoProxy}`]
      .filter(Boolean)
      .join(' ');
    steps.push({
      name: 'Docker info',
      ok: true,
      detail: `${i.OperatingSystem || 'unknown OS'}, server ${i.ServerVersion}, ${i.NCPU} CPU, ${Math.round(
        (i.MemTotal || 0) / 1073741824
      )} GB RAM${proxy ? `, proxy ${proxy}` : ''}`,
    });
    const insecure = i.RegistryConfig?.IndexConfigs
      ? Object.values(i.RegistryConfig.IndexConfigs)
          .filter((c) => c && c.Secure === false)
          .map((c) => c.Name)
      : [];
    if (insecure.length) steps.push({ name: 'Insecure registries', ok: true, detail: insecure.join(', ') });
  }

  const df = await timed(() => docker.df());
  if (df.ok) {
    const imagesBytes = (df.value.Images || []).reduce((n, img) => n + (img.Size || 0), 0);
    steps.push({
      name: 'Docker image storage',
      ok: true,
      detail: `${(df.value.Images || []).length} images, ${(imagesBytes / 1073741824).toFixed(1)} GB`,
    });
  }

  return { ok: steps.every((s) => s.ok), steps };
}

function checkEnvironment() {
  const steps = [];
  const watch = path.resolve(WATCH_FOLDER);
  steps.push({
    name: 'Image folder',
    ok: fs.existsSync(watch),
    detail: fs.existsSync(watch) ? watch : `${watch} does not exist`,
  });
  const cfg = dockerConfigPath();
  steps.push({
    name: 'Docker config',
    ok: fs.existsSync(cfg),
    detail: fs.existsSync(cfg) ? cfg : `${cfg} not found (no docker logins available)`,
  });
  steps.push({ name: 'TLS verification', ok: true, detail: INSECURE_TLS ? 'Disabled (REGISTRY_INSECURE_TLS=1)' : 'Enabled' });
  return { ok: steps.every((s) => s.ok), steps };
}

export async function runDiagnostics() {
  const startedAt = new Date().toISOString();
  logger.info('diagnostics', 'Running diagnostics');
  const [dockerResult, registries] = await Promise.all([
    checkDocker(),
    Promise.all(getAllRegistries().map(checkRegistry)),
  ]);
  const result = { startedAt, environment: checkEnvironment(), docker: dockerResult, registries };

  for (const s of [...result.environment.steps, ...dockerResult.steps]) {
    if (!s.ok) logger.warn('diagnostics', `${s.name}: ${s.detail}`, { hint: s.hint });
  }
  for (const r of registries) {
    const failed = r.steps.find((s) => !s.ok);
    if (failed) {
      logger.warn('diagnostics', `${r.name} (${r.host}) failed at ${failed.name}: ${failed.detail}`, {
        registry: r.name,
        hint: failed.hint,
        steps: r.steps,
      });
    } else {
      logger.info('diagnostics', `${r.name} (${r.host}) is reachable`, { registry: r.name, steps: r.steps });
    }
  }
  return result;
}
