import { join } from 'node:path';
import net from 'node:net';
import { readdirSync, readFileSync, existsSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { info, error as logError, warn } from './log.js';
import { taskQueue } from './queue.js';
import { sanitizeErrorText } from './format-utils.js';
import { listFacts, storeLesson, storeCorrectionLesson, purgeTransient, lintMemory } from './memory.js';
import { spawnWorker } from './spawn.js';
import { buildTaskUpdateChunks, extractSuggestedPrompts } from './adapters/slack-format.js';
const TAG = 'scheduler';
const DRAIN_TIMEOUT = 30_000;
const SKILL_REVIEW_THRESHOLD = 10;   // cumulative tool uses before triggering review
const MEMORY_SYNC_THRESHOLD = 20;    // cumulative tool uses before memory/user sync
const MEMORY_SYNC_INTERVAL = 6 * 60 * 60 * 1000;  // min 6h between syncs per profile
const MAX_AUTO_CONTINUE = 2;  // max auto-retries on empty result (context overflow)
const PERMISSION_APPROVAL_TIMEOUT_MS = parseInt(process.env.ORB_PERMISSION_TIMEOUT_MS, 10) || 300_000;
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

function isSilentResultText(text) {
  return typeof text === 'string' && text.startsWith(SILENT_PREFIX);
}

function getTaskCardStreamErrorCode(err) {
  if (!err) return null;
  if (typeof err.slackErrorCode === 'string' && err.slackErrorCode) return err.slackErrorCode;
  const match = String(err.message || '').match(/chat\.(?:start|append|stop)Stream failed: ([a-z_]+)/);
  return match?.[1] || null;
}

function classifyTaskCardStreamError(err) {
  const code = getTaskCardStreamErrorCode(err);
  if (code === 'invalid_chunks' || code === 'invalid_auth') {
    return { code, level: 'error' };
  }
  if (code === 'message_not_in_streaming_state' || code === 'message_not_owned_by_app') {
    return { code, level: 'warn' };
  }
  return { code, level: 'error' };
}

function resolveTaskCardDisplayMode(chunkType, fallback = 'timeline') {
  if (chunkType === 'task') return 'timeline';
  return fallback;
}

function buildTaskCardFallbackMarkdown(taskCards) {
  if (!(taskCards instanceof Map) || taskCards.size === 0) return '';
  const lines = [];
  for (const taskCard of taskCards.values()) {
    const statusIcon = taskCard.status === 'complete'
      ? '✅'
      : taskCard.status === 'error'
        ? '❌'
        : '⏳';
    const title = String(taskCard.title || 'Task').trim();
    const details = String(taskCard.details || '').trim();
    lines.push(details ? `${statusIcon} ${title}: ${details}` : `${statusIcon} ${title}`);
  }
  return lines.join('\n');
}

export class Scheduler {
  constructor({ maxWorkers, timeoutMs, getProfile }) {
    this.maxWorkers = maxWorkers || 3;
    this.timeoutMs = timeoutMs || 900_000;
    this.getProfile = getProfile;
    this.adapters = new Map();     // platform → adapter
    this.activeWorkers = new Map();
    this.threadQueues = new Map();
    this._skillToolCounts = new Map();   // profileName → cumulative tool count
    this._memorySyncCounts = new Map();  // profileName → cumulative tool count for memory sync
    this._lastMemorySync = new Map();    // profileName → timestamp of last sync
    this._autoContinueCount = new Map(); // threadTs → retry count for empty results
    this._backgroundWorkers = new Set(); // skill-review + memory-sync workers
    this._maxBackgroundWorkers = 2;
    this._pendingPermissionRequests = new Map();
    this._permissionApprovalMode = process.env.ORB_PERMISSION_APPROVAL_MODE || 'auto-allow';
    this._permissionSocketPath = join(tmpdir(), `orb-permission-scheduler-${process.pid}.sock`);
    this._permissionServer = null;
    globalThis.__orbSchedulerInstance = this;
    this._startPermissionServer();
    this._restoreShutdownQueues();
  }

  addAdapter(name, adapter) {
    this.adapters.set(name, adapter);
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

    if (this._permissionApprovalMode !== 'slack') {
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

    if (!adapter?.sendApproval) {
      this._resolvePermissionRequest(key, { allow: false, reason: 'permission approval adapter unavailable' });
      return;
    }

    // TODO(karry): Slack interactive callback path needs daemon-backed manual validation in a real thread.
    info(TAG, `permission approval requested: thread=${threadTs} tool=${toolName} request=${requestId}`);
    const decision = await adapter.sendApproval(channel, threadTs, {
      kind: 'permission',
      toolName,
      toolInput: msg.toolInput,
      requestId,
      toolUseId: msg.toolUseId,
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
    return { globalQueue, threadQueues };
  }

  async submit(task) {
    const { threadTs, channel, platform } = task;
    const adapter = this._getAdapter(platform);
    if (!adapter) {
      logError(TAG, `submit failed: no adapter for platform=${platform} thread=${threadTs}`);
      return;
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
      try {
        entry.worker.send({ type: 'inject', userText: task.userText, fileContent: task.fileContent, imagePaths: task.imagePaths });
        info(TAG, `injected into active worker: thread=${threadTs}`);
        return;
      } catch (e) {
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
          await adapter.sendReply(channel, threadTs,
            `队列已满（${taskQueue.size}条排队中），请稍等。`);
        }
      } else {
        if (!task.silentQueueing) {
          await adapter.sendReply(channel, threadTs,
            `已加入队列（${taskQueue.size}条排队中），会按顺序处理。`);
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

  async _spawnWorker(task) {
    const { userText, fileContent, imagePaths, threadTs, channel, userId, platform } = task;
    const deferDeliveryUntilResult = task.deferDeliveryUntilResult === true;
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
      await adapter?.sendReply(channel, threadTs, `:warning: 未识别的用户，无法处理请求。`).catch(() => {});
      task._completion?.reject?.(err);
      return;
    }
    info(TAG, `profile resolved: user=${userId} → ${profile.name} (${profile.workspaceDir})`);

    // 消息前缀解析模型 / effort（可选覆盖）
    let effectiveModel = null;
    let effectiveEffort = null;
    let effectiveText = userText || '';
    const modelMatch = effectiveText.match(/^\[(haiku|sonnet|opus)\]\s+/i);
    if (modelMatch) {
      effectiveModel = modelMatch[1].toLowerCase();
      effectiveText = effectiveText.slice(modelMatch[0].length);
    }
    const effortMatch = effectiveText.match(/^\[effort:(low|medium|high|xhigh|max)\]\s+/i);
    if (effortMatch) {
      effectiveEffort = effortMatch[1].toLowerCase();
      effectiveText = effectiveText.slice(effortMatch[0].length);
    }

    // 关键词自动升 xhigh（若未手动指定 effort）
    if (!effectiveEffort && shouldEscalateEffort(effectiveText)) {
      effectiveEffort = 'xhigh';
      info(TAG, `effort escalated to xhigh by keyword match`);
    }

    // 默认 low（若前面都没设）
    if (!effectiveEffort) effectiveEffort = 'low';

    let typingActive = false;
    let responded = false;
    let turnDelivered = false;
    let pendingAutoContinue = null;
    let effectiveThreadTs = task.deliveryThreadTs === undefined ? (threadTs || null) : task.deliveryThreadTs;
    let pendingThreadStatus = '';
    let turnCount = 0;
    let metadataUpdatedForTurn = false;
    let finalResultText = '';
    let workerFailure = null;
    let completionSettled = false;
    let worker;
    const hasTaskCardThread = () => effectiveThreadTs != null;
    const canManageThreadStatus = !deferDeliveryUntilResult
      && platform === 'slack'
      && channel != null
      && typeof adapter?.setThreadStatus === 'function';
    const taskCardState = {
      enabled: !deferDeliveryUntilResult
        && platform === 'slack' && channel != null && hasTaskCardThread()
        && task.enableTaskCard !== false
        && typeof adapter?.startStream === 'function'
        && typeof adapter?.appendStream === 'function'
        && typeof adapter?.stopStream === 'function',
      deferred: deferDeliveryUntilResult
        && platform === 'slack' && channel != null && hasTaskCardThread()
        && task.enableTaskCard !== false
        && typeof adapter?.startStream === 'function'
        && typeof adapter?.stopStream === 'function',
      streamId: null,
      chunkType: null,
      displayMode: null,
      taskCards: new Map(),
      failed: false,
      failureNotified: false,
      missingThreadWarned: false,
      bubbleCleared: false,
    };

    const settleCompletion = (method, payload) => {
      if (completionSettled) return;
      completionSettled = true;
      task._completion?.[method]?.(payload);
    };

    const applyThreadStatus = async (status, loadingMessages) => {
      pendingThreadStatus = String(status || '');
      if (!canManageThreadStatus || !effectiveThreadTs) return;
      try {
        await adapter.setThreadStatus(channel, effectiveThreadTs, pendingThreadStatus, loadingMessages);
      } catch (err) {
        warn(TAG, `failed to set thread status: ${err.message}`);
      }
    };

    const startThreadStatusRefresh = async (status = THINKING_STATUS) => {
      if (!canManageThreadStatus) return;
      await applyThreadStatus(status, LOADING_MESSAGES);
    };

    const startTyping = async () => {
      if (deferDeliveryUntilResult) return;
      await startThreadStatusRefresh();
      typingActive = true;
    };

    const stopTyping = async () => {
      if (deferDeliveryUntilResult) return;
      if (!typingActive) return;
      typingActive = false;
      await applyThreadStatus('');
    };

    const resetTaskCardState = () => {
      // Slack streaming is per-message; every turn starts a fresh stream.
      taskCardState.streamId = null;
      taskCardState.chunkType = null;
      taskCardState.displayMode = null;
      taskCardState.taskCards.clear();
      taskCardState.failed = false;
      taskCardState.failureNotified = false;
      taskCardState.bubbleCleared = false;
    };

    const failTaskCardStream = async (err) => {
      if (taskCardState.failed && taskCardState.failureNotified) return;
      const failure = classifyTaskCardStreamError(err);
      const fallbackMarkdown = failure.level === 'warn'
        ? buildTaskCardFallbackMarkdown(taskCardState.taskCards)
        : '';
      taskCardState.failed = true;
      taskCardState.streamId = null;
      taskCardState.chunkType = null;
      taskCardState.displayMode = null;
      if (fallbackMarkdown) {
        try {
          await adapter.sendReply(channel, effectiveThreadTs, fallbackMarkdown);
        } catch (sendErr) {
          warn(TAG, `[task_card] fallback delivery failed: ${sendErr.message}`);
        }
      }
      taskCardState.taskCards.clear();
      const detail = failure.code ? `${failure.code}: ${err.message}` : err.message;
      if (failure.level === 'warn') warn(TAG, `[task_card] stream degraded: ${detail}`);
      else logError(TAG, `[task_card] stream failed: ${detail}`);
      taskCardState.failureNotified = true;
    };

    const disableTaskCardStreaming = (mode) => {
      if (!taskCardState.missingThreadWarned) {
        warn(TAG, `[task_card] skipping ${mode} stream: missing delivery thread ts`);
        taskCardState.missingThreadWarned = true;
      }
      taskCardState.enabled = false;
      taskCardState.deferred = false;
      taskCardState.streamId = null;
      taskCardState.chunkType = null;
      taskCardState.displayMode = null;
      taskCardState.taskCards.clear();
    };

    const buildTaskCardChunks = () => {
      return buildTaskUpdateChunks(taskCardState.taskCards);
    };

    const ensureTaskCardStream = async () => {
      if (!taskCardState.enabled || taskCardState.failed) return false;
      if (!hasTaskCardThread()) {
        disableTaskCardStreaming('live');
        return false;
      }
      if (taskCardState.streamId) return true;
      try {
        const stream = await adapter.startStream(channel, effectiveThreadTs, {
          task_display_mode: taskCardState.displayMode || resolveTaskCardDisplayMode(taskCardState.chunkType, 'timeline'),
          initial_chunks: buildTaskCardChunks(),
          team_id: task.teamId || null,
        });
        taskCardState.streamId = stream?.stream_id || null;
        if (!effectiveThreadTs && stream?.ts) effectiveThreadTs = stream.ts;
        return Boolean(taskCardState.streamId);
      } catch (err) {
        await failTaskCardStream(err);
        return false;
      }
    };

    const appendTaskCardPlan = async () => {
      if (!taskCardState.streamId || taskCardState.failed) return false;
      try {
        await adapter.appendStream(taskCardState.streamId, buildTaskCardChunks());
        return true;
      } catch (err) {
        await failTaskCardStream(err);
        return false;
      }
    };

    const finalizePendingTaskCards = () => {
      let changed = false;
      for (const taskCard of taskCardState.taskCards.values()) {
        if (taskCard.status === 'in_progress') {
          taskCard.status = 'error';
          taskCard.output = taskCard.output || '(no result from tool)';
          changed = true;
        }
      }
      return changed;
    };

    const buildFinalTextPayloads = (text) => {
      const trimmed = String(text || '').trim();
      if (!trimmed) return [];
      return adapter.buildPayloads(trimmed);
    };

    const stopTaskCardStream = async (text) => {
      if (!taskCardState.streamId || taskCardState.failed) return false;
      finalizePendingTaskCards();
      const finalText = String(text || '').trim();
      const finalPayloads = buildFinalTextPayloads(finalText);
      const primaryPayload = finalPayloads.shift() || null;
      const hasBlocks = !!primaryPayload?.blocks?.length;
      const stopPayload = {
        chunks: buildTaskCardChunks(),
        ...(finalText && !hasBlocks ? { markdown_text: finalText } : {}),
        ...(hasBlocks ? { blocks: primaryPayload.blocks } : {}),
      };
      try {
        await adapter.stopStream(taskCardState.streamId, stopPayload);
      } catch (err) {
        const failure = classifyTaskCardStreamError(err);
        if (failure.code === 'message_not_in_streaming_state' || failure.code === 'message_not_owned_by_app') {
          warn(TAG, `stopStream degraded to plain message: ${err.message}`);
          taskCardState.failed = true;
          if (finalText && primaryPayload) await emitPayload(primaryPayload);
          else if (finalText) await adapter.sendReply(channel, effectiveThreadTs, finalText);
          resetTaskCardState();
          for (const payload of finalPayloads) await emitPayload(payload);
          return true;
        }
        throw err;
      }
      resetTaskCardState();
      for (const payload of finalPayloads) {
        await emitPayload(payload);
      }
      return true;
    };

    // Rerun via 🔥 reaction: first emitted payload edits targetMessageTs,
    // subsequent payloads append as normal replies.
    let pendingEdit = task.targetMessageTs || null;
    // Phase ①: ts of the in-thread progress message (null until first TodoWrite)
    let progressTs = null;
    const updateThreadMetadata = async (text) => {
      if (metadataUpdatedForTurn) return;
      if (platform !== 'slack' || !channel || !effectiveThreadTs || !text) return;
      metadataUpdatedForTurn = true;
      if (turnCount === 0 && typeof adapter?.setThreadTitle === 'function') {
        const title = text.split('\n')[0].trim().slice(0, 60);
        if (title) {
          adapter.setThreadTitle(channel, effectiveThreadTs, title).catch((err) => warn(TAG, `setThreadTitle failed: ${err.message}`));
        }
      }
      if (typeof adapter?.setSuggestedPrompts === 'function') {
        const prompts = extractSuggestedPrompts(text);
        if (prompts.length > 0) {
          adapter.setSuggestedPrompts(channel, effectiveThreadTs, prompts).catch((err) => warn(TAG, `setSuggestedPrompts failed: ${err.message}`));
        }
      }
      turnCount += 1;
    };

    const emitPayload = async (payload) => {
      const extra = payload.blocks ? { blocks: payload.blocks } : {};
      if (pendingEdit) {
        await adapter.editMessage(channel, pendingEdit, payload.text, extra);
        pendingEdit = null;
      } else {
        await adapter.sendReply(channel, effectiveThreadTs, payload.text, extra);
      }
    };

    const deliverDeferredFinalResult = async (text) => {
      if (!text) return false;
      if (taskCardState.deferred && taskCardState.taskCards.size > 0) {
        if (!hasTaskCardThread()) {
          disableTaskCardStreaming('deferred');
        } else {
          try {
            finalizePendingTaskCards();
            const finalPayloads = buildFinalTextPayloads(text);
            const primaryPayload = finalPayloads.shift() || null;
            const stream = await adapter.startStream(channel, effectiveThreadTs, {
              task_display_mode: taskCardState.displayMode || resolveTaskCardDisplayMode(taskCardState.chunkType, 'timeline'),
              initial_chunks: buildTaskCardChunks(),
              team_id: task.teamId || null,
            });
            if (!effectiveThreadTs && stream?.ts) effectiveThreadTs = stream.ts;
            const stopPayload = {
              chunks: buildTaskCardChunks(),
              markdown_text: text,
              ...(primaryPayload?.blocks?.length ? { blocks: primaryPayload.blocks } : {}),
            };
            await adapter.stopStream(stream?.stream_id, stopPayload);
            for (const payload of finalPayloads) {
              await emitPayload(payload);
            }
            resetTaskCardState();
            return true;
          } catch (err) {
            const failure = classifyTaskCardStreamError(err);
            if (failure.level === 'warn') {
              warn(TAG, `deferred task_card delivery degraded to plain message: ${err.message}`);
              taskCardState.failed = true;
              try {
                const fallbackPayloads = buildFinalTextPayloads(text);
                for (const payload of fallbackPayloads) await emitPayload(payload);
                resetTaskCardState();
                return true;
              } catch (fallbackErr) {
                logError(TAG, `deferred fallback delivery failed: ${fallbackErr.message}`);
              }
            } else {
              logError(TAG, `deferred task_card delivery failed: ${err.message}`);
            }
          }
        }
      }

      const payloads = adapter.buildPayloads(text);
      for (const payload of payloads) {
        await emitPayload(payload);
      }
      return true;
    };

    try {
      ({ worker } = spawnWorker({
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
          threadHistory: task.threadHistory,
          model: effectiveModel,
          effort: effectiveEffort,
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
          if (!msg || !msg.type) {
            warn(TAG, `invalid worker message: ${JSON.stringify(msg)?.slice(0, 200)}`);
            return;
          }
          info(TAG, `worker response: type=${msg.type} thread=${threadTs} textLen=${msg.text?.length || 0}`);

          if (msg.type === 'progress_update') {
            if (deferDeliveryUntilResult) return;
            if (taskCardState.enabled) return;
            try {
              if (!progressTs) {
                const result = await adapter.sendReply(channel, effectiveThreadTs, msg.text);
                progressTs = result?.ts || null;
              } else {
                await adapter.editMessage(channel, progressTs, msg.text);
              }
            } catch (err) {
              warn(TAG, `progress message failed: ${err.message}`);
            }
            return;
          }

          if (msg.type === 'status_update') {
            if (deferDeliveryUntilResult) return;
            if (taskCardState.streamId && !taskCardState.failed) return;
            await applyThreadStatus(msg.text || '');
            return;
          }

          if (msg.type === 'tool_call') {
            if ((!taskCardState.enabled && !taskCardState.deferred) || taskCardState.failed) return;
            if (!taskCardState.chunkType && typeof msg.chunk_type === 'string') {
              taskCardState.chunkType = msg.chunk_type;
            }
            if (!taskCardState.displayMode && typeof msg.display_mode === 'string') {
              taskCardState.displayMode = msg.display_mode;
            }
            if (!taskCardState.displayMode && taskCardState.chunkType) {
              taskCardState.displayMode = resolveTaskCardDisplayMode(taskCardState.chunkType);
            }
            taskCardState.taskCards.set(msg.task_id, {
              title: msg.title || msg.tool_name || 'Task',
              details: msg.details || '',
              status: 'in_progress',
              output: '',
            });
            if (!taskCardState.enabled) return;
            const hadStream = Boolean(taskCardState.streamId);
            const streamReady = await ensureTaskCardStream();
            if (streamReady && !taskCardState.bubbleCleared) {
              await applyThreadStatus('');
              taskCardState.bubbleCleared = true;
            }
            if (streamReady && hadStream) {
              await appendTaskCardPlan();
            }
            return;
          }

          if (msg.type === 'tool_result') {
            if (taskCardState.failed) return;
            const taskCard = taskCardState.taskCards.get(msg.task_id);
            if (!taskCard) return;
            taskCard.status = msg.status || 'complete';
            taskCard.output = msg.output || '';
            if (!taskCardState.enabled) return;
            if (taskCardState.streamId) {
              await appendTaskCardPlan();
            }
            return;
          }

          if (msg.type === 'turn_start') {
            metadataUpdatedForTurn = false;
            progressTs = null;
            await startTyping();
            return;
          }

          if (msg.type === 'turn_end') {
            await stopTyping();
            return;
          }

          if (msg.type === 'intermediate_text') {
            if (deferDeliveryUntilResult) return;
            if (taskCardState.streamId && !taskCardState.failed) return;
            if (msg.text?.trim()) {
              try {
                const payloads = adapter.buildPayloads(msg.text);
                for (const payload of payloads) {
                  await adapter.sendReply(channel, effectiveThreadTs, payload.text, payload.blocks ? { blocks: payload.blocks } : {});
                }
              } catch (err) {
                warn(TAG, `failed to send intermediate text: ${err.message}`);
              }
            }
            return;
          }

          responded = true;

          if (msg.type === 'turn_complete') {
            await stopTyping();
            // 中间轮次完成 — worker 已裁剪掉经 intermediate_text 投递过的部分
            try {
              const text = (typeof msg.undeliveredText === 'string' ? msg.undeliveredText : msg.text)?.trim();
              if (deferDeliveryUntilResult && isSilentResultText(text)) {
                info(TAG, `silent deferred turn suppressed: thread=${threadTs}`);
                turnDelivered = true;
                resetTaskCardState();
                return;
              }
              if (taskCardState.streamId && !taskCardState.failed) {
                await stopTaskCardStream(text);
                turnDelivered = true;
                await updateThreadMetadata(text);
                return;
              }
              if (text) {
                turnDelivered = true;
                if (deferDeliveryUntilResult) await deliverDeferredFinalResult(text);
                else {
                  const payloads = adapter.buildPayloads(text);
                  for (const payload of payloads) {
                    await emitPayload(payload);
                  }
                }
              }
              await updateThreadMetadata(text);
              resetTaskCardState();
            } catch (err) {
              if (taskCardState.streamId) await failTaskCardStream(err);
              logError(TAG, `failed to send turn_complete: ${err.message}`);
              const fallbackText = (typeof msg.undeliveredText === 'string' ? msg.undeliveredText : msg.text)?.trim();
              const silentDeferredFallback = deferDeliveryUntilResult && isSilentResultText(fallbackText);
              if (silentDeferredFallback) {
                info(TAG, `silent deferred turn suppressed after delivery failure: thread=${threadTs}`);
                turnDelivered = true;
              } else if (fallbackText) {
                turnDelivered = true;
                if (deferDeliveryUntilResult) await deliverDeferredFinalResult(fallbackText);
                else {
                  const payloads = adapter.buildPayloads(fallbackText);
                  for (const payload of payloads) {
                    await emitPayload(payload);
                  }
                }
              }
              if (!silentDeferredFallback) await updateThreadMetadata(fallbackText);
              resetTaskCardState();
            }
            return;
          }

          if (msg.type === 'result') {
            let text = msg.text?.trim() || null;
            const silentDeferredResult = deferDeliveryUntilResult && isSilentResultText(text);
            finalResultText = text || '';
            try {
              if (taskCardState.streamId && !taskCardState.failed && !turnDelivered) {
                await stopTaskCardStream(text);
                turnDelivered = true;
              }
              if (!text) {
                const retries = this._autoContinueCount.get(threadTs) || 0;
                if (retries < MAX_AUTO_CONTINUE) {
                  this._autoContinueCount.set(threadTs, retries + 1);
                  warn(TAG, `empty result, auto-continue ${retries + 1}/${MAX_AUTO_CONTINUE} for thread=${threadTs}`);
                  if (!deferDeliveryUntilResult) {
                    await adapter.sendReply(channel, effectiveThreadTs, `⏳ 回合上限已达${msg.stopReason === 'tool_use' ? '（任务执行中）' : msg.lastTool ? '（正在: ' + msg.lastTool + '）' : ''}，自动续接中 (${retries + 1}/${MAX_AUTO_CONTINUE})…`).catch(() => {});
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
                    threadHistory: task.threadHistory,
                    profile,
                    enableTaskCard: task.enableTaskCard,
                    deferDeliveryUntilResult,
                    _completion: task._completion,
                  };
                  return;
                }
                warn(TAG, `empty result after ${MAX_AUTO_CONTINUE} auto-continues for thread=${threadTs}`);
                this._autoContinueCount.delete(threadTs);
              } else {
                this._autoContinueCount.delete(threadTs);
              }
              if (silentDeferredResult) {
                info(TAG, `silent deferred result suppressed: thread=${threadTs}`);
                turnDelivered = true;
              }
              if (!turnDelivered) {
                if (deferDeliveryUntilResult && text) {
                  turnDelivered = await deliverDeferredFinalResult(text);
                } else {
                  const payloads = adapter.buildPayloads(text || '⚠️ 多次续接仍未生成回复，任务可能需要拆分。请用更小的指令重试。');
                  info(TAG, `sending ${payloads.length} payload(s) to thread=${threadTs}`);
                  for (const payload of payloads) {
                    await emitPayload(payload);
                  }
                }
              } else {
                turnDelivered = false;
              }
              resetTaskCardState();
              if (!silentDeferredResult) await updateThreadMetadata(text);
              await stopTyping();
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
              }
            } catch (err) {
              await stopTyping();
              logError(TAG, `failed to send result: ${err.message}`);
              await adapter.sendReply(channel, effectiveThreadTs, ':warning: 回复发送失败。').catch(() => {});
            }
            if (msg.toolCount > 0) {
              try { this._checkSkillReview(profile.name, msg.toolCount, task, text); } catch (_) {}
              try { this._checkMemorySync(profile.name, msg.toolCount, task); } catch (_) {}
            }
          } else if (msg.type === 'error') {
            const safeError = sanitizeErrorText(msg.error || '未知错误');
            workerFailure = new Error(safeError);
            logError(TAG, `worker error for thread=${threadTs}: ${safeError}`);
            await stopTyping();
            await adapter.sendReply(channel, effectiveThreadTs, `:warning: 出错了: ${safeError}`).catch(() => {});
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
          this.activeWorkers.delete(threadTs);

          const next = taskQueue.dequeue();
          if (next) {
            info(TAG, `draining queue: thread=${next.threadTs} waited=${Date.now() - next.enqueuedAt}ms`);
            await this.submit(next);
          }

          info(TAG, `worker exited: pid=${worker.pid} code=${code} signal=${signal} responded=${responded} thread=${threadTs}`);

          if (!responded) {
            logError(TAG, `worker exited without response: thread=${threadTs} code=${code} signal=${signal}`);
            this._autoContinueCount.delete(threadTs);
            await adapter.cleanupIndicator(channel, effectiveThreadTs, false, '处理过程中出错，请重试。');
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
            settleCompletion('resolve', { text: finalResultText, threadTs: effectiveThreadTs });
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

    this.activeWorkers.set(threadTs, { worker, platform, channel, userId });
    worker.on('error', (err) => {
      logError(TAG, `worker error event: pid=${worker.pid} err=${err.message}`);
    });
    info(TAG, `task sent to worker pid=${worker.pid} thread=${threadTs} profile=${profile.name}`);
  }

  // --- Skill auto-extraction ---

  _checkSkillReview(profileName, toolCount, task, resultText) {
    if (!toolCount || toolCount === 0) return;

    const prev = this._skillToolCounts.get(profileName) || 0;
    const next = prev + toolCount;
    this._skillToolCounts.set(profileName, next);

    if (next >= SKILL_REVIEW_THRESHOLD) {
      info(TAG, `skill review threshold reached: profile=${profileName} tools=${next}`);
      this._skillToolCounts.set(profileName, 0);
      // Package the just-completed turn as priorConversation so the review
      // worker has actual context to extract skills from.
      const priorMessages = [];
      if (task?.userText) priorMessages.push({ role: 'user', content: String(task.userText) });
      if (resultText) priorMessages.push({ role: 'assistant', content: String(resultText) });
      this._spawnSkillReview(task, priorMessages);
    }
  }

  _scanExistingSkills(agentsDir) {
    if (!existsSync(agentsDir)) return [];
    try {
      return readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          try {
            const content = readFileSync(join(agentsDir, f), 'utf8');
            // Extract first 5 lines as summary
            const summary = content.split('\n').slice(0, 5).join('\n');
            return { file: f, summary };
          } catch { return { file: f, summary: '(read error)' }; }
        });
    } catch { return []; }
  }

  _spawnSkillReview(task, priorMessages = []) {
    const { userId, platform } = task;
    const profile = this.getProfile(userId);
    const agentsDir = join(profile.workspaceDir, '.claude', 'skills');

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
      `## Output Location: ${agentsDir}/`,
      '',
      '## Skill File Format (Claude Code agent .md):',
      '```',
      '---',
      'name: skill-name',
      'description: One-line description of when/why to use this',
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
      'Be concise. One skill per file. Filename = kebab-case of skill name.',
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
        let profileName = 'unknown';
        let dataDir = null;
        try {
          const profile = this.getProfile(task.userId);
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
          entry.threadQueues[threadTs].push(task);
        } else {
          entry.globalQueue.push(task);
        }
      };

      for (const task of drained || []) addPersistedTask(task);
      for (const [threadTs, queue] of this.threadQueues) {
        for (const task of queue) addPersistedTask(task, threadTs);
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
