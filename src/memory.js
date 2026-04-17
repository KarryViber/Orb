/**
 * Memory bridge — Holographic (conversation) + DocStore (file knowledge).
 *
 * Two independent SQLite databases:
 *   - memory.db  → Holographic: conversation facts, trust scoring, HRR
 *   - doc-index.db → DocStore: file chunks, FTS5 BM25 search
 *
 * Both called via Python subprocess bridges.
 */

import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOLOGRAPHIC_BRIDGE = join(__dirname, '..', 'lib', 'holographic', 'bridge.py');
const DOCSTORE_BRIDGE = join(__dirname, '..', 'lib', 'docstore', 'bridge.py');
const EXTRACT_SCRIPT = join(__dirname, '..', 'lib', 'holographic', 'extract.py');
const DISTILL_SCRIPT = join(__dirname, '..', 'lib', 'holographic', 'distill.py');
const LINT_SCRIPT = join(__dirname, '..', 'lib', 'holographic', 'memory-lint.py');
const PYTHON = process.env.PYTHON_PATH || 'python3';
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== 'false';
const DOC_INDEX_ENABLED = process.env.DOC_INDEX_ENABLED !== 'false';
const DEFAULT_DOC_DB = process.env.DOC_INDEX_DB || '';  // explicit env override; profile dataDir preferred

// ── Holographic bridge (JSON args) ──

function holographicBridge(dbPath, command, args = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [HOLOGRAPHIC_BRIDGE, dbPath, command, JSON.stringify(args)],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`holographic ${command} failed: ${err.message} ${stderr || ''}`));
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
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error('batch: invalid JSON')); }
      },
    );
  });
}

// ── DocStore bridge (positional args) ──

function docstoreBridge(dbPath, command, ...extraArgs) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [DOCSTORE_BRIDGE, command, dbPath, ...extraArgs],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`docstore ${command} failed: ${err.message} ${stderr || ''}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error(`docstore ${command}: invalid JSON output`));
        }
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
    const results = await holographicBridge(db, 'search', { query, limit: 5 });
    if (Array.isArray(results)) return results;
    return [];
  } catch {
    return [];
  }
}

/**
 * Search indexed documents (file knowledge).
 * @param {string} query
 * @param {string} [dataDir] - Profile data directory (prefers dataDir/doc-index.db over env)
 * @param {string|null} [slug] - Optional project slug to scope search to a single project
 */
export async function searchDocs(query, dataDir, slug = null) {
  if (!DOC_INDEX_ENABLED || !query) return [];
  try {
    const db = (dataDir ? join(dataDir, 'doc-index.db') : '') || DEFAULT_DOC_DB;
    if (!db) return [];
    const extraArgs = ['--limit', '5'];
    if (slug) extraArgs.push('--slug', slug);
    const results = await docstoreBridge(db, 'search', query, ...extraArgs);
    if (Array.isArray(results)) return results;
    return [];
  } catch {
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
    child.stdin.write(JSON.stringify({ user: u, response: r }));
    child.stdin.end();
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
  } catch {
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
        },
      }));
      await holographicBatchBridge(db, operations).catch(() => {});
    } else if ((userText || '').length > 30) {
      // Fallback: store condensed raw if extraction found nothing
      // but user message was non-trivial
      const condensed = `Q: ${(userText || '').slice(0, 500)}\nA: ${(responseText || '').split('\n')[0]?.slice(0, 300) || ''}`;
      await holographicBridge(db, 'add', {
        content: condensed,
        category: 'conversation',
        tags,
      });
    }
    // Short trivial exchanges: don't store at all
  } catch { /* degrade gracefully */ }
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
      child.stdin.write(ctx);
      child.stdin.end();
    });

    const tags = ['lesson', userId, threadTs].filter(Boolean).join(',');
    for (const lesson of lessons) {
      const existing = await holographicBridge(dbPath, 'search', {
        query: lesson.content,
        category: 'lesson',
        min_trust: 0.0,
        limit: 1,
      }).catch(() => []);

      if (Array.isArray(existing) && existing.length > 0 && existing[0].similarity > 0.85) {
        continue; // 语义高度相似，跳过
      }

      await holographicBridge(dbPath, 'add', {
        content: lesson.content,
        category: 'lesson',
        tags,
        source: lesson.source || 'unknown',
      }).catch(() => {});
    }
  } catch { /* degrade gracefully */ }
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
      child.stdin.write(ctx);
      child.stdin.end();
    });

    const tags = ['lesson', 'correction', userId, threadTs].filter(Boolean).join(',');
    for (const lesson of lessons) {
      // Dedup check
      const existing = await holographicBridge(dbPath, 'search', {
        query: lesson.content,
        category: 'lesson',
        min_trust: 0.0,
        limit: 1,
      }).catch(() => []);
      if (Array.isArray(existing) && existing.length > 0 && existing[0].similarity > 0.85) {
        continue;
      }
      await holographicBridge(dbPath, 'add', {
        content: lesson.content,
        category: 'lesson',
        tags,
        source: lesson.source || 'correction_capture',
      }).catch(() => {});
    }
  } catch { /* degrade gracefully */ }
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
  } catch {
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
