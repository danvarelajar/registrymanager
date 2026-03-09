import { createReadStream } from 'fs';
import tar from 'tar-stream';

/**
 * Parse manifest.json from a docker save tar file.
 * Returns { component, tag } - component is last path segment, tag from image.
 * Never hardcodes tags - always from image metadata.
 */
export async function parseTarManifest(filePath) {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let manifestData = null;

    extract.on('entry', (header, stream, next) => {
      if (header.name === 'manifest.json') {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          try {
            manifestData = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (e) {
            reject(new Error('Invalid manifest.json in tar'));
          }
          next();
        });
        stream.resume();
      } else {
        stream.on('end', next);
        stream.resume();
      }
    });

    extract.on('finish', () => {
      if (!manifestData || !Array.isArray(manifestData) || manifestData.length === 0) {
        reject(new Error('No manifest found in tar'));
        return;
      }
      const first = manifestData[0];
      const repoTags = first.RepoTags;
      if (!repoTags || repoTags.length === 0) {
        reject(new Error('No RepoTags in manifest'));
        return;
      }
      // Use first RepoTag
      const repoTag = repoTags[0];
      const colonIdx = repoTag.lastIndexOf(':');
      const tag = colonIdx >= 0 ? repoTag.slice(colonIdx + 1) : 'latest';
      const repoPart = colonIdx >= 0 ? repoTag.slice(0, colonIdx) : repoTag;
      const component = repoPart.split('/').pop() || repoPart;
      resolve({
        component,
        tag,
        fullRepoTag: `${component}:${tag}`,
        originalRepoTag: repoTag, // Full ref from manifest (for docker.getImage)
      });
    });

    extract.on('error', reject);

    const readStream = createReadStream(filePath);
    readStream.pipe(extract);
  });
}
