import http from 'http';
import https from 'https';
import { getRegistryById } from './db.js';
import {
  encodeRepositoryPath,
  isOcirHost,
  resolveDockerAuth,
} from './docker-auth.js';

const REGISTRY_HEADERS = {
  'Docker-Distribution-Api-Version': 'registry/2.0',
  Accept: 'application/json',
  'User-Agent': 'FS-Repo-Manager/1.0',
};

const INSECURE_TLS = process.env.REGISTRY_INSECURE_TLS === '1' || process.env.REGISTRY_INSECURE_TLS === 'true';

// Keep connections open and cap how many are opened per host. Docker Desktop delays bursts of new
// outbound connections by 1-2s each, so opening a fresh TLS connection per request caused timeouts.
const MAX_SOCKETS_PER_HOST = Number(process.env.REGISTRY_MAX_SOCKETS) || 4;
const agentOpts = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: MAX_SOCKETS_PER_HOST, maxFreeSockets: MAX_SOCKETS_PER_HOST };
const httpsAgent = new https.Agent({ ...agentOpts, rejectUnauthorized: !INSECURE_TLS });
const httpAgent = new http.Agent(agentOpts);

const tokenCache = new Map();
// Last auth challenge seen per registry, so later requests can send credentials up front
// instead of first collecting a 401.
const challengeCache = new Map();

function registryBase(registryKey) {
  const r = getRegistryById(registryKey);
  if (!r) return null;
  return r.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function headerValue(headers, name) {
  const value = headers.get(name);
  if (Array.isArray(value)) return value.join(', ');
  return value || '';
}

export function parseWwwAuthenticate(header) {
  const raw = Array.isArray(header) ? header.join(', ') : String(header || '');
  if (!raw) return null;
  const scheme = raw.split(/\s+/)[0]?.toLowerCase();
  if (scheme !== 'bearer' && scheme !== 'basic') return null;
  const params = {};
  const re = /([a-zA-Z][a-zA-Z0-9_-]*)=("([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = re.exec(raw))) {
    params[match[1].toLowerCase()] = match[3] != null ? match[3] : match[4];
  }
  return { scheme, ...params };
}

const REQUEST_TIMEOUT_MS = Number(process.env.REGISTRY_REQUEST_TIMEOUT_MS) || 15000;
const RETRYABLE = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN']);

function rawFetchOnce(url, options = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  const opts = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    method: options.method || 'GET',
    headers: { ...REGISTRY_HEADERS, ...options.headers },
    agent: lib === https ? httpsAgent : httpAgent,
  };
  const timeoutMs = options.timeout ?? REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let connected = false;
    let timer;
    const req = lib.request(opts, (res) => {
      clearTimeout(timer);
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const h = res.headers;
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (k) => h[k.toLowerCase()] || h[k] },
          text: async () => body,
          json: async () => JSON.parse(body || '{}'),
        });
      });
    });
    req.on('socket', (socket) => {
      // A reused keep-alive socket is already connected.
      if (!socket.connecting) connected = true;
      else socket.once(lib === https ? 'secureConnect' : 'connect', () => (connected = true));
    });
    // One deadline for the whole request, including time spent waiting for a free socket.
    timer = setTimeout(() => {
      const what = connected
        ? `${opts.method} ${u.pathname} on ${opts.hostname}:${opts.port}: no response within ${timeoutMs / 1000}s`
        : `connect ETIMEDOUT ${opts.hostname}:${opts.port} (no connection within ${timeoutMs / 1000}s)`;
      req.destroy(Object.assign(new Error(what), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/** Read-only requests are retried once on network errors; DELETE is not. */
async function rawFetch(url, options = {}) {
  const method = options.method || 'GET';
  try {
    return await rawFetchOnce(url, options);
  } catch (err) {
    if (method !== 'GET' && method !== 'HEAD') throw err;
    if (!RETRYABLE.has(err.code)) throw err;
    await new Promise((r) => setTimeout(r, 500));
    return rawFetchOnce(url, options);
  }
}

async function requestToken(challenge, auth, scope) {
  const cacheKey = `${auth.username}\n${challenge.realm}\n${challenge.service || ''}\n${scope || ''}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.token;

  const realm = new URL(challenge.realm);
  if (challenge.service) realm.searchParams.set('service', challenge.service);
  if (scope) realm.searchParams.set('scope', scope);

  const basic = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  const res = await rawFetch(realm.toString(), {
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    const error = new Error(`Registry token request failed: ${res.status}${body ? ` - ${body}` : ''}`);
    error.statusCode = res.status;
    throw error;
  }
  const data = await res.json();
  const token = data.token || data.access_token;
  if (!token) throw new Error('Registry token response did not include a token');

  const expiresIn = Number(data.expires_in) || 60;
  if (tokenCache.size > 200) tokenCache.clear();
  tokenCache.set(cacheKey, { token, exp: Date.now() + Math.max(15, expiresIn - 15) * 1000 });
  return token;
}

async function getBearerToken(challenge, auth, scope) {
  const fromChallenge = challenge.scope || '';
  try {
    return await requestToken(challenge, auth, fromChallenge || scope || '');
  } catch (err) {
    // OCIR rejects some scopes the caller would add, such as registry:catalog:*.
    // A token without that scope still authenticates the retry.
    if (!fromChallenge && scope && err.statusCode >= 400 && err.statusCode < 500) {
      return requestToken(challenge, auth, '');
    }
    throw err;
  }
}

async function authHeader(challenge, auth, scope) {
  if (challenge?.scheme === 'bearer' && challenge.realm) {
    // The cached challenge carries another request's scope; use this request's own.
    const token = await getBearerToken({ ...challenge, scope: undefined }, auth, scope);
    return `Bearer ${token}`;
  }
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
}

async function authorizedFetch(registryKey, urlPath, options = {}) {
  const base = registryBase(registryKey);
  if (!base) throw new Error('Unknown registry');
  const url = `https://${base}${urlPath}`;
  const registry = getRegistryById(registryKey);
  const auth = registry ? await resolveDockerAuth(registry.hostname, registry.port) : null;
  const hasAuth = Boolean(auth?.username && auth.password);

  // Known challenge: send credentials straight away and skip the 401 round trip.
  const cached = challengeCache.get(base);
  if (cached && hasAuth) {
    const headers = { ...(options.headers || {}), Authorization: await authHeader(cached, auth, options.scope) };
    const res = await rawFetch(url, { ...options, headers });
    if (res.status !== 401) return res;
    challengeCache.delete(base);
  }

  const first = await rawFetch(url, options);
  if (first.status !== 401 || !hasAuth) return first;

  const challenge = parseWwwAuthenticate(headerValue(first.headers, 'www-authenticate'));
  if (challenge) challengeCache.set(base, challenge);
  const headers = {
    ...(options.headers || {}),
    Authorization: challenge?.scheme === 'bearer' && challenge.realm
      ? `Bearer ${await getBearerToken(challenge, auth, options.scope)}`
      : await authHeader(challenge, auth, options.scope),
  };
  return rawFetch(url, { ...options, headers });
}

async function failureMessage(res) {
  const body = await res.text();
  return body ? `${res.status}: ${body}` : String(res.status);
}

export async function getCatalog(registryKey) {
  const res = await authorizedFetch(registryKey, '/v2/_catalog?n=1000', {
    scope: 'registry:catalog:*',
  });
  if (!res.ok) {
    const registry = getRegistryById(registryKey);
    if (registry && isOcirHost(registry.hostname) && (res.status === 403 || res.status === 404 || res.status === 405)) {
      throw new Error('OCIR does not support listing every repository. Push and the folder presence check still work.');
    }
    const detail = await failureMessage(res);
    throw new Error(res.status === 401 ? `Registry authentication failed: ${detail}` : detail);
  }
  const data = await res.json();
  return data.repositories || [];
}

export async function getTags(registryKey, repository) {
  const encoded = encodeRepositoryPath(repository);
  const res = await authorizedFetch(registryKey, `/v2/${encoded}/tags/list?n=1000`, {
    scope: `repository:${repository}:pull`,
  });
  if (!res.ok) throw new Error(`Tags list failed: ${res.status}`);
  const data = await res.json();
  return data.tags || [];
}

export async function getManifestDigest(registryKey, repository, tag) {
  const encoded = encodeRepositoryPath(repository);
  const res = await authorizedFetch(registryKey, `/v2/${encoded}/manifests/${encodeURIComponent(tag)}`, {
    scope: `repository:${repository}:pull`,
    headers: {
      Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
    },
  });
  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
  return res.headers.get('docker-content-digest');
}

export async function deleteManifest(registryKey, repository, digest) {
  const encoded = encodeRepositoryPath(repository);
  const res = await authorizedFetch(registryKey, `/v2/${encoded}/manifests/${digest}`, {
    method: 'DELETE',
    scope: `repository:${repository}:*`,
    headers: {
      Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
    },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    if (res.status === 405) {
      throw new Error('Registry does not support manifest deletion (405 Method Not Allowed). Deletion may be disabled on this registry.');
    }
    throw new Error(`Delete failed: ${res.status}${body ? ` - ${body}` : ''}`);
  }
  return true;
}
