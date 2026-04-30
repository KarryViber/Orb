/**
 * DocStore bridge — file chunks and FTS5 BM25 search.
 *
 * Called via Python subprocess bridge.
 */

import { execFile } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { warn } from './log.js';
import {
  DOC_INDEX_DB,
  DOC_INDEX_ENABLED,
  ORB_DOC_RECALL_LIMIT,
  PYTHON_PATH,
} from './runtime-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCSTORE_BRIDGE = join(__dirname, '..', 'lib', 'docstore', 'bridge.py');
const PYTHON = PYTHON_PATH;
const DEFAULT_DOC_DB = DOC_INDEX_DB || '';  // explicit env override; profile dataDir preferred
const DOC_RECALL_LIMIT = ORB_DOC_RECALL_LIMIT;
const TAG = 'docstore';

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

function docstoreBridge(dbPath, command, ...extraArgs) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [DOCSTORE_BRIDGE, command, dbPath, ...extraArgs],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(createBridgeError(`docstore ${command} failed`, err, stderr));
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

/**
 * Search indexed documents (file knowledge).
 * @param {string} query
 * @param {string} [dataDir] - Profile data directory (prefers dataDir/doc-index.db over env)
 * @param {string|null} [slug] - Optional project slug to scope search to a single project
 */
export async function searchDocs(query, dataDir, slug = null) {
  if (!DOC_INDEX_ENABLED || !query || DOC_RECALL_LIMIT <= 0) return [];
  const db = (dataDir ? join(dataDir, 'doc-index.db') : '') || DEFAULT_DOC_DB;
  try {
    if (!db) return [];
    const extraArgs = ['--limit', String(DOC_RECALL_LIMIT)];
    if (slug) extraArgs.push('--slug', slug);
    const results = await docstoreBridge(db, 'search', query, ...extraArgs);
    if (Array.isArray(results)) return results;
    return [];
  } catch (error) {
    logBridgeFallback('searchDocs', db, error);
    return [];
  }
}
