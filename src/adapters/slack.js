import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { info, error as logError, warn } from '../log.js';
import { isSafeUrl } from '../format-utils.js';
import {
  buildPlanSnapshotRows,
  buildPlanSnapshotTitle,
  buildSendPayloads,
  categorizeTool,
} from './slack-format.js';
import { PlatformAdapter } from './interface.js';
import { downloadAndCacheImage, cleanImageCache, IMAGE_EXTENSIONS } from './image-cache.js';

const TAG = 'slack';
const MAX_USERNAME_CACHE = 500;
const __dirname = dirname(fileURLToPath(import.meta.url));
const streamTrace = () => process.env.ORB_STREAM_TRACE === '1';

const QI_INITIAL_CHUNKS = [
  { type: 'plan_update', title: 'Orbiting...' },
  { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress', details: '' },
  { type: 'task_update', id: 'qi-other', title: 'Delegate', status: 'in_progress', details: '' },
  { type: 'task_update', id: 'qi-summary', title: 'Distill', status: 'in_progress', details: '' },
];

const QI_TASK_IDS = {
  Probe: 'qi-exec',
  Delegate: 'qi-other',
  Distill: 'qi-summary',
};

const TEXT_DEBOUNCE_MS = 2000;
const STATUS_HEARTBEAT_MS = 90_000;

function isSlackSubscriberContext(ctx) {
  return ctx?.platform == null || ctx.platform === 'slack';
}

function truncateQiText(text, max = 256) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function summarizeQiInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const keys = ['description', 'command', 'query', 'pattern', 'file_path', 'url', 'skill_name', 'subagent_type'];
  for (const key of keys) {
    if (input[key] != null && String(input[key]).trim()) return String(input[key]);
  }
  const first = Object.entries(input).find(([, value]) => (
    value != null && ['string', 'number', 'boolean'].includes(typeof value)
  ));
  return first ? `${first[0]}: ${first[1]}` : '';
}

function buildQiToolLine(payload) {
  const name = payload?.name || 'Tool';
  const summary = summarizeQiInput(payload?.input);
  return truncateQiText(summary ? `${name}: ${summary}` : name);
}

function buildStatusText(payload) {
  return truncateQiText(buildQiToolLine(payload), 80);
}

function formatElapsedTime(startedAt, now = Date.now()) {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ${elapsedSeconds % 60}s`;
  return `${Math.floor(elapsedMinutes / 60)}h ${elapsedMinutes % 60}m`;
}

function getTurnKey(turnId) {
  return turnId || 'default';
}

export function buildQiSettledChunks(toolCount = 0, reason = '') {
  const count = Number.isFinite(Number(toolCount)) ? Number(toolCount) : 0;
  const details = reason ? `Settled: ${reason}` : `Distilled from ${count} probes`;
  return [
    { type: 'plan_update', title: 'Settled' },
    { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'complete' },
    { type: 'task_update', id: 'qi-other', title: 'Delegate', status: 'complete' },
    { type: 'task_update', id: 'qi-summary', title: 'Distill', status: 'complete', details },
  ];
}

function makeQiTurnState() {
  return {
    streamId: null,
    streamTs: null,
    startPromise: null,
    appendPromise: null,
    failed: false,
    toolCount: 0,
  };
}

function makePlanTurnState() {
  return {
    streamId: null,
    streamTs: null,
    startPromise: null,
    appendPromise: null,
    failed: false,
    lastChunks: [],
  };
}

function buildPlanSnapshotChunks(todos) {
  const rows = buildPlanSnapshotRows(todos);
  if (rows.length === 0) return [];
  return [
    { type: 'plan_update', title: buildPlanSnapshotTitle(todos) },
    ...rows.map((row) => ({
      type: 'task_update',
      id: row.task_id,
      title: row.title,
      status: row.status,
    })),
  ];
}

function createCcSubscriber(adapter, {
  matchTool,
  makeState,
  buildToolChunks,
  getInitialChunks,
  onResult,
}) {
  const turns = new Map();
  const getState = (turnId) => {
    const key = getTurnKey(turnId);
    if (!turns.has(key)) turns.set(key, makeState());
    return turns.get(key);
  };

  const ensureStarted = async (state, ctx, initialChunks) => {
    if (state.streamId || state.failed) return Boolean(state.streamId);
    if (state.startPromise) {
      await state.startPromise;
      return Boolean(state.streamId);
    }
    const channel = ctx?.channel || ctx?.task?.channel;
    const threadTs = ctx?.effectiveThreadTs || ctx?.threadTs || ctx?.task?.threadTs;
    if (!channel || !threadTs) return false;
    state.startPromise = (async () => {
      try {
        const stream = await adapter.startStream(channel, threadTs, {
          task_display_mode: 'plan',
          initial_chunks: initialChunks,
          team_id: ctx?.task?.teamId || ctx?.teamId || null,
        });
        state.streamId = stream?.stream_id || (stream?.ts ? `${channel}:${stream.ts}` : null);
        state.streamTs = stream?.ts || null;
      } catch (err) {
        state.failed = true;
        warn(TAG, `[cc_subscriber] start failed: ${err.message}`);
      } finally {
        state.startPromise = null;
      }
    })();
    await state.startPromise;
    return Boolean(state.streamId);
  };

  const chainAppend = (state, operation) => {
    const previous = state.appendPromise || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    state.appendPromise = next.finally(() => {
      if (state.appendPromise === next) state.appendPromise = null;
    });
    return state.appendPromise;
  };

  return {
    match: (msg, ctx) => isSlackSubscriberContext(ctx)
      && msg?.type === 'cc_event' && (msg.eventType === 'tool_use' || msg.eventType === 'result'),
    async handle(msg, ctx = {}) {
      const key = getTurnKey(msg.turnId);
      const state = getState(msg.turnId);
      if (msg.eventType === 'tool_use') {
        if (!matchTool(msg, ctx, state)) return;
        const chunks = buildToolChunks(msg, ctx, state);
        if (!Array.isArray(chunks) || chunks.length === 0) return;
        const hadStream = Boolean(state.streamId);
        const initialChunks = getInitialChunks(msg, ctx, state, chunks);
        if (!await ensureStarted(state, ctx, initialChunks)) return;
        if (!hadStream && initialChunks === chunks) return;
        if (state.failed || !state.streamId) return;
        await chainAppend(state, async () => {
          if (!state.streamId) return;
          await adapter.appendStream(state.streamId, chunks);
        }).catch((err) => {
          warn(TAG, `[cc_subscriber] append failed: ${err.message}`);
        });
        return;
      }

      if (state.startPromise) await state.startPromise;
      if (state.appendPromise) await state.appendPromise.catch(() => {});
      if (!state.streamId) {
        turns.delete(key);
        return;
      }
      const streamId = state.streamId;
      const chunks = onResult(msg, ctx, state);
      try {
        await adapter.stopStream(streamId, { chunks });
      } catch (err) {
        warn(TAG, `[cc_subscriber] stop failed: ${err.message}`);
      } finally {
        turns.delete(key);
      }
    },
  };
}

export function createSlackQiSubscriber(adapter) {
  return createCcSubscriber(adapter, {
    makeState: makeQiTurnState,
    matchTool(msg, ctx) {
      const category = categorizeTool(msg.payload?.name);
      if (!category) return false;
      const taskCardState = ctx?.turn?.taskCardState;
      if (taskCardState && !taskCardState.enabled && !taskCardState.deferred) return false;
      return !taskCardState?.failed;
    },
    buildToolChunks(msg, ctx, state) {
      const category = categorizeTool(msg.payload?.name);
      const taskId = QI_TASK_IDS[category];
      if (!taskId) return [];
      state.toolCount += 1;
      return [
        { type: 'task_update', id: taskId, title: category, details: `\n${buildQiToolLine(msg.payload)}\n` },
      ];
    },
    getInitialChunks: () => QI_INITIAL_CHUNKS,
    onResult: (msg, ctx, state) => buildQiSettledChunks(state.toolCount),
  });
}

export function createSlackPlanSubscriber(adapter) {
  return createCcSubscriber(adapter, {
    makeState: makePlanTurnState,
    matchTool: (msg) => msg.payload?.name === 'TodoWrite' && Array.isArray(msg.payload?.input?.todos),
    buildToolChunks(msg, ctx, state) {
      const chunks = buildPlanSnapshotChunks(msg.payload.input.todos);
      state.lastChunks = chunks;
      return chunks;
    },
    getInitialChunks: (msg, ctx, state, chunks) => chunks,
    onResult: (msg, ctx, state) => state.lastChunks,
  });
}

export function createSlackTextSubscriber(adapter, { debounceMs = TEXT_DEBOUNCE_MS } = {}) {
  const turns = new Map();

  const clearState = (key) => {
    const state = turns.get(key);
    if (state?.timer) clearTimeout(state.timer);
    turns.delete(key);
  };

  const deliver = async (key) => {
    const state = turns.get(key);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const text = state.texts.join('\n').trim();
    state.texts = [];
    if (!text) return;

    const { ctx } = state;
    if (ctx?.deferDeliveryUntilResult) return;
    const turn = ctx?.turn;
    const taskCardState = turn?.taskCardState;
    const streamId = taskCardState?.streamId;

    if (streamId && !taskCardState?.failed && typeof adapter.appendStream === 'function') {
      try {
        await adapter.appendStream(streamId, [{ type: 'markdown_text', text }]);
        if (turn) turn.intermediateDeliveredThisTurn = true;
        if (turn?.egress) turn.egress.admit(text, 'intermediate');
        return;
      } catch (err) {
        const code = err?.data?.error || err?.code || '';
        if (code === 'message_not_in_streaming_state' || code === 'message_not_owned_by_app') {
          if (taskCardState) taskCardState.failed = true;
          warn(TAG, `[text_subscriber] stream ownership lost, degrading to sendReply: ${code}`);
        } else {
          warn(TAG, `[text_subscriber] append failed: ${err.message}`);
          return;
        }
      }
    }

    if (turn?.egress && !turn.egress.admit(text, 'intermediate')) {
      turn.intermediateDeliveredThisTurn = true;
      return;
    }
    const channel = ctx?.channel || ctx?.task?.channel;
    const threadTs = ctx?.effectiveThreadTs || ctx?.threadTs || ctx?.task?.threadTs;
    if (!channel || !threadTs || typeof adapter.sendReply !== 'function') return;
    try {
      const payloads = typeof adapter.buildPayloads === 'function'
        ? adapter.buildPayloads(text)
        : [{ text }];
      for (const payload of payloads) {
        await adapter.sendReply(channel, threadTs, payload.text, payload.blocks ? { blocks: payload.blocks } : {});
      }
      if (turn) turn.intermediateDeliveredThisTurn = true;
    } catch (err) {
      warn(TAG, `[text_subscriber] sendReply failed: ${err.message}`);
    }
  };

  return {
    match: (msg, ctx) => isSlackSubscriberContext(ctx)
      && msg?.type === 'cc_event' && (msg.eventType === 'text' || msg.eventType === 'result'),
    async handle(msg, ctx = {}) {
      const key = getTurnKey(msg.turnId);
      if (msg.eventType === 'result') {
        await deliver(key);
        clearState(key);
        return;
      }

      const text = String(msg.payload?.text || '').trim();
      if (!text) return;
      let state = turns.get(key);
      if (!state) {
        state = { texts: [], timer: null, ctx };
        turns.set(key, state);
      }
      state.ctx = ctx;
      state.texts.push(text);
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        deliver(key).catch((err) => warn(TAG, `[text_subscriber] debounce deliver failed: ${err.message}`));
      }, debounceMs);
      if (typeof state.timer.unref === 'function') state.timer.unref();
    },
  };
}

export function createSlackStatusSubscriber(adapter, { heartbeatMs = STATUS_HEARTBEAT_MS } = {}) {
  const turns = new Map();

  const clearState = async (key, ctx) => {
    const state = turns.get(key);
    if (state?.timer) clearInterval(state.timer);
    turns.delete(key);
    if (typeof ctx?.applyThreadStatus === 'function') {
      await ctx.applyThreadStatus('');
    }
  };

  const refresh = async (state, { includeElapsed = true } = {}) => {
    if (!state?.payload || typeof state.ctx?.applyThreadStatus !== 'function') return;
    const base = buildStatusText(state.payload);
    const status = includeElapsed && state.startedAt
      ? truncateQiText(`${base} (${formatElapsedTime(state.startedAt)})`, 100)
      : base;
    await state.ctx.applyThreadStatus(status);
  };

  return {
    match: (msg, ctx) => isSlackSubscriberContext(ctx)
      && msg?.type === 'cc_event' && (msg.eventType === 'tool_use' || msg.eventType === 'result'),
    async handle(msg, ctx = {}) {
      const key = getTurnKey(msg.turnId);
      if (msg.eventType === 'result') {
        await clearState(key, ctx);
        return;
      }

      if (ctx?.deferDeliveryUntilResult) return;
      const state = turns.get(key) || { payload: null, startedAt: 0, timer: null, ctx };
      state.payload = msg.payload || {};
      state.startedAt = Date.now();
      state.ctx = ctx;
      turns.set(key, state);
      await refresh(state, { includeElapsed: false });
      if (!state.timer) {
        state.timer = setInterval(() => {
          refresh(state).catch((err) => warn(TAG, `[status_subscriber] heartbeat failed: ${err.message}`));
        }, heartbeatMs);
        if (typeof state.timer.unref === 'function') state.timer.unref();
      }
    },
  };
}

// --- Slack thread URL parsing ---

/**
 * Extract channel ID and thread timestamp from Slack message URLs.
 * Formats:
 *   https://{workspace}.slack.com/archives/{channelId}/p{ts_no_dot}
 *   https://{workspace}.slack.com/archives/{channelId}/p{ts_no_dot}?thread_ts={ts}&cid={channelId}
 * Returns array of { channel, threadTs } objects.
 */
const SLACK_URL_RE = /https?:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?([^\s>)]*))?/g;

function extractSlackThreadUrls(text) {
  if (!text) return [];
  const results = [];
  let m;
  while ((m = SLACK_URL_RE.exec(text)) !== null) {
    const channel = m[1];
    const messageTs = `${m[2]}.${m[3]}`;
    const query = m[4] || '';

    // Prefer thread_ts from query (points to thread parent) over p-timestamp (might be a reply)
    let threadTs = messageTs;
    const threadMatch = query.replace(/&amp;/g, '&').match(/thread_ts=(\d+\.\d+)/);
    if (threadMatch) {
      threadTs = threadMatch[1];
    }

    results.push({ channel, threadTs, messageTs });
  }
  SLACK_URL_RE.lastIndex = 0;
  return results;
}

// --- Block Kit text extraction ---

/**
 * Extract readable text from a Block Kit `blocks` array.
 *
 * Orb's cron outputs (夜间反思 / 盘前快检 / 日报 etc.) are all Block Kit —
 * `msg.text` is just a short header, the real content lives in section/header/
 * context blocks. Without this, fetchThreadHistory only sees the header and
 * the worker loses all context when the user replies in the thread.
 */
function extractBlockKitText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'header' && block.text?.text) {
      parts.push(block.text.text);
    } else if (block.type === 'section') {
      if (block.text?.text) parts.push(block.text.text);
      if (Array.isArray(block.fields)) {
        for (const f of block.fields) {
          if (f?.text) parts.push(f.text);
        }
      }
    } else if (block.type === 'context' && Array.isArray(block.elements)) {
      for (const el of block.elements) {
        if (el?.text) parts.push(el.text);
      }
    }
    // divider / image / actions ignored
  }
  return parts.join('\n');
}

// Compile a regex from config. Returns null on invalid input rather than
// throwing, so a bad rule disables just that rule instead of crashing routing.
// Accepts leading `(?i)` / `(?im)` inline flag prefix (PCRE-style, common in
// human-authored configs) and rewrites it to JS RegExp flags.
function safeRegex(pattern, flags = '') {
  if (pattern == null) return null;
  try {
    let p = String(pattern);
    let f = String(flags || '');
    const m = p.match(/^\(\?([a-z]+)\)/);
    if (m) {
      const inline = m[1].toLowerCase();
      for (const ch of inline) if (!f.includes(ch) && 'gimsuy'.includes(ch)) f += ch;
      p = p.slice(m[0].length);
    }
    return new RegExp(p, f);
  } catch {
    return null;
  }
}

function parsePermissionToolInput(toolInput) {
  if (toolInput && typeof toolInput === 'object') return toolInput;
  if (typeof toolInput !== 'string') return null;
  const trimmed = toolInput.trim();
  if (!trimmed) return null;
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function stringifyPermissionValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeSlackCodeText(text) {
  return String(text || '').replace(/```/g, '` ` `');
}

function truncatePermissionText(value, maxChars) {
  const normalized = sanitizeSlackCodeText(stringifyPermissionValue(value));
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function formatSlackInlineCode(value) {
  return `\`${String(value ?? 'unknown').replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;
}

function formatPermissionPreviewMeta(text, maxChars) {
  const totalChars = String(text || '').length;
  if (!totalChars) return '(共 0 字符)';
  const previewChars = Math.min(totalChars, maxChars);
  if (previewChars >= totalChars) return `(共 ${totalChars} 字符)`;
  return `(前 ${previewChars} 字符 / 共 ${totalChars} 字符)`;
}

function isIgnorableAssistantThreadError(err) {
  const code = String(err?.data?.error || err?.code || '').trim();
  return code === 'no_permission' || code === 'channel_not_found';
}

function tokenizeShellCommand(command) {
  return String(command || '')
    .match(/'[^']*'|"[^"]*"|\S+/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

function extractShellTargets(tokens) {
  return tokens.slice(1).filter((token) => token && token !== '--' && !token.startsWith('-'));
}

function pickPrimitiveParams(input, limit = 4) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      parts.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}: [${value.slice(0, 3).map((item) => String(item)).join(', ')}${value.length > 3 ? ', ...' : ''}]`);
    }
    if (parts.length >= limit) break;
  }
  return parts.join('\n');
}

function renderBashSemantics(command) {
  const commandText = String(command || '');
  const commandPreview = truncatePermissionText(commandText, 200);
  const tokens = tokenizeShellCommand(commandText);
  const verb = tokens[0]?.toLowerCase();
  const targets = extractShellTargets(tokens);
  const primaryTarget = targets.join(' ') || '未识别目标';
  const method = tokens.find((token, index) => {
    if (index === 0) return false;
    const upper = token.toUpperCase();
    return upper === 'POST' || upper === 'DELETE';
  })?.toUpperCase();

  if (['rm', 'unlink', 'rmdir', 'trash'].includes(verb)) {
    return {
      emoji: '🗑',
      action: '删除',
      targetLabel: '目标',
      targetValue: primaryTarget,
      previewTitle: '命令',
      previewBody: `\`\`\`${commandPreview}\`\`\``,
    };
  }

  if (verb === 'git' && (tokens[1] === 'push' || (tokens[1] === 'reset' && tokens.includes('--hard')))) {
    return {
      emoji: '⚠️',
      action: 'Git 高危操作',
      targetLabel: '命令',
      targetValue: commandPreview,
      previewTitle: '完整命令',
      previewBody: `\`\`\`${commandPreview}\`\`\``,
    };
  }

  if (verb === 'curl' || verb === 'wget') {
    const url = tokens.find((token) => /^https?:\/\//i.test(token)) || '未识别目标';
    return {
      emoji: '🌐',
      action: method ? `网络调用 (${method})` : '网络调用',
      targetLabel: '目标',
      targetValue: url,
      previewTitle: '命令',
      previewBody: `\`\`\`${commandPreview}\`\`\``,
    };
  }

  return {
    emoji: '⚡',
    action: '执行命令',
    targetLabel: '命令',
    targetValue: commandPreview,
    previewTitle: '命令',
    previewBody: `\`\`\`${commandPreview}\`\`\``,
  };
}

function renderPermissionSemantics(toolName, toolInput) {
  const normalizedToolName = String(toolName || 'unknown');
  const parsedInput = parsePermissionToolInput(toolInput);
  const rawInput = truncatePermissionText(toolInput, 500);

  if (normalizedToolName === 'Write') {
    const content = stringifyPermissionValue(parsedInput?.content ?? '');
    return {
      emoji: '📝',
      action: '写入文件',
      targetLabel: '文件',
      targetValue: parsedInput?.file_path ?? 'unknown',
      previewTitle: '内容预览',
      previewBody: `\`\`\`${truncatePermissionText(content, 500)}\`\`\``,
      previewMeta: formatPermissionPreviewMeta(content, 500),
      rawInput,
    };
  }

  if (normalizedToolName === 'Edit') {
    const oldString = stringifyPermissionValue(parsedInput?.old_string ?? '');
    const newString = stringifyPermissionValue(parsedInput?.new_string ?? '');
    return {
      emoji: '✏️',
      action: '编辑文件',
      targetLabel: '文件',
      targetValue: parsedInput?.file_path ?? 'unknown',
      previewTitle: '变更预览',
      previewBody: [
        '*旧内容*',
        `\`\`\`${truncatePermissionText(oldString, 300)}\`\`\``,
        formatPermissionPreviewMeta(oldString, 300),
        '*新内容*',
        `\`\`\`${truncatePermissionText(newString, 300)}\`\`\``,
        formatPermissionPreviewMeta(newString, 300),
      ].join('\n'),
      rawInput,
    };
  }

  if (normalizedToolName === 'Read') {
    return {
      emoji: '👁',
      action: '读取文件',
      targetLabel: '文件',
      targetValue: parsedInput?.file_path ?? 'unknown',
      rawInput,
    };
  }

  if (normalizedToolName === 'Bash') {
    return {
      ...renderBashSemantics(parsedInput?.command ?? toolInput),
      rawInput,
    };
  }

  if (normalizedToolName === 'Glob' || normalizedToolName === 'Grep') {
    return {
      emoji: '🔍',
      action: '搜索',
      targetLabel: '范围',
      targetValue: parsedInput?.path ?? parsedInput?.glob ?? 'unknown',
      previewTitle: 'Pattern',
      previewBody: `\`\`\`${truncatePermissionText(parsedInput?.pattern ?? parsedInput?.query ?? '', 300)}\`\`\``,
      rawInput,
    };
  }

  if (normalizedToolName.startsWith('mcp__')) {
    const keyParams = pickPrimitiveParams(parsedInput, 4);
    return {
      emoji: '🔌',
      action: '调用外部工具',
      targetLabel: '工具',
      targetValue: normalizedToolName,
      previewTitle: keyParams ? '关键参数' : null,
      previewBody: keyParams ? `\`\`\`${truncatePermissionText(keyParams, 300)}\`\`\`` : null,
      rawInput,
    };
  }

  return {
    emoji: '🛠',
    action: '工具调用',
    targetLabel: '工具',
    targetValue: normalizedToolName,
    previewTitle: '参数',
    previewBody: `\`\`\`${rawInput}\`\`\``,
    rawInput,
    fallback: true,
  };
}

// --- Incoming file processing ---
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'tsv', 'log', 'py', 'js', 'ts', 'jsx', 'tsx',
  'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'bash', 'sql',
  'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'cfg',
]);
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const BLOCK_ACTION_HANDLER_RE = /^[a-z][a-z0-9_]{0,63}$/;
const HANDLER_EXTENSIONS = ['.py', '.sh', '.js'];
const HANDLER_DEDUP_TTL = 10 * 60 * 1000;
const HANDLER_LOG_DIR = join(__dirname, '..', '..', 'logs', 'handlers');
const HANDLER_PID_LOG = join(HANDLER_LOG_DIR, 'pids.log');

export class StreamAPIError extends Error {
  constructor(message, cause, slackErrorCode = null) {
    super(message);
    this.name = 'StreamAPIError';
    this.cause = cause;
    this.slackErrorCode = slackErrorCode || getSlackStreamErrorCode(cause) || null;
  }
}

function getSlackStreamErrorCode(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.error === 'string' && value.error) return value.error;
  if (typeof value.data?.error === 'string' && value.data.error) return value.data.error;
  return null;
}

function isStreamingStateError(value) {
  return getSlackStreamErrorCode(value) === 'message_not_in_streaming_state';
}

const STREAM_TASK_FIELD_LIMIT = 256;

function buildStreamAPIError(method, codeOrMessage, cause, details = '') {
  const code = typeof codeOrMessage === 'string' && /^[a-z_]+$/.test(codeOrMessage) ? codeOrMessage : getSlackStreamErrorCode(cause);
  const message = details || codeOrMessage || 'unknown_error';
  return new StreamAPIError(`chat.${method} failed: ${message}`, cause, code);
}

function assertStreamTaskField(fieldName, value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (text.length > STREAM_TASK_FIELD_LIMIT) {
    throw buildStreamAPIError(
      'appendStream',
      'invalid_chunks',
      null,
      `invalid_chunks (${fieldName} exceeds ${STREAM_TASK_FIELD_LIMIT} chars)`,
    );
  }
  return text;
}

function preserveStreamTaskField(fieldName, value) {
  if (value == null) return '';
  const text = String(value);
  if (text.length > STREAM_TASK_FIELD_LIMIT) {
    throw buildStreamAPIError(
      'appendStream',
      'invalid_chunks',
      null,
      `invalid_chunks (${fieldName} exceeds ${STREAM_TASK_FIELD_LIMIT} chars)`,
    );
  }
  return text;
}

export class SlackAdapter extends PlatformAdapter {
  constructor({ botToken, appToken, allowBots, replyBroadcast, freeResponseChannels, freeResponseUsers, dmRouting, getProfilePaths }) {
    super();
    this._botToken = botToken;
    this._slack = new WebClient(botToken);
    this._socket = new SocketModeClient({ appToken });
    this._allowBots = allowBots || 'none';
    this._replyBroadcast = replyBroadcast || false;
    this._freeResponseChannels = freeResponseChannels || new Set();
    this._freeResponseUsers = freeResponseUsers || new Set();
    this._dmRouting = dmRouting || null;
    this._getProfilePaths = getProfilePaths || null;
    this._botUserId = null;
    this._botId = null;

    this._imageCacheDir = process.env.IMAGE_CACHE_DIR || join(homedir(), '.orb', 'cache', 'images');

    // Dedup
    this._seenMessages = new Map();
    this._DEDUP_TTL = 5 * 60 * 1000;

    // Thread tracking (mentioned threads + bot-participated threads)
    this._trackedThreads = new Map();
    this._THREAD_TTL = 24 * 60 * 60 * 1000;
    this._MAX_TRACKED = 5000;

    // Bot's own message timestamps (for auto-participation in reply threads)
    this._botMessageTs = new Set();
    this._MAX_BOT_TS = 5000;

    // Bot's own individual reply timestamps (for reaction rerun validation)
    this._botReplyTs = new Set();
    this._MAX_BOT_REPLY_TS = 5000;

    // Thread context cache (60s TTL, avoids hammering Slack API)
    this._threadCtxCache = new Map();
    this._assistantThreadRootCache = new Map();
    this._THREAD_CTX_TTL = 60 * 1000;
    this._cleanupInterval = null;

    // Pending approvals
    this._pendingApprovals = new Map();
    this._blockActionInFlight = new Set();
    this._streams = new Map();
    this._teamId = null;

    // Reaction dedupe (30s per ts+reaction, avoids add/remove/add loops)
    this._reactionDedupCache = new Map();
    this._REACTION_DEDUP_TTL = 30 * 1000;

    // Callbacks (set in start())
    this.onMessage = null;
    this.onInteractive = null;
    this.onReaction = null;
  }

  get botUserId() {
    return this._botUserId;
  }

  get platform() {
    return 'slack';
  }

  get supportsInteractiveApproval() {
    return true;
  }

  // --- Dedup ---

  _isDuplicate(eventTs) {
    const now = Date.now();
    if (this._seenMessages.size > 2000) {
      // Step 1: drop anything past TTL
      for (const [ts, t] of this._seenMessages) {
        if (now - t > this._DEDUP_TTL) this._seenMessages.delete(ts);
      }
      // Step 2: still over? force-evict the 500 oldest. Otherwise under a
      // sustained high-QPS burst (whole map inside TTL window) the Map grows
      // unbounded.
      if (this._seenMessages.size > 2000) {
        const sorted = [...this._seenMessages.entries()].sort((a, b) => a[1] - b[1]);
        for (const [ts] of sorted.slice(0, 500)) {
          this._seenMessages.delete(ts);
        }
      }
    }
    if (this._seenMessages.has(eventTs)) return true;
    this._seenMessages.set(eventTs, now);
    return false;
  }

  // --- Thread tracking ---

  _trackThread(threadTs) {
    this._trackedThreads.set(threadTs, Date.now());
  }

  _isTrackedThread(threadTs) {
    return this._trackedThreads.has(threadTs);
  }

  _cleanupTrackedThreads() {
    const cutoff = Date.now() - this._THREAD_TTL;
    for (const [ts, t] of this._trackedThreads) {
      if (t < cutoff) this._trackedThreads.delete(ts);
    }
    // LRU eviction if over limit
    if (this._trackedThreads.size > this._MAX_TRACKED) {
      const sorted = [...this._trackedThreads.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, Math.floor(sorted.length / 2));
      for (const [ts] of toRemove) this._trackedThreads.delete(ts);
    }
    // Evict bot message timestamps
    if (this._botMessageTs.size > this._MAX_BOT_TS) {
      const arr = [...this._botMessageTs];
      arr.splice(0, Math.floor(arr.length / 2));
      this._botMessageTs = new Set(arr);
    }
    // Evict bot reply timestamps (reaction rerun validation)
    if (this._botReplyTs.size > this._MAX_BOT_REPLY_TS) {
      const arr = [...this._botReplyTs];
      arr.splice(0, Math.floor(arr.length / 2));
      this._botReplyTs = new Set(arr);
    }
    // Evict expired thread context cache
    const now = Date.now();
    for (const [key, entry] of this._threadCtxCache) {
      if (now - entry.fetchedAt > this._THREAD_CTX_TTL) this._threadCtxCache.delete(key);
    }
    for (const [key, entry] of this._assistantThreadRootCache) {
      if (now - entry.fetchedAt > this._THREAD_CTX_TTL) this._assistantThreadRootCache.delete(key);
    }
    // Evict expired reaction dedupe entries
    for (const [key, t] of this._reactionDedupCache) {
      if (now - t > this._REACTION_DEDUP_TTL) this._reactionDedupCache.delete(key);
    }
  }

  // --- Bot message tracking (for auto-participation) ---

  _trackBotMessage(ts) {
    this._botMessageTs.add(ts);
  }

  _isBotThread(threadTs) {
    return this._botMessageTs.has(threadTs);
  }

  async _isAssistantThreadRoot(channel, threadTs) {
    if (!channel || !threadTs) return false;
    const cacheKey = `${channel}:${threadTs}`;
    const cached = this._assistantThreadRootCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt < this._THREAD_CTX_TTL)) {
      return cached.value;
    }

    let value = false;
    try {
      const resp = await this._slack.conversations.replies({
        channel,
        ts: threadTs,
        limit: 1,
        inclusive: true,
      });
      const root = resp.messages?.[0];
      const rootText = [root?.text || '', extractBlockKitText(root?.blocks)]
        .filter(Boolean)
        .join('\n');
      value = Boolean(root?.bot_id === this._botId && /assistant thread/i.test(rootText));
    } catch (err) {
      warn(TAG, `assistant thread root lookup failed for ${cacheKey}: ${err.message}`);
    }

    this._assistantThreadRootCache.set(cacheKey, { value, fetchedAt: Date.now() });
    return value;
  }

  // --- Thread history ---

  _userNameCache = new Map();

  async _resolveUserName(userId) {
    if (!userId) return 'User';
    if (this._userNameCache.has(userId)) return this._userNameCache.get(userId);

    try {
      const result = await this._slack.users.info({ user: userId });
      const profile = result.user?.profile;
      const name = profile?.display_name || profile?.real_name || userId;
      if (this._userNameCache.size >= MAX_USERNAME_CACHE) {
        // FIFO eviction — Map preserves insertion order
        const firstKey = this._userNameCache.keys().next().value;
        this._userNameCache.delete(firstKey);
      }
      this._userNameCache.set(userId, name);
      return name;
    } catch (_) {
      return userId;
    }
  }

  async fetchThreadHistory(threadTs, channel, { bypassCache = false } = {}) {
    const MAX_HISTORY_MESSAGES = 30;
    const MAX_HISTORY_CHARS = 8000;

    if (!channel) return null;

    // Check cache (60s TTL)
    const cacheKey = `${channel}:${threadTs}`;
    if (!bypassCache) {
      const cached = this._threadCtxCache.get(cacheKey);
      if (cached && (Date.now() - cached.fetchedAt < this._THREAD_CTX_TTL)) {
        return cached.content;
      }
    }

    // Fetch with retry on rate-limit (429)
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await this._slack.conversations.replies({
          channel,
          ts: threadTs,
          limit: MAX_HISTORY_MESSAGES + 5,
          inclusive: true,
        });
        break;
      } catch (err) {
        if (err.data?.error === 'ratelimited' && attempt < 2) {
          const delay = (attempt + 1) * 1000;
          warn(TAG, `rate-limited fetching thread ${cacheKey}, retry in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    if (!result?.messages || result.messages.length <= 1) {
      this._threadCtxCache.set(cacheKey, { content: null, fetchedAt: Date.now() });
      return null;
    }

    const messages = result.messages.slice(0, -1);

    const lines = [];
    let totalChars = 0;

    for (const msg of messages) {
      if (msg.bot_id && /^:[a-z_]+:/.test(msg.text || '')) continue;

      let role;
      if (msg.bot_id) {
        role = 'Orb';
      } else {
        role = await this._resolveUserName(msg.user);
      }

      // Always-try + take-max: if msg has blocks, extract text from them and
      // use whichever is longer (msg.text vs block-kit text). Avoids a length
      // threshold which is fragile with mixed CJK/emoji cron headers.
      let text = msg.text || '';
      if (Array.isArray(msg.blocks) && msg.blocks.length > 0) {
        const blockText = extractBlockKitText(msg.blocks);
        if (blockText.length > text.length) text = blockText;
      }
      text = text.slice(0, 2000);
      const line = `${role}: ${text}`;

      if (totalChars + line.length > MAX_HISTORY_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }

    const PHASE_RE = /\[phase:([a-z-]+)\]/i;
    const segments = [];
    let current = { phase: 'legacy', msgs: [] };

    for (const line of lines) {
      if (line.startsWith('Orb: ')) {
        const m = line.match(PHASE_RE);
        if (m) {
          if (current.msgs.length > 0) segments.push(current);
          current = { phase: m[1].toLowerCase(), msgs: [line] };
          continue;
        }
      }
      current.msgs.push(line);
    }
    if (current.msgs.length > 0) segments.push(current);

    const folded = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      if (isLast || seg.phase === 'legacy' || seg.msgs.length <= 2) {
        folded.push(...seg.msgs);
      } else {
        const first = seg.msgs[0];
        const last = seg.msgs[seg.msgs.length - 1];
        const middle = seg.msgs.length - 2;
        folded.push(first);
        if (middle > 0) folded.push(`… (折叠 ${middle} 条 · phase:${seg.phase}) …`);
        folded.push(last);
      }
    }

    const content = folded.length > 0 ? folded.join('\n') : null;
    this._threadCtxCache.set(cacheKey, { content, fetchedAt: Date.now() });
    return content;
  }

  // --- Incoming file processing ---

  async _processIncomingFiles(files) {
    if (!files || files.length === 0) return { text: '', imagePaths: [] };

    const parts = [];
    const imagePaths = [];
    for (const file of files) {
      const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';
      const isText = TEXT_EXTENSIONS.has(ext) || file.mimetype?.startsWith('text/');

      if (!isText) {
        const mimeIsImage = file.mimetype?.startsWith('image/');
        const extIsImage = IMAGE_EXTENSIONS.has(ext);
        if (mimeIsImage || extIsImage) {
          if (!isSafeUrl(file.url_private)) {
            parts.push(`[附件: ${file.name} — URL 安全检查失败]`);
            continue;
          }
          try {
            const imgPath = await downloadAndCacheImage(
              file.url_private, this._botToken, this._imageCacheDir
            );
            imagePaths.push(imgPath);
            parts.push(`[图片: ${file.name} — 已传递给模型]`);
            info(TAG, `cached image: ${file.name} → ${imgPath}`);
          } catch (err) {
            parts.push(`[附件: ${file.name} — 图片处理失败: ${err.message}]`);
          }
        } else {
          parts.push(`[附件: ${file.name} (${file.mimetype}, ${file.size} bytes)]`);
        }
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        parts.push(`[附件: ${file.name} — 超出大小限制 (${file.size} bytes, 上限 100KB)]`);
        continue;
      }
      if (!isSafeUrl(file.url_private)) {
        parts.push(`[附件: ${file.name} — URL 安全检查失败]`);
        continue;
      }
      try {
        const resp = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this._botToken}` },
          redirect: 'manual',
        });
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get('location');
          if (!loc || !isSafeUrl(loc)) {
            parts.push(`[附件: ${file.name} — 重定向目标不安全]`);
            continue;
          }
          const resp2 = await fetch(loc);
          if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
          const text = await resp2.text();
          parts.push(`--- 文件: ${file.name} ---\n${text}\n--- EOF ---`);
          info(TAG, `ingested file: ${file.name} (${text.length} chars)`);
          continue;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        parts.push(`--- 文件: ${file.name} ---\n${text}\n--- EOF ---`);
        info(TAG, `ingested file: ${file.name} (${text.length} chars)`);
      } catch (err) {
        parts.push(`[附件: ${file.name} — 下载失败: ${err.message}]`);
      }
    }
    return { text: parts.join('\n\n'), imagePaths };
  }

  // --- Approval buttons ---

  _buildApprovalBlocks(prompt, approvalId) {
    if (prompt && typeof prompt === 'object' && prompt.kind === 'permission') {
      return this._buildPermissionApprovalBlocks(prompt, approvalId);
    }
    return [
      { type: 'section', text: { type: 'mrkdwn', text: prompt } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Allow Once', emoji: true },
          style: 'primary', action_id: 'orb_approve_once', value: approvalId },
        { type: 'button', text: { type: 'plain_text', text: 'Allow Session', emoji: true },
          action_id: 'orb_approve_session', value: approvalId },
        { type: 'button', text: { type: 'plain_text', text: 'Always Allow', emoji: true },
          action_id: 'orb_approve_always', value: approvalId },
        { type: 'button', text: { type: 'plain_text', text: 'Deny', emoji: true },
          style: 'danger', action_id: 'orb_deny', value: approvalId },
      ]},
    ];
  }

  _buildPermissionApprovalBlocks(prompt, approvalId) {
    const timeoutSeconds = Math.round((prompt.timeoutMs || 300_000) / 1000);
    const timeoutLabel = timeoutSeconds % 60 === 0
      ? `${Math.max(1, Math.round(timeoutSeconds / 60))} 分钟内处理`
      : `${timeoutSeconds}s 内处理`;
    const semantics = renderPermissionSemantics(prompt.toolName, prompt.toolInput);
    const debugSummary = [
      `tool=\`${prompt.toolName || 'unknown'}\``,
      `request=\`${prompt.requestId || 'unknown'}\``,
      `thread=\`${prompt.threadTs || 'unknown'}\``,
    ].join(' · ');
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*🔐 权限请求*' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${semantics.emoji} ${semantics.action}*\n${formatSlackInlineCode(semantics.targetValue)}`,
        },
      },
    ];

    if (semantics.previewTitle && semantics.previewBody) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${semantics.previewTitle}*\n${semantics.previewBody}${semantics.previewMeta ? `\n${semantics.previewMeta}` : ''}`,
        },
      });
    }

    blocks.push(
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `⏰ ${timeoutLabel}，超时自动拒绝` },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `调试: ${debugSummary}` },
          { type: 'mrkdwn', text: `raw: ${formatSlackInlineCode(this._truncateForSlackCodeBlock(semantics.rawInput || prompt.toolInput, 180))}` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '允许', emoji: true },
            style: 'primary',
            action_id: 'orb_approve_once',
            value: approvalId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '拒绝', emoji: true },
            style: 'danger',
            action_id: 'orb_deny',
            value: approvalId,
          },
        ],
      },
    );
    return blocks;
  }

  _truncateForSlackCodeBlock(value, maxChars) {
    let text;
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
    const normalized = (text || '').replace(/```/g, '` ` `');
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars - 3)}...`;
  }

  _approvalFallbackText(prompt) {
    if (prompt && typeof prompt === 'object' && prompt.kind === 'permission') {
      return `权限请求: ${prompt.toolName || 'unknown'}`;
    }
    return `承認リクエスト: ${String(prompt || '').slice(0, 100)}`;
  }

  _approvalTimeoutReason(prompt) {
    if (prompt && typeof prompt === 'object' && prompt.kind === 'permission') {
      const seconds = Math.round((prompt.timeoutMs || 300_000) / 1000);
      return `timeout: no response from Slack approval in ${seconds}s`;
    }
    return 'timeout';
  }

  _buildApprovalStatusBlocks(pending, label, extraText) {
    const toolName = pending?.prompt?.toolName || '';
    const semantics = toolName ? ` · \`${toolName}\`` : '';
    const trailing = extraText ? ` · ${extraText}` : '';
    return [{
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${label}${semantics}${trailing}` },
      ],
    }];
  }

  async sendApproval(channel, threadTs, prompt) {
    const effectivePrompt = (prompt && typeof prompt === 'object')
      ? { ...prompt, threadTs, channel }
      : prompt;
    const approvalId = `${threadTs}_${Date.now()}`;
    const blocks = this._buildApprovalBlocks(effectivePrompt, approvalId);
    const timeoutMs = (effectivePrompt && typeof effectivePrompt === 'object' && effectivePrompt.timeoutMs) ? effectivePrompt.timeoutMs : 10 * 60 * 1000;

    const msg = await this._slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      blocks,
      text: this._approvalFallbackText(effectivePrompt),
    });

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        if (this._pendingApprovals.has(approvalId)) {
          const pending = this._pendingApprovals.get(approvalId);
          this._pendingApprovals.delete(approvalId);
          const reason = this._approvalTimeoutReason(effectivePrompt);
          const label = effectivePrompt?.kind === 'permission' ? '⏰ 超时自动拒绝' : '⏰ Timed Out';
          this._slack.chat.update({
            channel,
            ts: msg.ts,
            blocks: this._buildApprovalStatusBlocks(pending, label, reason),
            text: label,
          }).catch((err) => {
            logError(TAG, `failed to update timed out approval: ${err.message}`);
          });
          resolve({ approved: false, reason, scope: 'once' });
        }
      }, timeoutMs);

      this._pendingApprovals.set(approvalId, {
        resolve,
        channel,
        threadTs,
        messageTs: msg.ts,
        timeoutHandle,
        prompt: effectivePrompt,
        blocks,
      });
    });
  }

  async _handleInteractive({ body, ack }) {
    try { await ack(); } catch (_) {}

    if (body.type !== 'block_actions' || !body.actions?.length) return;

    const action = body.actions[0];
    const approvalId = action.value;
    const actionId = action.id || action.action_id;
    const userId = body.user?.id;

    if (approvalId && this._pendingApprovals.has(approvalId)) {
      const pending = this._pendingApprovals.get(approvalId);
      this._pendingApprovals.delete(approvalId);
      clearTimeout(pending.timeoutHandle); // #22: cancel timeout if user acted early

      const approvalMap = {
        orb_approve_once: { approved: true, scope: 'once', label: '✅ Allowed Once' },
        orb_approve_session: { approved: true, scope: 'session', label: '✅ Allowed (Session)' },
        orb_approve_always: { approved: true, scope: 'always', label: '✅ Always Allowed' },
        orb_deny: { approved: false, scope: 'once', label: '❌ Denied' },
      };
      const decision = approvalMap[actionId] || { approved: false, scope: 'once', label: '❌ Denied' };
      const { approved, scope, label } = decision;

      try {
        const updatedBlocks = this._buildApprovalStatusBlocks(pending, label, `by <@${userId}>`);

        await this._slack.chat.update({
          channel: pending.channel,
          ts: pending.messageTs,
          blocks: updatedBlocks,
          text: label,
        });
      } catch (err) {
        logError(TAG, `failed to update approval message: ${err.message}`);
      }

      pending.resolve({ approved, scope, userId });
      return;
    }

    await this._dispatchBlockActionHandler({ body, action, actionId });
  }

  _rememberBlockActionMessage(messageTs) {
    this._blockActionInFlight.add(messageTs);
    const timer = setTimeout(() => {
      this._blockActionInFlight.delete(messageTs);
    }, HANDLER_DEDUP_TTL);
    timer.unref?.();
  }

  _releaseBlockActionMessage(messageTs) {
    if (!messageTs) return;
    this._blockActionInFlight.delete(messageTs);
  }

  _isBlockActionProcessingMessage(message) {
    if (!message) return false;
    const text = [message.text || '', extractBlockKitText(message.blocks)]
      .filter(Boolean)
      .join('\n');
    return text.includes('⏳ 处理中…');
  }

  _handleMessageChanged(event) {
    const messageTs = event?.message?.ts || event?.previous_message?.ts;
    if (!messageTs || !this._blockActionInFlight.has(messageTs)) return;
    if (this._isBlockActionProcessingMessage(event.message)) return;
    this._releaseBlockActionMessage(messageTs);
    info(TAG, `block_action released: message_ts=${messageTs}`);
  }

  async _updateBlockActionCard(channel, messageTs, text, originalBlocks = null) {
    const safeText = String(text || '');
    const statusBlock = {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: safeText }],
    };
    const preserved = Array.isArray(originalBlocks)
      ? originalBlocks.filter((block) => block && block.type !== 'actions')
      : [];
    const blocks = preserved.length
      ? [statusBlock, ...preserved]
      : [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: safeText },
        },
      ];
    return this._slack.chat.update({
      channel,
      ts: messageTs,
      text: safeText,
      blocks,
    });
  }

  _resolveHandlerScript(profilePaths, actionId) {
    if (!profilePaths?.scriptsDir) return null;
    const handlersDir = join(profilePaths.scriptsDir, 'handlers');
    for (const ext of HANDLER_EXTENSIONS) {
      const candidate = join(handlersDir, `${actionId}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  _getHandlerCommand(handlerPath) {
    if (handlerPath.endsWith('.py')) return { command: 'python3', args: [handlerPath] };
    if (handlerPath.endsWith('.sh')) return { command: '/bin/bash', args: [handlerPath] };
    return { command: process.execPath, args: [handlerPath] };
  }

  async _dispatchBlockActionHandler({ body, action, actionId }) {
    const channel = body.channel?.id || body.container?.channel_id;
    const messageTs = body.container?.message_ts || body.message?.ts;
    const threadTs = body.message?.thread_ts || messageTs || null;
    const userId = body.user?.id || '';
    const rawActionId = String(actionId || '');
    const originalBlocks = Array.isArray(body.message?.blocks) ? body.message.blocks : null;

    if (!channel || !messageTs) {
      warn(TAG, `block_action missing channel/message_ts: action_id=${rawActionId || 'unknown'}`);
      return;
    }

    if (!BLOCK_ACTION_HANDLER_RE.test(rawActionId)) {
      warn(TAG, `rejected block_action with invalid action_id: ${rawActionId || 'unknown'}`);
      try {
        await this._updateBlockActionCard(
          channel,
          messageTs,
          `⚠️ 未注册 handler: ${formatSlackInlineCode(rawActionId || 'unknown')} · <@${userId || 'unknown'}>`,
          originalBlocks,
        );
      } catch (err) {
        logError(TAG, `failed to update invalid handler message: ${err.message}`);
      }
      return;
    }

    let profilePaths = null;
    try {
      profilePaths = this._getProfilePaths ? this._getProfilePaths(userId) : null;
    } catch (err) {
      logError(TAG, `profile resolution failed for handler user=${userId}: ${err.message}`);
    }
    const profileName = profilePaths?.name || 'unknown';

    const handlerPath = this._resolveHandlerScript(profilePaths, rawActionId);
    if (!handlerPath) {
      warn(TAG, `unregistered handler: action_id=${rawActionId} profile=${profileName}`);
      try {
        await this._updateBlockActionCard(
          channel,
          messageTs,
          `⚠️ 未注册 handler: ${formatSlackInlineCode(rawActionId)} · <@${userId || 'unknown'}>`,
          originalBlocks,
        );
      } catch (err) {
        logError(TAG, `failed to update unregistered handler message: ${err.message}`);
      }
      return;
    }

    if (this._blockActionInFlight.has(messageTs)) {
      info(TAG, `block_action dedup: action_id=${rawActionId || 'unknown'} message_ts=${messageTs}`);
      return;
    }
    this._rememberBlockActionMessage(messageTs);

    const processingText = `⏳ 处理中… <@${userId}> clicked ${formatSlackInlineCode(rawActionId)}`;
    try {
      await this._updateBlockActionCard(channel, messageTs, processingText, originalBlocks);
    } catch (err) {
      logError(TAG, `failed to update handler processing message: ${err.message}`);
    }

    const responseUrl = body.response_url || body.response_urls?.[0]?.response_url || null;
    const context = {
      action_id: rawActionId,
      value: action.value ?? null,
      user_id: userId,
      channel,
      message_ts: messageTs,
      thread_ts: threadTs,
      profile: profilePaths?.name || null,
      response_url: responseUrl,
      message_blocks: originalBlocks,
    };

    mkdirSync(HANDLER_LOG_DIR, { recursive: true });
    const logPath = join(
      HANDLER_LOG_DIR,
      `${rawActionId}-${Date.now()}-${String(messageTs).replace(/[^\d]+/g, '_') || 'message'}.log`
    );
    writeFileSync(
      logPath,
      `${new Date().toISOString()} action_id=${rawActionId} profile=${profileName} user_id=${userId || 'unknown'}\n${JSON.stringify(context)}\n\n`,
      { flag: 'a' },
    );

    let logFd = null;
    try {
      const { command, args } = this._getHandlerCommand(handlerPath);
      logFd = openSync(logPath, 'a');
      const child = spawn(command, args, {
        cwd: profilePaths?.scriptsDir || undefined,
        detached: true,
        stdio: ['pipe', logFd, logFd],
      });

      child.on('error', (err) => {
        this._releaseBlockActionMessage(messageTs);
        logError(TAG, `handler spawn error: action_id=${rawActionId} message_ts=${messageTs} error=${err.message}`);
        this._updateBlockActionCard(
          channel,
          messageTs,
          `⚠️ handler 启动失败: ${formatSlackInlineCode(rawActionId)}`,
          originalBlocks,
        ).catch((updateErr) => {
          logError(TAG, `failed to update handler spawn error message: ${updateErr.message}`);
        });
      });
      child.stdin.on('error', () => {});
      child.stdin.write(`${JSON.stringify(context)}\n`);
      child.stdin.end();
      child.unref();
      closeSync(logFd);
      logFd = null;

      appendFileSync(
        HANDLER_PID_LOG,
        `${new Date().toISOString()} pid=${child.pid} profile=${profileName} action_id=${rawActionId} message_ts=${messageTs}\n`,
        'utf-8',
      );
      info(TAG, `handler spawned: pid=${child.pid} profile=${profileName} action_id=${rawActionId} message_ts=${messageTs} log=${logPath}`);
    } catch (err) {
      this._releaseBlockActionMessage(messageTs);
      logError(TAG, `failed to spawn handler: action_id=${rawActionId} message_ts=${messageTs} error=${err.message}`);
      try {
        await this._updateBlockActionCard(
          channel,
          messageTs,
          `⚠️ handler 启动失败: ${formatSlackInlineCode(rawActionId)}`,
          originalBlocks,
        );
      } catch (updateErr) {
        logError(TAG, `failed to update handler launch error message: ${updateErr.message}`);
      }
    } finally {
      if (logFd != null) closeSync(logFd);
    }
  }

  // --- Reply / Edit helpers ---

  async _postReply(channel, threadTs, text, extra = {}) {
    const params = { channel, thread_ts: threadTs, text, ...extra };
    if (this._replyBroadcast) params.reply_broadcast = true;
    const result = await this._slack.chat.postMessage(params);
    // Track bot's own messages for auto-participation
    if (result.ts) {
      this._trackBotMessage(threadTs);
      this._botReplyTs.add(result.ts);
    }
    return result;
  }

  async _editMessage(channel, ts, text, extra = {}) {
    const params = { channel, ts, text, ...extra };
    return this._slack.chat.update(params);
  }

  async sendReply(channel, threadTs, text, extra = {}) {
    return this._postReply(channel, threadTs, text, extra);
  }

  async editMessage(channel, ts, text, extra = {}) {
    return this._editMessage(channel, ts, text, extra);
  }

  createQiSubscriber() {
    return createSlackQiSubscriber(this);
  }

  createPlanSubscriber() {
    return createSlackPlanSubscriber(this);
  }

  createTextSubscriber() {
    return createSlackTextSubscriber(this);
  }

  createStatusSubscriber() {
    return createSlackStatusSubscriber(this);
  }

  // --- Streaming helpers ---

  normalizeTaskDisplayMode(mode) {
    return mode === 'aggregated' || mode === 'plan' ? 'plan' : 'timeline';
  }

  normalizeStreamChunks(chunks) {
    const normalized = [];
    const blocks = [];
    const pushTaskUpdate = (taskLike) => {
      if (!taskLike || typeof taskLike !== 'object') return;
      const id = String(taskLike.id || taskLike.task_id || '').trim();
      const title = assertStreamTaskField('title', taskLike.title || taskLike.text || '');
      if (!id || !title) return;

      const chunk = {
        type: 'task_update',
        id,
        title,
        status: taskLike.status === 'completed' ? 'complete' : taskLike.status,
      };

      if (!['pending', 'in_progress', 'complete', 'error'].includes(chunk.status)) {
        chunk.status = 'in_progress';
      }

      const details = typeof taskLike.details === 'string' ? preserveStreamTaskField('details', taskLike.details) : '';
      const output = typeof taskLike.output === 'string' ? assertStreamTaskField('output', taskLike.output) : '';
      if (details) chunk.details = details;
      if (output) chunk.output = output;
      if (Array.isArray(taskLike.sources) && taskLike.sources.length > 0) {
        chunk.sources = taskLike.sources;
      }
      normalized.push(chunk);
    };

    for (const chunk of Array.isArray(chunks) ? chunks : []) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'markdown_text') {
        const text = String(chunk.text || chunk.markdown_text || '').trim();
        if (text) normalized.push({ type: 'markdown_text', text });
        continue;
      }
      if (chunk.type === 'task_update') {
        pushTaskUpdate(chunk.task && typeof chunk.task === 'object' ? chunk.task : chunk);
        continue;
      }
      if (chunk.type === 'task') {
        pushTaskUpdate(chunk);
        continue;
      }
      if (chunk.type === 'plan_update') {
        const title = String(chunk.title || '').trim();
        if (title) normalized.push({ type: 'plan_update', title: title.slice(0, STREAM_TASK_FIELD_LIMIT) });
        continue;
      }
      if (chunk.type === 'blocks') {
        if (Array.isArray(chunk.blocks) && chunk.blocks.length > 0) normalized.push(chunk);
        continue;
      }
      if (chunk.type === 'text') {
        normalized.push({ type: 'markdown_text', text: String(chunk.text || '').trim() || ' ' });
        continue;
      }
      blocks.push(chunk);
    }

    if (blocks.length > 0) normalized.push({ type: 'blocks', blocks });
    return normalized;
  }

  _getStreamHandle(streamId) {
    const stream = this._streams.get(streamId);
    if (!stream) throw new StreamAPIError(`unknown stream id: ${streamId}`);
    return stream;
  }

  async _resolveStreamRecipient(channel, threadTs, teamId = null) {
    if (!channel || !threadTs || String(channel).startsWith('D')) return {};
    const resolvedTeamId = this._teamId || teamId || null;
    if (!resolvedTeamId) throw new StreamAPIError('missing Slack team_id for streaming API');

    try {
      const result = await this._slack.conversations.replies({
        channel,
        ts: threadTs,
        limit: 1,
        inclusive: true,
      });
      const recipientUserId = result?.messages?.[0]?.user;
      if (!recipientUserId) {
        throw new StreamAPIError(`failed to resolve recipient_user_id for thread ${threadTs}`);
      }
      return {
        recipient_user_id: recipientUserId,
        recipient_team_id: resolvedTeamId,
      };
    } catch (err) {
      if (err instanceof StreamAPIError) throw err;
      throw new StreamAPIError(`failed to resolve stream recipient: ${err.message}`, err);
    }
  }

  async startStream(channel, threadTs, { task_display_mode = 'timeline', initial_chunks = [], team_id = null } = {}) {
    if (!threadTs) throw new StreamAPIError('chat.startStream requires thread_ts');

    const normalizedTaskDisplayMode = this.normalizeTaskDisplayMode(task_display_mode);
    const initialChunks = this.normalizeStreamChunks(initial_chunks);

    const params = {
      channel,
      thread_ts: threadTs,
      task_display_mode: normalizedTaskDisplayMode,
      // Keep all initial text inside chunks so Slack never sees both
      // top-level markdown_text and markdown_text chunks in one request.
      chunks: initialChunks.length > 0 ? initialChunks : [{ type: 'markdown_text', text: ' ' }],
      ...(await this._resolveStreamRecipient(channel, threadTs, team_id)),
    };

    let result;
    try {
      result = await this._slack.apiCall('chat.startStream', params);
    } catch (err) {
      throw buildStreamAPIError('startStream', err.data?.error || err.message, err);
    }
    if (!result?.ok || !result?.ts) {
      throw buildStreamAPIError('startStream', result?.error || 'missing_ts');
    }

    const streamId = `${channel}:${result.ts}`;
    const initialLen = initialChunks.reduce((s, c) => s + (c?.text?.length || 0), 0);
    info(TAG, `[slack:startStream] stream_id=${streamId} display_mode=${normalizedTaskDisplayMode} initial_chunks=${initialChunks.length} initial_len=${initialLen}`);
    this._streams.set(streamId, {
      channel,
      ts: result.ts,
      startedAt: Date.now(),
      appendCount: 0,
      totalAppendLen: 0,
      lastAppendAt: null,
    });
    return { stream_id: streamId, ts: result.ts };
  }

  async appendStream(streamId, chunks) {
    const stream = this._getStreamHandle(streamId);
    const normalizedChunks = this.normalizeStreamChunks(chunks);
    if (normalizedChunks.length === 0) return;
    const appendLen = normalizedChunks.reduce((s, c) => s + (c?.text?.length || 0), 0);

    let result;
    try {
      result = await this._slack.apiCall('chat.appendStream', {
        channel: stream.channel,
        ts: stream.ts,
        chunks: normalizedChunks,
      });
    } catch (err) {
      if (isStreamingStateError(err) || getSlackStreamErrorCode(err) === 'message_not_owned_by_app') {
        this._streams.delete(streamId);
      }
      info(TAG, `[slack:appendStream:error] stream_id=${streamId} error=${err.data?.error || err.message} chunks=${normalizedChunks.length} len=${appendLen} n=${stream.appendCount || 0} total_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('appendStream', err.data?.error || err.message, err);
    }
    if (!result?.ok) {
      if (isStreamingStateError(result) || getSlackStreamErrorCode(result) === 'message_not_owned_by_app') {
        this._streams.delete(streamId);
      }
      info(TAG, `[slack:appendStream:error] stream_id=${streamId} error=${result?.error || 'unknown_error'} chunks=${normalizedChunks.length} len=${appendLen} n=${stream.appendCount || 0} total_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('appendStream', result?.error || 'unknown_error');
    }
    const now = Date.now();
    const sinceLast = stream.lastAppendAt ? now - stream.lastAppendAt : null;
    stream.appendCount = (stream.appendCount || 0) + 1;
    stream.totalAppendLen = (stream.totalAppendLen || 0) + appendLen;
    stream.lastAppendAt = now;
    const lifeMs = stream.startedAt ? now - stream.startedAt : null;
    if (streamTrace()) {
      info(TAG, `[slack:appendStream] stream_id=${streamId} chunks=${normalizedChunks.length} len=${appendLen} since_last_ms=${sinceLast ?? 'null'} n=${stream.appendCount} total_len=${stream.totalAppendLen} life_ms=${lifeMs}`);
    }
  }

  async stopStream(streamId, { markdown_text, blocks, chunks, final_blocks } = {}) {
    const stream = this._getStreamHandle(streamId);
    const normalizedChunks = this.normalizeStreamChunks(chunks);
    const finalBlocks = Array.isArray(blocks) && blocks.length > 0
      ? blocks
      : Array.isArray(final_blocks) && final_blocks.length > 0
        ? final_blocks
        : null;
    const finalText = typeof markdown_text === 'string' ? markdown_text.trim() : '';
    if (finalText && streamTrace()) {
      info(TAG, `[slack:stopStream] emitting markdown_text as implicit post (len=${finalText.length}, channel=${stream.channel}, ts=${stream.ts})`);
    }

    // Slack rejects markdown_text + chunks in the same call; fold final text
    // into chunks to match startStream behavior.
    if (finalText && normalizedChunks.length > 0) {
      normalizedChunks.push({ type: 'markdown_text', text: finalText });
    }
    const sendMarkdownTop = Boolean(finalText) && normalizedChunks.length === 0;

    let result;
    try {
      const lifeMs = stream.startedAt ? Date.now() - stream.startedAt : null;
      info(TAG, `[slack:stopStream] summary stream_id=${streamId} life_ms=${lifeMs} total_appends=${stream.appendCount || 0} total_append_len=${stream.totalAppendLen || 0} final_len=${finalText.length} final_blocks=${finalBlocks ? finalBlocks.length : 0}`);
      result = await this._slack.apiCall('chat.stopStream', {
        channel: stream.channel,
        ts: stream.ts,
        ...(normalizedChunks.length > 0 ? { chunks: normalizedChunks } : {}),
        ...(sendMarkdownTop ? { markdown_text: finalText } : {}),
        ...(finalBlocks ? { blocks: finalBlocks } : {}),
      });
    } catch (err) {
      info(TAG, `[slack:stopStream:error] stream_id=${streamId} error=${err.data?.error || err.message} total_appends=${stream.appendCount || 0} total_append_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('stopStream', err.data?.error || err.message, err);
    } finally {
      this._streams.delete(streamId);
    }
    if (!result?.ok) {
      info(TAG, `[slack:stopStream:error] stream_id=${streamId} error=${result?.error || 'unknown_error'} total_appends=${stream.appendCount || 0} total_append_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('stopStream', result?.error || 'unknown_error');
    }
  }

  // --- PlatformAdapter interface ---

  async uploadFile(channel, threadTs, filePath, filename) {
    try {
      await this._slack.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: createReadStream(filePath),
        filename: filename || filePath.split('/').pop(),
      });
      info(TAG, `uploaded file: ${filename || filePath}`);
    } catch (err) {
      logError(TAG, `file upload failed: ${err.message}`);
      await this._postReply(channel, threadTs, `:warning: 文件上传失败: ${filename || filePath}`);
    }
  }

  async setThreadStatus(channel, threadTs, status, loadingMessages) {
    if (!channel || !threadTs) return;
    try {
      const payload = {
        channel_id: channel,
        thread_ts: threadTs,
        status: String(status || ''),
      };
      if (Array.isArray(loadingMessages) && loadingMessages.length > 0) {
        payload.loading_messages = loadingMessages.slice(0, 10).map(String);
      }
      await this._slack.apiCall('assistant.threads.setStatus', payload);
    } catch (err) {
      if (isIgnorableAssistantThreadError(err)) return;
      warn(TAG, `setThreadStatus failed: ${err.message}`);
    }
  }

  async setThreadTitle(channel, threadTs, title) {
    if (!channel || !threadTs || !title) return;
    try {
      await this._slack.apiCall('assistant.threads.setTitle', {
        channel_id: channel,
        thread_ts: threadTs,
        title: String(title).trim().slice(0, 60),
      });
    } catch (err) {
      if (isIgnorableAssistantThreadError(err)) return;
      warn(TAG, `setThreadTitle failed: ${err.message}`);
    }
  }

  async setSuggestedPrompts(channel, threadTs, prompts) {
    if (!channel || !threadTs || !Array.isArray(prompts) || prompts.length === 0) return;
    const normalizedPrompts = prompts
      .filter((prompt) => prompt?.title && prompt?.message)
      .slice(0, 4)
      .map((prompt) => ({
        title: String(prompt.title).trim().slice(0, 60),
        message: String(prompt.message).trim().slice(0, 200),
      }));
    if (normalizedPrompts.length === 0) return;
    try {
      await this._slack.apiCall('assistant.threads.setSuggestedPrompts', {
        channel_id: channel,
        thread_ts: threadTs,
        prompts: normalizedPrompts,
      });
    } catch (err) {
      if (isIgnorableAssistantThreadError(err)) return;
      warn(TAG, `setSuggestedPrompts failed: ${err.message}`);
    }
  }

  async setTyping(channel, threadTs, status) {
    await this.setThreadStatus(channel, threadTs, status);
  }

  buildPayloads(text) {
    return buildSendPayloads(text);
  }

  async cleanupIndicator(channel, threadTs, typingSet, errorMsg) {
    if (typingSet) await this.setThreadStatus(channel, threadTs, '').catch(() => {});
    try {
      await this._postReply(channel, threadTs, `:warning: ${errorMsg}`);
    } catch (err) {
      logError(TAG, `failed to send error msg: ${err.message}`);
    }
  }

  async disconnect() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._socket.disconnect();
  }

  // --- DM content-based routing (v2.1) ---
  //
  // Routes 1:1 DM messages to target channels based on rules in
  // config.adapters.slack.dmRouting. On match:
  //   1. Posts main card (short header) to target channel — only visible message
  //   2. Synthesizes a task whose userText is the interpolated workerPrompt
  //      (NOT posted to Slack — passed straight to worker)
  //   3. Worker produces the 3-section Block Kit approval card as its first output
  //   4. DM stays silent (iron rule from v1 spec)
  // Returns true if routed (caller should skip normal worker dispatch).

  _matchDMRule(rule, text, files) {
    const m = rule.match || {};

    if (m.hasFile) {
      if (!files || files.length === 0) return null;
      const fileRe = m.filenamePattern ? safeRegex(m.filenamePattern) : null;
      const wantType = m.filetype ? String(m.filetype).toLowerCase() : null;
      for (const f of files) {
        const name = f.name || '';
        const ext = (name.split('.').pop() || '').toLowerCase();
        const ftype = (f.filetype || '').toLowerCase();
        if (wantType && ext !== wantType && ftype !== wantType) continue;
        if (fileRe && !fileRe.test(name)) continue;
        return {
          file: f,
          filename: name,
          preview: name,
          original_text: text || '',
        };
      }
      return null;
    }

    if (m.urlPattern) {
      const re = safeRegex(m.urlPattern);
      if (!re) return null;
      const found = text ? text.match(re) : null;
      if (!found) return null;
      const url = found[0];
      return {
        urlMatched: url,
        url_matched: url,
        preview: this._makePreview(url),
        repo_slug: this._extractRepoSlug(url),
        original_text: text || '',
      };
    }

    return null;
  }

  _extractRepoSlug(url) {
    if (!url) return '';
    const m = String(url).match(/github\.com\/([^/\s]+)\/([^/\s?#]+)/);
    if (!m) return '';
    const owner = m[1];
    const name = m[2].replace(/\.git$/, '');
    return `${owner}/${name}`;
  }

  _dateMMDD(d = new Date()) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}`;
  }

  _makePreview(s, max = 40) {
    if (!s) return '';
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  }

  _interpRuleTemplate(template, ctx) {
    return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
      const v = ctx[key];
      return v == null ? '' : String(v);
    });
  }

  async _downloadDMFile(file, event, userId) {
    if (!file?.url_private) throw new Error('no url_private');
    if (!isSafeUrl(file.url_private)) throw new Error('unsafe URL');

    let inboxDir;
    if (this._getProfilePaths && userId) {
      const paths = this._getProfilePaths(userId);
      inboxDir = join(paths.workspaceDir, 'work', 'inbox');
    } else {
      inboxDir = join(homedir(), '.orb', 'dm-inbox');
    }
    mkdirSync(inboxDir, { recursive: true });

    const safeName = (file.name || 'file.bin').replace(/[\/\\]/g, '_');
    const ts = event.ts || String(Date.now());
    const dest = join(inboxDir, `${ts}_${safeName}`);

    const resp = await fetch(file.url_private, {
      headers: { Authorization: `Bearer ${this._botToken}` },
      redirect: 'manual',
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc || !isSafeUrl(loc)) throw new Error('unsafe redirect');
      const resp2 = await fetch(loc);
      if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
      writeFileSync(dest, Buffer.from(await resp2.arrayBuffer()));
      return dest;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
    return dest;
  }

  async _routeDMMessage(event) {
    const cfg = this._dmRouting;
    if (!cfg?.enabled) return { routed: false };

    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    const text = event.text || '';
    const files = event.files || [];

    let matched = null;
    for (const rule of rules) {
      const ctx = this._matchDMRule(rule, text, files);
      if (ctx) { matched = { rule, ctx }; break; }
    }

    if (!matched) {
      return { routed: false, fallback: cfg.dmFallback || 'worker' };
    }

    const { rule, ctx } = matched;

    if (ctx.file) {
      try {
        ctx.localPath = await this._downloadDMFile(ctx.file, event, event.user);
        info(TAG, `DM file downloaded: ${ctx.localPath}`);
      } catch (err) {
        warn(TAG, `DM file download failed for rule=${rule.name}: ${err.message}`);
        ctx.localPath = null;
      }
    }
    ctx.date_mmdd = this._dateMMDD();

    const buildWorkerPrompt = () => {
      const tpl = rule.target.workerPrompt || rule.target.threadBootstrap || '';
      let workerPrompt = this._interpRuleTemplate(tpl, ctx);
      if (ctx.file) {
        workerPrompt += ctx.localPath
          ? `\n\n[附件已下载到: ${ctx.localPath}]`
          : `\n\n[附件下载失败，请手动从 Slack 获取：${ctx.file.name}]`;
      }
      return workerPrompt;
    };

    try {
      const mainText = this._interpRuleTemplate(rule.target.mainTemplate, ctx);
      const mainMsg = await this._slack.chat.postMessage({
        channel: rule.target.channel,
        text: mainText,
        unfurl_links: false,
      });
      if (!mainMsg.ts) throw new Error('postMessage returned no ts');
      this._trackBotMessage(mainMsg.ts);
      this._trackThread(mainMsg.ts);

      const workerPrompt = buildWorkerPrompt();

      if (this.onMessage) {
        const task = {
          userText: workerPrompt,
          fileContent: '',
          imagePaths: [],
          threadTs: mainMsg.ts,
          channel: rule.target.channel,
          userId: event.user,
          platform: 'slack',
          teamId: event.team || event.team_id || null,
          threadHistory: null,
        };
        this.onMessage(task);
      }

      info(TAG, `DM routed: rule=${rule.name} source_dm=${event.ts} → ${rule.target.channel}/${mainMsg.ts}`);
      return { routed: true };
    } catch (err) {
      logError(TAG, `DM routing failed (rule=${rule.name}): ${err.message}`);
      try {
        const pendingText = [
          this._interpRuleTemplate(rule.target.mainTemplate || '待补', ctx),
          '',
          '待补：DM 路由已命中，但自动建卡/启动 worker 时遇到 Slack API 故障；请稍后补处理。',
        ].filter((line) => line !== null && line !== undefined).join('\n');
        const pendingMsg = await this._slack.chat.postMessage({
          channel: rule.target.channel,
          text: pendingText,
          unfurl_links: false,
        });
        if (pendingMsg.ts) {
          this._trackBotMessage(pendingMsg.ts);
          this._trackThread(pendingMsg.ts);
        }
      } catch (pendingErr) {
        logError(TAG, `DM routing degraded card failed (rule=${rule.name}): ${pendingErr.message}`);
      }
      return { routed: true, degraded: true };
    }
  }

  // --- Message handler ---

  async _handleMessage({ event, ack }) {
    try { await ack(); } catch (err) {
      logError(TAG, `ack failed: ${err.message}`);
      return;
    }

    if (event.subtype === 'message_changed') {
      this._handleMessageChanged(event);
      return;
    }

    // Bot message filtering
    if (event.bot_id) {
      if (event.bot_id === this._botId) return;
      if (this._allowBots === 'none') return;
      if (this._allowBots === 'mentions' && !event.text?.includes(`<@${this._botUserId}>`)) return;
    }
    if (event.subtype && event.subtype !== 'file_share') return;

    const eventTs = event.event_ts || event.ts;
    if (this._isDuplicate(eventTs)) {
      info(TAG, `dedup: skipping already-seen event ${eventTs}`);
      return;
    }

    // Detect DM: both 1:1 (im) and group DM (mpim)
    const channelType = event.channel_type || (event.channel?.startsWith('D') ? 'im' : '');
    const isDM = channelType === 'im' || channelType === 'mpim';
    const isMention = event.text?.includes(`<@${this._botUserId}>`);
    const threadTs = event.thread_ts || event.ts;
    const tracked = this._isTrackedThread(threadTs);
    const isBotThread = event.thread_ts && this._isBotThread(event.thread_ts);
    let isAssistantThread = false;
    if (isDM && channelType === 'im' && event.thread_ts && !event.bot_id && !isBotThread) {
      const assistantThreadRoot = event.assistant_thread
        ? true
        : await this._isAssistantThreadRoot(event.channel, event.thread_ts);
      // Slack AI Assistant roots are server-created, so Orb never tracks them
      // via chat.postMessage; fall back to the human DM thread heuristic.
      isAssistantThread = assistantThreadRoot || Boolean(event.user);
    }

    // DM content-based routing (v2) — allow Slack AI Assistant threads through,
    // but keep Orb-created worker threads on the normal worker path.
    if (isDM && channelType === 'im' && (!event.thread_ts || isAssistantThread) && this._dmRouting?.enabled) {
      const outcome = await this._routeDMMessage(event);
      if (outcome.routed) return;
      if (outcome.fallback === 'silent') {
        info(TAG, `DM unmatched, silent fallback: user=${event.user} ts=${event.ts}`);
        return;
      }
      // fallback === 'worker' → fall through to normal handling
    }

    const isFreeResponse = this._freeResponseChannels.has(event.channel) && this._freeResponseUsers.has(event.user);
    if (!isDM && !isMention && !tracked && !isBotThread && !isFreeResponse) return;
    if (isMention || isDM || isFreeResponse) this._trackThread(threadTs);

    const userText = (event.text || '')
      .replace(new RegExp(`<@${this._botUserId}>`, 'g'), '')
      .trim();

    if (!userText && (!event.files || event.files.length === 0)) return;

    const channel = event.channel;
    const userId = event.user;

    // Process incoming file attachments
    let fileContent = '';
    let imagePaths = [];
    if (event.files && event.files.length > 0) {
      const result = await this._processIncomingFiles(event.files);
      fileContent = result.text;
      imagePaths = result.imagePaths;
      info(TAG, `processed ${event.files.length} incoming file(s), ${imagePaths.length} image(s)`);
    }

    // Resolve Slack thread URLs → fetch referenced conversation context
    let linkedContext = '';
    const linkedUrls = extractSlackThreadUrls(userText);
    if (linkedUrls.length > 0) {
      const seen = new Set();
      for (const { channel: linkCh, threadTs: linkTs } of linkedUrls) {
        const key = `${linkCh}:${linkTs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const history = await this.fetchThreadHistory(linkTs, linkCh);
          if (history) {
            linkedContext += `\n--- 引用对话 (${linkCh}/${linkTs}) ---\n${history}\n--- END ---\n`;
            info(TAG, `fetched linked thread: ${linkCh}/${linkTs}`);
          }
        } catch (err) {
          logError(TAG, `failed to fetch linked thread ${linkCh}/${linkTs}: ${err.message}`);
        }
      }
    }

    info(TAG, `msg: ch=${channel} thread=${threadTs} user=${userId} text="${(userText || '[files only]').slice(0, 80)}"`);

    const task = {
      userText,
      fileContent: fileContent + linkedContext,
      imagePaths,
      threadTs,
      channel,
      userId,
      platform: 'slack',
      teamId: event.team || event.team_id || null,
      threadHistory: null,
    };

    // Fetch thread history (only for thread replies, not new conversations)
    if (event.thread_ts) {
      try {
        task.threadHistory = await this.fetchThreadHistory(threadTs, channel);
      } catch (err) {
        logError(TAG, `failed to fetch thread history: ${err.message}`);
      }
    }

    if (this.onMessage) {
      this.onMessage(task);
    }
  }

  // --- Reaction handler (🔥 → rerun at xhigh) ---

  async _handleReaction({ event, ack }) {
    try { await ack(); } catch (_) {}

    if (!event) return;
    if (event.reaction !== 'fire') return;
    if (event.item?.type !== 'message') return;

    const { channel, ts: targetTs } = event.item;
    if (!channel || !targetTs) return;

    // Only bot's own replies are eligible
    if (!this._botReplyTs.has(targetTs)) {
      info(TAG, `ignored fire reaction on non-bot message: ${targetTs}`);
      return;
    }

    // Dedupe: same ts+reaction within 30s ignored (handles rapid add/remove/add)
    const dedupKey = `${targetTs}:${event.reaction}`;
    const now = Date.now();
    const last = this._reactionDedupCache.get(dedupKey);
    if (last && now - last < this._REACTION_DEDUP_TTL) {
      info(TAG, `reaction dedupe: ${dedupKey} (last=${now - last}ms ago)`);
      return;
    }
    this._reactionDedupCache.set(dedupKey, now);

    const thread = await this._fetchThreadForReaction(channel, targetTs);
    if (!thread) {
      warn(TAG, `no preceding user message for reaction on ${targetTs}`);
      return;
    }
    const { threadTs, userText, userId } = thread;

    info(TAG, `fire reaction → rerun: thread=${threadTs} target=${targetTs} user=${userId}`);

    if (this.onReaction) {
      this.onReaction({
        platform: 'slack',
        channel,
        threadTs,
        targetMessageTs: targetTs,
        userText: `[effort:xhigh] ${userText}`,
        userId,
        teamId: event.team || event.team_id || null,
        threadHistory: null,
        rerun: true,
      });
    }
  }

  async _fetchThreadForReaction(channel, botMessageTs) {
    try {
      // Step 1: fetch the reacted message to discover thread_ts
      const msgResp = await this._slack.conversations.replies({
        channel,
        ts: botMessageTs,
        limit: 1,
        inclusive: true,
      });
      const botMsg = msgResp.messages?.[0];
      if (!botMsg) return null;
      const threadTs = botMsg.thread_ts || botMessageTs;

      // Step 2: fetch full thread, walk backwards from bot msg to nearest user msg
      const threadResp = await this._slack.conversations.replies({
        channel,
        ts: threadTs,
        limit: 100,
        inclusive: true,
      });
      const messages = threadResp.messages || [];

      const idx = messages.findIndex((m) => m.ts === botMessageTs);
      if (idx < 0) return null;

      for (let i = idx - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.user && m.user !== this._botUserId && !m.bot_id) {
          return {
            threadTs,
            userText: m.text || '',
            userId: m.user,
          };
        }
      }
      return null;
    } catch (err) {
      logError(TAG, `_fetchThreadForReaction: ${err.message}`);
      return null;
    }
  }

  // --- Start ---

  async start(onMessage, onInteractive) {
    this.onMessage = onMessage;
    this.onInteractive = onInteractive;

    const auth = await this._slack.auth.test();
    this._botUserId = auth.user_id;
    this._botId = auth.bot_id;
    this._teamId = auth.team_id || null;
    info(TAG, `booted as @${auth.user} (${this._botUserId}, bot=${this._botId})`);

    this._socket.on('message', (evt) => this._handleMessage(evt));
    this._socket.on('interactive', (evt) => this._handleInteractive(evt));
    this._socket.on('reaction_added', (evt) => this._handleReaction(evt));

    this._socket.on('disconnect', (err) => {
      warn(TAG, `socket disconnected: ${err || 'unknown'}`);
    });
    this._socket.on('error', (err) => {
      logError(TAG, `socket error: ${err?.message || err}`);
    });
    this._socket.on('reconnecting', () => {
      info(TAG, 'socket reconnecting...');
    });

    await this._socket.start();
    info(TAG, `socket connected, reply_broadcast=${this._replyBroadcast}`);

    // Periodic cleanup every 30 min
    this._cleanupInterval = setInterval(() => {
      this._cleanupTrackedThreads();
      cleanImageCache(this._imageCacheDir).catch(() => {});
      info(TAG, `cleanup: trackedThreads=${this._trackedThreads.size} seenMessages=${this._seenMessages.size}`);
    }, 30 * 60 * 1000);
  }
}
