import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { info, error as logError, warn } from './log.js';
import { taskQueue } from './queue.js';
import { sanitizeErrorText } from './format-utils.js';
import { listFacts, storeLesson, storeCorrectionLesson, purgeTransient, lintMemory } from './memory.js';
import { spawnWorker } from './spawn.js';
import { getDefaults } from './config.js';
import { extractSuggestedPrompts } from './adapters/slack-format.js';
import { writeLessonCandidate, isUserCorrectionText } from './lesson-candidates.js';
import { assessSkillReviewTrigger } from './skill-review-trigger.js';
import {
  ASSISTANT_TEXT_FINAL,
  CONTROL_PLANE_MESSAGE,
  METADATA_TITLE,
  makeTurnId,
} from './turn-delivery/intents.js';
import { TurnDeliveryLedger, ledgerPathForDataDir } from './turn-delivery/ledger.js';
import { TurnDeliveryOrchestrator } from './turn-delivery/orchestrator.js';
const TAG = 'scheduler';
const DRAIN_TIMEOUT = 30_000;
const SKILL_REVIEW_THRESHOLD = 10;   // cumulative tool uses before triggering review
const MEMORY_SYNC_THRESHOLD = 20;    // cumulative tool uses before memory/user sync
const MEMORY_SYNC_INTERVAL = 6 * 60 * 60 * 1000;  // min 6h between syncs per profile
const MAX_AUTO_CONTINUE = 2;  // max auto-retries on empty result (context overflow)
const PERMISSION_APPROVAL_TIMEOUT_MS = parseInt(process.env.ORB_PERMISSION_TIMEOUT_MS, 10) || 300_000;
const STATUS_REFRESH_MS = 20_000;
const SHUTDOWN_QUEUE_FILE = 'shutdown-queue.json';
const SHUTDOWN_QUEUE_VERSION = 2;
const SILENT_PREFIX = '[SILENT]';
const LOADING_MESSAGES = [
  'Cooking…',
  'Reading files…',
  'Thinking…',
  'Working on it…',
  'Analyzing…',
];
const THINKING_STATUS = LOADING_MESSAGES[0];
const PERSISTED_TASK_FIELDS = [
  'userText',
  'fileContent',
  'imagePaths',
  'threadTs',
  'channel',
  'userId',
  'platform',
  'teamId',
  'profile',
  'model',
  'effort',
  'maxTurns',
  'deliveryThreadTs',
  'rerun',
  'targetMessageTs',
  'forceNewWorker',
  'mode',
  'priorConversation',
  'deferDeliveryUntilResult',
  'enableTaskCard',
  'channelSemantics',
  'attemptId',
];

// --- Effort escalation keywords ---
// 命中任一关键词且消息长度 > 20 字 → 升到 xhigh
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

// 英文 review 单独处理（太常见，需要更严格的上下文）
const ENGLISH_REVIEW_PATTERNS = [
  /\breview\s+一下\b/i,
  /\b帮\s*(我\s*)?review\b/i,
  /\b做个\s*review\b/i,
  /\breview\s+(这段|这个|下面|代码|PR)\b/i,
  /\b深度\s*review\b/i,
];

function shouldEscalateEffort(text) {
  if (!text || text.length < 20) return false;
  for (const kw of ESCALATE_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  for (const re of ENGLISH_REVIEW_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

function sanitizeTaskForPersistence(task) {
  if (!task || typeof task !== 'object') return null;
  const persisted = {};
  for (const field of PERSISTED_TASK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(task, field)) {
      persisted[field] = task[field];
    }
  }
  return persisted;
}

function makeAttemptId() {
  return `attempt-${randomUUID()}`;
}

function ensureAttemptId(task) {
  if (!task || typeof task !== 'object') return task;
  if (!task.attemptId) task.attemptId = makeAttemptId();
  return task.attemptId;
}

function taskDedupKey(task, fallbackThreadTs = null) {
  const attemptId = task?.attemptId;
  if (!attemptId) return null;
  const threadTs = task?.threadTs || fallbackThreadTs;
  if (!threadTs) return null;
  return `${threadTs}:${attemptId}`;
}

function isSilentResultText(text) {
  return typeof text === 'string' && text.startsWith(SILENT_PREFIX);
}

function normalizeChannelSemantics(value) {
  return value === 'silent' || value === 'broadcast' ? value : 'reply';
}

function isSuccessfulStopReason(stopReason) {
  return !stopReason || stopReason === 'success' || stopReason === 'stop' || stopReason === 'end_turn';
}

function shouldSuppressForChannelSemantics(channelSemantics, stopReason) {
  return channelSemantics === 'silent' && isSuccessfulStopReason(stopReason);
}

function getTaskCardStreamErrorCode(err) {
  if (!err) return null;
  if (typeof err.slackErrorCode === 'string' && err.slackErrorCode) return err.slackErrorCode;
  const match = String(err.message || '').match(/chat\.(?:start|append|stop)Stream failed: ([a-z_]+)/);
  return match?.[1] || null;
}

export function makeTaskCardState({ enabled = false, deferred = false } = {}) {
  return {
    enabled: Boolean(enabled),
    deferred: Boolean(deferred),
    streamId: null,
    failed: false,
  };
}

function makeTurnState(taskCardConfig) {
  return {
    typingActive: false,
    pendingThreadStatus: '',
    pendingStatusLoadingMessages: null,
    statusRefreshTimer: null,
    abandoned: false,
    taskCardState: makeTaskCardState(taskCardConfig),
  };
}

async function emitEphemeralControlPlane({ adapter, channel, threadTs, platform, text, source = 'scheduler.control_plane' }) {
  const orchestrator = new TurnDeliveryOrchestrator({ adapter, logger: (line) => warn(TAG, line) });
  const turnId = makeTurnId({ threadTs, attemptId: `control-${Date.now()}` });
  orchestrator.beginTurn({ turnId, channel, threadTs, platform, channelSemantics: 'reply' });
  return orchestrator.emit({
    turnId,
    channel,
    threadTs,
    platform,
    intent: CONTROL_PLANE_MESSAGE,
    text,
    source,
  });
}

export function buildQiSettledChunks(toolCount = 0, reason = '') {
  const details = reason
    ? `Settled: ${reason}`
    : `Distilled from ${Number.isFinite(Number(toolCount)) ? Number(toolCount) : 0} probes`;
  return [
    { type: 'plan_update', title: 'Settled' },
    { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'complete' },
    { type: 'task_update', id: 'qi-other', title: 'Delegate', status: 'complete' },
    { type: 'task_update', id: 'qi-summary', title: 'Distill', status: 'complete', details },
  ];
}

export async function abandonTurnState({
  turn,
  adapter,
  channel,
  threadTs,
  canManageThreadStatus = channel != null && threadTs != null && typeof adapter?.setThreadStatus === 'function',
}) {
  if (!turn || turn.abandoned) return false;
  const shouldClearThreadStatus = Boolean(turn.typingActive && canManageThreadStatus);
  turn.abandoned = true;
  if (turn.statusRefreshTimer) {
    clearTimeout(turn.statusRefreshTimer);
    turn.statusRefreshTimer = null;
  }
  if (shouldClearThreadStatus) {
    try {
      await adapter.setThreadStatus(channel, threadTs, '', null);
      turn.typingActive = false;
      turn.pendingThreadStatus = '';
      turn.pendingStatusLoadingMessages = null;
    } catch (err) {
      warn(TAG, `failed to clear abandoned thread status: ${err.message}`);
    }
  }
  return true;
}

export function buildRespawnTaskForInjectFailed({
  msg,
  failedTask,
  task,
  threadTs,
  effectiveThreadTs,
  channel,
  userId,
  platform,
  profile,
  deferDeliveryUntilResult,
  channelSemantics,
}) {
  return {
    ...(failedTask || {}),
    userText: msg.userText ?? failedTask?.userText ?? '',
    fileContent: msg.fileContent ?? failedTask?.fileContent ?? '',
    imagePaths: Array.isArray(msg.imagePaths)
      ? msg.imagePaths
      : (failedTask?.imagePaths || []),
    threadTs,
    deliveryThreadTs: failedTask?.deliveryThreadTs === undefined
      ? effectiveThreadTs
      : failedTask.deliveryThreadTs,
    channel,
    userId,
    platform,
    teamId: failedTask?.teamId ?? task.teamId ?? null,
    threadHistory: failedTask?.threadHistory ?? task.threadHistory,
    profile: failedTask?.profile ?? profile,
    maxTurns: failedTask?.maxTurns ?? task.maxTurns ?? null,
    enableTaskCard: failedTask?.enableTaskCard ?? task.enableTaskCard,
    deferDeliveryUntilResult: failedTask?.deferDeliveryUntilResult ?? deferDeliveryUntilResult,
    channelSemantics: normalizeChannelSemantics(failedTask?.channelSemantics ?? task.channelSemantics ?? channelSemantics),
    attemptId: failedTask?.attemptId ?? msg.attemptId ?? task.attemptId ?? makeAttemptId(),
  };
}

export class EventBus {
  constructor({ subscriberTimeoutMs = 5_000 } = {}) {
    this.subscribers = new Set();
    this.subscriberTimeoutMs = subscriberTimeoutMs;
  }

  subscribe(subscriber) {
    if (!subscriber || (typeof subscriber !== 'function' && typeof subscriber.handle !== 'function')) {
      throw new TypeError('EventBus subscriber must be a function or an object with handle()');
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async publish(msg, ctx = {}) {
    const errors = [];
    for (const subscriber of [...this.subscribers]) {
      try {
        await this._publishToSubscriber(subscriber, msg, ctx);
      } catch (err) {
        errors.push(err);
        warn(TAG, `eventBus subscriber failed: ${err.message}`);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `EventBus publish failed for ${errors.length} subscriber(s)`);
    }
  }

  async _publishToSubscriber(subscriber, msg, ctx) {
    return this._withSubscriberTimeout(async () => {
      const match = typeof subscriber === 'function'
        ? true
        : (typeof subscriber.match === 'function' ? await subscriber.match(msg, ctx) : true);
      if (!match) return;
      if (typeof subscriber === 'function') await subscriber(msg, ctx);
      else await subscriber.handle(msg, ctx);
    });
  }

  _withSubscriberTimeout(operation) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`subscriber timed out after ${this.subscriberTimeoutMs}ms`)), this.subscriberTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    return Promise.race([operation(), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}

export class Scheduler {
  constructor({ maxWorkers, timeoutMs, getProfile, startPermissionServer = true, spawnWorkerFn = spawnWorker }) {
    this.maxWorkers = maxWorkers || 3;
    this.timeoutMs = timeoutMs || parseInt(process.env.ORB_WORKER_TIMEOUT_MS, 10) || 1_800_000;
    this.getProfile = getProfile;
    this.eventBus = new EventBus();
    this.adapters = new Map();     // platform → adapter
    this.activeWorkers = new Map();
    this.threadQueues = new Map();
    this._skillToolCounts = new Map();   // profileName → cumulative tool count
    this._memorySyncCounts = new Map();  // profileName → cumulative tool count for memory sync
    this._lastMemorySync = new Map();    // profileName → timestamp of last sync
    this._autoContinueCount = new Map(); // threadTs → retry count for empty results
    this._backgroundWorkers = new Set(); // skill-review + memory-sync workers
    this._maxBackgroundWorkers = 2;
    this._nextInjectId = 1;
    this._spawnWorkerFn = spawnWorkerFn;
    this._turnDeliveryLedgers = new Map();
    this._pendingPermissionRequests = new Map();
    this._permissionApprovalMode = process.env.ORB_PERMISSION_APPROVAL_MODE || 'auto-allow';
    this._permissionSocketPath = join(tmpdir(), `orb-permission-scheduler-${process.pid}.sock`);
    this._permissionServer = null;
    if (process.env.ORB_EVENTBUS_SMOKE_LOG === '1') {
      this.eventBus.subscribe({
        match: (msg) => msg?.type === 'cc_event',
        handle: (msg) => info(TAG, `eventBus cc_event: turn=${msg.turnId || 'unknown'} event=${msg.eventType || 'unknown'}`),
      });
    }
    globalThis.__orbSchedulerInstance = this;
    if (startPermissionServer !== false) this._startPermissionServer();
    this._restoreShutdownQueues();
  }

  addAdapter(name, adapter) {
    if (typeof adapter?.deliver !== 'function') throw new Error('adapter must implement deliver()');
    if (typeof adapter.setAdapterEventLedgerResolver === 'function') {
      adapter.setAdapterEventLedgerResolver((hint = {}) => {
        const userId = hint?.userId || hint?.user || null;
        if (!userId || typeof this.getProfile !== 'function') return null;
        return this._getTurnDeliveryLedger(this.getProfile(userId));
      });
    }
    this.adapters.set(name, adapter);
    if (name === 'slack' && typeof adapter?.createQiSubscriber === 'function' && !adapter.__orbQiSubscriberUnsubscribe) {
      adapter.__orbQiSubscriberUnsubscribe = this.eventBus.subscribe(adapter.createQiSubscriber());
    }
    if (name === 'slack' && typeof adapter?.createPlanSubscriber === 'function' && !adapter.__orbPlanSubscriberUnsubscribe) {
      adapter.__orbPlanSubscriberUnsubscribe = this.eventBus.subscribe(adapter.createPlanSubscriber());
    }
    if (name === 'slack' && typeof adapter?.createTextSubscriber === 'function' && !adapter.__orbTextSubscriberUnsubscribe) {
      adapter.__orbTextSubscriberUnsubscribe = this.eventBus.subscribe(adapter.createTextSubscriber());
    }
    if (name === 'slack' && typeof adapter?.createStatusSubscriber === 'function' && !adapter.__orbStatusSubscriberUnsubscribe) {
      adapter.__orbStatusSubscriberUnsubscribe = this.eventBus.subscribe(adapter.createStatusSubscriber());
    }
    setImmediate(() => {
      this.replayQueuedTasks().catch((err) => {
        warn(TAG, `startup replay dispatch failed: ${err.message}`);
      });
    });
  }

  async executeTask(task) {
    return new Promise((resolve, reject) => {
      const wrappedTask = {
        ...task,
        silentQueueing: true,
        deferDeliveryUntilResult: true,
        _completion: { resolve, reject },
      };
      this.submit(wrappedTask).catch(reject);
    });
  }

  _getAdapter(platform) {
    return this.adapters.get(platform) || null;
  }

  _getTurnDeliveryLedger(profile) {
    const dataDir = profile?.dataDir;
    if (!dataDir) return null;
    const key = String(dataDir);
    if (!this._turnDeliveryLedgers.has(key)) {
      this._turnDeliveryLedgers.set(key, new TurnDeliveryLedger({
        logger: (line) => warn(TAG, line),
        ndjsonPath: ledgerPathForDataDir(key),
      }));
    }
    return this._turnDeliveryLedgers.get(key);
  }

  _startPermissionServer() {
    try {
      if (existsSync(this._permissionSocketPath)) unlinkSync(this._permissionSocketPath);
    } catch (err) {
      warn(TAG, `failed to cleanup stale permission socket: ${err.message}`);
    }

    this._permissionServer = net.createServer((socket) => this._handlePermissionSocket(socket));
    this._permissionServer.on('error', (err) => {
      logError(TAG, `permission socket server error: ${err.message}`);
    });
    this._permissionServer.listen(this._permissionSocketPath, () => {
      info(TAG, `permission socket listening: ${this._permissionSocketPath} mode=${this._permissionApprovalMode}`);
    });
  }

  _handlePermissionSocket(socket) {
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) return;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        warn(TAG, `invalid permission socket payload: ${err.message}`);
        this._writePermissionSocketResponse(socket, { allow: false, reason: `invalid permission payload: ${err.message}` });
        return;
      }

      this._handlePermissionRequest(msg, socket).catch((err) => {
        logError(TAG, `permission request failed: ${err.message}`);
        const key = this._permissionRequestKey(String(msg?.threadTs || ''), String(msg?.requestId || ''));
        if (this._pendingPermissionRequests.has(key)) {
          this._pendingPermissionRequests.delete(key);
        }
        this._writePermissionSocketResponse(socket, { allow: false, reason: `permission request failed: ${err.message}` });
      });
    });

    socket.on('error', (err) => {
      warn(TAG, `permission socket client error: ${err.message}`);
    });
  }

  async _handlePermissionRequest(msg, socket) {
    if (msg?.type !== 'permission_request') {
      this._writePermissionSocketResponse(socket, { allow: false, reason: `unsupported socket message type: ${msg?.type || 'unknown'}` });
      return;
    }

    const requestId = String(msg.requestId || '');
    const threadTs = String(msg.threadTs || '');
    const channel = msg.channel || null;
    const toolName = msg.toolName || 'unknown';
    const key = this._permissionRequestKey(threadTs, requestId);
    if (!threadTs || !requestId) {
      this._writePermissionSocketResponse(socket, { allow: false, reason: 'permission request missing threadTs/requestId' });
      return;
    }
    if (this._pendingPermissionRequests.has(key)) {
      this._writePermissionSocketResponse(socket, { allow: false, reason: `duplicate permission request: ${key}` });
      return;
    }

    const activeEntry = this.activeWorkers.get(threadTs);
    const platform = activeEntry?.platform || 'slack';
    const adapter = this._getAdapter(platform);
    this._pendingPermissionRequests.set(key, {
      socket,
      requestId,
      threadTs,
      channel,
      toolName,
      createdAt: Date.now(),
      settled: false,
    });

    socket.once('close', () => {
      const pending = this._pendingPermissionRequests.get(key);
      if (pending && !pending.settled) {
        this._pendingPermissionRequests.delete(key);
        warn(TAG, `permission socket closed before response: ${key}`);
      }
    });

    if (this._permissionApprovalMode === 'auto-allow') {
      info(TAG, `permission auto-allow: thread=${threadTs} tool=${toolName} request=${requestId}`);
      this._resolvePermissionRequest(key, { allow: true, reason: 'auto-allow stub' });
      return;
    }

    if (platform === 'system' || channel == null) {
      warn(TAG, `permission request denied: unsupported approval route platform=${platform} thread=${threadTs} request=${requestId}`);
      this._resolvePermissionRequest(key, {
        allow: false,
        reason: `permission approval unavailable for platform=${platform} channel=${channel == null ? 'null' : 'set'}`,
      });
      return;
    }

    if (adapter?.supportsInteractiveApproval !== true) {
      const reason = `permission approval unavailable: platform=${platform} does not support interactive approval; use ORB_PERMISSION_APPROVAL_MODE=auto-allow or approve from Slack`;
      warn(TAG, `permission request denied: ${reason} thread=${threadTs} request=${requestId}`);
      if (typeof adapter?.sendApproval === 'function') {
        try {
          await adapter.sendApproval(channel, threadTs, {
            kind: 'permission',
            toolName,
            toolInput: msg.toolInput,
            requestId,
            toolUseId: msg.toolUseId,
            userId: activeEntry?.userId,
            timeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
          });
        } catch (err) {
          warn(TAG, `failed to notify unsupported approval route: ${err.message}`);
        }
      }
      this._resolvePermissionRequest(key, { allow: false, reason });
      return;
    }

    if (!adapter?.sendApproval) {
      this._resolvePermissionRequest(key, { allow: false, reason: 'permission approval adapter unavailable' });
      return;
    }

    // Slack interactive callback path needs daemon-backed manual validation in a real thread.
    info(TAG, `permission approval requested: thread=${threadTs} tool=${toolName} request=${requestId}`);
    const decision = await adapter.sendApproval(channel, threadTs, {
      kind: 'permission',
      toolName,
      toolInput: msg.toolInput,
      requestId,
      toolUseId: msg.toolUseId,
      userId: activeEntry?.userId,
      timeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
    });

    const reason = decision?.approved
      ? `approved by ${decision.userId || 'unknown'}`
      : decision?.reason || `timeout: no response from Slack approval in ${Math.round(PERMISSION_APPROVAL_TIMEOUT_MS / 1000)}s`;
    this._resolvePermissionRequest(key, {
      allow: Boolean(decision?.approved),
      reason,
    });
  }

  _permissionRequestKey(threadTs, requestId) {
    return `${threadTs}:${requestId}`;
  }

  _permissionResolutionAction(payload) {
    if (payload?.allow) return 'allow';
    const reason = String(payload?.reason || '').toLowerCase();
    if (reason.startsWith('timeout:') || reason === 'timeout') return 'timeout';
    return 'deny';
  }

  _resolvePermissionRequest(key, payload) {
    const pending = this._pendingPermissionRequests.get(key);
    if (!pending) return;
    const action = this._permissionResolutionAction(payload);
    const latencyMs = Math.max(0, Date.now() - (pending.createdAt || Date.now()));
    info(TAG, `permission resolved: thread=${pending.threadTs} request=${pending.requestId} action=${action} latency=${latencyMs}ms`);
    pending.settled = true;
    this._pendingPermissionRequests.delete(key);
    this._writePermissionSocketResponse(pending.socket, payload);
  }

  _writePermissionSocketResponse(socket, payload) {
    if (!socket || socket.destroyed) return;
    try {
      socket.end(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      warn(TAG, `failed to write permission socket response: ${err.message}`);
    }
  }

  _restoreShutdownQueues() {
    const profilesDir = join(import.meta.dirname, '..', 'profiles');
    if (!existsSync(profilesDir)) return;

    try {
      const profiles = readdirSync(profilesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      for (const entry of profiles) {
        const queuePath = join(profilesDir, entry.name, 'data', SHUTDOWN_QUEUE_FILE);
        if (!existsSync(queuePath)) continue;

        try {
          const raw = JSON.parse(readFileSync(queuePath, 'utf8'));
          const restored = this._normalizeShutdownQueue(raw, queuePath);
          let restoredCount = 0;

          for (const task of restored.globalQueue) {
            if (taskQueue.enqueue(task)) restoredCount++;
            else warn(TAG, `startup replay dropped global queued task for thread=${task?.threadTs || 'unknown'}: taskQueue full`);
          }

          for (const [threadTs, queue] of Object.entries(restored.threadQueues)) {
            const validQueue = Array.isArray(queue) ? queue.filter(Boolean) : [];
            if (validQueue.length === 0) continue;
            this.threadQueues.set(threadTs, validQueue);
            restoredCount += validQueue.length;
          }

          unlinkSync(queuePath);
          info(TAG, `startup replay restored ${restoredCount} queued task(s) from ${queuePath}`);
        } catch (err) {
          warn(TAG, `startup replay failed for ${queuePath}: ${err.message}`);
        }
      }
    } catch (err) {
      warn(TAG, `startup replay scan failed: ${err.message}`);
    }
  }

  _normalizeShutdownQueue(raw, queuePath) {
    if (Array.isArray(raw)) {
      warn(TAG, `startup replay: legacy shutdown queue schema detected at ${queuePath}; only global queue will be restored`);
      return { globalQueue: raw, threadQueues: {} };
    }
    if (!raw || typeof raw !== 'object') {
      throw new Error('shutdown queue payload must be an array or object');
    }

    const globalQueue = Array.isArray(raw.globalQueue)
      ? raw.globalQueue
      : Array.isArray(raw.taskQueue)
        ? raw.taskQueue
        : [];
    const threadQueues = raw.threadQueues && typeof raw.threadQueues === 'object'
      ? raw.threadQueues
      : {};
    const seen = new Set();
    const dedupQueue = (queue, fallbackThreadTs = null) => {
      const out = [];
      for (const task of Array.isArray(queue) ? queue : []) {
        if (!task) continue;
        const key = taskDedupKey(task, fallbackThreadTs);
        if (key && seen.has(key)) {
          warn(TAG, `startup replay deduped task attempt=${task.attemptId} thread=${task.threadTs || fallbackThreadTs || 'unknown'} from ${queuePath}`);
          continue;
        }
        if (key) seen.add(key);
        out.push(task);
      }
      return out;
    };
    const dedupedGlobalQueue = dedupQueue(globalQueue);
    const dedupedThreadQueues = {};
    for (const [threadTs, queue] of Object.entries(threadQueues)) {
      const deduped = dedupQueue(queue, threadTs);
      if (deduped.length > 0) dedupedThreadQueues[threadTs] = deduped;
    }
    return { globalQueue: dedupedGlobalQueue, threadQueues: dedupedThreadQueues };
  }

  async submit(task) {
    const { threadTs, channel, platform } = task;
    ensureAttemptId(task);
    const adapter = this._getAdapter(platform);
    if (!adapter) {
      logError(TAG, `submit failed: no adapter for platform=${platform} thread=${threadTs}`);
      return;
    }
    if (threadTs && !task._autoContinue) {
      this._autoContinueCount.delete(threadTs);
    }

    // Rerun (🔥 reaction): bypass inject, spawn fresh worker. If a worker is
    // already active on this thread, queue the rerun so it runs after it exits.
    if (task.rerun) {
      info(TAG, `rerun submitted: thread=${threadTs} target=${task.targetMessageTs}`);
      if (this.activeWorkers.has(threadTs)) {
        info(TAG, `rerun queued: active worker on thread=${threadTs}`);
        if (!this.threadQueues.has(threadTs)) this.threadQueues.set(threadTs, []);
        this.threadQueues.get(threadTs).push(task);
        return;
      }
      await this._spawnWorker(task);
      return;
    }

    if (!task.forceNewWorker && this.activeWorkers.has(threadTs)) {
      const entry = this.activeWorkers.get(threadTs);
      const injectId = `inject-${this._nextInjectId++}`;
      const injectTask = {
        ...task,
        attemptId: task.attemptId,
        deliveryThreadTs: task.deliveryThreadTs === undefined
          ? (entry?.deliveryThreadTs ?? threadTs ?? null)
          : task.deliveryThreadTs,
        channelSemantics: task.channelSemantics === undefined
          ? normalizeChannelSemantics(entry?.channelSemantics ?? entry?.task?.channelSemantics)
          : normalizeChannelSemantics(task.channelSemantics),
      };
      if (!entry.pendingInjects) entry.pendingInjects = new Map();
      entry.pendingInjects.set(injectId, injectTask);
      try {
        entry.worker.send({
          type: 'inject',
          injectId,
          userText: task.userText,
          fileContent: task.fileContent,
          imagePaths: task.imagePaths,
          attemptId: injectTask.attemptId,
        });
        info(TAG, `injected into active worker: thread=${threadTs}`);
        return;
      } catch (e) {
        entry.pendingInjects.delete(injectId);
        info(TAG, `inject failed, queuing: ${e.message}`);
        if (!this.threadQueues.has(threadTs)) this.threadQueues.set(threadTs, []);
        this.threadQueues.get(threadTs).push(task);
        return;
      }
    }

    if (task.forceNewWorker && this.activeWorkers.has(threadTs)) {
      if (!this.threadQueues.has(threadTs)) this.threadQueues.set(threadTs, []);
      this.threadQueues.get(threadTs).push(task);
      info(TAG, `force-new worker queued behind active thread=${threadTs}`);
      return;
    }

    if (this.activeWorkers.size >= this.maxWorkers) {
      const alreadyQueued = taskQueue.hasThread(threadTs);
      if (alreadyQueued && task.silentQueueing) {
        if (!this.threadQueues.has(threadTs)) this.threadQueues.set(threadTs, []);
        this.threadQueues.get(threadTs).push(task);
        info(TAG, `thread-local queue: thread=${threadTs} size=${this.threadQueues.get(threadTs).length}`);
        return;
      }

      if (alreadyQueued || !taskQueue.enqueue(task)) {
        if (task._completion && task.silentQueueing) {
          task._completion.reject(new Error(alreadyQueued ? `task already queued for thread=${threadTs}` : 'global queue full'));
          return;
        }
        if (!task.silentQueueing) {
          await emitEphemeralControlPlane({
            adapter,
            channel,
            threadTs,
            platform,
            text: `队列已满（${taskQueue.size}条排队中），请稍等。`,
            source: 'scheduler.queue_full',
          });
        }
      } else {
        if (!task.silentQueueing) {
          await emitEphemeralControlPlane({
            adapter,
            channel,
            threadTs,
            platform,
            text: `已加入队列（${taskQueue.size}条排队中），会按顺序处理。`,
            source: 'scheduler.queue_joined',
          });
        }
      }
      info(TAG, `global queue: size=${taskQueue.size} thread=${threadTs}`);
      return;
    }

    await this._spawnWorker(task);
  }

  async processNextQueued(exitedThreadTs) {
    const thisQueue = this.threadQueues.get(exitedThreadTs);
    if (thisQueue && thisQueue.length > 0 && this.activeWorkers.size < this.maxWorkers) {
      const nextTask = thisQueue.shift();
      if (thisQueue.length === 0) this.threadQueues.delete(exitedThreadTs);
      await this._spawnWorker(nextTask);
      return;
    }

    for (const [threadTs, queue] of this.threadQueues) {
      if (this.activeWorkers.size >= this.maxWorkers) break;
      if (!this.activeWorkers.has(threadTs) && queue.length > 0) {
        const nextTask = queue.shift();
        if (queue.length === 0) this.threadQueues.delete(threadTs);
        await this._spawnWorker(nextTask);
      }
    }
  }

  async replayQueuedTasks() {
    if (this.activeWorkers.size >= this.maxWorkers) return;

    const pendingGlobal = Array.isArray(taskQueue.queue) ? taskQueue.queue.splice(0, taskQueue.queue.length) : [];
    const deferredGlobal = [];
    for (const task of pendingGlobal) {
      if (this.activeWorkers.size >= this.maxWorkers) {
        deferredGlobal.push(task);
        continue;
      }
      if (!this._getAdapter(task.platform)) {
        deferredGlobal.push(task);
        continue;
      }
      await this.submit(task);
    }
    if (deferredGlobal.length > 0) taskQueue.queue.unshift(...deferredGlobal);

    for (const [threadTs, queue] of [...this.threadQueues]) {
      if (this.activeWorkers.size >= this.maxWorkers) break;
      if (this.activeWorkers.has(threadTs) || queue.length === 0) continue;
      if (!this._getAdapter(queue[0]?.platform)) continue;
      const nextTask = queue.shift();
      if (queue.length === 0) this.threadQueues.delete(threadTs);
      await this.submit(nextTask);
    }
  }

  async _publishWorkerCcEvent(msg, ctx = {}) {
    await this.eventBus.publish(msg, {
      scheduler: this,
      ...ctx,
    });
  }

  async _spawnWorker(task) {
    const { userText, fileContent, imagePaths, threadTs, channel, userId, platform } = task;
    const deferDeliveryUntilResult = task.deferDeliveryUntilResult === true;
    const channelSemantics = normalizeChannelSemantics(task.channelSemantics);
    task.channelSemantics = channelSemantics;
    const adapter = this._getAdapter(platform);
    if (!adapter && platform !== 'system') {
      logError(TAG, `spawn failed: no adapter for platform=${platform} thread=${threadTs}`);
      task._completion?.reject?.(new Error(`no adapter for platform=${platform}`));
      return;
    }

    // Resolve profile for this user
    let profile;
    try {
      profile = task.profile || this.getProfile(userId);
    } catch (err) {
      logError(TAG, `profile resolution failed for user=${userId}: ${err.message}`);
      await emitEphemeralControlPlane({
        adapter,
        channel,
        threadTs,
        platform,
        text: ':warning: 未识别的用户，无法处理请求。',
        source: 'scheduler.profile_error',
      }).catch(() => {});
      task._completion?.reject?.(err);
      return;
    }
    info(TAG, `profile resolved: user=${userId} → ${profile.name} (${profile.workspaceDir})`);
    const ledger = this._getTurnDeliveryLedger(profile);
    const orchestrator = new TurnDeliveryOrchestrator({
      adapter,
      ledger,
      logger: (line) => warn(TAG, line),
    });

    // 优先级最高：task 已显式指定（cron / executeTask 程序化调用）
    let effectiveModel = task.model || null;
    let effectiveEffort = task.effort || null;
    let effectiveText = userText || '';

    // 消息前缀解析模型 / effort（可选覆盖）
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

    // 关键词自动升 xhigh（若未手动指定 effort）
    if (!effectiveEffort && shouldEscalateEffort(effectiveText)) {
      effectiveEffort = 'xhigh';
      info(TAG, `effort escalated to xhigh by keyword match`);
    }

    // Fallback: task fields > 前缀 > 关键词 > config.defaults > 内置兜底（getDefaults 已保证 effort 非空）
    const defaults = getDefaults();
    if (!effectiveModel) effectiveModel = defaults.model;
    if (!effectiveEffort) effectiveEffort = defaults.effort;

    let responded = false;
    let userVisibleDeliveryObserved = false;
    let pendingAutoContinue = null;
    let effectiveThreadTs = task.deliveryThreadTs === undefined ? (threadTs || null) : task.deliveryThreadTs;
    let turnCount = 0;
    let metadataUpdatedForTurn = false;
    let finalResultText = '';
    let finalStopReason = null;
    let workerFailure = null;
    let completionSettled = false;
    let currentCcTurnId = null;
    const toolHistory = [];
    const toolResults = [];
    let worker;
    const canManageThreadStatus = !deferDeliveryUntilResult
      && channel != null
      && typeof adapter?.setThreadStatus === 'function';
    const taskCardConfig = {
      enabled: !deferDeliveryUntilResult
        && platform === 'slack' && channel != null && effectiveThreadTs != null
        && task.enableTaskCard !== false
        && typeof adapter?.startStream === 'function'
        && typeof adapter?.appendStream === 'function'
        && typeof adapter?.stopStream === 'function',
      deferred: deferDeliveryUntilResult
        && platform === 'slack' && channel != null && effectiveThreadTs != null
        && task.enableTaskCard !== false
        && typeof adapter?.startStream === 'function'
        && typeof adapter?.stopStream === 'function',
    };
    let turn = makeTurnState(taskCardConfig);

    const settleCompletion = (method, payload) => {
      if (completionSettled) return;
      completionSettled = true;
      task._completion?.[method]?.(payload);
    };

    const suppressSuccessfulText = (phase, text, stopReason, messageChannelSemantics = channelSemantics) => {
      const effectiveChannelSemantics = normalizeChannelSemantics(messageChannelSemantics);
      if (!shouldSuppressForChannelSemantics(effectiveChannelSemantics, stopReason)) return false;
      const textLength = String(text || '').length;
      info(TAG, `silent ${phase} suppressed: thread=${threadTs} textLen=${textLength}`);
      return true;
    };

    const clearStatusRefresh = (targetTurn = turn) => {
      if (targetTurn?.statusRefreshTimer) {
        clearTimeout(targetTurn.statusRefreshTimer);
        targetTurn.statusRefreshTimer = null;
      }
    };
    const armStatusRefresh = () => {
      clearStatusRefresh();
      if (!canManageThreadStatus || !effectiveThreadTs) return;
      if (!turn.pendingThreadStatus) return;
      const capturedTurn = turn;
      turn.statusRefreshTimer = setTimeout(async () => {
        capturedTurn.statusRefreshTimer = null;
        if (turn !== capturedTurn || capturedTurn.abandoned) return;
        if (!capturedTurn.pendingThreadStatus || !canManageThreadStatus || !effectiveThreadTs) return;
        try {
          await adapter.setThreadStatus(channel, effectiveThreadTs, capturedTurn.pendingThreadStatus, capturedTurn.pendingStatusLoadingMessages || undefined);
          if (turn !== capturedTurn || capturedTurn.abandoned || !capturedTurn.pendingThreadStatus) {
            await adapter.setThreadStatus(channel, effectiveThreadTs, '', null).catch(() => {});
            return;
          }
          armStatusRefresh();
        } catch (err) {
          warn(TAG, `status refresh failed: ${err.message}`);
        }
      }, STATUS_REFRESH_MS);
    };

    const applyThreadStatus = async (status, loadingMessages) => {
      turn.pendingThreadStatus = String(status || '');
      turn.pendingStatusLoadingMessages = Array.isArray(loadingMessages) ? loadingMessages : null;
      if (!canManageThreadStatus || !effectiveThreadTs) return;
      try {
        await adapter.setThreadStatus(channel, effectiveThreadTs, turn.pendingThreadStatus, loadingMessages);
        if (turn.pendingThreadStatus) armStatusRefresh();
        else clearStatusRefresh();
      } catch (err) {
        warn(TAG, `failed to set thread status: ${err.message}`);
        clearStatusRefresh();
      }
    };

    const startThreadStatusRefresh = async (status = THINKING_STATUS) => {
      if (!canManageThreadStatus) return;
      await applyThreadStatus(status, LOADING_MESSAGES);
    };

    const startTyping = async () => {
      if (deferDeliveryUntilResult) return;
      await startThreadStatusRefresh();
      turn.typingActive = true;
    };

    const stopTyping = async () => {
      if (deferDeliveryUntilResult) return;
      if (!turn.typingActive) return;
      turn.typingActive = false;
      await applyThreadStatus('');
    };

    const abandonTurn = async (prevTurn) => {
      if (!prevTurn || prevTurn.abandoned) return;
      clearStatusRefresh(prevTurn);
      for (const key of [...this._pendingPermissionRequests.keys()]) {
        if (key.startsWith(`${threadTs}:`)) this._pendingPermissionRequests.delete(key);
      }
      await abandonTurnState({
        turn: prevTurn,
        adapter,
        channel,
        threadTs: effectiveThreadTs,
        canManageThreadStatus: canManageThreadStatus && effectiveThreadTs != null,
      });
    };

    const resetTaskCardState = () => {
      turn.taskCardState.streamId = null;
      turn.taskCardState.failed = false;
    };

    const finalizeStreamsOnAbnormalExit = async () => {
      try {
        if (channel != null && effectiveThreadTs != null && !userVisibleDeliveryObserved) {
          await orchestrator.emit({
            turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
            attemptId: task.attemptId || '',
            channel,
            threadTs: effectiveThreadTs,
            platform,
            channelSemantics,
            intent: CONTROL_PLANE_MESSAGE,
            text: '⚠️ 本轮任务异常终止（worker timeout 或 crash），可发「继续」让我从失败点续做。',
            source: 'scheduler.abnormal_exit',
          });
          userVisibleDeliveryObserved = true;
        }
      } catch (err) {
        warn(TAG, `failed to send worker abnormal-exit notice: ${err.message}`);
      } finally {
        resetTaskCardState();
      }
    };

    const updateThreadMetadata = async (text) => {
      if (metadataUpdatedForTurn) return;
      if (platform !== 'slack' || !channel || !effectiveThreadTs || !text) return;
      metadataUpdatedForTurn = true;
      const prompts = extractSuggestedPrompts(text);
      if (turnCount === 0) {
        await orchestrator.emit({
          turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
          attemptId: task.attemptId || '',
          channel,
          threadTs: effectiveThreadTs,
          platform,
          channelSemantics,
          intent: METADATA_TITLE,
          text,
          source: 'scheduler.metadata',
          meta: { suggestedPrompts: prompts },
        }).catch((err) => warn(TAG, `metadata delivery failed: ${err.message}`));
      }
      turnCount += 1;
    };

    const emitAssistantFinal = async ({ text, msg = null, source, meta = {}, channelSemanticsOverride = null }) => {
      if (!String(text || '').trim()) return { delivered: false, reason: 'empty-final' };
      const result = await orchestrator.emit({
        turnId: makeTurnId({ turnId: msg?.turnId || currentCcTurnId, threadTs, attemptId: msg?.attemptId || task.attemptId }),
        attemptId: msg?.attemptId || task.attemptId || '',
        channel,
        threadTs: effectiveThreadTs,
        platform,
        channelSemantics: normalizeChannelSemantics(channelSemanticsOverride ?? msg?.channelSemantics ?? channelSemantics),
        intent: ASSISTANT_TEXT_FINAL,
        text,
        source,
        meta,
      });
      if (result.delivered) userVisibleDeliveryObserved = true;
      return result;
    };

    const handleExitResult = async (msg) => {
      const text = '';
      finalResultText = '';
      finalStopReason = msg.stopReason || finalStopReason;

      try {
        // Exit signal: empty text after turn_complete delivery is expected and
        // should not enter auto-continue or fallback delivery.
        if (userVisibleDeliveryObserved) {
          this._autoContinueCount.delete(threadTs);
          return;
        }

        const isMaxTurnsReached = msg.stopReason === 'max_turns_reached';
        const isToolOnlyCompletion = !isMaxTurnsReached && (msg.toolCount || 0) > 0;

        // tool-only turn（如 GitHub 调研卡片流）：最后一个 turn 只有 tool_use、
        // 外投通过 Bash → Slack API 完成，没有 assistant text。这是预期的正常结束，
        // 不应触发 auto-continue 也不应发提示。
        if (isToolOnlyCompletion) {
          info(TAG, `tool-only turn completed without text, skipping auto-continue: thread=${threadTs} toolCount=${msg.toolCount} lastTool=${msg.lastTool || 'none'}`);
          this._autoContinueCount.delete(threadTs);
          return;
        }

        const retries = this._autoContinueCount.get(threadTs) || 0;
        if (retries < MAX_AUTO_CONTINUE) {
          this._autoContinueCount.set(threadTs, retries + 1);
          const reasonTag = isMaxTurnsReached ? 'max_turns_reached' : 'empty';
          warn(TAG, `${reasonTag} result, auto-continue ${retries + 1}/${MAX_AUTO_CONTINUE} for thread=${threadTs}`);
          const suppressAutoContinueNotice = platform === 'slack'
            && typeof channel === 'string'
            && channel.startsWith('D');
          if (!deferDeliveryUntilResult && !suppressAutoContinueNotice) {
            const notice = isMaxTurnsReached
              ? `⏳ 到达回合上限，自动续接中 (${retries + 1}/${MAX_AUTO_CONTINUE})…`
              : `⏳ 本轮无输出，自动续接中 (${retries + 1}/${MAX_AUTO_CONTINUE})…`;
            await orchestrator.emit({
              turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
              attemptId: task.attemptId || '',
              channel,
              threadTs: effectiveThreadTs,
              platform,
              channelSemantics,
              intent: CONTROL_PLANE_MESSAGE,
              text: notice,
              source: 'scheduler.auto_continue',
            }).catch(() => {});
          } else if (suppressAutoContinueNotice) {
            info(TAG, `${reasonTag} result auto-continue notice suppressed in Slack DM: thread=${threadTs}`);
          }
          // Defer submit to onExit — avoid race with worker's process.exit(0)
          pendingAutoContinue = {
            userText: '继续',
            fileContent: '',
            imagePaths: [],
            threadTs,
            deliveryThreadTs: effectiveThreadTs,
            channel,
            userId,
            platform,
            teamId: task.teamId || null,
            attemptId: task.attemptId,
            threadHistory: task.threadHistory,
            profile,
            maxTurns: task.maxTurns || null,
            enableTaskCard: task.enableTaskCard,
            deferDeliveryUntilResult,
            channelSemantics,
            _autoContinue: true,
            _completion: task._completion,
          };
          return;
        }
        warn(TAG, `empty result after ${MAX_AUTO_CONTINUE} auto-continues for thread=${threadTs}`);
        this._autoContinueCount.delete(threadTs);

        // Fallback delivery remains here only for exit-only completions that
        // never reached turn_complete. result.text is intentionally ignored.
        if (!userVisibleDeliveryObserved) {
          const finalText = '⚠️ 多次续接仍未生成回复，任务可能需要拆分。请用更小的指令重试。';
          await emitAssistantFinal({
            text: finalText,
            msg,
            source: 'scheduler.result',
            meta: { stopReason: msg.stopReason || null },
          });
          userVisibleDeliveryObserved = true;
        }

        resetTaskCardState();
        await updateThreadMetadata(text);

        if (text) {
          const errorPatterns = /(?:error|failed|permission denied|ENOENT|not found|timed?\s*out|EACCES)/i;
          if (errorPatterns.test(text) && text.length > 50) {
            storeLesson({
              userText: task.userText || '',
              errorText: '',
              responseText: text.slice(0, 2000),
              threadTs,
              userId,
              dbPath: join(profile.dataDir, 'memory.db'),
            }).catch(() => {});
          }
        }
        const correctionPatterns = /不对|不是这样|重来|重新|按我说的|你搞错了|我要的是|不是我想要|改一下|错了|再试|not what I|wrong|redo|try again/i;
        if (correctionPatterns.test(task.userText || '')) {
          storeCorrectionLesson({
            userText: task.userText || '',
            responseText: (text || '').slice(0, 2000),
            threadHistory: (task.threadHistory || '').slice(0, 3000),
            threadTs,
            userId,
            dbPath: join(profile.dataDir, 'memory.db'),
          }).catch(() => {});
          try {
            writeLessonCandidate(profile.dataDir, {
              source: 'user-correction',
              stopReason: 'user correction keyword',
              errorContext: String(task.userText || '').slice(0, 500),
              threadId: threadTs,
              kind: 'user',
            });
          } catch (candidateErr) {
            warn(TAG, `failed to write user-correction lesson candidate: ${candidateErr.message}`);
          }
        }
      } catch (err) {
        const errCode = typeof getTaskCardStreamErrorCode === 'function' ? getTaskCardStreamErrorCode(err) : null;
        logError(TAG, `failed to send result: ${err.message}${errCode ? ` (code=${errCode})` : ''}`);
        await orchestrator.emit({
          turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
          attemptId: task.attemptId || '',
          channel,
          threadTs: effectiveThreadTs,
          platform,
          channelSemantics,
          intent: CONTROL_PLANE_MESSAGE,
          text: ':warning: 回复发送失败。',
          source: 'scheduler.result_error',
        }).catch(() => {});
      }

      if (msg.toolCount > 0) {
        try { this._checkSkillReview(profile.name, msg.toolCount, task, text, toolHistory, toolResults); } catch (_) {}
        try { this._checkMemorySync(profile.name, msg.toolCount, task); } catch (_) {}
      }
    };

    try {
      ({ worker } = this._spawnWorkerFn({
        task: {
          type: 'task',
          userText: effectiveText,
          fileContent,
          imagePaths: imagePaths || [],
          threadTs,
          channel,
          userId,
          platform,
          teamId: task.teamId || null,
          attemptId: task.attemptId,
          channelSemantics,
          threadHistory: task.threadHistory,
          model: effectiveModel,
          effort: effectiveEffort,
          maxTurns: task.maxTurns || null,
          profile: {
            name: profile.name,
            scriptsDir: profile.scriptsDir,
            workspaceDir: profile.workspaceDir,
            dataDir: profile.dataDir,
          },
        },
        timeout: this.timeoutMs,
        label: threadTs,
        onMessage: async (msg) => {
          // Worker IPC is now lifecycle + event-stream only:
          // turn_start, turn_end, turn_complete, cc_event, inject_failed,
          // error, and the process-exit result signal. Slack UI rendering is
          // driven by cc_event subscribers; legacy UI IPC handlers were removed.
          if (!msg || !msg.type) {
            warn(TAG, `invalid worker message: ${JSON.stringify(msg)?.slice(0, 200)}`);
            return;
          }
          info(TAG, `worker response: type=${msg.type} thread=${threadTs} textLen=${msg.text?.length || 0}`);

          if (msg.type === 'cc_event') {
            currentCcTurnId = msg.turnId || currentCcTurnId;
            if (msg.eventType === 'tool_use') {
              toolHistory.push({
                name: msg.payload?.name || null,
                input: msg.payload?.input || msg.payload || {},
              });
            } else if (msg.eventType === 'tool_result') {
              toolResults.push(msg.payload || {});
            }
            try {
              await this._publishWorkerCcEvent(msg, {
                task,
                turn,
                worker,
                adapter,
                channel,
                threadTs,
                effectiveThreadTs,
                platform,
                deferDeliveryUntilResult,
                channelSemantics,
                applyThreadStatus,
                orchestrator,
              });
            } catch (err) {
              warn(TAG, `eventBus publish failed: ${err.message}`);
            }
            return;
          }
          if (msg.type === 'inject_failed') {
            responded = true;
            try {
              writeLessonCandidate(profile.dataDir, {
                source: 'inject-failed',
                stopReason: 'inject_failed',
                errorContext: JSON.stringify({ userText: msg.userText || '', injectId: msg.injectId || null }).slice(0, 500),
                threadId: threadTs,
                kind: 'inject',
              });
            } catch (err) {
              warn(TAG, `failed to write inject_failed lesson candidate: ${err.message}`);
            }
            const activeEntry = this.activeWorkers.get(threadTs);
            const failedTask = activeEntry?.pendingInjects?.get(msg.injectId) || null;
            if (activeEntry?.pendingInjects && msg.injectId) {
              activeEntry.pendingInjects.delete(msg.injectId);
            }
            const respawnTask = buildRespawnTaskForInjectFailed({
              msg,
              failedTask,
              task,
              threadTs,
              effectiveThreadTs,
              channel,
              userId,
              platform,
              profile,
              deferDeliveryUntilResult,
              channelSemantics,
            });
            if (!this.threadQueues.has(threadTs)) this.threadQueues.set(threadTs, []);
            this.threadQueues.get(threadTs).unshift(respawnTask);
            await abandonTurn(turn);
            turn = makeTurnState(taskCardConfig);
            try {
              activeEntry?.worker?.kill?.('SIGTERM');
            } catch (err) {
              warn(TAG, `inject_failed kill worker failed: ${err.message}`);
            }
            warn(TAG, `inject failed, respawning worker for thread=${threadTs}`);
            return;
          }

          if (msg.type === 'turn_start') {
            if (msg.injectId) {
              const activeEntry = this.activeWorkers.get(threadTs);
              activeEntry?.pendingInjects?.delete(msg.injectId);
            }
            await abandonTurn(turn);
            turn = makeTurnState(taskCardConfig);
            userVisibleDeliveryObserved = false;
            currentCcTurnId = makeTurnId({ turnId: msg.turnId, threadTs, attemptId: msg.attemptId || task.attemptId });
            orchestrator.beginTurn({
              turnId: currentCcTurnId,
              attemptId: msg.attemptId || task.attemptId || '',
              channel,
              threadTs: effectiveThreadTs,
              platform,
              channelSemantics: normalizeChannelSemantics(msg.channelSemantics ?? channelSemantics),
              taskCardState: turn.taskCardState,
            });
            metadataUpdatedForTurn = false;
            await startTyping();
            return;
          }

          if (msg.type === 'turn_end') {
            await stopTyping();
            responded = true;
            return;
          }

          responded = true;

          if (msg.type === 'turn_complete') {
            finalStopReason = msg.stopReason || finalStopReason;
            await stopTyping();
            const deliveryText = typeof msg?.text === 'string' ? msg.text : '';
            const metadataText = deliveryText;
            try {
              if (deliveryText.trim() && suppressSuccessfulText('turn_complete', deliveryText, msg.stopReason, msg.channelSemantics)) {
                await emitAssistantFinal({
                  text: deliveryText,
                  msg,
                  source: 'scheduler.turn_complete',
                  meta: { stopReason: msg.stopReason || null },
                });
                resetTaskCardState();
                return;
              }
              if (deferDeliveryUntilResult && isSilentResultText(deliveryText)) {
                info(TAG, `silent deferred turn suppressed: thread=${threadTs}`);
                await emitAssistantFinal({
                  text: deliveryText,
                  msg,
                  source: 'scheduler.turn_complete',
                  meta: { stopReason: msg.stopReason || null, deferred: true },
                  channelSemanticsOverride: 'silent',
                });
                resetTaskCardState();
                return;
              }
              if (deliveryText.trim()) {
                await emitAssistantFinal({
                  text: deliveryText,
                  msg,
                  source: 'scheduler.turn_complete',
                  meta: { gitDiffSummary: msg.gitDiffSummary || null, deferred: deferDeliveryUntilResult },
                });
              } else if (metadataText?.trim()) {
                userVisibleDeliveryObserved = true;
                info(TAG, `turn_complete text already delivered`);
              }
              await updateThreadMetadata(metadataText);
              resetTaskCardState();
            } catch (err) {
              logError(TAG, `failed to send turn_complete: ${err.message}`);
              const fallbackText = deliveryText;
              const silentDeferredFallback = deferDeliveryUntilResult && isSilentResultText(fallbackText);
              if (silentDeferredFallback) {
                info(TAG, `silent deferred turn suppressed after delivery failure: thread=${threadTs}`);
                await emitAssistantFinal({
                  text: fallbackText,
                  msg,
                  source: 'scheduler.fallback',
                  meta: { stopReason: msg.stopReason || null, deferred: true },
                  channelSemanticsOverride: 'silent',
                });
              } else if (fallbackText.trim()) {
                await emitAssistantFinal({
                  text: fallbackText,
                  msg,
                  source: 'scheduler.fallback',
                  meta: { gitDiffSummary: msg.gitDiffSummary || null, deferred: deferDeliveryUntilResult },
                });
              } else if (metadataText?.trim()) {
                userVisibleDeliveryObserved = true;
                info(TAG, `turn_complete fallback text already delivered`);
              }
              if (!silentDeferredFallback) await updateThreadMetadata(metadataText);
              resetTaskCardState();
            }
            return;
          }

          if (msg.type === 'result') {
            await handleExitResult(msg);
          } else if (msg.type === 'error') {
            const safeError = sanitizeErrorText(msg.error || '未知错误');
            workerFailure = new Error(safeError);
            logError(TAG, `worker error for thread=${threadTs}: ${safeError}`);
            try {
              writeLessonCandidate(profile.dataDir, {
                source: 'worker-error',
                stopReason: safeError,
                errorContext: JSON.stringify(msg.errorContext || {}).slice(0, 500),
                threadId: threadTs,
                kind: 'worker',
              });
            } catch (err) {
              warn(TAG, `failed to write worker-error lesson candidate: ${err.message}`);
            }
            await stopTyping();
            await orchestrator.emit({
              turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
              attemptId: task.attemptId || '',
              channel,
              threadTs: effectiveThreadTs,
              platform,
              channelSemantics,
              intent: CONTROL_PLANE_MESSAGE,
              text: `:warning: 出错了: ${safeError}`,
              source: 'scheduler.worker_error',
            }).catch(() => {});
            storeLesson({
              userText: msg.errorContext?.userText || '',
              errorText: msg.error || '',
              responseText: '',
              threadTs,
              userId,
              dbPath: join(profile.dataDir, 'memory.db'),
            }).catch(() => {});
          }
        },
        onExit: async (code, signal) => {
          await stopTyping();
          await applyThreadStatus('');
          if (currentCcTurnId) {
            try {
              await this._publishWorkerCcEvent({
                type: 'cc_event',
                eventType: 'turn_abort',
                turnId: currentCcTurnId,
                synthetic: true,
              }, {
                task,
                turn,
                worker,
                adapter,
                channel,
                threadTs,
                effectiveThreadTs,
                platform,
                deferDeliveryUntilResult,
                channelSemantics,
                applyThreadStatus,
                orchestrator,
              });
            } catch (err) {
              warn(TAG, `eventBus turn_abort publish failed: ${err.message}`);
            }
          }
          this.activeWorkers.delete(threadTs);

          const next = taskQueue.dequeue();
          if (next) {
            info(TAG, `draining queue: thread=${next.threadTs} waited=${Date.now() - next.enqueuedAt}ms`);
            await this.submit(next);
          }

          info(TAG, `worker exited: pid=${worker.pid} code=${code} signal=${signal} responded=${responded} thread=${threadTs}`);

          const deliveredBeforeExitNotice = userVisibleDeliveryObserved
            || Boolean(currentCcTurnId && orchestrator.hasUserVisibleDelivery(currentCcTurnId));
          const abnormalExit = !responded && (signal !== null || (code !== 0 && code !== null));
          if (abnormalExit) {
            await finalizeStreamsOnAbnormalExit();
          }

          if (!responded && !deliveredBeforeExitNotice) {
            logError(TAG, `worker exited without response: thread=${threadTs} code=${code} signal=${signal}`);
            this._autoContinueCount.delete(threadTs);
            await adapter.cleanupIndicator(channel, effectiveThreadTs, false, '处理过程中出错，请重试。');
          } else if (!responded) {
            warn(TAG, `worker exited without IPC signal but stream delivered: thread=${threadTs} (suppressed user-facing warning)`);
            this._autoContinueCount.delete(threadTs);
          }

          await this.processNextQueued(threadTs);

          if (pendingAutoContinue) {
            const cont = pendingAutoContinue;
            pendingAutoContinue = null;
            info(TAG, `auto-continue dispatched after worker exit: thread=${cont.threadTs}`);
            await this.submit(cont);
            return;
          }

          if (workerFailure) {
            settleCompletion('reject', workerFailure);
          } else if (!responded) {
            settleCompletion('reject', new Error(signal ? `worker killed: ${signal}` : `worker exited with code ${code}`));
          } else {
            settleCompletion('resolve', { text: finalResultText, threadTs: effectiveThreadTs, stopReason: finalStopReason });
          }
        },
      }));
    } catch (err) {
      logError(TAG, `fork failed: ${err.message}`);
      await stopTyping();
      await adapter.cleanupIndicator(channel, effectiveThreadTs, false, 'Worker 启动失败。');
      await this.processNextQueued(threadTs);
      settleCompletion('reject', err);
      return;
    }

    this.activeWorkers.set(threadTs, {
      worker,
      platform,
      channel,
      userId,
      deliveryThreadTs: effectiveThreadTs,
      channelSemantics,
      pendingInjects: new Map(),
      task: sanitizeTaskForPersistence(task),
      orchestrator,
      ledger,
    });
    worker.on('error', (err) => {
      logError(TAG, `worker error event: pid=${worker.pid} err=${err.message}`);
    });
    info(TAG, `task sent to worker pid=${worker.pid} thread=${threadTs} profile=${profile.name}`);
  }

  // --- Skill auto-extraction ---

  _checkSkillReview(profileName, toolCount, task, resultText, toolHistory = [], toolResults = []) {
    if (!toolCount || toolCount === 0) return;

    const prev = this._skillToolCounts.get(profileName) || 0;
    const next = prev + toolCount;
    this._skillToolCounts.set(profileName, next);

    const profile = task?.profile || this.getProfile(task?.userId);
    const agentsDir = join(profile.workspaceDir, '.claude', 'skills');
    const existingSkillText = this._scanExistingSkills(agentsDir)
      .map((skill) => `${skill.file}\n${skill.summary}`)
      .join('\n');
    const assessment = assessSkillReviewTrigger(toolHistory, {
      userText: task?.userText || '',
      resultText: resultText || '',
      threadText: [task?.threadHistory || '', task?.userText || '', resultText || ''].join('\n'),
      existingSkillText,
      toolResults,
    });

    if (assessment.should || next >= SKILL_REVIEW_THRESHOLD) {
      info(TAG, `skill review triggered: profile=${profileName} tools=${next} pattern=${assessment.pattern} reason=${assessment.reason}`);
      this._skillToolCounts.set(profileName, 0);
      // Package the just-completed turn as priorConversation so the review
      // worker has actual context to extract skills from.
      const priorMessages = [];
      if (task?.userText) priorMessages.push({ role: 'user', content: String(task.userText) });
      if (resultText) priorMessages.push({ role: 'assistant', content: String(resultText) });
      if (toolHistory.length > 0) {
        priorMessages.push({ role: 'assistant', content: `Skill trigger: ${assessment.pattern} — ${assessment.reason}\nTools: ${toolHistory.map((item) => item.name).filter(Boolean).join(' -> ')}` });
      }
      this._spawnSkillReview(task, priorMessages);
    }
  }

  _scanExistingSkills(agentsDir) {
    if (!existsSync(agentsDir)) return [];
    try {
      return readdirSync(agentsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
        .map((entry) => {
          try {
            const content = readFileSync(join(agentsDir, entry.name, 'SKILL.md'), 'utf8');
            // Extract first 5 lines as summary
            const summary = content.split('\n').slice(0, 5).join('\n');
            return { file: `${entry.name}/SKILL.md`, summary };
          } catch { return { file: `${entry.name}/SKILL.md`, summary: '(read error)' }; }
        });
    } catch { return []; }
  }

  _spawnSkillReview(task, priorMessages = []) {
    const { userId, platform } = task;
    const profile = this.getProfile(userId);
    const agentsDir = join(profile.workspaceDir, '.claude', 'skills');
    const draftsDir = join(agentsDir, '_drafts');

    // Pre-scan existing skills for iteration context
    const existing = this._scanExistingSkills(agentsDir);
    const existingSection = existing.length > 0
      ? [
          '',
          '## Existing Skills',
          'These skills already exist. If the conversation improved or extended one, UPDATE it instead of creating a duplicate.',
          '',
          ...existing.map(s => `### ${s.file}\n${s.summary}\n`),
        ].join('\n')
      : '\n## Existing Skills\nNone yet.\n';

    const reviewPrompt = [
      'You are a skill extraction agent. Review the conversation that just completed.',
      '',
      '## Decision Flow',
      '1. Was a non-trivial, multi-step, reusable approach demonstrated?',
      '   - If NO → respond "No skill extracted." and exit',
      '   - If YES → continue',
      '2. Does it match an existing skill below?',
      '   - If YES → read that file, merge new learnings, write updated version back',
      '   - If NO → create a new skill file',
      '',
      '## Extraction Criteria',
      '- Multi-step approach requiring domain knowledge or trial-and-error',
      '- Reusable across different contexts (not one-off)',
      '- Worth documenting (saves future time)',
      '',
      existingSection,
      '',
      `## Output Location: ${draftsDir}/{kebab-case-name}/SKILL.md`,
      '',
      '## Skill File Format (Claude Code agent .md):',
      '```',
      '---',
      'name: skill-name',
      'description: One-line description of when/why to use this',
      'stage: draft',
      `created_at: ${new Date().toISOString()}`,
      `source_thread_id: ${task.threadTs || 'unknown'}`,
      '---',
      '# Skill Title',
      '',
      '## When to Use',
      'Trigger conditions...',
      '',
      '## Steps',
      '1. ...',
      '2. ...',
      '',
      '## Notes',
      'Gotchas, edge cases, lessons learned...',
      '```',
      '',
      'When UPDATING: preserve existing content that\'s still valid, add new learnings, bump any version notes.',
      'Be concise. One skill per directory. Directory name = kebab-case skill name; file name must be SKILL.md.',
    ].join('\n');

    if (this._backgroundWorkers.size >= this._maxBackgroundWorkers) {
      info(TAG, 'background worker limit reached, skipping skill review');
      return;
    }

    let worker;
    ({ worker } = spawnWorker({
      task: {
        type: 'task',
        userText: reviewPrompt,
        fileContent: '',
        threadTs: `skill-review-${Date.now()}`,
        channel: null,
        userId: null,
        platform: 'system',
        threadHistory: null,
        model: 'haiku',
        effort: 'low',
        maxTurns: null,
        disablePermissionPrompt: true,
        mode: 'skill-review',
        priorConversation: priorMessages,
        profile: {
          name: profile.name,
          scriptsDir: profile.scriptsDir,
          workspaceDir: profile.workspaceDir,
          dataDir: profile.dataDir,
        },
      },
      timeout: 120_000,
      label: `skill-review:${profile.name}`,
      onMessage: () => {},
      onExit: (code) => {
        this._backgroundWorkers.delete(worker);
        info(TAG, `skill review worker exited: code=${code} profile=${profile.name}`);
      },
    }));
    this._backgroundWorkers.add(worker);
    info(TAG, `skill review dispatched: profile=${profile.name} priorMessages=${priorMessages.length}`);
  }

  // --- Memory + User profile sync ---

  _checkMemorySync(profileName, toolCount, task) {
    if (!toolCount) return;

    const prev = this._memorySyncCounts.get(profileName) || 0;
    const next = prev + toolCount;
    this._memorySyncCounts.set(profileName, next);

    if (next < MEMORY_SYNC_THRESHOLD) return;

    // Reset counter regardless of rate limit
    this._memorySyncCounts.set(profileName, 0);

    // Rate limit: min 6h between syncs
    const lastSync = this._lastMemorySync.get(profileName) || 0;
    if (Date.now() - lastSync < MEMORY_SYNC_INTERVAL) return;
    this._lastMemorySync.set(profileName, Date.now());
    info(TAG, `memory sync threshold reached: profile=${profileName} tools=${next}`);
    this._spawnMemorySync(task);
  }

  // Memory housekeeping: purge transient facts, lint memory.db, GC image cache.
  // MEMORY.md / USER.md distillation is retired — CLI-native auto-memory
  // (~/.claude/projects/{cwd}/memory/) handles persistent preference tracking.
  async _spawnMemorySync(task) {
    const { userId } = task;
    const profile = this.getProfile(userId);
    const dbPath = join(profile.dataDir, 'memory.db');

    const transientReport = await purgeTransient(dbPath, { maxAgeDays: 7 }).catch(() => ({ purged: 0 }));
    if (transientReport.purged > 0) {
      info(TAG, `purged ${transientReport.purged} transient fact(s)`);
    }

    const lintReport = await lintMemory(dbPath, { fix: true }).catch(() => ({}));
    if (lintReport.actions_taken?.length > 0) {
      info(TAG, `memory lint: ${lintReport.actions_taken.length} actions — ${lintReport.actions_taken.join(', ')}`);
    }

    cleanupImages(profile.workspaceDir);
  }

  shutdown(signal) {
    const allWorkers = [...this.activeWorkers.values()].map(({ worker }) => worker).concat([...this._backgroundWorkers]);
    info(TAG, `${signal} received, draining ${this.activeWorkers.size} active + ${this._backgroundWorkers.size} background worker(s)...`);
    try {
      this._permissionServer?.close();
    } catch {}
    try {
      if (existsSync(this._permissionSocketPath)) unlinkSync(this._permissionSocketPath);
    } catch {}

    // Persist queued tasks so they're not silently lost on SIGTERM
    try {
      const pending = taskQueue.drain ? taskQueue.drain() : [];
      let drained = pending;
      if ((!drained || drained.length === 0) && typeof taskQueue.dequeue === 'function') {
        drained = [];
        let t;
        while ((t = taskQueue.dequeue())) drained.push(t);
      }
      const byProfile = new Map();
      const addPersistedTask = (task, threadTs = null) => {
        const persistedTask = sanitizeTaskForPersistence(task);
        if (!persistedTask) return;
        let profileName = 'unknown';
        let dataDir = null;
        try {
          const profile = this.getProfile(persistedTask.userId);
          profileName = profile.name;
          dataDir = profile.dataDir;
        } catch {}
        if (!dataDir) return;
        if (!byProfile.has(profileName)) {
          byProfile.set(profileName, { dataDir, globalQueue: [], threadQueues: {} });
        }
        const entry = byProfile.get(profileName);
        if (threadTs) {
          if (!entry.threadQueues[threadTs]) entry.threadQueues[threadTs] = [];
          entry.threadQueues[threadTs].push(persistedTask);
        } else {
          entry.globalQueue.push(persistedTask);
        }
      };

      for (const task of drained || []) addPersistedTask(task);
      for (const [threadTs, queue] of this.threadQueues) {
        for (const task of queue) addPersistedTask(task, threadTs);
      }
      for (const [threadTs, entry] of this.activeWorkers) {
        if (entry.task) {
          addPersistedTask(entry.task, threadTs);
        }
        if (entry.pendingInjects && entry.pendingInjects.size > 0) {
          for (const injectTask of entry.pendingInjects.values()) {
            addPersistedTask(injectTask, threadTs);
          }
        }
      }

      if (byProfile.size > 0) {
        let totalPersisted = 0;
        for (const [name, payload] of byProfile) {
          try {
            mkdirSync(payload.dataDir, { recursive: true });
            const outPath = join(payload.dataDir, SHUTDOWN_QUEUE_FILE);
            writeFileSync(outPath, `${JSON.stringify({
              version: SHUTDOWN_QUEUE_VERSION,
              globalQueue: payload.globalQueue,
              threadQueues: payload.threadQueues,
            }, null, 2)}\n`);
            const profileCount = payload.globalQueue.length
              + Object.values(payload.threadQueues).reduce((sum, queue) => sum + queue.length, 0);
            totalPersisted += profileCount;
            info(TAG, `shutdown: persisted ${profileCount} task(s) for profile=${name} → ${outPath}`);
          } catch (e) {
            warn(TAG, `shutdown: failed to persist queue for profile=${name}: ${e.message}`);
          }
        }
        warn(TAG, `shutdown: persisted ${totalPersisted} queued task(s) to ${SHUTDOWN_QUEUE_FILE}`);
      }
    } catch (e) {
      warn(TAG, `shutdown: queue persistence error: ${e.message}`);
    }

    // Disconnect all adapters
    for (const [name, adapter] of this.adapters) {
      info(TAG, `disconnecting adapter: ${name}`);
      adapter.disconnect();
    }

    if (allWorkers.length === 0) {
      process.exit(0);
    }

    let remaining = allWorkers.length;
    const onExit = () => {
      remaining--;
      info(TAG, `worker drained, ${remaining} remaining`);
      if (remaining <= 0) process.exit(0);
    };
    for (const worker of allWorkers) {
      worker.once('exit', onExit);
    }

    setTimeout(() => {
      warn(TAG, `drain timeout, force killing ${allWorkers.length} worker(s)`);
      for (const worker of allWorkers) {
        try { worker.kill('SIGKILL'); } catch {}
      }
      process.exit(1);
    }, DRAIN_TIMEOUT);
  }
}

// ── Image GC ──

function cleanupImages(workspaceDir) {
  const imgDir = join(workspaceDir, '.images');
  try {
    const files = readdirSync(imgDir);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of files) {
      const fp = join(imgDir, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp);
      } catch {}
    }
  } catch {}
}
