/**
 * Memory bridge — Holographic conversation facts, trust scoring, HRR.
 *
 * Called via Python subprocess bridge.
 */

import { execFile } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { info, warn } from './log.js';
import {
  ORB_MEMORY_MIN_TRUST,
  ORB_MEMORY_RECALL_LIMIT,
  MEMORY_ENABLED,
  PYTHON_PATH,
} from './runtime-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOLOGRAPHIC_BRIDGE = join(__dirname, '..', 'lib', 'holographic', 'bridge.py');
const EXTRACT_SCRIPT = join(__dirname, '..', 'lib', 'holographic', 'extract.py');
const DISTILL_SCRIPT = join(__dirname, '..', 'lib', 'holographic', 'distill.py');
const LINT_SCRIPT = join(__dirname, '..', 'lib', 'holographic', 'memory-lint.py');
const PYTHON = PYTHON_PATH;

// Recall tuning — override via .env, no code change needed.
// See spec architecture-hardening.md #30 for the parameter matrix.
const MEMORY_RECALL_LIMIT = ORB_MEMORY_RECALL_LIMIT;
const MEMORY_MIN_TRUST = ORB_MEMORY_MIN_TRUST;
const TAG = 'memory';

function serializeError(error) {
  if (!error) return 'Error: unknown';
  const name = error.name || 'Error';
  const message = error.message || String(error);
  return `${name}: ${message}`;
}

function isTimeoutError(error) {
  if (!error) return false;
  return error.kind === 'timeout'
    || error.code === 'ETIMEDOUT'
    || /timed out/i.test(error.message || '');
}

function logBridgeFallback(operation, dbPath, error) {
  const parts = [
    `operation=${operation}`,
    `db=${basename(dbPath || 'unknown')}`,
    `error=${serializeError(error)}`,
  ];
  if (isTimeoutError(error)) parts.push('kind=timeout');
  warn(TAG, parts.join(' '));
}

function forwardArbitrateStderr(stderr) {
  const passthrough = [];
  for (const rawLine of (stderr || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let forwarded = false;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.component === 'arbitrate') {
        info(TAG, line);
        forwarded = true;
      }
    } catch {}
    if (!forwarded) passthrough.push(line);
  }
  return passthrough.join('\n');
}

function createBridgeError(prefix, err, stderr = '') {
  const suffix = stderr ? ` ${stderr}` : '';
  const wrapped = new Error(`${prefix}: ${err.message}${suffix}`);
  wrapped.name = err.name || 'Error';
  wrapped.code = err.code;
  if (err.killed || err.code === 'ETIMEDOUT' || /timed out/i.test(err.message || '')) {
    wrapped.kind = 'timeout';
  }
  return wrapped;
}

// ── Holographic bridge (JSON args) ──

function holographicBridge(dbPath, command, args = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [HOLOGRAPHIC_BRIDGE, dbPath, command, JSON.stringify(args)],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const bridgeStderr = forwardArbitrateStderr(stderr);
        if (err) {
          reject(createBridgeError(`holographic ${command} failed`, err, bridgeStderr));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error(`holographic ${command}: invalid JSON output`));
        }
      },
    );
  });
}

// ── Holographic batch bridge ──

function holographicBatchBridge(dbPath, operations) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [HOLOGRAPHIC_BRIDGE, dbPath, 'batch', JSON.stringify({ operations })],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const bridgeStderr = forwardArbitrateStderr(stderr);
        if (err) return reject(createBridgeError('holographic batch failed', err, bridgeStderr));
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error('batch: invalid JSON')); }
      },
    );
  });
}

// ── Public API ──

/**
 * Recall relevant conversation memories.
 */
export async function recallMemory(query, userId, dbPath) {
  if (!MEMORY_ENABLED || !query || !dbPath) return [];
  try {
    const db = dbPath;
    const results = await holographicBridge(db, 'search', {
      query,
      limit: MEMORY_RECALL_LIMIT,
      min_trust: MEMORY_MIN_TRUST,
    });
    if (Array.isArray(results)) return results;
    return [];
  } catch (error) {
    logBridgeFallback('recallMemory', dbPath, error);
    return [];
  }
}

/**
 * Extract structured facts from a conversation turn via Python script.
 */
function extractFacts(userText, responseText) {
  return new Promise((resolve) => {
    const u = (userText || '').slice(0, 50000);
    const r = (responseText || '').slice(0, 50000);
    const child = execFile(
      PYTHON,
      [EXTRACT_SCRIPT],
      { timeout: 10_000, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) { resolve([]); return; }
        try {
          const facts = JSON.parse(stdout.trim());
          resolve(Array.isArray(facts) ? facts : []);
        } catch { resolve([]); }
      },
    );
    // Guard against EPIPE when the Python child dies before write completes —
    // would otherwise crash the whole worker process.
    child.stdin.on('error', () => resolve([]));
    child.stdin.write(JSON.stringify({ user: u, response: r }), (err) => {
      if (err) resolve([]);
      else child.stdin.end();
    });
  });
}

/**
 * List facts from holographic memory, optionally filtered by category.
 * Used by scheduler for memory/user profile sync.
 */
export async function listFacts(dbPath, { category, minTrust = 0.5, limit = 50 } = {}) {
  if (!MEMORY_ENABLED || !dbPath) return [];
  try {
    const db = dbPath;
    const results = await holographicBridge(db, 'list', { category, min_trust: minTrust, limit });
    if (Array.isArray(results)) return results;
    return [];
  } catch (error) {
    logBridgeFallback('listFacts', dbPath, error);
    return [];
  }
}

/**
 * Store a conversation turn as structured facts.
 *
 * Extracts meaningful facts (decisions, preferences, entities, etc.)
 * and stores each separately with proper categorization.
 * Falls back to raw storage if extraction yields nothing but the
 * conversation seems non-trivial.
 */
export async function storeConversation({ userText, responseText, threadTs, userId, dbPath }) {
  if (!MEMORY_ENABLED || !dbPath) return;
  try {
    const db = dbPath;
    const tags = [userId, threadTs].filter(Boolean).join(',');

    // Try structured extraction first
    const facts = await extractFacts(userText, responseText);

    if (facts.length > 0) {
      // Batch all adds into a single Python subprocess call.
      // Confidence from extract.py drives write-time trust in store.add_fact
      // (confirmed=0.9 / default=0.5 / speculative=0.2, then trust_frozen=1).
      const operations = facts.map((fact) => ({
        command: 'add',
        args: {
          content: fact.content,
          category: fact.category || 'conversation',
          tags,
          confidence: fact.confidence || 'default',
          source_kind: fact.source_kind || 'extracted',
          source_confidence: fact.source_confidence ?? 0.5,
        },
      }));
      try {
        await holographicBatchBridge(db, operations);
      } catch (error) {
        logBridgeFallback('storeConversation.batchAdd', db, error);
      }
    } else if ((userText || '').length > 30) {
      // Fallback: store condensed raw if extraction found nothing
      // but user message was non-trivial
      const condensed = `Q: ${(userText || '').slice(0, 500)}\nA: ${(responseText || '').split('\n')[0]?.slice(0, 300) || ''}`;
      await holographicBridge(db, 'add', {
        content: condensed,
        category: 'conversation',
        tags,
        source_kind: 'inferred',
        source_confidence: 0.6,
      });
    }
    // Short trivial exchanges: don't store at all
  } catch (error) {
    logBridgeFallback('storeConversation', dbPath, error);
  }
}

/**
 * Distill and store lessons from an error context.
 * Called by scheduler when worker reports an error.
 */
export async function storeLesson({ userText, errorText, responseText, threadTs, userId, dbPath }) {
  if (!MEMORY_ENABLED || !dbPath) return;
  try {
    const ctx = JSON.stringify({ userText, errorText, responseText });
    const lessons = await new Promise((resolve) => {
      const child = execFile(
        PYTHON,
        [DISTILL_SCRIPT],
        { timeout: 20_000, maxBuffer: 512 * 1024 },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          try { resolve(JSON.parse(stdout.trim())); } catch { resolve([]); }
        },
      );
      child.stdin.on('error', () => resolve([]));
      child.stdin.write(ctx, (err) => {
        if (err) resolve([]);
        else child.stdin.end();
      });
    });

    const tags = ['lesson', userId, threadTs].filter(Boolean).join(',');
    for (const lesson of lessons) {
      const existing = await holographicBridge(dbPath, 'search', {
        query: lesson.content,
        category: 'lesson',
        min_trust: 0.0,
        limit: 1,
      }).catch((error) => {
        logBridgeFallback('storeLesson.dedupSearch', dbPath, error);
        return null;
      });

      if (!Array.isArray(existing)) continue;
      if (existing.length > 0 && existing[0].similarity > 0.85) {
        continue; // 语义高度相似，跳过
      }

      await holographicBridge(dbPath, 'add', {
        content: lesson.content,
        category: 'lesson',
        tags,
        source: lesson.source || 'unknown',
        source_kind: lesson.source_kind || 'inferred',
        source_confidence: lesson.source_confidence ?? 0.6,
      }).catch((error) => {
        logBridgeFallback('storeLesson.add', dbPath, error);
      });
    }
  } catch (error) {
    logBridgeFallback('storeLesson', dbPath, error);
  }
}

/**
 * Distill and store lessons from user correction signals.
 * Called by scheduler when user message contains correction patterns.
 */
export async function storeCorrectionLesson({ userText, responseText, threadHistory, threadTs, userId, dbPath }) {
  if (!MEMORY_ENABLED || !dbPath) return;
  try {
    const ctx = JSON.stringify({
      mode: 'correction',
      userText,
      responseText,
      threadHistory,
    });
    const lessons = await new Promise((resolve) => {
      const child = execFile(
        PYTHON,
        [DISTILL_SCRIPT],
        { timeout: 20_000, maxBuffer: 512 * 1024 },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          try { resolve(JSON.parse(stdout.trim())); } catch { resolve([]); }
        },
      );
      child.stdin.on('error', () => resolve([]));
      child.stdin.write(ctx, (err) => {
        if (err) resolve([]);
        else child.stdin.end();
      });
    });

    const tags = ['lesson', 'correction', userId, threadTs].filter(Boolean).join(',');
    for (const lesson of lessons) {
      // Dedup check
      const existing = await holographicBridge(dbPath, 'search', {
        query: lesson.content,
        category: 'lesson',
        min_trust: 0.0,
        limit: 1,
      }).catch((error) => {
        logBridgeFallback('storeCorrectionLesson.dedupSearch', dbPath, error);
        return null;
      });
      if (!Array.isArray(existing)) continue;
      if (existing.length > 0 && existing[0].similarity > 0.85) {
        continue;
      }
      await holographicBridge(dbPath, 'add', {
        content: lesson.content,
        category: 'lesson',
        tags,
        source: lesson.source || 'correction_capture',
        source_kind: lesson.source_kind || 'extracted',
        source_confidence: lesson.source_confidence ?? 0.8,
      }).catch((error) => {
        logBridgeFallback('storeCorrectionLesson.add', dbPath, error);
      });
    }
  } catch (error) {
    logBridgeFallback('storeCorrectionLesson', dbPath, error);
  }
}

/**
 * Purge transient-category facts older than max_age_days.
 * These are the only facts we hard-delete — durable facts go through tombstone
 * via bridge's arbitration / feedback paths instead.
 */
export async function purgeTransient(dbPath, { categories, maxAgeDays = 7 } = {}) {
  if (!MEMORY_ENABLED || !dbPath) return { purged: 0 };
  try {
    const args = { max_age_days: maxAgeDays };
    if (categories) args.categories = categories;
    const result = await holographicBridge(dbPath, 'purge_transient', args);
    return result || { purged: 0 };
  } catch (error) {
    logBridgeFallback('purgeTransient', dbPath, error);
    return { purged: 0 };
  }
}

/**
 * Run memory health check across all categories. Returns report object.
 * @param {string} dbPath - holographic DB path
 * @param {boolean} fix - auto-remove orphans and duplicates
 */
export async function lintMemory(dbPath, { fix = false } = {}) {
  if (!MEMORY_ENABLED || !dbPath) return { total: 0 };
  const args = [LINT_SCRIPT, dbPath];
  if (fix) args.push('--fix');
  return new Promise((resolve) => {
    execFile(
      PYTHON,
      args,
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve({ error: err.message }); return; }
        try { resolve(JSON.parse(stdout.trim())); } catch { resolve({ error: 'invalid output' }); }
      },
    );
  });
}
