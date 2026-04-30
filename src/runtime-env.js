import { homedir } from 'node:os';
import { join } from 'node:path';

export function parseIntEnv(value, defaultValue = null) {
  if (value == null || value === '') return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function parseFloatEnv(value, defaultValue = null) {
  if (value == null || value === '') return defaultValue;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function parseBoolEnv(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  return defaultValue;
}

export function parseStringEnv(value, defaultValue = null) {
  if (value == null || value === '') return defaultValue;
  return String(value);
}

export const ORB_PERMISSION_TIMEOUT_MS = parseIntEnv(process.env.ORB_PERMISSION_TIMEOUT_MS, 300_000);
export const ORB_WORKER_TIMEOUT_MS = parseIntEnv(process.env.ORB_WORKER_TIMEOUT_MS, 1_800_000);
export const ORB_PERMISSION_APPROVAL_MODE = parseStringEnv(process.env.ORB_PERMISSION_APPROVAL_MODE, 'auto-allow');
export const ORB_EVENTBUS_SMOKE_LOG = parseBoolEnv(process.env.ORB_EVENTBUS_SMOKE_LOG, false);
export const ORB_PROMPT_SOURCE_LABELING = parseBoolEnv(process.env.ORB_PROMPT_SOURCE_LABELING, true);
export const ORB_PROMPT_TOKEN_BUDGET = parseIntEnv(process.env.ORB_PROMPT_TOKEN_BUDGET, null);
export const ORB_LEDGER_HYDRATE = parseBoolEnv(process.env.ORB_LEDGER_HYDRATE, true);
export const ORB_STREAM_TRACE = parseBoolEnv(process.env.ORB_STREAM_TRACE, false);
// ORB_TURN_DELIVERY_CC_EVENT is intentionally read directly by scheduler.addAdapter
// so tests and daemon runtime overrides can flip the dual-track cc_event routing.
export const ORB_TURN_DELIVERY_CC_EVENT = parseBoolEnv(process.env.ORB_TURN_DELIVERY_CC_EVENT, false);
export const ORB_MEMORY_RECALL_LIMIT = parseIntEnv(process.env.ORB_MEMORY_RECALL_LIMIT, 10);
export const ORB_MEMORY_MIN_TRUST = parseFloatEnv(process.env.ORB_MEMORY_MIN_TRUST, 0.3);
export const ORB_DOC_RECALL_LIMIT = parseIntEnv(process.env.ORB_DOC_RECALL_LIMIT, 8);
export const ORB_MCP_PERMISSION_LOG = parseStringEnv(process.env.ORB_MCP_PERMISSION_LOG, null);

export const MEMORY_ENABLED = parseBoolEnv(process.env.MEMORY_ENABLED, true);
export const DOC_INDEX_ENABLED = parseBoolEnv(process.env.DOC_INDEX_ENABLED, true);
export const DOC_INDEX_DB = parseStringEnv(process.env.DOC_INDEX_DB, null);
export const DOC_REGISTRY_PATH = parseStringEnv(process.env.DOC_REGISTRY_PATH, null);
export const DOC_PROJECTS_ROOT = parseStringEnv(process.env.DOC_PROJECTS_ROOT, null);
export const IMAGE_CACHE_DIR = parseStringEnv(process.env.IMAGE_CACHE_DIR, join(homedir(), '.orb', 'cache', 'images'));
export const WORKSPACE_DIR = parseStringEnv(process.env.WORKSPACE_DIR, null);

export const CLAUDE_PATH = parseStringEnv(process.env.CLAUDE_PATH, 'claude');
export const CLAUDE_MODEL = parseStringEnv(process.env.CLAUDE_MODEL, null);
export const CLAUDE_EFFORT = parseStringEnv(process.env.CLAUDE_EFFORT, null);
export const PYTHON_PATH = parseStringEnv(process.env.PYTHON_PATH, 'python3');
export const MAX_TURNS = parseIntEnv(process.env.MAX_TURNS, 50);
export const WORKER_IDLE_TIMEOUT_MS = parseIntEnv(process.env.WORKER_IDLE_TIMEOUT_MS, 60_000);

// Subprocess-only context injected into src/mcp-permission-server.js by worker.js.
export const ORB_THREAD_TS = parseStringEnv(process.env.ORB_THREAD_TS, '');
export const ORB_CHANNEL = parseStringEnv(process.env.ORB_CHANNEL, '');
export const ORB_USER_ID = parseStringEnv(process.env.ORB_USER_ID, '');
export const ORB_SCHEDULER_SOCKET = parseStringEnv(process.env.ORB_SCHEDULER_SOCKET, '');
