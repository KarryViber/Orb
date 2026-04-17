import { join } from 'node:path';
import { readdirSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { info, error as logError, warn } from './log.js';
import { taskQueue } from './queue.js';
import { sanitizeErrorText } from './format-utils.js';
import { listFacts, storeLesson, storeCorrectionLesson, decayFacts, lintMemory } from './memory.js';
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
    }, 10_000) : null;

    let responded = false;
    let turnDelivered = false;
    let worker; // declared for closure access in approval_result send

    // Rerun via 🔥 reaction: first emitted payload edits targetMessageTs,
    // subsequent payloads append as normal replies.
    let pendingEdit = task.targetMessageTs || null;
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
            soulDir: profile.soulDir,
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
          responded = true;

          if (msg.type === 'turn_complete') {
            // 中间轮次完成 — 发送结果，typing 由 interval 维持
            try {
              const text = msg.text?.trim();
              if (text) {
                turnDelivered = true;
                const payloads = adapter.buildPayloads(text);
                for (const payload of payloads) {
                  await emitPayload(payload);
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
                  this.submit({ userText: '继续', fileContent: null, threadTs, channel, userId, platform, threadHistory: task.threadHistory });
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
              try { this._checkSkillReview(profile.name, msg.toolCount, task); } catch (_) {}
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
          } else if (msg.type === 'update' && msg.messageTs) {
            try {
              const payloads = adapter.buildPayloads(msg.text);
              const p = payloads[0];
              await adapter.editMessage(channel, msg.messageTs, p.text, p.blocks ? { blocks: p.blocks } : {});
            } catch (err) {
              logError(TAG, `failed to update message: ${err.message}`);
            }
          } else if (msg.type === 'file') {
            await adapter.uploadFile(channel, threadTs, msg.filePath, msg.filename);
          } else if (msg.type === 'approval') {
            const result = await adapter.sendApproval(channel, threadTs, msg.prompt);
            try { worker.send({ type: 'approval_result', ...result }); } catch (_) {}
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

  _checkSkillReview(profileName, toolCount, task) {
    if (!toolCount || toolCount === 0) return;

    const prev = this._skillToolCounts.get(profileName) || 0;
    const next = prev + toolCount;
    this._skillToolCounts.set(profileName, next);

    if (next >= SKILL_REVIEW_THRESHOLD) {
      info(TAG, `skill review threshold reached: profile=${profileName} tools=${next}`);
      this._skillToolCounts.set(profileName, 0);
      this._spawnSkillReview(task);
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

  _spawnSkillReview(task) {
    const { userId, platform } = task;
    const profile = this.getProfile(userId);
    const agentsDir = join(profile.soulDir, '..', 'skills');

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
        profile: {
          name: profile.name,
          soulDir: profile.soulDir,
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

  async _spawnMemorySync(task) {
    const { userId, platform } = task;
    const profile = this.getProfile(userId);
    const memoryMdPath = join(profile.dataDir, 'MEMORY.md');
    const userMdPath = join(profile.soulDir, 'USER.md');

    // Pre-fetch high-trust facts from holographic
    const dbPath = join(profile.dataDir, 'memory.db');

    // 顺带清理过期低 trust facts（分层衰减策略）
    await decayFacts(dbPath).catch(() => {});
    // 健康检查：清理孤儿和重复 facts
    const lintReport = await lintMemory(dbPath, { fix: true }).catch(() => ({}));
    if (lintReport.actions_taken?.length > 0) {
      info(TAG, `lesson lint: ${lintReport.actions_taken.length} actions — ${lintReport.actions_taken.join(', ')}`);
    }

    let allFacts = [];
    let prefFacts = [];
    try {
      [allFacts, prefFacts] = await Promise.all([
        listFacts(dbPath, { minTrust: 0.5, limit: 50 }),
        listFacts(dbPath, { category: 'preference', minTrust: 0.3, limit: 30 }),
      ]);
    } catch (err) {
      logError(TAG, `memory sync: failed to fetch facts: ${err.message}`);
      return;
    }

    if (allFacts.length === 0 && prefFacts.length === 0) {
      info(TAG, 'memory sync: no facts to sync, skipping');
      return;
    }

    // Read current files
    let currentMemory = '';
    let currentUser = '';
    try { currentMemory = readFileSync(memoryMdPath, 'utf8'); } catch {}
    try { currentUser = readFileSync(userMdPath, 'utf8'); } catch {}

    const factsBlock = allFacts.map(f =>
      `[${f.category || 'general'}|trust:${(f.trust_score ?? 0).toFixed(2)}] ${f.content}`
    ).join('\n');

    const prefBlock = prefFacts.map(f =>
      `[trust:${(f.trust_score ?? 0).toFixed(2)}] ${f.content}`
    ).join('\n');

    const syncPrompt = [
      'You are a memory consolidation agent. Two tasks:',
      '',
      '## Task 1: Update MEMORY.md',
      `File: ${memoryMdPath}`,
      'Current content:',
      '```',
      currentMemory || '(empty)',
      '```',
      '',
      'High-trust facts from holographic memory:',
      '```',
      factsBlock || '(none)',
      '```',
      '',
      'Rules:',
      '- Each entry is a DIGEST, not raw text. Max ~100 chars per entry.',
      '  Good: "- User prefers markdown list format for MEMORY.md"',
      '  Bad:  "- User said \'嗯，更markdown一点吧\' and Orb changed the format from § to markdown lists"',
      '- Details stay in holographic memory. MEMORY.md only keeps the conclusion/pointer.',
      '- Remove outdated/contradicted entries (superseded by newer facts)',
      '- Format: markdown list (- per entry), use ## headings to group by category',
      '- Keep total under 2000 chars',
      '- Preserve: durable preferences, environment facts, key decisions, lessons learned',
      '- Skip: one-off results, temporary plans, trivial exchanges, implementation details',
      '',
      '## Task 2: Update USER.md',
      `File: ${userMdPath}`,
      'Current content:',
      '```',
      currentUser || '(empty)',
      '```',
      '',
      'Preference/instruction facts:',
      '```',
      prefBlock || '(none)',
      '```',
      '',
      'Rules:',
      '- Merge confirmed user preferences and corrections into USER.md',
      '- Keep the existing structure/sections, add or update entries',
      '- Only modify sections relevant to the new facts',
      '- Do NOT remove existing content unless directly contradicted',
      '',
      'Write both files. If no meaningful changes needed for either, skip that file.',
    ].join('\n');

    if (this._backgroundWorkers.size >= this._maxBackgroundWorkers) {
      info(TAG, 'background worker limit reached, skipping memory sync');
      return;
    }

    // Piggyback image GC on memory sync cadence
    cleanupImages(profile.workspaceDir);

    let worker;
    ({ worker } = spawnWorker({
      task: {
        type: 'task',
        userText: syncPrompt,
        fileContent: '',
        threadTs: `memory-sync-${Date.now()}`,
        channel: null,
        userId: null,
        platform: 'system',
        threadHistory: null,
        model: 'haiku',
        effort: 'low',
        profile: {
          name: profile.name,
          soulDir: profile.soulDir,
          scriptsDir: profile.scriptsDir,
          workspaceDir: profile.workspaceDir,
          dataDir: profile.dataDir,
        },
      },
      timeout: 120_000,
      label: `memory-sync:${profile.name}`,
      onMessage: () => {},
      onExit: (code) => {
        this._backgroundWorkers.delete(worker);
        info(TAG, `memory sync worker exited: code=${code} profile=${profile.name}`);
      },
    }));
    this._backgroundWorkers.add(worker);
  }

  shutdown(signal) {
    const allWorkers = [...this.activeWorkers.values(), ...this._backgroundWorkers];
    info(TAG, `${signal} received, draining ${this.activeWorkers.size} active + ${this._backgroundWorkers.size} background worker(s)...`);

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
