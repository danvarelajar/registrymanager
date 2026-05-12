import https from 'https';
import { getRegistryById } from './db.js';

const REGISTRY_HEADERS = {
  'Docker-Distribution-Api-Version': 'registry/2.0',
  Accept: 'application/json',
  'User-Agent': 'FS-Repo-Manager/1.0',
};

const INSECURE_TLS = process.env.REGISTRY_INSECURE_TLS === '1' || process.env.REGISTRY_INSECURE_TLS === 'true';
const httpsOpts = { rejectUnauthorized: !INSECURE_TLS };

function registryBase(registryKey) {
  const r = getRegistryById(registryKey);
  if (!r) return null;
  return r.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function registryFetch(url, options = {}) {
  const u = new URL(url);
  const opts = {
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + u.search,
    method: options.method || 'GET',
    headers: { ...REGISTRY_HEADERS, ...options.headers },
    ...httpsOpts,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
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

export async function getCatalog(registryKey) {
  const base = registryBase(registryKey);
  if (!base) throw new Error('Unknown registry');
  const res = await registryFetch(`https://${base}/v2/_catalog?n=1000`);
  if (!res.ok) {
    const body = await res.text();
    const msg = body ? `${res.status}: ${body}` : `Registry catalog failed: ${res.status}`;
    throw new Error(msg);
  }
  const data = await res.json();
  return data.repositories || [];
}

export async function getTags(registryKey, repository) {
  const base = registryBase(registryKey);
  if (!base) throw new Error('Unknown registry');
  const encoded = encodeURIComponent(repository);
  const res = await registryFetch(`https://${base}/v2/${encoded}/tags/list?n=1000`);
  if (!res.ok) throw new Error(`Tags list failed: ${res.status}`);
  const data = await res.json();
  return data.tags || [];
}

export async function getManifestDigest(registryKey, repository, tag) {
  const base = registryBase(registryKey);
  if (!base) throw new Error('Unknown registry');
  const encoded = encodeURIComponent(repository);
  const res = await registryFetch(`https://${base}/v2/${encoded}/manifests/${tag}`, {
    headers: {
      Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
    },
  });
  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
  const digest = res.headers.get('Docker-Content-Digest');
  return digest;
}

export async function deleteManifest(registryKey, repository, digest) {
  const base = registryBase(registryKey);
  if (!base) throw new Error('Unknown registry');
  const encodedRepo = encodeURIComponent(repository);
  const url = `https://${base}/v2/${encodedRepo}/manifests/${digest}`;
  const res = await registryFetch(url, {
    method: 'DELETE',
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
