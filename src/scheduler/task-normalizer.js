import { randomUUID } from 'node:crypto';
import { getDefaults } from '../config.js';
import { normalizeChannelSemantics } from '../turn-delivery/intents.js';

const ESCALATE_KEYWORDS = [
  '复盘',
  '深入分析',
  '深度分析',
  '深度思考',
  '审计',
  '架构设计',
  '方案设计',
  '重构方案',
  '代码审查',
  '战略判断',
];
const ENGLISH_REVIEW_PATTERNS = [
  /\breview\s+一下\b/i,
  /\b帮\s*(我\s*)?review\b/i,
  /\b做个\s*review\b/i,
  /\breview\s+(这段|这个|下面|代码|PR)\b/i,
  /\b深度\s*review\b/i,
];

export class InvalidTaskError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'InvalidTaskError';
    if (cause) this.cause = cause;
  }
}

export function shouldEscalateEffort(text) {
  if (!text || text.length < 20) return false;
  for (const kw of ESCALATE_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  for (const re of ENGLISH_REVIEW_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

export function makeAttemptId() {
  return `attempt-${randomUUID()}`;
}

export function ensureAttemptId(task) {
  if (!task || typeof task !== 'object') return task;
  if (!task.attemptId) task.attemptId = makeAttemptId();
  return task.attemptId;
}

export function normalizeOrigin(origin) {
  if (!origin || typeof origin !== 'object') return null;
  const allowed = new Set(['cron', 'inject', 'launcher_result', 'user', 'system']);
  const kind = allowed.has(origin.kind) ? origin.kind : null;
  if (!kind) return null;
  return {
    kind,
    name: origin.name == null || origin.name === '' ? null : String(origin.name),
    parentAttemptId: origin.parentAttemptId == null || origin.parentAttemptId === ''
      ? null
      : String(origin.parentAttemptId),
  };
}

export function inferTaskOrigin(task, fallbackKind = 'user') {
  const existing = normalizeOrigin(task?.origin);
  if (existing) return existing;
  const threadTs = String(task?.threadTs || '');
  if (task?.cronName || threadTs.startsWith('cron:')) {
    return {
      kind: 'cron',
      name: String(task?.cronName || threadTs.slice('cron:'.length) || 'unknown'),
      parentAttemptId: null,
    };
  }
  if (task?.platform === 'system' || fallbackKind === 'system') {
    return { kind: 'system', name: task?.mode || null, parentAttemptId: null };
  }
  return { kind: 'user', name: 'first-touch', parentAttemptId: null };
}

export function injectOriginForTask(task, parentAttemptId) {
  return {
    kind: 'inject',
    name: 'replay',
    parentAttemptId: parentAttemptId || task?.attemptId || null,
  };
}

export function normalizeTaskForSpawn(task, { getProfile, defaults = getDefaults() } = {}) {
  if (!task || typeof task !== 'object') {
    throw new InvalidTaskError('task must be an object');
  }

  const normalizedTask = task;
  const channelSemantics = normalizeChannelSemantics(normalizedTask.channelSemantics);
  normalizedTask.channelSemantics = channelSemantics;
  normalizedTask.origin = normalizeOrigin(normalizedTask.origin) || inferTaskOrigin(normalizedTask);
  ensureAttemptId(normalizedTask);

  let profile;
  try {
    profile = normalizedTask.profile || getProfile?.(normalizedTask.userId);
  } catch (err) {
    throw new InvalidTaskError(err.message, err);
  }
  if (!profile) throw new InvalidTaskError('profile is required');

  let effectiveModel = normalizedTask.model || null;
  let effectiveEffort = normalizedTask.effort || null;
  let effectiveText = normalizedTask.userText || '';

  if (!effectiveModel) {
    const modelMatch = effectiveText.match(/^\[(haiku|sonnet|opus)\]\s+/i);
    if (modelMatch) {
      effectiveModel = modelMatch[1].toLowerCase();
      effectiveText = effectiveText.slice(modelMatch[0].length);
    }
  }
  if (!effectiveEffort) {
    const effortMatch = effectiveText.match(/^\[effort:(low|medium|high|xhigh|max)\]\s+/i);
    if (effortMatch) {
      effectiveEffort = effortMatch[1].toLowerCase();
      effectiveText = effectiveText.slice(effortMatch[0].length);
    }
  }
  if (shouldEscalateEffort(effectiveText)) {
    if (!effectiveEffort) effectiveEffort = 'xhigh';
    if (!effectiveModel) effectiveModel = 'opus';
  }
  if (!effectiveModel) effectiveModel = defaults.model;
  if (!effectiveEffort) effectiveEffort = defaults.effort;

  return {
    normalizedTask,
    profile,
    modelEffort: {
      model: effectiveModel,
      effort: effectiveEffort,
      text: effectiveText,
    },
    channelMeta: normalizedTask.channelMeta || null,
  };
}
