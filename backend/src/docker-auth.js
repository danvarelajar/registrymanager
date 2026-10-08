import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

let configCache = { at: 0, path: '', config: null };

export function isOcirHost(hostname) {
  return String(hostname || '').toLowerCase().endsWith('.ocir.io');
}

/** Image registry host. OCIR on 443 is referenced without the port; other registries keep host:port. */
export function imageRegistryHost(registry) {
  const hostname = registry.hostname;
  const port = Number(registry.port);
  if (isOcirHost(hostname) && port === 443) return hostname;
  return `${hostname}:${port}`;
}

export function encodeRepositoryPath(repository) {
  return String(repository)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function ocirNamespaceFromUsername(username) {
  if (!username || !String(username).includes('/')) return null;
  const ns = String(username).split('/')[0].trim().toLowerCase();
  return ns || null;
}

function repositoryPrefix(registry) {
  return String(registry.repository || '').replace(/^\/+|\/+$/g, '');
}

/**
 * Where an image is pushed.
 * Regular registries use hostname:port/<component>:<tag>. An optional repository is a path prefix.
 * OCIR repository names are the image names. With no prefix the reference is
 * <tenancy-namespace>/<component>:<tag>, for example fortinetoraclecloud1/webui:V8.0.2-build0046.
 */
export function imageDestination(registry, component, tag, auth) {
  const prefix = repositoryPrefix(registry);
  const imageName = prefix ? `${prefix}/${component}` : component;
  if (!isOcirHost(registry.hostname)) {
    return { repository: imageName, tag };
  }
  const ns = ocirNamespaceFromUsername(auth?.username);
  if (!ns) {
    throw new Error(
      `OCIR requires docker login for ${registry.hostname} (looked at ${dockerConfigPath()}). ` +
        'Username must be <tenancy-namespace>/<user>, and the password is an auth token.'
    );
  }
  return { repository: `${ns}/${imageName}`.toLowerCase(), tag };
}

export function dockerConfigPath() {
  const dir = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker');
  return path.join(dir, 'config.json');
}

export function clearDockerAuthCache() {
  configCache = { at: 0, path: '', config: null };
}

function normalizeAuthKey(key) {
  return String(key)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/v1\/?$/i, '')
    .replace(/\/v2\/?$/i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function decodeAuthField(auth) {
  const pad = String(auth).replace(/-/g, '+').replace(/_/g, '/');
  const decoded = Buffer.from(pad, 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx <= 0) return null;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

function authLookupKeys(hostname, port) {
  const host = String(hostname).toLowerCase();
  const p = Number(port);
  const keys = [`${host}:${p}`];
  // docker login stores the default HTTPS port without ":443".
  // Only fall back to the bare host for 443 and OCIR so a custom port cannot pick up another registry's login.
  if (p === 443 || isOcirHost(host)) keys.push(host);
  return keys;
}

export function authFromConfig(config, hostname, port) {
  const auths = config?.auths || {};
  const byNorm = new Map();
  for (const [key, entry] of Object.entries(auths)) {
    if (!byNorm.has(normalizeAuthKey(key))) byNorm.set(normalizeAuthKey(key), entry);
  }

  for (const key of authLookupKeys(hostname, port)) {
    const entry = byNorm.get(key);
    if (!entry || typeof entry !== 'object') continue;
    if (entry.auth) {
      const decoded = decodeAuthField(entry.auth);
      if (decoded?.username) return { ...decoded, serveraddress: key };
    }
    const username = entry.username || entry.Username;
    const password = entry.password || entry.Secret || entry.secret;
    if (username && password) return { username, password, serveraddress: key };
    return { username: '', password: '', serveraddress: key, needsHelper: true };
  }
  return null;
}

async function helperGet(helperName, server) {
  const bin = `docker-credential-${helperName}`;
  const { stdout } = await execFileAsync(bin, ['get'], {
    input: server,
    timeout: 5000,
    encoding: 'utf8',
  });
  const data = JSON.parse(stdout || '{}');
  const username = data.Username || data.username;
  const password = data.Secret || data.secret;
  if (!username || !password) return null;
  return { username, password, serveraddress: server };
}

function readConfig() {
  const configPath = dockerConfigPath();
  const now = Date.now();
  if (configCache.path === configPath && now - configCache.at < 5000) return configCache.config;
  configCache = { at: now, path: configPath, config: null };
  try {
    configCache.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Could not read Docker config ${configPath}: ${err.message}`);
    }
    configCache.config = null;
  }
  return configCache.config;
}

/**
 * Credentials from the host docker login for this registry, or null when none are stored.
 * Anonymous registries keep working when this returns null.
 */
export async function resolveDockerAuth(hostname, port) {
  const config = readConfig();
  if (!config) return null;

  const found = authFromConfig(config, hostname, port);
  if (found?.username && found.password) return found;

  const host = String(hostname).toLowerCase();
  const helper =
    config.credHelpers?.[found?.serveraddress] ||
    config.credHelpers?.[host] ||
    config.credHelpers?.[`${host}:${port}`] ||
    (found?.needsHelper ? config.credsStore : null);
  if (!helper) return null;

  const servers = [
    found?.serveraddress,
    host,
    `${host}:${port}`,
    `https://${host}`,
    `https://${host}:${port}`,
  ].filter(Boolean);

  for (const server of servers) {
    try {
      const cred = await helperGet(helper, server);
      if (cred) return cred;
    } catch {
      /* helper missing or no entry for this server */
    }
  }
  return null;
}
