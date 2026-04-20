import { join } from 'node:path';
import { readdirSync, readFileSync, existsSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { info, error as logError, warn } from './log.js';
import { taskQueue } from './queue.js';
import { sanitizeErrorText } from './format-utils.js';
import { listFacts, storeLesson, storeCorrectionLesson, purgeTransient, lintMemory } from './memory.js';
import { spawnWorker } from './spawn.js';
const TAG = 'scheduler';
const DRAIN_TIMEOUT = 30_000;
const SKILL_REVIEW_THRESHOLD = 10;   // cumulative tool uses before triggering review
const MEMORY_SYNC_THRESHOLD = 20;    // cumulative tool uses before memory/user sync
const MEMORY_SYNC_INTERVAL = 6 * 60 * 60 * 1000;  // min 6h between syncs per profile
const MAX_AUTO_CONTINUE = 2;  // max auto-retries on empty result (context overflow)

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
  }

  addAdapter(name, adapter) {
    this.adapters.set(name, adapter);
  }

  _getAdapter(platform) {
    return this.adapters.get(platform) || this.adapters.values().next().value;
  }

  async submit(task) {
    const { threadTs, channel, platform } = task;
    const adapter = this._getAdapter(platform);

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

    if (this.activeWorkers.has(threadTs)) {
      const worker = this.activeWorkers.get(threadTs);
      try {
        worker.send({ type: 'inject', userText: task.userText, fileContent: task.fileContent, imagePaths: task.imagePaths });
        info(TAG, `injected into active worker: thread=${threadTs}`);
        await adapter.setTyping(channel, threadTs, 'is thinking…').catch(() => {});
        return;
      } catch (e) {
        info(TAG, `inject failed, queuing: ${e.message}`);
        if (!this.threadQueues.has(threadTs)) this.threadQueues.set(threadTs, []);
        this.threadQueues.get(threadTs).push(task);
        return;
      }
    }

    if (this.activeWorkers.size >= this.maxWorkers) {
      if (taskQueue.hasThread(threadTs) || !taskQueue.enqueue(task)) {
        await adapter.sendReply(channel, threadTs,
          `队列已满（${taskQueue.size}条排队中），请稍等。`);
      } else {
        await adapter.sendReply(channel, threadTs,
          `已加入队列（${taskQueue.size}条排队中），会按顺序处理。`);
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

  async _spawnWorker(task) {
    const { userText, fileContent, imagePaths, threadTs, channel, userId, platform } = task;
    const adapter = this._getAdapter(platform);

    // Resolve profile for this user
    let profile;
    try {
      profile = this.getProfile(userId);
    } catch (err) {
      logError(TAG, `profile resolution failed for user=${userId}: ${err.message}`);
      await adapter.sendReply(channel, threadTs, `:warning: 未识别的用户，无法处理请求。`).catch(() => {});
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

    let typingSet = false;
    try {
      await adapter.setTyping(channel, threadTs, 'is thinking…');
      typingSet = true;
    } catch (_) {}

    // Typing refresh interval — kept alive until first response or exit
    const typingInterval = typingSet ? setInterval(async () => {
      try { await adapter.setTyping(channel, threadTs, 'is thinking…'); } catch (_) {}
    }, 5_000) : null;

    let responded = false;
    let turnDelivered = false;
    let pendingAutoContinue = null;
    let worker;

    // Rerun via 🔥 reaction: first emitted payload edits targetMessageTs,
    // subsequent payloads append as normal replies.
    let pendingEdit = task.targetMessageTs || null;
    // Phase ①: ts of the in-thread progress message (null until first TodoWrite)
    let progressTs = null;
    const emitPayload = async (payload) => {
      const extra = payload.blocks ? { blocks: payload.blocks } : {};
      if (pendingEdit) {
        await adapter.editMessage(channel, pendingEdit, payload.text, extra);
        pendingEdit = null;
      } else {
        await adapter.sendReply(channel, threadTs, payload.text, extra);
      }
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
            try {
              if (!progressTs) {
                const result = await adapter.sendReply(channel, threadTs, msg.text);
                progressTs = result?.ts || null;
              } else {
                await adapter.editMessage(channel, progressTs, msg.text);
              }
            } catch (err) {
              warn(TAG, `progress message failed: ${err.message}`);
            }
            return;
          }

          if (msg.type === 'typing_heartbeat') {
            try { await adapter.setTyping(msg.channel, msg.threadTs, 'is thinking…'); } catch (_) {}
            return;
          }

          if (msg.type === 'intermediate_text') {
            if (msg.text?.trim()) {
              try {
                const payloads = adapter.buildPayloads(msg.text);
                for (const payload of payloads) {
                  await adapter.sendReply(channel, threadTs, payload.text, payload.blocks ? { blocks: payload.blocks } : {});
                }
              } catch (err) {
                warn(TAG, `failed to send intermediate text: ${err.message}`);
              }
            }
            return;
          }

          responded = true;

          if (msg.type === 'turn_complete') {
            // 中间轮次完成 — 去重已由 intermediate_text 投递的文本，避免重复发送
            try {
              const text = msg.text?.trim();
              if (text) {
                const deliveredSet = new Set((msg.deliveredTexts || []).map(t => t.trim()));
                if (!deliveredSet.has(text)) {
                  turnDelivered = true;
                  const payloads = adapter.buildPayloads(text);
                  for (const payload of payloads) {
                    await emitPayload(payload);
                  }
                }
              }
            } catch (err) {
              logError(TAG, `failed to send turn_complete: ${err.message}`);
            }
            return;
          }

          if (msg.type === 'result') {
            try {
              const text = msg.text?.trim() || null;
              if (!text) {
                const retries = this._autoContinueCount.get(threadTs) || 0;
                if (retries < MAX_AUTO_CONTINUE) {
                  this._autoContinueCount.set(threadTs, retries + 1);
                  warn(TAG, `empty result, auto-continue ${retries + 1}/${MAX_AUTO_CONTINUE} for thread=${threadTs}`);
                  await adapter.sendReply(channel, threadTs, `⏳ 回合上限已达${msg.stopReason === 'tool_use' ? '（任务执行中）' : msg.lastTool ? '（正在: ' + msg.lastTool + '）' : ''}，自动续接中 (${retries + 1}/${MAX_AUTO_CONTINUE})…`).catch(() => {});
                  // Defer submit to onExit — avoid race with worker's process.exit(0)
                  pendingAutoContinue = { userText: '继续', fileContent: '', threadTs, channel, userId, platform, threadHistory: task.threadHistory };
                  return;
                }
                warn(TAG, `empty result after ${MAX_AUTO_CONTINUE} auto-continues for thread=${threadTs}`);
                this._autoContinueCount.delete(threadTs);
              } else {
                this._autoContinueCount.delete(threadTs);
              }
              if (!turnDelivered) {
                const payloads = adapter.buildPayloads(text || '⚠️ 多次续接仍未生成回复，任务可能需要拆分。请用更小的指令重试。');
                info(TAG, `sending ${payloads.length} payload(s) to thread=${threadTs}`);
                for (const payload of payloads) {
                  await emitPayload(payload);
                }
              } else {
                turnDelivered = false;
              }
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
              logError(TAG, `failed to send result: ${err.message}`);
              await adapter.sendReply(channel, threadTs, ':warning: 回复发送失败。').catch(() => {});
            }
            if (msg.toolCount > 0) {
              try { this._checkSkillReview(profile.name, msg.toolCount, task, text); } catch (_) {}
              try { this._checkMemorySync(profile.name, msg.toolCount, task); } catch (_) {}
            }
          } else if (msg.type === 'error') {
            const safeError = sanitizeErrorText(msg.error || '未知错误');
            logError(TAG, `worker error for thread=${threadTs}: ${safeError}`);
            await adapter.sendReply(channel, threadTs, `:warning: 出错了: ${safeError}`).catch(() => {});
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
          if (typingInterval) clearInterval(typingInterval);
          if (typingSet) {
            try { await adapter.setTyping(channel, threadTs, ''); } catch (_) {}
          }
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
            await adapter.cleanupIndicator(channel, threadTs, typingSet, '处理过程中出错，请重试。');
          }

          await this.processNextQueued(threadTs);

          if (pendingAutoContinue) {
            const cont = pendingAutoContinue;
            pendingAutoContinue = null;
            info(TAG, `auto-continue dispatched after worker exit: thread=${cont.threadTs}`);
            await this.submit(cont);
          }
        },
      }));
    } catch (err) {
      logError(TAG, `fork failed: ${err.message}`);
      if (typingInterval) clearInterval(typingInterval);
      await adapter.cleanupIndicator(channel, threadTs, typingSet, 'Worker 启动失败。');
      await this.processNextQueued(threadTs);
      return;
    }

    this.activeWorkers.set(threadTs, worker);
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
    const allWorkers = [...this.activeWorkers.values(), ...this._backgroundWorkers];
    info(TAG, `${signal} received, draining ${this.activeWorkers.size} active + ${this._backgroundWorkers.size} background worker(s)...`);

    // Persist queued tasks so they're not silently lost on SIGTERM
    try {
      const pending = taskQueue.drain ? taskQueue.drain() : [];
      let drained = pending;
      if ((!drained || drained.length === 0) && typeof taskQueue.dequeue === 'function') {
        drained = [];
        let t;
        while ((t = taskQueue.dequeue())) drained.push(t);
      }
      if (drained && drained.length > 0) {
        const byProfile = new Map();
        for (const t of drained) {
          let profileName = 'unknown';
          try { profileName = this.getProfile(t.userId).name; } catch {}
          if (!byProfile.has(profileName)) byProfile.set(profileName, []);
          byProfile.get(profileName).push(t);
        }
        let totalPersisted = 0;
        for (const [name, tasks] of byProfile) {
          try {
            let dataDir = null;
            try { dataDir = this.getProfile(tasks[0].userId).dataDir; } catch {}
            if (!dataDir) continue;
            mkdirSync(dataDir, { recursive: true });
            const outPath = join(dataDir, 'shutdown-queue.json');
            writeFileSync(outPath, JSON.stringify(tasks, null, 2));
            totalPersisted += tasks.length;
            info(TAG, `shutdown: persisted ${tasks.length} task(s) for profile=${name} → ${outPath}`);
          } catch (e) {
            warn(TAG, `shutdown: failed to persist queue for profile=${name}: ${e.message}`);
          }
        }
        warn(TAG, `shutdown: persisted ${totalPersisted} queued tasks to shutdown-queue.json`);
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
