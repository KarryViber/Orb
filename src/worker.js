import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile as appendFileAsync, mkdir as mkdirAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from './context.js';
import { warn } from './log.js';
import { normalizeChannelSemantics } from './turn-delivery/intents.js';
import { collectGitDiffSummary, recordModifiedPathFromToolUse } from './worker-git-diff.js';
import { parseDailyNotesAppendToolUse } from './worker-daily-notes.js';
import { buildImageBlocks } from './worker-image-blocks.js';
import { buildWorkerMcpConfig, collectWorkspaceMcpServers } from './worker-mcp-boot.js';
import { createCcStreamParseState, normalizeCcUsage, parseStreamLine } from './worker/cc-stream-parser.js';
import {
  buildToolTitle,
  createToolEventState,
  shouldEmitTaskCardForTool,
  stringifyToolValue,
} from './worker/tool-event-state.js';
import { getSessionId, updateSession } from './session.js';
import { storeConversation } from './memory.js';
import { writeLessonCandidate } from './lesson-candidates.js';
import { resolveTurnCompleteText } from './worker-turn-text.js';
import {
  makeCcEvent,
  makeError,
  makeInjectFailed,
  makeResult,
  makeTurnComplete,
  makeTurnEnd,
  makeTurnStart,
} from './ipc-schema.js';
import {
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  CLAUDE_PATH,
  MAX_TURNS,
  ORB_PERMISSION_TIMEOUT_MS,
  PYTHON_PATH,
  WORKER_IDLE_TIMEOUT_MS,
  WORKSPACE_DIR,
} from './runtime-env.js';

/**
 * Worker IPC Protocol
 * Schema source of truth: src/ipc-schema.js
 *
 * Scheduler -> Worker:
 *   { type: 'task', userText, fileContent, imagePaths, threadTs, channel,
 *                   userId, platform, threadHistory, profile, model, effort,
 *                   channelSemantics?, channelMeta?, fragments?, origin?, attemptId?, mode?, priorConversation?, disablePermissionPrompt?, maxTurns? }
 *     - channelSemantics: 'reply' (default) delivers turn text to the thread;
 *       'silent' suppresses successful worker text delivery in the scheduler;
 *       'broadcast' is reserved for top-level channel delivery.
 *     - mode: 'skill-review' enters a dedicated branch that requires
 *       priorConversation; context.js injects it as "## 待审查会话".
 *     - priorConversation: [{role: 'user'|'assistant', content: string}, ...]
 *   { type: 'inject', injectId?, attemptId?, userText, fileContent?, imagePaths?, channelMeta?, fragments?, origin? }
 *
 * Worker -> Scheduler:
 *   { type: 'turn_start', injectId?, attemptId? }  — explicit turn ownership start on task/inject receipt
 *   { type: 'turn_end' }  — explicit turn ownership end when Claude emits result
 *   { type: 'turn_complete', text, toolCount, lastTool, stopReason, channelSemantics, gitDiffSummary?, dailyNotesSummary? }
 *     - one Claude turn finished; text comes from worker turnBuffer assistant text blocks
 *       joined with "\n"; CLI result text is only a fallback when the buffer is empty.
 *       Block-level dedup suppresses repeated result lines within the same turn.
 *     - gitDiffSummary/dailyNotesSummary are routing-only metadata and are
 *       not rendered to Slack since 2026-05-14.
 *   { type: 'cc_event', turnId, attemptId?, origin?, eventType, payload }  — raw Claude Code event forwarded to scheduler subscribers
 *   { type: 'inject_failed', injectId?, attemptId?, userText, fileContent?, imagePaths?, fragments? }  — follow-up inject could not reach CLI;
 *     scheduler should respawn a fresh worker and replay the user payload.
 *   { type: 'error', error, errorContext? }
 *   { type: 'result', text, stopReason?, channelSemantics, exitOnly: true, toolCount?, lastTool?, exitCode?, stderrSummary? }
 *     - process-exit completion signal, not a UI stream primitive.
 */

const PYTHON = PYTHON_PATH;
const ORB_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const MEMORY_USAGE_DIR = join(ORB_ROOT, 'lib', 'memory-usage');
const SKILL_USAGE_TRACKER = join(ORB_ROOT, 'lib', 'skill-usage-tracker.py');
const DEFAULT_PERMISSION_TIMEOUT_MS = ORB_PERMISSION_TIMEOUT_MS;
const MCP_PERMISSION_TOOL_NOT_FOUND_RE = /MCP tool mcp__orb_permission__orb_request_permission[\s\S]*not found[\s\S]*Available MCP tools: none/i;
const CLI_API_ERROR_RE = /\b(?:API Error|Internal server error|5\d\d|rate limit|overloaded|upstream)\b/i;
const TOOL_USE_TERMINAL_REASONS = new Set(['tool_use', 'max_turns_reached']);
const DEFAULT_WORKSPACE_ALLOW_RULES = [
  'Read(*)',
  'Skill(*)',
  'WebFetch(*)',
  'WebSearch',
  'Bash(git *)',
  'Bash(rg *)',
  'Bash(ls *)',
  'Bash(find *)',
  'Bash(cat *)',
  'Bash(sed *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(wc *)',
  'Bash(pwd)',
  'Bash(date)',
];

let _activeCli = null;   // reference to active interactive CLI session
let _currentTurnId = null;
let _currentJobId = null;
let _currentThreadTs = null;
let _currentAttemptId = null;
let _currentProfileName = null;
let _currentDataDir = null;
let _currentChannel = null;
let _currentUserId = null;
let _currentScriptsDir = null;
let _currentChannelMeta = null;
let _currentFragments = [];
let _currentOrigin = null;
let _currentChannelSemantics = 'reply';
let _currentTurnUserText = '';
let _currentTurnModifiedPaths = new Set();
let _currentTurnDailyNotesEntries = [];
let _currentMemoryManifest = [];
let _stdoutParseFailCount = 0;
let _stdoutParseFailLastSampleAt = 0;
const STDOUT_PARSE_FAIL_THRESHOLD = 50;
const STDOUT_PARSE_FAIL_SAMPLE_INTERVAL_MS = 60_000;
// 防御超大单行 stream-json（含 base64 图片内联等）撑爆 V8 heap
const STDOUT_BUF_MAX_BYTES = 64 * 1024 * 1024;

process.on('message', async (msg) => {
  if (msg.type === 'inject') {
    if (_activeCli) {
      beginCcTurn({ attemptId: msg.attemptId || null, origin: msg.origin || _currentOrigin || null });
      _currentTurnUserText = msg.userText || '';
      let injectText = msg.userText;
      if (_currentDataDir) {
        const prompt = await buildPrompt({
          userText: msg.userText,
          fileContent: msg.fileContent,
          threadTs: _currentThreadTs,
          userId: _currentUserId,
          channel: _currentChannel,
          scriptsDir: _currentScriptsDir,
          threadHistory: msg.threadHistory || null,
          dataDir: _currentDataDir,
          channelMeta: msg.channelMeta || _currentChannelMeta,
          fragments: msg.fragments || _currentFragments,
          origin: msg.origin || _currentOrigin || null,
        });
        injectText = prompt.userPrompt || String(prompt);
        _currentMemoryManifest = Array.isArray(prompt.memoryManifest) ? prompt.memoryManifest : [];
        recordMemoryInjection({
          dataDir: _currentDataDir,
          threadId: _currentThreadTs,
          turnId: _currentTurnId,
          items: _currentMemoryManifest,
        }).catch((err) => console.warn(`[worker] memory injection record failed: ${err.message}`));
      }
      const injected = _activeCli.inject(injectText, null, msg.imagePaths);
      if (injected) {
        await ipcSend(makeTurnStart({ injectId: msg.injectId || null, attemptId: msg.attemptId || null })).catch(() => {});
        console.log(`[worker] injected: "${(msg.userText || '').slice(0, 60)}"`);
      } else {
        clearCcTurn();
        console.warn('[worker] inject rejected by CLI — signaling fail-forward');
        await ipcSend(makeInjectFailed({
          injectId: msg.injectId || null,
          attemptId: msg.attemptId || null,
          userText: msg.userText,
          fileContent: msg.fileContent,
          imagePaths: msg.imagePaths,
          channelMeta: msg.channelMeta,
          fragments: msg.fragments || _currentFragments,
          origin: msg.origin || _currentOrigin || null,
        })).catch(() => {});
        _activeCli.close();
      }
    } else {
      console.warn('[worker] inject received but no active CLI — signaling fail-forward');
      await ipcSend(makeInjectFailed({
        injectId: msg.injectId || null,
        attemptId: msg.attemptId || null,
        userText: msg.userText,
        fileContent: msg.fileContent,
        imagePaths: msg.imagePaths,
        channelMeta: msg.channelMeta,
        fragments: msg.fragments || _currentFragments,
        origin: msg.origin || _currentOrigin || null,
      })).catch(() => {});
      setImmediate(() => drainAppendChainsAndExit(0));
    }
    return;
  }
  if (msg.type !== 'task') return;

  let { userText, fileContent, imagePaths, threadTs, channel, userId, platform, profile, threadHistory, model, effort, mode, priorConversation, disablePermissionPrompt, maxTurns, attemptId, channelMeta, fragments, origin } = msg;
  _currentChannelSemantics = normalizeChannelSemantics(msg.channelSemantics);
  _currentTurnUserText = userText || '';
  if (!profile?.dataDir) {
    await ipcSend(makeError({ error: 'profile.dataDir is required' })).catch(() => {});
    process.exit(1);
    return;
  }
  const profileDataDir = profile.dataDir;
  beginCcTurn({
    threadTs,
    attemptId,
    origin,
    profileName: profile?.name,
    dataDir: profileDataDir,
  });
  await ipcSend(makeTurnStart({ attemptId: attemptId || null })).catch(() => {});

  // Fail-fast: skill-review mode without context produces "no skill" noise.
  // Without real content to review the worker is just burning tokens on nothing.
  if (mode === 'skill-review') {
    const hasCtx = Array.isArray(priorConversation) && priorConversation.length > 0;
    if (!hasCtx) {
      console.error('[worker] skill-review invoked without priorConversation, skipping');
      try {
        process.send(makeResult({
          text: '',
          toolCount: 0,
          channelSemantics: _currentChannelSemantics,
        }));
      } catch {}
      setImmediate(() => drainAppendChainsAndExit(0));
      return;
    }
  }

  // IPC profile path validation — prevent path traversal
  if (profile?.workspaceDir && profile?.dataDir) {
    const profileRoot = join(ORB_ROOT, 'profiles');
    const resolvedWorkspace = resolve(profile.workspaceDir);
    const resolvedData = resolve(profile.dataDir);
    if (!resolvedWorkspace.startsWith(profileRoot) || !resolvedData.startsWith(profileRoot)) {
      process.send(makeError({ error: `path traversal blocked: workspace=${resolvedWorkspace}` }));
      process.exit(1);
      return;
    }
  }

  // Use profile-specific workspace, with env fallback for local development.
  const WORKSPACE = profile?.workspaceDir || WORKSPACE_DIR;
  if (!WORKSPACE) {
    await ipcSend(makeError({ error: 'no workspace path: profile.workspaceDir + WORKSPACE_DIR both empty' })).catch(() => {});
    process.exit(1);
    return;
  }

  // Session key includes platform to avoid collisions
  const sessionKey = platform ? `${platform}:${threadTs}` : threadTs;
  let mcpConfigPath = null;

  try {
    console.log(`[worker] starting task: thread=${threadTs} profile=${profile?.name || 'default'} text="${(userText || '[files]').slice(0, 80)}"`);
    const dataDir = profileDataDir;
    _currentDataDir = dataDir;
    _currentChannel = channel || null;
    _currentUserId = userId || null;
    _currentScriptsDir = profile?.scriptsDir || null;
    _currentChannelMeta = channelMeta || null;
    _currentFragments = Array.isArray(fragments) ? fragments : [];
    _currentOrigin = origin || null;
    let sessionId = getSessionId(dataDir, sessionKey);
    // Validate sessionId format before passing to CLI
    if (sessionId && !/^[a-f0-9-]{20,}$/.test(sessionId)) {
      console.error(`[worker] invalid sessionId format: ${sessionId}`);
      sessionId = null; // fall back to new session
    }
    const prompt = await buildPrompt({
      userText, fileContent, threadTs, userId, channel,
      scriptsDir: profile?.scriptsDir,
      threadHistory,
      dataDir,
      mode,
      priorConversation,
      channelMeta,
      fragments: _currentFragments,
      origin,
    });
    _currentMemoryManifest = Array.isArray(prompt.memoryManifest) ? prompt.memoryManifest : [];
    recordMemoryInjection({
      dataDir,
      threadId: threadTs,
      turnId: _currentTurnId,
      items: _currentMemoryManifest,
    }).catch((err) => console.warn(`[worker] memory injection record failed: ${err.message}`));
    const promptLen = (prompt.systemPrompt?.length || 0) + (prompt.userPrompt?.length || prompt.length || 0);
    console.log(`[worker] prompt built (${promptLen} chars), session=${sessionId || 'new'}`);
    ensureWorkspaceClaudeSettings(WORKSPACE);
    const permissionPromptDisabled = disablePermissionPrompt === true || platform === 'system' || channel == null;
    if (!permissionPromptDisabled) {
      mcpConfigPath = buildWorkerMcpConfig({
        threadTs,
        channel,
        userId,
        permissionTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
        workspace: WORKSPACE,
      });
    }

    // Build image content blocks for stream-json mode
    // ── Build initial content (unified stream-json format) ──
    const initialContent = buildUserContent({
      userText: prompt.userPrompt || String(prompt),
      imagePaths,
      workspace: WORKSPACE,
    });

    // ── CLI args for interactive stream-json mode ──
    const turns = Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : MAX_TURNS;
    const streamArgs = [
      '--max-turns', String(turns),
      ...(model || CLAUDE_MODEL ? ['--model', model || CLAUDE_MODEL] : []),
      ...(effort || CLAUDE_EFFORT ? ['--effort', effort || CLAUDE_EFFORT] : []),
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--exclude-dynamic-system-prompt-sections',
      '--verbose',
      '--add-dir', join(ORB_ROOT, 'profiles'),
    ];
    if (!permissionPromptDisabled) {
      streamArgs.push(
        '--permission-prompt-tool', 'mcp__orb_permission__orb_request_permission',
        '--mcp-config', mcpConfigPath,
        '--strict-mcp-config',
      );
    }

    if (sessionId) {
      streamArgs.push('--resume', sessionId);
    } else if (prompt.systemPrompt) {
      streamArgs.push('--append-system-prompt', prompt.systemPrompt);
    }

    console.log(`[worker] cli args: ${streamArgs.join(' ')}`);
    let mcpRetried = false;

    const startCliSession = () => {
      console.log(`[worker] starting interactive CLI session`);
      const cli = runClaudeInteractive(streamArgs, initialContent, WORKSPACE);
      _activeCli = cli;

      // Each turn completed → send to scheduler for delivery
      cli.setOnTurnComplete(async (turn) => {
        recordMemoryUsage({
          dataDir,
          threadId: threadTs,
          turnId: _currentTurnId,
          manifest: _currentMemoryManifest,
          toolInputs: turn.toolInputs || [],
          finalText: turn.text || '',
        }).catch((err) => console.warn(`[worker] memory usage record failed: ${err.message}`));
        // Summary fields are routing-only metadata; Slack rendering was removed on 2026-05-14.
        const { gitDiffSummary, dailyNotesSummary } = turn.summarySnapshot
          || await collectCurrentTurnSummarySnapshot(WORKSPACE);
        const hasTurnText = Boolean(turn.text?.trim());
        if (!hasTurnText && !gitDiffSummary?.hasChanges && !dailyNotesSummary) {
          return;
        }
        if (hasTurnText) {
          const turnUserText = turn.userText || _currentTurnUserText || userText || '';
          if (turnUserText) {
            storeConversation({
              userText: turnUserText,
              responseText: turn.text,
              threadTs,
              userId,
              dbPath: join(dataDir, 'memory.db'),
              turnId: turn.turnId || _currentTurnId,
            }).catch((err) => console.warn(`[worker] storeConversation per-turn failed: ${err.message}`));
          }
        }
        const turnCompleteMsg = makeTurnComplete({
          text: turn.text || '',
          toolCount: turn.toolCount,
          lastTool: turn.lastTool,
          stopReason: turn.stopReason,
          channelSemantics: _currentChannelSemantics,
          gitDiffSummary,
          dailyNotesSummary,
        });
        if (turn.usage) turnCompleteMsg.usage = turn.usage;
        await ipcSend(turnCompleteMsg);
      });
      cli.setOnTurnEnd(async () => {
        await ipcSend(makeTurnEnd()).catch(() => {});
        clearCcTurn();
      });

      return cli;
    };

    const waitForCliExit = async (cli) => {
      const exitResult = await cli.exitPromise;
      if (_activeCli === cli) _activeCli = null;

      console.log(`[worker] CLI exited: code=${exitResult.code} tools=${exitResult.toolCount}`);
      if (exitResult.stderr?.trim()) {
        console.error(`[worker] CLI stderr: ${exitResult.stderr.trim()}`);
      }

      return exitResult;
    };

    let cli = startCliSession();
    let exitResult = await waitForCliExit(cli);
    if (
      exitResult.code === 1 &&
      exitResult.stderr?.trim() &&
      MCP_PERMISSION_TOOL_NOT_FOUND_RE.test(exitResult.stderr) &&
      !mcpRetried
    ) {
      mcpRetried = true;
      console.log('[worker] MCP race detected, retrying after 500ms (1/1)');
      cleanupTempFile(mcpConfigPath);
      await new Promise((resolve) => setTimeout(resolve, 500));
      mcpConfigPath = buildWorkerMcpConfig({
        threadTs,
        channel,
        userId,
        permissionTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
        workspace: WORKSPACE,
      });
      const mcpConfigIndex = streamArgs.indexOf('--mcp-config');
      if (mcpConfigIndex >= 0 && streamArgs[mcpConfigIndex + 1]) {
        streamArgs[mcpConfigIndex + 1] = mcpConfigPath;
      }
      cli = startCliSession();
      exitResult = await waitForCliExit(cli);
    }

    // Session persistence
    if (exitResult.sessionId) {
      try {
        await updateSession(dataDir, sessionKey, { sessionId: exitResult.sessionId, userId });
      } catch (err) {
        warn('worker', `session persistence failed (degraded): ${err.message}`);
        try {
          writeLessonCandidate(dataDir, {
            source: 'session-persistence-failure',
            stopReason: 'sessions_json_write_failed',
            errorContext: `Worker turn completed but session persistence failed: ${err.message}`,
            threadId: threadTs,
            kind: 'session',
            origin: { kind: 'worker-session-save', threadTs, userId },
          });
        } catch {}
      }
    }

    // Send final result as an exit/status signal only. turn_complete is the only
    // worker IPC message that carries deliverable final text.
    const stderrSummary = summarizeCliStderr(exitResult.stderr);
    const cliFailure = (exitResult.code !== 0 && !TOOL_USE_TERMINAL_REASONS.has(exitResult.stopReason))
      || (!exitResult.stopReason && CLI_API_ERROR_RE.test(stderrSummary));
    const resultStopReason = exitResult.stopReason
      || (cliFailure ? (CLI_API_ERROR_RE.test(stderrSummary) ? 'api_error' : 'cli_error') : null);
    const resultMsg = makeResult({
      text: '',
      toolCount: exitResult.toolCount,
      lastTool: exitResult.lastTool,
      stopReason: resultStopReason,
      channelSemantics: _currentChannelSemantics,
      exitOnly: true,
      exitCode: exitResult.code,
      stderrSummary,
    });
    if (exitResult.usage) resultMsg.usage = exitResult.usage;
    await ipcSend(resultMsg);

  } catch (err) {
    await ipcSend(makeError({
      error: err.message,
      // 附带上下文供教训蒸馏
      errorContext: { userText: (userText || '').slice(0, 2000) },
    })).catch(() => {});
  } finally {
    cleanupTempFile(mcpConfigPath);
  }

  // Worker exits after CLI closes — drain pending jsonl writes first
  // (CLI idle timeout → stdin.end → child close → exitPromise resolves → IPC sent → drain → exit)
  setImmediate(() => drainAppendChainsAndExit(0));
});

const IDLE_TIMEOUT = WORKER_IDLE_TIMEOUT_MS; // idle → close stdin → CLI exits
function truncateText(text, maxChars) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function summarizeCliStderr(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return truncateText(lines.slice(-6).join('\n'), 1000);
}

export { collectGitDiffSummary };

function beginCcTurn({ threadTs, attemptId, origin, profileName, dataDir } = {}) {
  if (threadTs !== undefined) {
    _currentThreadTs = threadTs;
    _currentJobId = typeof threadTs === 'string' && threadTs.startsWith('cron:') ? threadTs : null;
  }
  if (attemptId !== undefined) _currentAttemptId = attemptId || null;
  if (origin !== undefined) _currentOrigin = origin || null;
  if (profileName !== undefined) _currentProfileName = profileName || 'default';
  if (dataDir !== undefined) _currentDataDir = dataDir;
  _currentTurnModifiedPaths.clear();
  _currentTurnDailyNotesEntries = [];
  _currentTurnId = randomUUID();
}

function clearCcTurn() {
  _currentTurnId = null;
  _currentAttemptId = null;
}

function runMemoryUsageScript(scriptName, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON,
      [join(MEMORY_USAGE_DIR, scriptName)],
      { timeout: 10_000, maxBuffer: 256 * 1024 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(payload));
  });
}

async function recordMemoryInjection({ dataDir, threadId, turnId, items }) {
  if (!dataDir || !Array.isArray(items) || items.length === 0) return;
  await runMemoryUsageScript('record_injection.py', {
    db_path: join(dataDir, 'memory-usage.db'),
    thread_id: threadId || null,
    turn_id: turnId || null,
    items,
  });
}

function extractUsageEvidence(manifest, toolInputs, finalText) {
  const items = [];
  const seen = new Set();
  const add = (item, evidence) => {
    const key = `${item.item_kind}:${item.item_id}:${evidence}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ...item, evidence });
  };
  const toolText = (toolInputs || []).map((input) => stringifyToolValue(input)).join('\n');
  const response = String(finalText || '');
  for (const item of manifest || []) {
    if (!item?.item_kind || !item?.item_id) continue;
    const id = String(item.item_id);
    if (id && toolText.includes(id)) add(item, 'tool_arg');
    const content = String(item.content || '').replace(/\s+/g, ' ').trim();
    if (content.length >= 30) {
      for (let idx = 0; idx + 30 <= content.length; idx += 30) {
        const slice = content.slice(idx, idx + 30);
        if (response.includes(slice)) {
          add(item, 'text_quote');
          break;
        }
      }
    }
    const label = id.split('/').filter(Boolean).pop()?.replace(/SKILL\.md$/i, '').replace(/\.md$/i, '') || id;
    const explicit = new RegExp(`(?:lesson|skill)\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|(?:按|according to).{0,20}${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    if (explicit.test(response)) add(item, 'explicit_ref');
  }
  return items;
}

async function recordMemoryUsage({ dataDir, threadId, turnId, manifest, toolInputs, finalText }) {
  if (!dataDir || !Array.isArray(manifest) || manifest.length === 0) return;
  const items = extractUsageEvidence(manifest, toolInputs, finalText);
  if (items.length === 0) return;
  await runMemoryUsageScript('record_usage.py', {
    db_path: join(dataDir, 'memory-usage.db'),
    thread_id: threadId || null,
    turn_id: turnId || null,
    items,
  });
}

async function recordSkillUsage({ dataDir, threadId, turnId, skills }) {
  if (!dataDir || !Array.isArray(skills) || skills.length === 0) return;
  const items = skills
    .map((skill) => String(skill || '').trim())
    .filter(Boolean)
    .map((skill) => ({
      item_kind: 'skill',
      item_id: skill,
      content: skill,
    }));
  await recordMemoryInjection({ dataDir, threadId, turnId, items });

  await new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON || 'python3',
      [SKILL_USAGE_TRACKER],
      { timeout: 10_000, maxBuffer: 256 * 1024 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify({
      db_path: join(dataDir, 'memory-usage.db'),
      skills,
      ts: new Date().toISOString(),
      thread_id: threadId || null,
      turn_id: turnId || null,
    }));
  });
}

function extractSkillNamesFromToolInput(input) {
  const values = [
    input?.skill_name,
    input?.name,
    input?.skill,
    input?.id,
    input?.path,
  ];
  return [...new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => {
      if (value.endsWith('/SKILL.md')) return basename(dirname(value));
      return value;
    })
    .filter((value) => value && value !== 'unknown' && !value.startsWith('_')))];
}

function todayJstDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function timestampJst() {
  const shifted = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, -1)}+09:00`;
}

const _appendChains = new Map(); // filePath → Promise

function appendJsonlAsync(dir, fileName, record, label) {
  // per-file 串行 chain：同一 jsonl 文件的多次 append 顺序写，避免乱序/丢行；
  // 跨文件仍并行；exit 前 drain 全部 chain（见 drainAppendChainsAndExit）。
  const filePath = join(dir, fileName);
  const line = `${JSON.stringify(record)}\n`;
  const prev = _appendChains.get(filePath) ?? Promise.resolve();
  const next = prev
    .then(() => mkdirAsync(dir, { recursive: true }))
    .then(() => appendFileAsync(filePath, line))
    .catch((err) => console.warn(`[worker] failed to write ${label}: ${err.message}`));
  _appendChains.set(filePath, next);
  return next;
}

async function drainAppendChainsAndExit(code = 0) {
  try {
    await Promise.allSettled([..._appendChains.values()]);
  } catch {}
  process.exit(code);
}

function writeCcEvent({ event_type, payload }) {
  if (!_currentTurnId || !_currentDataDir) return;
  appendJsonlAsync(join(_currentDataDir, 'cc-events'), `${todayJstDate()}.jsonl`, {
    ts: timestampJst(),
    thread_ts: _currentThreadTs || null,
    turn_id: _currentTurnId,
    job_id: _currentJobId,
    profile: _currentProfileName || 'default',
    attempt_id: _currentAttemptId || null,
    origin: _currentOrigin || null,
    event_type,
    payload: payload || {},
  }, 'cc event');
}

function writeTurnReceipt({ stopReason, toolCount, lastTool, usage }) {
  if (!_currentTurnId || !_currentDataDir) return;
  appendJsonlAsync(join(_currentDataDir, 'receipts'), `${todayJstDate()}.jsonl`, {
    ts: timestampJst(),
    thread_ts: _currentThreadTs || null,
    turn_id: _currentTurnId,
    job_id: _currentJobId,
    profile: _currentProfileName || 'default',
    attempt_id: _currentAttemptId || null,
    origin: _currentOrigin || null,
    stop_reason: stopReason || null,
    tool_count: toolCount || 0,
    last_tool: lastTool || null,
    channel_semantics: _currentChannelSemantics,
    ...(usage ? { usage } : {}),
  }, 'turn receipt');
}

function sendCcEvent(eventType, payload) {
  if (!_currentTurnId) return;
  ipcSend(makeCcEvent({
    turnId: _currentTurnId,
    attemptId: _currentAttemptId || null,
    origin: _currentOrigin || null,
    eventType,
    payload,
  })).catch(() => {});
}

async function collectCurrentTurnSummarySnapshot(workspace) {
  const gitDiffSummary = await collectGitDiffSummary(workspace, _currentTurnModifiedPaths);
  const dailyNotesSummary = _currentTurnDailyNotesEntries.length > 0
    ? { count: _currentTurnDailyNotesEntries.length, entries: [..._currentTurnDailyNotesEntries] }
    : null;
  return { gitDiffSummary, dailyNotesSummary };
}

export { shouldEmitTaskCardForTool };

function runClaudeInteractive(args, initialContent, workspace) {
  const child = spawn(CLAUDE_PATH, args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let idleTimer = null;
  let turnBuffer = [];
  let totalToolCount = 0;
  let turnToolCount = 0;
  let totalToolInputs = [];
  let turnToolInputs = [];
  let lastTool = null;
  let lastStopReason = null;
  let lastUsage = null;
  let lastSessionId = null;
  let lastTurnText = '';
  let lastEmittedTurnText = '';
  let blocksSinceLastEmit = 0;
  let onTurnComplete = null;
  let onTurnEnd = null;
  let closed = false;
  let turnOpen = true;
  let taskCardEmittedInTurn = false;
  let taskCardChunkType = 'plan';
  let taskCardDisplayMode = 'timeline';
  let turnStopReasonOverride = null;
  const recordedSkillNamesInTurn = new Set();
  const pendingTaskCards = new Map();
  const inProgressTaskCards = new Map();
  let stdoutParseState = createCcStreamParseState();
  const toolEventState = createToolEventState();

  const resetTurnStreamingState = () => {
    taskCardEmittedInTurn = false;
    taskCardChunkType = 'plan';
    taskCardDisplayMode = 'timeline';
    turnToolCount = 0;
    turnToolInputs = [];
    turnStopReasonOverride = null;
    recordedSkillNamesInTurn.clear();
    pendingTaskCards.clear();
    inProgressTaskCards.clear();
    _currentTurnDailyNotesEntries = [];
    toolEventState.resetTurn();
  };

  const resetTurnTextDedupState = () => {
    lastEmittedTurnText = '';
    blocksSinceLastEmit = 0;
    turnBuffer = [];
  };

  // ── stdout: incremental NDJSON parse ──
  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    if (stdoutBuf.length > STDOUT_BUF_MAX_BYTES) {
      // 单行无换行符堆积超阈值（如 stream-json 中 base64 图片）→ 中止 worker
      const bufLen = stdoutBuf.length;
      stdoutBuf = '';
      try {
        process.send?.(makeError({
          error: `cli stdout buffer overflow: ${bufLen} bytes`,
          errorContext: { stdoutBufLen: bufLen, threshold: STDOUT_BUF_MAX_BYTES },
        }));
      } catch {}
      process.exit(1);
    }
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsedLine = parseStreamLine(line, stdoutParseState);
      stdoutParseState = parsedLine.newState;
      const parseError = parsedLine.events.find((event) => event.type === 'parse_error');
      if (parseError) {
        _stdoutParseFailCount += 1;
        const now = Date.now();
        if (now - _stdoutParseFailLastSampleAt > STDOUT_PARSE_FAIL_SAMPLE_INTERVAL_MS) {
          _stdoutParseFailLastSampleAt = now;
          warn('worker', `cli stdout JSON parse failed (sample, count=${_stdoutParseFailCount}): ${line.slice(0, 120)}`);
        }
        if (_stdoutParseFailCount >= STDOUT_PARSE_FAIL_THRESHOLD) {
          process.send?.(makeError({
            error: `cli stdout JSON parse failed ${_stdoutParseFailCount} times`,
            errorContext: { lastLinePrefix: line.slice(0, 120) },
          }));
          process.exit(1);
        }
        continue;
      }
      for (const event of parsedLine.events) {
        if (event.type === 'stream_msg') {
          handleStreamMsg(event.payload).catch(() => {});
          break;
        }
      }
    }
  });

  function hasAttachmentType(node, targetType) {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some((item) => hasAttachmentType(item, targetType));
    if (node.type === targetType) return true;
    if (node.attachment?.type === targetType) return true;
    for (const value of Object.values(node)) {
      if (hasAttachmentType(value, targetType)) return true;
    }
    return false;
  }

  async function handleStreamMsg(msg) {
    if (hasAttachmentType(msg, 'max_turns_reached')) {
      turnStopReasonOverride = 'max_turns_reached';
    }
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          turnBuffer.push(block.text);
          blocksSinceLastEmit++;
          writeCcEvent({
            event_type: 'text',
            payload: { text_summary: truncateText(block.text, 300) },
          });
          sendCcEvent('text', block);
        }
        if (block.type === 'tool_use') {
          toolEventState.recordToolUse(block);
          totalToolCount++;
          turnToolCount++;
          totalToolInputs.push(block.input || {});
          turnToolInputs.push(block.input || {});
          lastTool = block.name || null;
          recordModifiedPathFromToolUse(block, _currentTurnModifiedPaths);
          const dailyNotesEntry = parseDailyNotesAppendToolUse(block);
          if (dailyNotesEntry) _currentTurnDailyNotesEntries.push(dailyNotesEntry);
          if (block.name === 'Skill') {
            const skillNames = extractSkillNamesFromToolInput(block.input)
              .filter((name) => !recordedSkillNamesInTurn.has(name));
            for (const name of skillNames) recordedSkillNamesInTurn.add(name);
            if (skillNames.length > 0) {
              recordSkillUsage({
                dataDir: _currentDataDir,
                threadId: _currentThreadTs,
                turnId: _currentTurnId,
                skills: skillNames,
              }).catch((err) => console.warn(`[worker] skill usage record failed: ${err.message}`));
            }
          }
          writeCcEvent({
            event_type: 'tool_use',
            payload: {
              name: block.name || null,
              input_summary: truncateText(stringifyToolValue(block.input), 300),
            },
          });
          sendCcEvent('tool_use', block);
          const isTodoWriteSnapshot = block.name === 'TodoWrite' && Array.isArray(block.input?.todos);
          const emitsTaskCard = shouldEmitTaskCardForTool(block.name, block.input, block.id);
          if (emitsTaskCard && !taskCardEmittedInTurn) {
            taskCardChunkType = isTodoWriteSnapshot ? 'task' : 'plan';
            taskCardDisplayMode = 'plan';
          }
          if (isTodoWriteSnapshot) {
            if (block.input.todos.length > 0) {
              taskCardEmittedInTurn = true;
            }
            continue;
          }
          if (emitsTaskCard) {
            const title = buildToolTitle(block.name, block.input);
            pendingTaskCards.set(block.id, { toolName: block.name });
            inProgressTaskCards.set(block.id, {
              taskId: block.id,
              toolName: block.name,
              title,
              input: block.input,
              startedAt: Date.now(),
            });
            taskCardEmittedInTurn = true;
          }
        }
      }
    }
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block?.type === 'tool_result') {
          toolEventState.recordToolResult(block);
          writeCcEvent({
            event_type: 'tool_result',
            payload: {
              tool_use_id: block.tool_use_id || null,
              output_summary: truncateText(stringifyToolValue(block.content ?? block.output ?? ''), 500),
              is_error: block.is_error === true,
            },
          });
          sendCcEvent('tool_result', block);
        }
        if (!block?.tool_use_id || !pendingTaskCards.has(block.tool_use_id)) continue;
        pendingTaskCards.delete(block.tool_use_id);
        inProgressTaskCards.delete(block.tool_use_id);
      }
    }
    if (msg.type === 'result') {
      const completedTurnId = _currentTurnId;
      const completedTurnUserText = _currentTurnUserText;
      const summarySnapshot = await collectCurrentTurnSummarySnapshot(workspace);
      lastSessionId = msg.session_id || lastSessionId;
      lastStopReason = turnStopReasonOverride || msg.stop_reason || msg.subtype || null;
      lastUsage = normalizeCcUsage(msg.usage);
      sendCcEvent('summary_snapshot', summarySnapshot);
      writeCcEvent({
        event_type: 'result',
        payload: {
          stop_reason: lastStopReason,
          ...(msg.num_turns != null ? { num_turns: msg.num_turns } : {}),
          ...(lastUsage ? { usage: lastUsage } : {}),
        },
      });
      writeTurnReceipt({
        stopReason: lastStopReason,
        toolCount: totalToolCount,
        lastTool,
        usage: lastUsage,
      });
      sendCcEvent('result', msg);
      if (turnOpen && onTurnEnd) {
        turnOpen = false;
        await onTurnEnd();
      }

      const resolvedTurn = resolveTurnCompleteText({
        turnBuffer,
        msgResult: msg.result,
        lastEmittedText: lastEmittedTurnText,
        blocksSinceLastEmit,
      });
      if (resolvedTurn.mismatch) {
        console.warn(`[worker] turn_complete text mismatch: bufferLen=${turnBuffer.join('\n').length} resultLen=${String(msg.result || '').length} stopReason=${lastStopReason || 'unknown'} toolCount=${turnToolCount}`);
      }

      const shouldEmitTurnComplete = resolvedTurn.shouldEmit || _currentTurnDailyNotesEntries.length > 0;
      if (shouldEmitTurnComplete) {
        lastTurnText = resolvedTurn.text;
        lastEmittedTurnText = resolvedTurn.text;
        blocksSinceLastEmit = 0;
        if (onTurnComplete) {
          onTurnComplete({
            text: resolvedTurn.text,
            toolCount: totalToolCount,
            lastTool,
            stopReason: lastStopReason,
            usage: lastUsage,
            toolInputs: [...turnToolInputs],
            turnId: completedTurnId,
            userText: completedTurnUserText,
            summarySnapshot,
          });
        }
      }
      resetTurnStreamingState();
      turnBuffer = [];
      resetIdleTimer();
    }
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log('[worker] idle timeout, closing CLI stdin');
      close();
    }, IDLE_TIMEOUT);
  }

  function inject(userText, fileContent, imagePaths) {
    try {
      if (closed || !child?.stdin?.writable) return false;
      resetTurnStreamingState();
      resetTurnTextDedupState();
      const content = buildUserContent({ userText, fileContent, imagePaths, workspace });
      const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
      child.stdin.write(msg + '\n');
      turnOpen = true;
      // Reset idle timer — new message means stay alive
      resetIdleTimer();
      return true;
    } catch (err) {
      console.warn(`[worker] inject write failed: ${err.message}`);
      return false;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    try { child.stdin.end(); } catch {}
  }

  const errChunks = [];
  child.stderr.on('data', (d) => errChunks.push(d));

  const exitPromise = new Promise((resolve) => {
    child.on('close', (code) => {
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      resolve({
        code,
        stderr: Buffer.concat(errChunks).toString(),
        sessionId: lastSessionId,
        toolCount: totalToolCount,
        toolInputs: [...totalToolInputs],
        lastTool,
        stopReason: turnStopReasonOverride || lastStopReason,
        usage: lastUsage,
        lastTurnText,
      });
    });
  });

  // Send initial message (do NOT close stdin)
  resetTurnStreamingState();
  resetTurnTextDedupState();
  const initMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: initialContent } });
  child.stdin.write(initMsg + '\n');
  resetIdleTimer();

  return {
    inject,
    close,
    exitPromise,
    child,
    setOnTurnComplete: (fn) => { onTurnComplete = fn; },
    setOnTurnEnd: (fn) => { onTurnEnd = fn; },
  };
}

function ipcSend(msg) {
  return new Promise((resolve, reject) => {
    process.send(msg, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function buildUserContent({ userText, fileContent, imagePaths, workspace }) {
  let text = userText || '';
  if (fileContent) {
    console.warn('[worker] ignored raw fileContent in buildUserContent; context.js must render attachments');
  }
  return [
    ...buildImageBlocks(imagePaths, workspace),
    { type: 'text', text },
  ];
}

export { collectWorkspaceMcpServers };

function cleanupTempFile(filePath) {
  if (!filePath) return;
  try {
    rmSync(filePath, { force: true });
  } catch {}
}

function ensureWorkspaceClaudeSettings(workspace) {
  const claudeDir = join(workspace, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  if (existsSync(settingsPath)) return settingsPath;

  mkdirSync(claudeDir, { recursive: true });
  const settings = {
    permissions: {
      allow: collectWorkspaceAllowRules(),
      defaultMode: 'default',
    },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`[worker] wrote workspace settings: ${settingsPath}`);
  return settingsPath;
}

function collectWorkspaceAllowRules() {
  const allow = new Set(DEFAULT_WORKSPACE_ALLOW_RULES);
  const homeSettingsPath = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(homeSettingsPath)) return [...allow];

  try {
    const homeSettings = JSON.parse(readFileSync(homeSettingsPath, 'utf8'));
    const homeAllow = homeSettings?.permissions?.allow;
    if (Array.isArray(homeAllow)) {
      for (const rule of homeAllow) {
        if (isCommonAllowRule(rule)) allow.add(rule);
      }
    }
  } catch (err) {
    console.warn(`[worker] failed to read ~/.claude/settings.json: ${err.message}`);
  }

  return [...allow];
}

function isCommonAllowRule(rule) {
  if (typeof rule !== 'string') return false;
  return (
    rule === 'Read(*)' ||
    rule === 'Skill(*)' ||
    rule === 'WebSearch' ||
    rule === 'WebFetch(*)' ||
    /^Bash\((git|rg|ls|find|cat|sed|head|tail|wc|pwd|date)(?:\s|[)])/.test(rule)
  );
}
