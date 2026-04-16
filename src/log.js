import { createWriteStream, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const LOG_PATH = join(DATA_DIR, 'orb.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50MB

let logFile = createWriteStream(LOG_PATH, { flags: 'a' });

function rotate() {
  try {
    const stat = statSync(LOG_PATH);
    if (stat.size > MAX_LOG_SIZE) {
      logFile.end();
      renameSync(LOG_PATH, LOG_PATH + '.1');
      logFile = createWriteStream(LOG_PATH, { flags: 'a' });
    }
  } catch {}
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
  rotate();
}

export function error(tag, msg) {
  const line = fmt('ERROR', tag, msg);
  safePrint(console.error, line);
  logFile.write(line + '\n');
  rotate();
}

export function warn(tag, msg) {
  const line = fmt('WARN', tag, msg);
  safePrint(console.warn, line);
  logFile.write(line + '\n');
  rotate();
}
