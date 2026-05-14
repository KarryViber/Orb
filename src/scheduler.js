import { dirname, join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { info, error as logError, warn } from './log.js';
import { taskQueue } from './queue.js';
import { sanitizeErrorText } from './format-utils.js';
import { listFacts, storeLesson, storeCorrectionLesson } from './memory.js';
import { spawnWorker } from './spawn.js';
import { getDefaults } from './config.js';
import { writeLessonCandidate } from './lesson-candidates.js';
import { isSuccessfulStopReason, isTruncatedStopReason } from './stop-reason.js';
import {
  checkSkillReview,
  scanExistingSkills,
  spawnSkillReview,
} from './scheduler-skill-review.js';
import {
  checkMemorySync,
  runMemoryMaintenance,
} from './scheduler-memory-maintenance.js';
import {
  normalizeShutdownQueue,
  persistShutdownQueues,
  restoreShutdownQueues,
  sanitizeTaskForPersistence,
} from './scheduler-shutdown-persistence.js';
import {
  ASSISTANT_TEXT_FINAL,
  CONTROL_PLANE_MESSAGE,
  METADATA_TITLE,
  makeTurnId,
  normalizeChannelSemantics,
} from './turn-delivery/intents.js';
import { TurnDeliveryLedger, ledgerPathForDataDir } from './turn-delivery/ledger.js';
import { TurnDeliveryOrchestrator } from './turn-delivery/orchestrator.js';
import { makeCcEvent, makeInject, makeTask, validateExternalSessionResult, validateIncomingIpc } from './ipc-schema.js';
import {
  ORB_EVENTBUS_SMOKE_LOG,
  ORB_PERMISSION_APPROVAL_MODE,
  ORB_RUNTIME,
  ORB_PERMISSION_TIMEOUT_MS,
  ORB_WORKER_TIMEOUT_MS,
} from './runtime-env.js';
import { runWorkerForTask } from './scheduler/worker-runner.js';
const TAG = 'scheduler';
const DRAIN_TIMEOUT = 30_000;
const MAX_AUTO_CONTINUE = 2;  // max auto-retries on empty result (context overflow)
const PERMISSION_APPROVAL_TIMEOUT_MS = ORB_PERMISSION_TIMEOUT_MS;
const STATUS_REFRESH_MS = 20_000;
const SILENT_PREFIX = '[SILENT]';
const MAX_SOCKET_BUFFER = 64 * 1024;
const LOADING_MESSAGES = [
  'Cooking…',
  'Reading files…',
  'Thinking…',
  'Working on it…',
  'Analyzing…',
];
const THINKING_STATUS = LOADING_MESSAGES[0];
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

function makeAttemptId() {
  return `attempt-${randomUUID()}`;
}
function ensureAttemptId(task) {
  if (!task || typeof task !== 'object') return task;
  if (!task.attemptId) task.attemptId = makeAttemptId();
  return task.attemptId;
}

function normalizeOrigin(origin) {
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
function inferTaskOrigin(task, fallbackKind = 'user') {
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
function injectOriginForTask(task, parentAttemptId) {
  return {
    kind: 'inject',
    name: 'replay',
    parentAttemptId: parentAttemptId || task?.attemptId || null,
  };
}
function isSilentResultText(text) {
  return typeof text === 'string' && text.startsWith(SILENT_PREFIX);
}
function shortFailureReason(value, fallback = 'worker failed') {
  const text = sanitizeErrorText(value || fallback)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || fallback;
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

function formatJstMonthDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function buildFailureReceiptText({ task, threadTs, stopReason, stderrSummary, exitCode }) {
  const reason = shortFailureReason(stderrSummary || stopReason || (exitCode != null ? `exitCode=${exitCode}` : 'worker failed'));
  const cronName = task?.origin?.kind === 'cron'
    ? task.origin.name
    : (task?.cronName || (String(threadTs || '').startsWith('cron:') ? String(threadTs).slice('cron:'.length) : ''));
  if (cronName) {
    return `⚠️ ${cronName} ${formatJstMonthDay()}｜失败：LLM｜${reason}`;
  }
  return `:warning: 出错了: ${reason}`;
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

export class EventBus {
  constructor({ subscriberTimeoutMs = 5_000, onSubscriberDisabled = null } = {}) {
    this.subscribers = new Set();
    this.subscriberTimeoutMs = subscriberTimeoutMs;
    this.onSubscriberDisabled = typeof onSubscriberDisabled === 'function' ? onSubscriberDisabled : null;
    this._subscriberFailures = new Map();
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
    const subscriberName = this._subscriberName(subscriber);
    try {
      const handled = await this._withSubscriberTimeout(async () => {
        const match = typeof subscriber === 'function'
          ? true
          : (typeof subscriber.match === 'function' ? await subscriber.match(msg, ctx) : true);
        if (!match) return false;
        if (typeof subscriber === 'function') await subscriber(msg, ctx);
        else await subscriber.handle(msg, ctx);
        return true;
      });
      if (handled) this._subscriberFailures.delete(subscriber);
    } catch (err) {
      const previous = this._subscriberFailures.get(subscriber);
      const count = (previous?.count || 0) + 1;
      this._subscriberFailures.set(subscriber, {
        count,
        lastError: err.message,
        lastFailedAt: new Date().toISOString(),
      });
      err.subscriberName = subscriberName;
      err.subscriberFailureCount = count;
      if (count >= 3) {
        this.subscribers.delete(subscriber);
        this._subscriberFailures.delete(subscriber);
        warn(TAG, `subscriber ${subscriberName} disabled after 3 consecutive failures: ${err.message}`);
        if (this.onSubscriberDisabled) {
          try {
            await this.onSubscriberDisabled({ subscriberName, lastError: err, ctx });
          } catch (notifyErr) {
            warn(TAG, `subscriber disabled notification failed: ${notifyErr.message}`);
          }
        }
      }
      throw err;
    }
  }

  _subscriberName(subscriber) {
    if (typeof subscriber === 'function') return subscriber.name || 'anonymous-function';
    return subscriber.name || subscriber.constructor?.name || 'anonymous-subscriber';
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
  constructor({ maxWorkers, timeoutMs, getProfile, startPermissionServer = true, startExternalSessionListener = null, externalSessionSocketPath = null, spawnWorkerFn = spawnWorker }) {
    this.maxWorkers = maxWorkers || 3;
    this.timeoutMs = timeoutMs || ORB_WORKER_TIMEOUT_MS;
    this.getProfile = getProfile;
    this.eventBus = new EventBus({
      onSubscriberDisabled: async ({ subscriberName, ctx }) => {
        const channel = ctx?.channel;
        const threadTs = ctx?.threadTs;
        const adapter = this._getAdapter(ctx?.platform);
        if (!adapter || !channel || !threadTs) return;
        await adapter.sendReply({
          channel,
          threadTs,
          text: `⚠️ 进度渲染暂时不可用（subscriber \`${subscriberName}\` 连续失败 3 次，已临时关闭）。最终结果会在任务完成时一次性发送。`,
          intent: CONTROL_PLANE_MESSAGE,
        });
      },
    });
    this.adapter = null;           // single Slack adapter
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
    this._permissionApprovalMode = ORB_PERMISSION_APPROVAL_MODE;
    this._permissionSocketPath = join(tmpdir(), `orb-permission-scheduler-${process.pid}.sock`);
    process.env.ORB_SCHEDULER_SOCKET = this._permissionSocketPath;
    this._permissionServer = null;
    this._externalSessionSocketPath = externalSessionSocketPath || join(ORB_RUNTIME, 'external-session.sock');
    process.env.ORB_EXTERNAL_SESSION_SOCKET = this._externalSessionSocketPath;
    this._externalSessionServer = null;
    if (ORB_EVENTBUS_SMOKE_LOG) {
      this.eventBus.subscribe({
        match: (msg) => msg?.type === 'cc_event',
        handle: (msg) => info(TAG, `eventBus cc_event: turn=${msg.turnId || 'unknown'} event=${msg.eventType || 'unknown'}`),
      });
    }
    globalThis.__orbSchedulerInstance = this;
    if (startPermissionServer !== false) this._startPermissionServer();
    if ((startExternalSessionListener ?? startPermissionServer) !== false) this._startExternalSessionListener();
    this._restoreShutdownQueues();
  }

  setAdapter(adapter) {
    if (typeof adapter?.deliver !== 'function') throw new Error('adapter must implement deliver()');
    if (typeof adapter.setAdapterEventLedgerResolver === 'function') {
      adapter.setAdapterEventLedgerResolver((hint = {}) => {
        const userId = hint?.userId || hint?.user || null;
        if (!userId || typeof this.getProfile !== 'function') return null;
        return this._getTurnDeliveryLedger(this.getProfile(userId));
      });
    }
    this.adapter = adapter;
    if (typeof adapter.installCcEventSubscriber === 'function') {
      adapter.installCcEventSubscriber(this.eventBus);
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

  _getAdapter(_platform) {
    return this.adapter;
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
      if (buffer.length > MAX_SOCKET_BUFFER) {
        warn(TAG, `permission socket buffer overflow, closing: ${buffer.length} bytes`);
        socket.destroy();
        return;
      }
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
    if (msg?.type === 'permission_response') {
      const key = this._permissionResponseKey(msg);
      if (!key) {
        this._writePermissionSocketResponse(socket, { allow: false, reason: `unknown permission response requestId: ${msg?.requestId || 'missing'}` });
        return;
      }
      this._resolvePermissionRequest(key, {
        allow: Boolean(msg.allow),
        reason: msg.reason,
        answers: msg.answers && typeof msg.answers === 'object' ? msg.answers : undefined,
      });
      this._writePermissionSocketResponse(socket, { allow: true, reason: 'permission response accepted' });
      return;
    }

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
    let profile = activeEntry?.task?.profile || null;
    if (!profile && typeof this.getProfile === 'function') {
      try {
        profile = this.getProfile(msg.userId) || null;
      } catch {}
    }
    this._pendingPermissionRequests.set(key, {
      socket,
      requestId,
      threadTs,
      channel,
      toolName,
      profileDataDir: profile?.dataDir || null,
      createdAt: Date.now(),
      settled: false,
    });

    socket.once('close', () => {
      const pending = this._pendingPermissionRequests.get(key);
      if (pending && !pending.settled) {
        this._pendingPermissionRequests.delete(key);
        warn(TAG, `permission socket closed before response: ${key}`);
        if (pending.isAskUserQuestion) {
          this._deleteAskUserQuestionPending(pending);
        }
        if (pending.isAskUserQuestion && typeof pending.adapter?.cancelAskUserQuestionCard === 'function') {
          pending.adapter.cancelAskUserQuestionCard({
            channel: pending.channel,
            messageTs: pending.messageTs,
            reason: 'worker exited',
          }).catch((err) => {
            warn(TAG, `failed to cancel AskUserQuestion card: ${err.message}`);
          });
        }
      }
    });

    if (this._permissionApprovalMode === 'auto-allow') {
      info(TAG, `permission auto-allow: thread=${threadTs} tool=${toolName} request=${requestId}`);
      this._resolvePermissionRequest(key, { allow: true, reason: 'auto-allow stub' });
      return;
    }

    if (toolName === 'AskUserQuestion') {
      await this._dispatchAskUserQuestion(msg, key, adapter);
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

  async _dispatchAskUserQuestion(msg, key, adapter) {
    const pending = this._pendingPermissionRequests.get(key);
    if (!pending) return;
    if (typeof adapter?.sendAskUserQuestion !== 'function') {
      this._resolvePermissionRequest(key, { allow: false, reason: 'AskUserQuestion adapter unavailable' });
      return;
    }
    const questions = Array.isArray(msg.toolInput?.questions) ? msg.toolInput.questions : [];
    if (questions.length < 1 || questions.length > 4) {
      this._resolvePermissionRequest(key, { allow: false, reason: `AskUserQuestion expected 1-4 questions, got ${questions.length}` });
      return;
    }
    pending.isAskUserQuestion = true;
    pending.adapter = adapter;
    pending.questions = questions;
    info(TAG, `AskUserQuestion requested: thread=${pending.threadTs} request=${pending.requestId} questions=${questions.length}`);
    const sent = await adapter.sendAskUserQuestion({
      channel: pending.channel,
      threadTs: pending.threadTs,
      requestId: pending.requestId,
      questions,
      socketPath: this._permissionSocketPath,
    });
    pending.messageTs = sent?.ts || null;
  }

  _deleteAskUserQuestionPending(pending) {
    if (!pending?.profileDataDir || !pending.requestId) return;
    const pendingPath = join(pending.profileDataDir, 'auq-pending', `${pending.requestId}.json`);
    try {
      if (existsSync(pendingPath)) unlinkSync(pendingPath);
    } catch (err) {
      warn(TAG, `failed to delete AskUserQuestion pending file: ${err.message}`);
    }
  }

  _permissionRequestKey(threadTs, requestId) {
    return `${threadTs}:${requestId}`;
  }

  _permissionResponseKey(msg) {
    const requestId = String(msg?.requestId || '');
    if (!requestId) return null;
    const threadTs = String(msg?.threadTs || '');
    if (threadTs) {
      const key = this._permissionRequestKey(threadTs, requestId);
      if (this._pendingPermissionRequests.has(key)) return key;
    }
    for (const [key, pending] of this._pendingPermissionRequests.entries()) {
      if (pending.requestId === requestId) return key;
    }
    return null;
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

  _startExternalSessionListener() {
    try {
      mkdirSync(dirname(this._externalSessionSocketPath), { recursive: true, mode: 0o700 });
      if (existsSync(this._externalSessionSocketPath)) unlinkSync(this._externalSessionSocketPath);
    } catch (err) {
      warn(TAG, `failed to prepare external session socket: ${err.message}`);
    }

    this._externalSessionServer = net.createServer((socket) => this._handleExternalSessionSocket(socket));
    this._externalSessionServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        warn(TAG, `external session socket EADDRINUSE, retrying unlink: ${this._externalSessionSocketPath}`);
        try {
          unlinkSync(this._externalSessionSocketPath);
          this._externalSessionServer.listen(this._externalSessionSocketPath, () => {
            try {
              chmodSync(this._externalSessionSocketPath, 0o600);
            } catch (chmodErr) {
              warn(TAG, `failed to chmod external session socket after retry: ${chmodErr.message}`);
            }
            info(TAG, `external session socket re-listening after EADDRINUSE recovery: ${this._externalSessionSocketPath}`);
          });
        } catch (retryErr) {
          logError(TAG, `external session socket unrecoverable: ${retryErr.message}`);
        }
        return;
      }
      logError(TAG, `external session socket server error: ${err.message}`);
    });
    this._externalSessionServer.listen(this._externalSessionSocketPath, () => {
      try {
        chmodSync(this._externalSessionSocketPath, 0o600);
      } catch (err) {
        warn(TAG, `failed to chmod external session socket: ${err.message}`);
      }
      info(TAG, `external session socket listening: ${this._externalSessionSocketPath}`);
    });
  }

  _handleExternalSessionSocket(socket) {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_SOCKET_BUFFER) {
        warn(TAG, `external session socket buffer overflow, closing: ${buffer.length} bytes`);
        socket.destroy();
        return;
      }
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          warn(TAG, `invalid external session payload: ${err.message}`);
          continue;
        }
        this._handleExternalSessionResult(msg).catch((err) => {
          logError(TAG, `external session result failed: ${err.message}`);
        });
      }
    });
    socket.on('error', (err) => {
      warn(TAG, `external session socket client error: ${err.message}`);
    });
  }

  async _handleExternalSessionResult(msg) {
    const validationError = validateExternalSessionResult(msg);
    if (validationError) {
      warn(TAG, `dropped invalid external session result: ${validationError}`);
      return;
    }
    const channel = msg.channel;
    const threadTs = msg.thread_ts;
    const label = msg.label;
    const adapter = this._getAdapter('slack');
    if (adapter) {
      await adapter.deliver({
        intent: 'launcher_result_card',
        channel,
        threadTs,
        platform: 'slack',
        text: msg.text,
        source: 'scheduler.external_session_result',
        meta: { externalSessionResult: msg },
      }, { channel: 'postMessage' });
    }
    const entry = this.activeWorkers.get(threadTs);
    if (!entry?.worker) return;
    const injectId = `inject-${this._nextInjectId++}`;
    const attemptId = makeAttemptId();
    const origin = {
      kind: 'launcher_result',
      name: label,
      parentAttemptId: entry?.task?.attemptId || null,
    };
    const injectTask = {
      userText: `外部 session \`${label}\` rc=${msg.rc} took=${msg.took_seconds ?? '?'}s，详情见上方卡片。`,
      fileContent: '',
      imagePaths: [],
      fragments: [],
      threadTs,
      deliveryThreadTs: entry.deliveryThreadTs ?? threadTs,
      channel,
      userId: entry.userId || null,
      platform: entry.platform || 'slack',
      attemptId,
      origin,
      channelSemantics: normalizeChannelSemantics(entry.channelSemantics ?? entry.task?.channelSemantics),
    };
    if (!entry.pendingInjects) entry.pendingInjects = new Map();
    entry.pendingInjects.set(injectId, injectTask);
    try {
      entry.worker.send(makeInject({
        injectId,
        attemptId,
        userText: injectTask.userText,
        fileContent: '',
        imagePaths: [],
        fragments: [],
        origin,
      }));
      info(TAG, `launcher result injected into active worker: thread=${threadTs} label=${label}`);
    } catch (err) {
      entry.pendingInjects.delete(injectId);
      warn(TAG, `launcher result inject failed: thread=${threadTs} label=${label} err=${err.message}`);
    }
  }

  _restoreShutdownQueues() {
    return restoreShutdownQueues({ threadQueues: this.threadQueues });
  }

  _normalizeShutdownQueue(raw, queuePath) {
    return normalizeShutdownQueue(raw, queuePath);
  }

  async submit(task) {
    const { threadTs, channel, platform } = task;
    ensureAttemptId(task);
    task.origin = normalizeOrigin(task.origin) || inferTaskOrigin(task);
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
        origin: normalizeOrigin(task.origin) || injectOriginForTask(task, entry?.task?.attemptId || task.attemptId),
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
        entry.worker.send(makeInject({
          injectId,
          userText: task.userText,
          fileContent: task.fileContent,
          imagePaths: task.imagePaths,
          fragments: task.fragments || [],
          attemptId: injectTask.attemptId,
          origin: injectTask.origin,
          channelMeta: task.channelMeta,
        }));
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
    try {
      await this.eventBus.publish(msg, {
        scheduler: this,
        ...ctx,
      });
    } catch (err) {
      const errors = err instanceof AggregateError ? err.errors : [err];
      const summaries = errors.map((item) => ({
        subscriber: item?.subscriberName || 'unknown',
        message: sanitizeErrorText(item?.message || String(item || 'unknown')).slice(0, 200),
        count: item?.subscriberFailureCount || null,
      }));
      try {
        const userNotified = Boolean(
          ctx.channel
          && ctx.threadTs
          && ctx.platform
          && this._getAdapter(ctx.platform)
        );
        writeLessonCandidate(ctx.profile?.dataDir || ctx.task?.profile?.dataDir, {
          source: 'event-bus-subscriber-failed',
          userNotified,
          stopReason: msg.eventType || 'cc_event',
          errorContext: JSON.stringify({
            eventType: msg.eventType || null,
            subscribers: summaries,
          }).slice(0, 500),
          threadId: ctx.threadTs || ctx.task?.threadTs || '',
          kind: 'event-bus',
          origin: ctx.task?.origin || msg.origin || null,
        });
      } catch (lessonErr) {
        warn(TAG, `failed to write event-bus subscriber failure lesson candidate: ${lessonErr.message}`);
      }
      throw err;
    }
  }

  async _spawnWorker(task) {
    return runWorkerForTask(task, { scheduler: this });
  }

  // --- Skill auto-extraction ---

  _checkSkillReview(profileName, toolCount, task, resultText, toolHistory = [], toolResults = []) {
    return checkSkillReview({
      profileName,
      toolCount,
      task,
      resultText,
      toolHistory,
      toolResults,
      skillToolCounts: this._skillToolCounts,
      getProfile: (userId) => this.getProfile(userId),
      backgroundWorkers: this._backgroundWorkers,
      maxBackgroundWorkers: this._maxBackgroundWorkers,
    });
  }

  _scanExistingSkills(agentsDir) {
    return scanExistingSkills(agentsDir);
  }

  _spawnSkillReview(task, priorMessages = []) {
    return spawnSkillReview({
      task,
      priorMessages,
      getProfile: (userId) => this.getProfile(userId),
      backgroundWorkers: this._backgroundWorkers,
      maxBackgroundWorkers: this._maxBackgroundWorkers,
    });
  }

  // --- Memory + User profile sync ---

  _checkMemorySync(profileName, toolCount, task) {
    return checkMemorySync({
      profileName,
      toolCount,
      task,
      memorySyncCounts: this._memorySyncCounts,
      lastMemorySync: this._lastMemorySync,
      getProfile: (userId) => this.getProfile(userId),
    });
  }

  async _spawnMemorySync(task) {
    return runMemoryMaintenance({
      task,
      getProfile: (userId) => this.getProfile(userId),
    });
  }

  _disconnectAdapters() {
    if (this.adapter) {
      info(TAG, 'disconnecting adapter: slack');
      this.adapter.disconnect();
    }
  }

  _activeWorkerTurnId(threadTs, entry) {
    const turnIds = entry?.orchestrator?._turns?.keys
      ? [...entry.orchestrator._turns.keys()]
      : [];
    return turnIds.at(-1) || makeTurnId({
      threadTs: entry?.deliveryThreadTs || threadTs,
      attemptId: entry?.task?.attemptId,
    });
  }

  async _publishDrainWorkerCrashResults(activeEntries) {
    for (const [threadTs, entry] of activeEntries) {
      if (this.activeWorkers.get(threadTs)?.worker !== entry.worker) continue;
      const adapter = this._getAdapter(entry.platform);
      if (!adapter) continue;
      const turnId = this._activeWorkerTurnId(threadTs, entry);
      const msg = {
        ...makeCcEvent({
          turnId,
          attemptId: entry.task?.attemptId || '',
          origin: entry.task?.origin || null,
          eventType: 'result',
          payload: {
            stop_reason: 'worker_crash',
            stopReason: 'worker_crash',
            synthetic: true,
            reason: 'scheduler_drain_timeout',
          },
        }),
        stopReason: 'worker_crash',
      };
      try {
        await this._publishWorkerCcEvent(msg, {
          task: entry.task,
          turn: entry.turn,
          worker: entry.worker,
          adapter,
          channel: entry.channel,
          threadTs,
          effectiveThreadTs: entry.deliveryThreadTs || threadTs,
          platform: entry.platform,
          profile: entry.task?.profile || null,
          deferDeliveryUntilResult: entry.task?.deferDeliveryUntilResult === true,
          channelSemantics: entry.channelSemantics,
          orchestrator: entry.orchestrator,
        });
        info(TAG, `synthetic worker_crash result published before drain kill: thread=${threadTs} turn=${turnId}`);
      } catch (err) {
        warn(TAG, `synthetic worker_crash result publish failed: thread=${threadTs} err=${err.message}`);
      }
    }
  }

  async shutdown(signal) {
    const activeEntries = [...this.activeWorkers.entries()];
    const allWorkers = activeEntries.map(([, { worker }]) => worker).concat([...this._backgroundWorkers]);
    info(TAG, `${signal} received, draining ${this.activeWorkers.size} active + ${this._backgroundWorkers.size} background worker(s)...`);
    try {
      this._permissionServer?.close();
    } catch {}
    try {
      if (existsSync(this._permissionSocketPath)) unlinkSync(this._permissionSocketPath);
    } catch {}

    persistShutdownQueues({
      threadQueues: this.threadQueues,
      getProfile: (userId) => this.getProfile(userId),
    });

    for (const ledger of this._turnDeliveryLedgers.values()) {
      try {
        await ledger.flush?.();
      } catch (err) {
        warn(TAG, `turn delivery ledger flush failed: ${err.message}`);
      }
    }

    if (allWorkers.length === 0) {
      this._disconnectAdapters();
      process.exit(0);
    }

    let remaining = allWorkers.length;
    const onExit = () => {
      remaining--;
      info(TAG, `worker drained, ${remaining} remaining`);
      if (remaining <= 0) {
        this._disconnectAdapters();
        process.exit(0);
      }
    };
    for (const worker of allWorkers) {
      worker.once('exit', onExit);
    }

    setTimeout(async () => {
      warn(TAG, `drain timeout, force killing ${allWorkers.length} worker(s)`);
      await this._publishDrainWorkerCrashResults(activeEntries);
      for (const ledger of this._turnDeliveryLedgers.values()) {
        try {
          await ledger.flush?.();
        } catch (err) {
          warn(TAG, `turn delivery ledger flush failed: ${err.message}`);
        }
      }
      for (const worker of allWorkers) {
        try { worker.kill('SIGKILL'); } catch {}
      }
      this._disconnectAdapters();
      process.exit(1);
    }, DRAIN_TIMEOUT);
  }
}
