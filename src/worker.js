import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from './context.js';
import { warn } from './log.js';
import { collectGitDiffSummary, isFileModifyingTool } from './worker-git-diff.js';
import { buildImageBlocks } from './worker-image-blocks.js';
import { buildWorkerMcpConfig, collectWorkspaceMcpServers } from './worker-mcp-boot.js';
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
 *   { type: 'turn_complete', text, toolCount, lastTool, stopReason, channelSemantics, gitDiffSummary? }
 *     - one Claude turn finished; text comes from worker turnBuffer assistant text blocks
 *       joined with "\n"; CLI result text is only a fallback when the buffer is empty.
 *       Block-level dedup suppresses repeated result lines within the same turn.
 *   { type: 'cc_event', turnId, attemptId?, origin?, eventType, payload }  — raw Claude Code event forwarded to scheduler subscribers
 *   { type: 'inject_failed', injectId?, attemptId?, userText, fileContent?, imagePaths?, fragments? }  — follow-up inject could not reach CLI;
 *     scheduler should respawn a fresh worker and replay the user payload.
 *   { type: 'error', error, errorContext? }
 *   { type: 'result', text, stopReason?, channelSemantics, exitOnly: true, toolCount?, lastTool?, exitCode?, stderrSummary? }
 *     - process-exit completion signal, not a UI stream primitive.
 */

const PYTHON = PYTHON_PATH;
const MEMORY_USAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'memory-usage');
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
const TASK_CARD_TOOLS = new Set([
  'TodoWrite', 'Task', 'Agent', 'Skill',
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'NotebookEdit',
]);

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
let _currentTurnModifiedPaths = new Set();
let _currentMemoryManifest = [];
let _stdoutParseFailCount = 0;
let _stdoutParseFailLastSampleAt = 0;
const STDOUT_PARSE_FAIL_THRESHOLD = 50;
const STDOUT_PARSE_FAIL_SAMPLE_INTERVAL_MS = 60_000;

process.on('message', async (msg) => {
  if (msg.type === 'inject') {
    if (_activeCli) {
      beginCcTurn({ attemptId: msg.attemptId || null, origin: msg.origin || _currentOrigin || null });
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
      setImmediate(() => process.exit(0));
    }
    return;
  }
  if (msg.type !== 'task') return;

  let { userText, fileContent, imagePaths, threadTs, channel, userId, platform, profile, threadHistory, model, effort, mode, priorConversation, disablePermissionPrompt, maxTurns, attemptId, channelMeta, fragments, origin } = msg;
  _currentChannelSemantics = normalizeChannelSemantics(msg.channelSemantics);
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
      setImmediate(() => process.exit(0));
      return;
    }
  }

  // IPC profile path validation — prevent path traversal
  if (profile?.workspaceDir && profile?.dataDir) {
    const orbRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
    const profileRoot = join(orbRoot, 'profiles');
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
        if (turn.text?.trim()) {
          const gitDiffSummary = await collectGitDiffSummary(WORKSPACE, _currentTurnModifiedPaths);
          await ipcSend(makeTurnComplete({
            text: turn.text,
            toolCount: turn.toolCount,
            lastTool: turn.lastTool,
            stopReason: turn.stopReason,
            channelSemantics: _currentChannelSemantics,
            gitDiffSummary,
          }));
        }
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
    await ipcSend(makeResult({
      text: '',
      toolCount: exitResult.toolCount,
      lastTool: exitResult.lastTool,
      stopReason: resultStopReason,
      channelSemantics: _currentChannelSemantics,
      exitOnly: true,
      exitCode: exitResult.code,
      stderrSummary,
    }));

    const memDbPath = join(dataDir, 'memory.db');
    storeConversation({ userText, responseText: exitResult.lastTurnText || '', threadTs, userId, dbPath: memDbPath }).catch(() => {});

  } catch (err) {
    await ipcSend(makeError({
      error: err.message,
      // 附带上下文供教训蒸馏
      errorContext: { userText: (userText || '').slice(0, 2000) },
    })).catch(() => {});
  } finally {
    cleanupTempFile(mcpConfigPath);
  }

  // Worker exits after CLI closes — no explicit process.exit needed
  // (CLI idle timeout → stdin.end → child close → exitPromise resolves → IPC sent → exit)
  setImmediate(() => process.exit(0));
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

function normalizeChannelSemantics(value) {
  return value === 'silent' || value === 'broadcast' ? value : 'reply';
}

export function recordModifiedPathFromToolUse(toolUse, modifiedPaths = _currentTurnModifiedPaths) {
  const toolName = toolUse?.name;
  if (!isFileModifyingTool(toolName)) return false;
  const input = parseToolInput(toolUse?.input);
  const filePath = toolName === 'NotebookEdit' ? input?.notebook_path : input?.file_path;
  if (!filePath || typeof filePath !== 'string') return false;
  modifiedPaths.add(filePath);
  return true;
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

function todayJstDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function timestampJst() {
  const shifted = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, -1)}+09:00`;
}

function writeCcEvent({ event_type, payload }) {
  if (!_currentTurnId || !_currentDataDir) return;
  try {
    const dir = join(_currentDataDir, 'cc-events');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${todayJstDate()}.jsonl`), `${JSON.stringify({
      ts: timestampJst(),
      thread_ts: _currentThreadTs || null,
      turn_id: _currentTurnId,
      job_id: _currentJobId,
      profile: _currentProfileName || 'default',
      attempt_id: _currentAttemptId || null,
      origin: _currentOrigin || null,
      event_type,
      payload: payload || {},
    })}\n`);
  } catch (err) {
    console.warn(`[worker] failed to write cc event: ${err.message}`);
  }
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

function truncate256(text) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= 256) return normalized;
  return `${normalized.slice(0, 255)}…`;
}

export function shouldEmitTaskCardForTool(toolName, input, toolUseId = null) {
  const isTodoWriteSnapshot = toolName === 'TodoWrite' && Array.isArray(input?.todos);
  return isTodoWriteSnapshot
    ? TASK_CARD_TOOLS.has(toolName)
    : TASK_CARD_TOOLS.has(toolName) && Boolean(toolUseId);
}

function tokenizeShellCommand(command) {
  return String(command || '')
    .match(/'[^']*'|"[^"]*"|\S+/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

function parseToolInput(toolInput) {
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

function stringifyToolValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizePrimitiveParams(input, limit = 4) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}: [${value.slice(0, 3).map((item) => String(item)).join(', ')}${value.length > 3 ? ', ...' : ''}]`);
    }
    if (parts.length >= limit) break;
  }
  return parts.join('\n');
}

function firstNonFlagToken(command) {
  const tokens = tokenizeShellCommand(command);
  return tokens.find((token) => token && token !== '--' && !token.startsWith('-')) || tokens[0] || 'sh';
}

function summarizeWriteDetails(parsedInput) {
  const filePath = parsedInput?.file_path ? `path: ${parsedInput.file_path}` : '';
  const content = parsedInput?.content != null
    ? `content: ${truncateText(stringifyToolValue(parsedInput.content), 120)}`
    : '';
  return [filePath, content].filter(Boolean).join('\n');
}

function summarizeEditDetails(parsedInput) {
  const filePath = parsedInput?.file_path ? `path: ${parsedInput.file_path}` : '';
  const oldString = parsedInput?.old_string != null
    ? `old: ${truncateText(stringifyToolValue(parsedInput.old_string), 80)}`
    : '';
  const newString = parsedInput?.new_string != null
    ? `new: ${truncateText(stringifyToolValue(parsedInput.new_string), 80)}`
    : '';
  return [filePath, oldString, newString].filter(Boolean).join('\n');
}

function summarizeTodos(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return 'No todos';
  return todos.map((todo) => {
    const icon = todo.status === 'completed' ? 'complete' : todo.status === 'in_progress' ? 'in progress' : 'pending';
    return `- [${icon}] ${todo.content || '(untitled)'}`;
  }).join('\n');
}

function buildToolTitle(toolName, input) {
  const parsedInput = parseToolInput(input);
  const title = (value) => truncate256(value);
  const basename = (filePath) => {
    const rawPath = filePath || 'unknown';
    return String(rawPath).split('/').filter(Boolean).pop() || String(rawPath);
  };

  if (toolName === 'TodoWrite') return title('Plan update');
  if (toolName === 'Bash') {
    const description = parsedInput?.description;
    if (description && typeof description === 'string' && description.trim()) {
      return title(`Bash: ${description.trim()}`);
    }
    const command = parsedInput?.command ?? parsedInput?.cmd ?? input;
    return title(`Bash: ${firstNonFlagToken(command)}`);
  }
  if (toolName === 'Read') {
    return title(`Read: ${basename(parsedInput?.file_path)}`);
  }
  if (toolName === 'Edit') {
    return title(`Edit: ${basename(parsedInput?.file_path)}`);
  }
  if (toolName === 'Write') {
    return title(`Write: ${basename(parsedInput?.file_path)}`);
  }
  if (toolName === 'Grep') {
    return title(`Grep: ${parsedInput?.pattern || 'unknown'}`);
  }
  if (toolName === 'Glob') {
    return title(`Glob: ${parsedInput?.pattern || 'unknown'}`);
  }
  if (toolName === 'WebSearch') {
    return title(`WebSearch: ${parsedInput?.query || 'unknown'}`);
  }
  if (toolName === 'NotebookEdit') {
    return title(`NotebookEdit: ${basename(parsedInput?.notebook_path)}`);
  }
  if (toolName === 'Skill') {
    const description = parsedInput?.description || parsedInput?.skill_description;
    const skillName = parsedInput?.skill_name || parsedInput?.name || parsedInput?.skill || 'unknown';
    return title(`Skill: ${description || skillName}`);
  }
  if (toolName === 'Task' || toolName === 'Agent') {
    const desc = parsedInput?.description || parsedInput?.subagent_type || 'sub-agent';
    return title(`Agent: ${desc}`);
  }
  if (toolName === 'WebFetch') {
    const url = parsedInput?.url || '';
    try {
      return title(`WebFetch: ${new URL(url).hostname || url}`);
    } catch {
      return title(`WebFetch: ${truncateText(url, 80) || 'unknown'}`);
    }
  }

  const summary = summarizePrimitiveParams(parsedInput);
  return title(summary ? `${toolName}: ${summary}` : `${toolName || 'unknown'}:`);
}

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
  const pendingTaskCards = new Map();
  const inProgressTaskCards = new Map();

  const resetTurnStreamingState = () => {
    taskCardEmittedInTurn = false;
    taskCardChunkType = 'plan';
    taskCardDisplayMode = 'timeline';
    turnToolCount = 0;
    turnToolInputs = [];
    turnStopReasonOverride = null;
    pendingTaskCards.clear();
    inProgressTaskCards.clear();
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
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        handleStreamMsg(parsed).catch(() => {});
      } catch {
        _stdoutParseFailCount += 1;
        const now = Date.now();
        if (now - _stdoutParseFailLastSampleAt > STDOUT_PARSE_FAIL_SAMPLE_INTERVAL_MS) {
          _stdoutParseFailLastSampleAt = now;
          warn('worker', `cli stdout JSON parse failed (sample, count=${_stdoutParseFailCount}): ${line.slice(0, 120)}`);
        }
        if (_stdoutParseFailCount >= STDOUT_PARSE_FAIL_THRESHOLD) {
          process.send?.({
            type: 'error',
            error: `cli stdout JSON parse failed ${_stdoutParseFailCount} times`,
            errorContext: { lastLinePrefix: line.slice(0, 120) },
          });
          process.exit(1);
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
          totalToolCount++;
          turnToolCount++;
          totalToolInputs.push(block.input || {});
          turnToolInputs.push(block.input || {});
          lastTool = block.name || null;
          recordModifiedPathFromToolUse(block);
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
            const title = truncate256(buildToolTitle(block.name, block.input));
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
      lastSessionId = msg.session_id || lastSessionId;
      lastStopReason = turnStopReasonOverride || msg.stop_reason || msg.subtype || null;
      writeCcEvent({
        event_type: 'result',
        payload: {
          stop_reason: lastStopReason,
          ...(msg.num_turns != null ? { num_turns: msg.num_turns } : {}),
          ...(msg.usage != null ? { usage: msg.usage } : {}),
        },
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

      if (resolvedTurn.shouldEmit) {
        lastTurnText = resolvedTurn.text;
        lastEmittedTurnText = resolvedTurn.text;
        blocksSinceLastEmit = 0;
        if (onTurnComplete) {
          onTurnComplete({
            text: resolvedTurn.text,
            toolCount: totalToolCount,
            lastTool,
            stopReason: lastStopReason,
            toolInputs: [...turnToolInputs],
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
