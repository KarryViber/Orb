import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { warn } from './log.js';

function sessionsPath(dataDir) {
  return resolve(dataDir, 'sessions.json');
}

function ensureFile(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = sessionsPath(dataDir);
  if (!existsSync(file)) writeFileSync(file, '{}', 'utf8');
  return file;
}

function load(dataDir) {
  const file = sessionsPath(dataDir);
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  return {};
}

function save(dataDir, sessions) {
  mkdirSync(dataDir, { recursive: true });
  try { writeFileSync(sessionsPath(dataDir), JSON.stringify(sessions, null, 2), 'utf8'); } catch {}
}

/**
 * Run a read-modify-write operation under a file lock.
 * Throws if the lock cannot be acquired — callers must be prepared to handle
 * a dropped write. Fallback-to-unlocked is NOT safe: updateSession is
 * read-modify-write; two concurrent unlocked writers silently overwrite fields.
 */
async function withLock(dataDir, fn) {
  const file = ensureFile(dataDir);
  let release;
  try {
    release = await lockfile.lock(file, { retries: { retries: 5, minTimeout: 50, maxTimeout: 500 } });
  } catch (lockErr) {
    warn('session', `lock failed after retries (${lockErr?.message || 'unknown'}), skipping write`);
    throw new Error('session lock unavailable');
  }
  try {
    fn();
  } finally {
    try { await release(); } catch {}
  }
}

export function getSessionId(dataDir, threadTs) {
  const sessions = load(dataDir);
  return sessions[threadTs]?.sessionId || null;
}

export async function updateSession(dataDir, threadTs, { sessionId, userId }) {
  await withLock(dataDir, () => {
    const sessions = load(dataDir);
    const now = new Date().toISOString();
    if (sessions[threadTs]) {
      sessions[threadTs].sessionId = sessionId;
      sessions[threadTs].lastActive = now;
    } else {
      sessions[threadTs] = { sessionId, userId, createdAt: now, lastActive: now };
    }
    save(dataDir, sessions);
  });
}

export async function cleanupSessions(dataDir, maxAgeDays = 7) {
  await withLock(dataDir, () => {
    const sessions = load(dataDir);
    const cutoff = Date.now() - maxAgeDays * 86400000;
    let cleaned = 0;
    for (const [ts, entry] of Object.entries(sessions)) {
      if (new Date(entry.lastActive).getTime() < cutoff) { delete sessions[ts]; cleaned++; }
    }
    if (cleaned > 0) save(dataDir, sessions);
  });
}
