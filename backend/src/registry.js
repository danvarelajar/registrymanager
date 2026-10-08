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
const httpsOpts = { rejectUnauthorized: !INSECURE_TLS };

const tokenCache = new Map();

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

function rawFetch(url, options = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  const opts = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    method: options.method || 'GET',
    headers: { ...REGISTRY_HEADERS, ...options.headers },
    ...(lib === https ? httpsOpts : {}),
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
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
    req.on('error', reject);
    req.end();
  });
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

async function authorizedFetch(registryKey, urlPath, options = {}) {
  const base = registryBase(registryKey);
  if (!base) throw new Error('Unknown registry');
  const url = `https://${base}${urlPath}`;
  const first = await rawFetch(url, options);
  if (first.status !== 401) return first;

  const registry = getRegistryById(registryKey);
  if (!registry) return first;
  const auth = await resolveDockerAuth(registry.hostname, registry.port);
  if (!auth?.username || !auth.password) return first;

  const challenge = parseWwwAuthenticate(headerValue(first.headers, 'www-authenticate'));
  const headers = { ...(options.headers || {}) };
  if (challenge?.scheme === 'bearer' && challenge.realm) {
    const token = await getBearerToken(challenge, auth, options.scope);
    headers.Authorization = `Bearer ${token}`;
  } else {
    headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  }
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
