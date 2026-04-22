import { readFileSync, existsSync } from 'node:fs';
import { warn } from './log.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(ROOT, 'config.json');

let _config = null;

/**
 * Load and return config. Caches after first load.
 * Env var interpolation: "${VAR}" -> process.env.VAR
 */
export function loadConfig(force = false) {
  if (_config && !force) return _config;

  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);

  // Deep interpolate env vars
  _config = interpolateEnv(parsed);
  _config._root = ROOT;
  return _config;
}

function interpolateEnv(obj) {
  if (typeof obj === 'string') {
    const m = obj.match(/^\$\{(\w+)\}$/);
    if (m) return process.env[m[1]] || '';
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(interpolateEnv);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = interpolateEnv(v);
    }
    return result;
  }
  return obj;
}

/**
 * Return scheduler-level defaults for Slack-triggered workers.
 * `effort` falls back to `'low'` (preserving legacy behavior);
 * `model` defaults to `null` so CLI's own default is used.
 */
export function getDefaults() {
  const config = loadConfig();
  return {
    model: config.defaults?.model || null,
    effort: config.defaults?.effort || 'low',
  };
}

/**
 * Resolve a userId to a profile name.
 * Throws if no match — unmapped userIds are rejected.
 */
export function resolveProfile(userId) {
  const config = loadConfig();
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profile.userIds && profile.userIds.includes(userId)) {
      return { name, ...profile };
    }
  }
  // No fallback — unknown users are rejected
  throw new Error(`no profile mapped for userId: ${userId}`);
}

/**
 * Resolve relative paths in profile to absolute paths.
 */
export function resolveProfilePaths(profile) {
  const config = loadConfig();
  const root = config._root;
  const paths = {
    name: profile.name,
    scriptsDir: profile.scripts ? resolve(root, profile.scripts) : null,
    workspaceDir: resolve(root, profile.workspace),
    dataDir: resolve(root, profile.data),
  };
  for (const [key, dir] of Object.entries(paths)) {
    if (key === 'name' || key === 'dataDir') continue;
    if (!existsSync(dir)) {
      warn('config', `profile "${profile.name}": ${key} not found: ${dir}`);
    }
  }
  return paths;
}
