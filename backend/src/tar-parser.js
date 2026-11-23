import fs from 'fs/promises';

/**
 * Parse manifest.json from a docker save tar file.
 * Returns { component, tag } - component is last path segment, tag from image.
 * Never hardcodes tags - always from image metadata.
 *
 * docker save puts manifest.json after the image layers, near the end of the archive.
 * Instead of streaming the whole (often multi-GB) file, this reads only the 512-byte
 * tar headers and seeks past each entry's data, so a scan touches a few KB per file.
 */

const BLOCK = 512;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function cString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString('utf8');
}

/** Tar numeric field: octal text, or base-256 binary (high bit set) for values over 8 GB. */
function tarNumber(buf, start, len) {
  if (buf[start] & 0x80) {
    let value = buf[start] & 0x7f;
    for (let i = start + 1; i < start + len; i++) value = value * 256 + buf[i];
    return value;
  }
  const text = cString(buf, start, len).trim();
  return text ? parseInt(text, 8) : 0;
}

/** PAX extended header records: "<len> key=value\n". */
function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const space = buf.indexOf(0x20, i);
    if (space === -1) break;
    const len = parseInt(buf.subarray(i, space).toString('utf8'), 10);
    if (!len) break;
    const record = buf.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

async function readAt(fh, length, position) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

async function readManifestJson(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    let offset = 0;
    let pax = null;
    let longName = null;

    while (offset + BLOCK <= fileSize) {
      const header = await readAt(fh, BLOCK, offset);
      if (header.length < BLOCK) break;
      if (header.every((b) => b === 0)) break; // end-of-archive marker

      const type = String.fromCharCode(header[156] || 0x30);
      let size = tarNumber(header, 124, 12);
      const dataStart = offset + BLOCK;

      if (type === 'x' || type === 'g' || type === 'L') {
        if (size > MAX_MANIFEST_BYTES) throw new Error('Tar header record too large');
        const data = await readAt(fh, size, dataStart);
        if (type === 'x') pax = parsePax(data);
        if (type === 'L') longName = cString(data, 0, data.length);
        offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
        continue;
      }

      let name = cString(header, 0, 100);
      const magic = cString(header, 257, 6);
      if (magic.startsWith('ustar')) {
        const prefix = cString(header, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      if (longName) name = longName;
      if (pax?.path) name = pax.path;
      if (pax?.size) size = Number(pax.size);
      pax = null;
      longName = null;

      if (name.replace(/^\.\//, '') === 'manifest.json') {
        if (size > MAX_MANIFEST_BYTES) throw new Error('manifest.json is unexpectedly large');
        return readAt(fh, size, dataStart);
      }
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    }
    return null;
  } finally {
    await fh.close();
  }
}

export async function parseTarManifest(filePath) {
  const raw = await readManifestJson(filePath);
  if (!raw) throw new Error('No manifest found in tar');

  let manifestData;
  try {
    manifestData = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Invalid manifest.json in tar');
  }
  if (!Array.isArray(manifestData) || manifestData.length === 0) {
    throw new Error('No manifest found in tar');
  }

  const first = manifestData[0];
  const repoTags = first.RepoTags;
  if (!repoTags || repoTags.length === 0) {
    throw new Error('No RepoTags in manifest');
  }
  // Use first RepoTag
  const repoTag = repoTags[0];
  const colonIdx = repoTag.lastIndexOf(':');
  const tag = colonIdx >= 0 ? repoTag.slice(colonIdx + 1) : 'latest';
  const repoPart = colonIdx >= 0 ? repoTag.slice(0, colonIdx) : repoTag;
  const component = repoPart.split('/').pop() || repoPart;
  return {
    component,
    tag,
    fullRepoTag: `${component}:${tag}`,
    originalRepoTag: repoTag, // Full ref from manifest (for docker.getImage)
  };
}
