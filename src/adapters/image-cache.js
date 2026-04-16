import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSafeUrl } from '../format-utils.js';
import { info, warn } from '../log.js';

const TAG = 'image-cache';

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

const IMAGE_MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

// Magic byte signatures for image validation
const MAGIC_BYTES = [
  { ext: 'png',  bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { ext: 'jpg',  bytes: [0xFF, 0xD8, 0xFF] },
  { ext: 'gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'bmp',  bytes: [0x42, 0x4D] },
  // WEBP: RIFF at 0-3 + WEBP at 8-11
];

function validateMagicBytes(buffer) {
  const view = new Uint8Array(buffer);

  // Check WEBP specially (needs two ranges)
  if (view.length >= 12 &&
      view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46 &&
      view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) {
    return 'webp';
  }

  for (const { ext, bytes } of MAGIC_BYTES) {
    if (view.length < bytes.length) continue;
    if (bytes.every((b, i) => view[i] === b)) return ext;
  }

  return null;
}

function resolveExt(mimetype, filename) {
  if (mimetype && IMAGE_MIME_TO_EXT[mimetype]) return IMAGE_MIME_TO_EXT[mimetype];
  const ext = (filename || '').split('.').pop()?.toLowerCase();
  if (ext && IMAGE_EXTENSIONS.has(ext)) return ext;
  return 'jpg'; // fallback
}

const RETRY_DELAYS = [500, 1500, 4500];

export async function downloadAndCacheImage(url, botToken, cacheDir) {
  if (!isSafeUrl(url)) throw new Error('URL failed safety check');

  await mkdir(cacheDir, { recursive: true });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let resp = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        redirect: 'manual',
      });

      // Follow one redirect with safety check
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc || !isSafeUrl(loc)) throw new Error('redirect target failed safety check');
        resp = await fetch(loc);
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      // Size check from Content-Length header
      const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_IMAGE_SIZE) {
        throw new Error(`image too large: ${contentLength} bytes (max ${MAX_IMAGE_SIZE})`);
      }

      const buffer = await resp.arrayBuffer();

      // Post-download size check
      if (buffer.byteLength > MAX_IMAGE_SIZE) {
        throw new Error(`image too large: ${buffer.byteLength} bytes (max ${MAX_IMAGE_SIZE})`);
      }

      // Validate magic bytes (prevents HTML cache poisoning)
      const detectedType = validateMagicBytes(buffer);
      if (!detectedType) {
        throw new Error('invalid image magic bytes — possibly HTML or corrupted file');
      }

      const filename = `img_${randomUUID().slice(0, 12)}.${detectedType}`;
      const filePath = join(cacheDir, filename);
      await writeFile(filePath, Buffer.from(buffer));

      info(TAG, `cached: ${filePath} (${buffer.byteLength} bytes, ${detectedType})`);
      return filePath;

    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS.length) {
        warn(TAG, `download attempt ${attempt + 1} failed: ${err.message}, retrying...`);
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }

  throw lastErr;
}

export async function cleanImageCache(cacheDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const files = await readdir(cacheDir);
    const now = Date.now();
    let cleaned = 0;

    for (const file of files) {
      if (!file.startsWith('img_')) continue;
      try {
        const filePath = join(cacheDir, file);
        const s = await stat(filePath);
        if (now - s.mtimeMs > maxAgeMs) {
          await unlink(filePath);
          cleaned++;
        }
      } catch (_) {}
    }

    if (cleaned > 0) info(TAG, `cleaned ${cleaned} expired image(s)`);
  } catch (_) {
    // Cache dir may not exist yet — fine
  }
}
