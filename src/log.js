import { createWriteStream, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const LOG_PATH = join(DATA_DIR, 'orb.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50MB

function attachWriteStreamErrorHandler(stream) {
  // 写入失败时降级到 console only，避免 EventEmitter 'error' 未监听导致 throw 循环
  stream.on('error', (err) => {
    try { console.error(`[log] WriteStream error: ${err?.message || err}`); } catch {}
  });
  return stream;
}

let logFile = attachWriteStreamErrorHandler(createWriteStream(LOG_PATH, { flags: 'a' }));

let _logWriteCount = 0;
const ROTATE_CHECK_INTERVAL = 100;

function rotate() {
  try {
    const stat = statSync(LOG_PATH);
    if (stat.size > MAX_LOG_SIZE) {
      logFile.end();
      renameSync(LOG_PATH, LOG_PATH + '.1');
      logFile = attachWriteStreamErrorHandler(createWriteStream(LOG_PATH, { flags: 'a' }));
    }
  } catch {}
}

function maybeRotate() {
  // 节流：每写 ROTATE_CHECK_INTERVAL 次才 statSync 一次，
  // 避免 cc_event 高频 stream 期间每秒数十次同步 IO
  if (++_logWriteCount % ROTATE_CHECK_INTERVAL === 0) rotate();
}

function fmt(level, tag, msg) {
  return `${new Date().toISOString()} [${level}] [${tag}] ${msg}`;
}

function safePrint(fn, line) {
  try { fn(line); } catch {}
}

export function info(tag, msg) {
  const line = fmt('INFO', tag, msg);
  safePrint(console.log, line);
  logFile.write(line + '\n');
  maybeRotate();
}

export function error(tag, msg) {
  const line = fmt('ERROR', tag, msg);
  safePrint(console.error, line);
  logFile.write(line + '\n');
  maybeRotate();
}

export function warn(tag, msg) {
  const line = fmt('WARN', tag, msg);
  safePrint(console.warn, line);
  logFile.write(line + '\n');
  maybeRotate();
}
