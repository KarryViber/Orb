import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function mediaTypeForImageName(name) {
  const ext = name.split('.').pop().toLowerCase();
  const mimeMap = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return mimeMap[ext] || 'image/png';
}

export function buildImageBlocks(imagePaths, workspace) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) return [];
  const imgDir = join(workspace, '.images');
  mkdirSync(imgDir, { recursive: true });
  const blocks = [];
  for (const imgPath of imagePaths) {
    const name = imgPath.split('/').pop();
    const dest = join(imgDir, name);
    copyFileSync(imgPath, dest);
    const mediaType = mediaTypeForImageName(name);
    const b64 = readFileSync(dest, 'base64');
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } });
    console.log(`[worker] attached image: ${name} (${mediaType}, ${Math.round(b64.length / 1024)}KB b64)`);
  }
  return blocks;
}
