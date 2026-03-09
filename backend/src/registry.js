import { getRegistryById } from './db.js';

const REGISTRY_HEADERS = {
  'Docker-Distribution-Api-Version': 'registry/2.0',
  Accept: 'application/json',
  'User-Agent': 'FS-Repo-Manager/1.0',
};

function registryBase(registryKey) {
  const r = getRegistryById(registryKey);
  if (!r) return null;
  return r.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export async function getCatalog(registryKey) {
  const base = registryBase(registryKey);
  if (!base) throw new Error('Unknown registry');
  const res = await fetch(`https://${base}/v2/_catalog?n=1000`, {
    headers: REGISTRY_HEADERS,
  });
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
  const res = await fetch(`https://${base}/v2/${encoded}/tags/list?n=1000`, {
    headers: REGISTRY_HEADERS,
  });
  if (!res.ok) throw new Error(`Tags list failed: ${res.status}`);
  const data = await res.json();
  return data.tags || [];
}

export async function getManifestDigest(registryKey, repository, tag) {
  const base = registryBase(registryKey);
  if (!base) throw new Error('Unknown registry');
  const encoded = encodeURIComponent(repository);
  const res = await fetch(`https://${base}/v2/${encoded}/manifests/${tag}`, {
    headers: {
      ...REGISTRY_HEADERS,
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
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...REGISTRY_HEADERS,
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
