import { spawn } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync, existsSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from './context.js';
import { getSessionId, updateSession } from './session.js';
import { storeConversation } from './memory.js';

/**
 * Worker IPC Protocol
 *
 * Scheduler -> Worker:
 *   { type: 'task', userText, fileContent, imagePaths, threadTs, channel,
 *                   userId, platform, threadHistory, profile, model, effort,
 *                   mode?, priorConversation?, disablePermissionPrompt?, maxTurns? }
 *     - mode: 'skill-review' enters a dedicated branch that requires
 *       priorConversation; context.js injects it as "## 待审查会话".
 *     - priorConversation: [{role: 'user'|'assistant', content: string}, ...]
 *   { type: 'inject', injectId?, userText, fileContent?, imagePaths? }
 *
 * Worker -> Scheduler:
 *   { type: 'result', text, toolCount, lastTool?, stopReason? }
 *   { type: 'error', error, errorContext? }
 *   { type: 'turn_complete', text, toolCount, lastTool, stopReason, deliveredTexts, undeliveredText? }  — Phase ③: includes delivered set + remaining text
 *   { type: 'progress_update', text }  — Phase ①: fired on each TodoWrite event;
 *     scheduler posts/edits a single progress message in-thread (ts owned by scheduler)
 *     only outside the task-card path / error fallback scenes.
 *   { type: 'plan_title_update', title }  — task-card path:
 *     compatibility path for callers that want to label plan-mode cards.
 *   { type: 'plan_section', title }  — legacy task-card path:
 *     scheduler compatibility handler for non-TodoWrite plan-mode section headers.
 *   { type: 'plan_snapshot', title, chunk_type, display_mode, rows }  — task-card path:
 *     TodoWrite-only full snapshot for plan rendering; rows replace the current
 *     plan-card contents in one scheduler update.
 *   { type: 'qi_start' }  — realtime Qi task-card path:
 *     opens a plan-mode stream shell before non-TodoWrite tool rows append.
 *   { type: 'qi_append', category, line }  — realtime Qi task-card path:
 *     appends a single tool line into the category task_update.
 *   { type: 'qi_finalize', tool_count }  — realtime Qi task-card path:
 *     completes the realtime Qi stream and summary.
 *   { type: 'tool_call', task_id, tool_name, title, details, status?, chunk_type, display_mode? }  — legacy task-card path:
 *     scheduler compatibility handler for incremental task-card tool updates.
 *     TodoWrite synthetic per-todo ids now live inside plan_snapshot.rows[].task_id.
 *   { type: 'tool_result', task_id, status, output }  — legacy task-card path:
 *     scheduler compatibility handler for tool_result completion updates.
 *   { type: 'status_update', text }  — short assistant thread status text;
 *     emitted when a tool starts, refreshed during long task-card tools, and cleared with empty text on turn_complete.
 *   { type: 'turn_start', injectId? }  — explicit turn ownership start on task/inject receipt
 *   { type: 'turn_end' }  — explicit turn ownership end when Claude emits result
 *   { type: 'intermediate_text', text }  — Phase ③: mid-turn text block, debounced 2s
 *   { type: 'inject_failed', injectId?, userText, fileContent?, imagePaths? }  — follow-up inject could not reach CLI;
 *     scheduler should respawn a fresh worker and replay the user payload.
 */

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const MAX_TURNS = parseInt(process.env.MAX_TURNS, 10) || 50;
const DEFAULT_PERMISSION_TIMEOUT_MS = parseInt(process.env.ORB_PERMISSION_TIMEOUT_MS, 10) || 300_000;
const MCP_PERMISSION_TOOL_NOT_FOUND_RE = /MCP tool mcp__orb_permission__orb_request_permission[\s\S]*not found[\s\S]*Available MCP tools: none/i;
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
// Last full turn text emitted via turn_complete IPC. Exit path compares against
// exitResult.lastTurnText and suppresses duplicate result text when the
// scheduler has already handled that turn through turn_complete delivery.
let _lastEmittedTurnText = null;

process.on('message', async (msg) => {
  if (msg.type === 'inject') {
    if (_activeCli) {
      const injected = _activeCli.inject(msg.userText, msg.fileContent, msg.imagePaths);
      if (injected) {
        _lastEmittedTurnText = null;
        await ipcSend({ type: 'turn_start', injectId: msg.injectId || null }).catch(() => {});
        console.log(`[worker] injected: "${(msg.userText || '').slice(0, 60)}"`);
      } else {
        console.warn('[worker] inject rejected by CLI — signaling fail-forward');
        await ipcSend({
          type: 'inject_failed',
          injectId: msg.injectId || null,
          userText: msg.userText,
          fileContent: msg.fileContent,
          imagePaths: msg.imagePaths,
        }).catch(() => {});
        _activeCli.close();
      }
    } else {
      console.warn('[worker] inject received but no active CLI — signaling fail-forward');
      await ipcSend({
        type: 'inject_failed',
        injectId: msg.injectId || null,
        userText: msg.userText,
        fileContent: msg.fileContent,
        imagePaths: msg.imagePaths,
      }).catch(() => {});
      setImmediate(() => process.exit(0));
    }
    return;
  }
  if (msg.type !== 'task') return;

  _lastEmittedTurnText = null;
  await ipcSend({ type: 'turn_start' }).catch(() => {});

  let { userText, fileContent, imagePaths, threadTs, channel, userId, platform, profile, threadHistory, model, effort, mode, priorConversation, disablePermissionPrompt, maxTurns } = msg;

  // Fail-fast: skill-review mode without context produces "no skill" noise.
  // Without real content to review the worker is just burning tokens on nothing.
  if (mode === 'skill-review') {
    const hasCtx = Array.isArray(priorConversation) && priorConversation.length > 0;
    if (!hasCtx) {
      console.error('[worker] skill-review invoked without priorConversation, skipping');
      try { process.send({ type: 'result', text: '[skipped: no context]', toolCount: 0 }); } catch {}
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
      process.send({ type: 'error', error: `path traversal blocked: workspace=${resolvedWorkspace}` });
      process.exit(1);
      return;
    }
  }

  // Use profile-specific workspace, fallback to env/cwd
  const WORKSPACE = profile?.workspaceDir || process.env.WORKSPACE_DIR || process.cwd();

  // Session key includes platform to avoid collisions
  const sessionKey = platform ? `${platform}:${threadTs}` : threadTs;
  let mcpConfigPath = null;

  try {
    console.log(`[worker] starting task: thread=${threadTs} profile=${profile?.name || 'default'} text="${(userText || '[files]').slice(0, 80)}"`);
    const dataDir = profile?.dataDir || process.cwd();
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
    });
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
      ...(model || process.env.CLAUDE_MODEL ? ['--model', model || process.env.CLAUDE_MODEL] : []),
      ...(effort || process.env.CLAUDE_EFFORT ? ['--effort', effort || process.env.CLAUDE_EFFORT] : []),
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
        if (turn.text?.trim()) {
          _lastEmittedTurnText = turn.text || turn.undeliveredText || '';
          await ipcSend({
            type: 'turn_complete',
            text: turn.text,
            toolCount: turn.toolCount,
            lastTool: turn.lastTool,
            stopReason: turn.stopReason,
            deliveredTexts: turn.deliveredTexts || [],
            undeliveredText: turn.undeliveredText,
          });
        }
      });
      cli.setOnTurnEnd(async () => {
        await ipcSend({ type: 'turn_end' }).catch(() => {});
      });

      // Phase ③: stream mid-turn text blocks as they arrive
      cli.setOnIntermediateText(async (text) => {
        await ipcSend({ type: 'intermediate_text', text }).catch(() => {});
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
      await updateSession(dataDir, sessionKey, { sessionId: exitResult.sessionId, userId });
    }

    // Send final result (last turn's output).
    // Suppress text if it matches what turn_complete already delivered — prevents the
    // canvas stopStream + exit-path sendReply from posting the same text twice.
    const exitText = exitResult.lastTurnText || '';
    const shouldSuppressText = !!exitText && exitText.trim() === (_lastEmittedTurnText || '').trim();
    await ipcSend({
      type: 'result',
      text: shouldSuppressText ? '' : exitText,
      toolCount: exitResult.toolCount,
      lastTool: exitResult.lastTool,
      stopReason: exitResult.stopReason,
    });

    const memDbPath = join(dataDir, 'memory.db');
    storeConversation({ userText, responseText: exitResult.lastTurnText || '', threadTs, userId, dbPath: memDbPath }).catch(() => {});

  } catch (err) {
    await ipcSend({
      type: 'error',
      error: err.message,
      // 附带上下文供教训蒸馏
      errorContext: { userText: (userText || '').slice(0, 2000) },
    }).catch(() => {});
  } finally {
    cleanupTempFile(mcpConfigPath);
  }

  // Worker exits after CLI closes — no explicit process.exit needed
  // (CLI idle timeout → stdin.end → child close → exitPromise resolves → IPC sent → exit)
  setImmediate(() => process.exit(0));
});

const IDLE_TIMEOUT = parseInt(process.env.WORKER_IDLE_TIMEOUT_MS, 10) || 60_000; // idle → close stdin → CLI exits
const STATUS_HEARTBEAT_MS = 90_000;

function renderTodos(todos) {
  const lines = [`📋 ${buildPlanSnapshotTitle(todos)}`];
  for (const t of todos) {
    const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
    lines.push(`${icon} ${t.content}`);
  }
  return lines.join('\n');
}

function truncateText(text, maxChars) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function formatElapsedTime(startedAt, now = Date.now()) {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ${elapsedSeconds % 60}s`;
  return `${Math.floor(elapsedMinutes / 60)}h ${elapsedMinutes % 60}m`;
}

function truncate256(text) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= 256) return normalized;
  return `${normalized.slice(0, 255)}…`;
}

function mapTodoStatus(status) {
  if (status === 'completed') return 'complete';
  if (status === 'in_progress') return 'in_progress';
  return 'pending';
}

export function buildPlanSnapshotRows(todos) {
  if (!Array.isArray(todos)) return [];
  return todos.map((todo, index) => ({
    task_id: `todowrite-todo-${index}`,
    title: truncate256(todo?.content || `Todo ${index + 1}`),
    status: mapTodoStatus(todo?.status),
  }));
}

export function buildPlanSnapshotTitle(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const total = list.length;
  const completed = list.filter((todo) => todo?.status === 'completed').length;
  const activeTodo = list.find((todo) => todo?.status === 'in_progress');

  if (activeTodo) {
    return `进度 ${completed}/${total}｜${truncateText(activeTodo.content || '进行中', 40)}`;
  }
  if (total > 0 && completed === total) {
    return `进度 ${total}/${total}｜完成`;
  }
  return `进度 ${completed}/${total}`;
}

export function shouldEmitTaskCardForTool(toolName, input, toolUseId = null) {
  const isTodoWriteSnapshot = toolName === 'TodoWrite' && Array.isArray(input?.todos);
  return isTodoWriteSnapshot
    ? TASK_CARD_TOOLS.has(toolName)
    : TASK_CARD_TOOLS.has(toolName) && Boolean(toolUseId);
}

function categorizeTool(toolName) {
  if (/^(Bash|Read|Edit|Write|Grep|Glob|NotebookEdit|WebFetch|WebSearch|LSP)$/.test(toolName)) return '工具执行';
  if (/^(Task|Agent|Skill|mcp__)/.test(toolName)) return '其他操作';
  return '工具执行';
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

function buildStatusText(toolName, input) {
  return truncateText(buildToolTitle(toolName, input), 80);
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
  let lastTool = null;
  let lastStopReason = null;
  let lastSessionId = null;
  let lastTurnText = '';
  let onTurnComplete = null;
  let onIntermediateText = null;
  let onTurnEnd = null;
  let deliveredTexts = [];
  let accumulatedDelivered = '';
  let pendingText = '';
  let pendingTimer = null;
  let closed = false;
  let turnOpen = true;
  let taskCardEmittedInTurn = false;
  let taskCardChunkType = 'plan';
  let taskCardDisplayMode = 'timeline';
  let turnCategoryBuffer = new Map();
  let qiStreamOpened = false;
  let qiCategoryLines = new Map();
  let turnStopReasonOverride = null;
  const pendingTaskCards = new Map();
  const inProgressTaskCards = new Map();
  let statusHeartbeatTimer = null;

  const resetTurnStreamingState = () => {
    taskCardEmittedInTurn = false;
    taskCardChunkType = 'plan';
    taskCardDisplayMode = 'timeline';
    turnCategoryBuffer = new Map();
    qiStreamOpened = false;
    qiCategoryLines = new Map();
    turnToolCount = 0;
    turnStopReasonOverride = null;
    pendingTaskCards.clear();
    inProgressTaskCards.clear();
    clearTurnHeartbeatTimers();
  };

  const clearTurnHeartbeatTimers = () => {
    if (statusHeartbeatTimer) {
      clearInterval(statusHeartbeatTimer);
      statusHeartbeatTimer = null;
    }
  };

  const getActiveTaskCard = () => {
    let active = null;
    for (const [taskId, card] of inProgressTaskCards.entries()) {
      if (!pendingTaskCards.has(taskId)) {
        inProgressTaskCards.delete(taskId);
        continue;
      }
      if (!active || card.startedAt > active.card.startedAt) active = { taskId, card };
    }
    return active;
  };

  const buildElapsedStatusText = (card) => (
    truncateText(`${buildStatusText(card.toolName, card.input)} (${formatElapsedTime(card.startedAt)})`, 100)
  );

  const ensureTurnHeartbeatTimers = () => {
    if (!statusHeartbeatTimer) {
      statusHeartbeatTimer = setInterval(() => {
        const active = getActiveTaskCard();
        if (!active) return;
        ipcSend({
          type: 'status_update',
          text: buildElapsedStatusText(active.card),
        }).catch(() => {});
      }, STATUS_HEARTBEAT_MS);
    }
  };

  const queueIntermediate = (text) => {
    if (!text?.trim() || !onIntermediateText) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingText = pendingText ? pendingText + '\n' + text : text;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const toSend = pendingText.trim();
      pendingText = '';
      if (toSend) {
        deliveredTexts.push(toSend);
        accumulatedDelivered += toSend;
        onIntermediateText(toSend);
      }
    }, 2000);
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
      } catch {}
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
          queueIntermediate(block.text);
        }
        if (block.type === 'tool_use') {
          totalToolCount++;
          turnToolCount++;
          lastTool = block.name || null;
          const isTodoWriteSnapshot = block.name === 'TodoWrite' && Array.isArray(block.input?.todos);
          const emitsTaskCard = shouldEmitTaskCardForTool(block.name, block.input, block.id);
          if (emitsTaskCard && !taskCardEmittedInTurn) {
            taskCardChunkType = isTodoWriteSnapshot ? 'task' : 'plan';
            taskCardDisplayMode = 'plan';
          }
          ipcSend({
            type: 'status_update',
            text: buildStatusText(block.name, block.input),
          }).catch(() => {});
          if (isTodoWriteSnapshot) {
            const rows = buildPlanSnapshotRows(block.input.todos);
            if (rows.length > 0) {
              ipcSend({
                type: 'plan_snapshot',
                title: buildPlanSnapshotTitle(block.input.todos),
                chunk_type: taskCardChunkType,
                display_mode: taskCardDisplayMode,
                rows,
              }).catch(() => {});
              taskCardEmittedInTurn = true;
            }
            ipcSend({ type: 'progress_update', text: renderTodos(block.input.todos) }).catch(() => {});
            continue;
          }
          if (emitsTaskCard) {
            const title = truncate256(buildToolTitle(block.name, block.input));
            const category = categorizeTool(block.name);
            if (!qiStreamOpened) {
              await ipcSend({ type: 'qi_start' });
              qiStreamOpened = true;
            }
            await ipcSend({ type: 'qi_append', category, line: title });
            if (!qiCategoryLines.has(category)) qiCategoryLines.set(category, []);
            qiCategoryLines.get(category).push(title);
            if (!turnCategoryBuffer.has(category)) turnCategoryBuffer.set(category, []);
            turnCategoryBuffer.get(category).push(title);
            pendingTaskCards.set(block.id, { toolName: block.name });
            inProgressTaskCards.set(block.id, {
              taskId: block.id,
              toolName: block.name,
              title,
              input: block.input,
              startedAt: Date.now(),
            });
            ensureTurnHeartbeatTimers();
            taskCardEmittedInTurn = true;
          }
        }
      }
    }
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (!block?.tool_use_id || !pendingTaskCards.has(block.tool_use_id)) continue;
        pendingTaskCards.delete(block.tool_use_id);
        inProgressTaskCards.delete(block.tool_use_id);
      }
    }
    if (msg.type === 'result') {
      lastSessionId = msg.session_id || lastSessionId;
      lastStopReason = turnStopReasonOverride || msg.stop_reason || msg.subtype || null;
      const turnText = msg.result || turnBuffer.join('\n');
      if (qiStreamOpened) {
        await ipcSend({
          type: 'qi_finalize',
          tool_count: turnToolCount,
        }).catch(() => {});
      }
      if (turnOpen && onTurnEnd) {
        turnOpen = false;
        await onTurnEnd();
      }

      // Cancel pending intermediate flush — turn is done, onTurnComplete takes over
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingText = ''; }

      // 防止同一段文本重复触发（CLI 可能输出多个 result 行）
      if (turnText && turnText !== lastTurnText) {
        lastTurnText = turnText;
        if (onTurnComplete) {
          onTurnComplete({
            text: turnText,
            toolCount: totalToolCount,
            lastTool,
            stopReason: lastStopReason,
            deliveredTexts: [...deliveredTexts],
            undeliveredText: computeUndeliveredTurnText(turnText, accumulatedDelivered, deliveredTexts),
          });
        }
      } else if (!lastTurnText && turnText) {
        lastTurnText = turnText;
      }
      ipcSend({ type: 'status_update', text: '' }).catch(() => {});
      resetTurnStreamingState();
      deliveredTexts = [];
      accumulatedDelivered = '';
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
    if (closed) return false;
    resetTurnStreamingState();
    const content = buildUserContent({ userText, fileContent, imagePaths, workspace });
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
    child.stdin.write(msg + '\n');
    turnOpen = true;
    // Reset idle timer — new message means stay alive
    resetIdleTimer();
    return true;
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
      clearTurnHeartbeatTimers();
      resolve({
        code,
        stderr: Buffer.concat(errChunks).toString(),
        sessionId: lastSessionId,
        toolCount: totalToolCount,
        lastTool,
        stopReason: turnStopReasonOverride || lastStopReason,
        lastTurnText,
      });
    });
  });

  // Send initial message (do NOT close stdin)
  resetTurnStreamingState();
  const initMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: initialContent } });
  child.stdin.write(initMsg + '\n');
  resetIdleTimer();

  return {
    inject,
    close,
    exitPromise,
    child,
    setOnTurnComplete: (fn) => { onTurnComplete = fn; },
    setOnIntermediateText: (fn) => { onIntermediateText = fn; },
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

function sanitizeFileToken(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

export function computeUndeliveredTurnText(finalText, accumulatedDelivered = '', deliveredTexts = []) {
  const text = typeof finalText === 'string' ? finalText : '';
  if (!text.trim()) return '';

  const accumulated = typeof accumulatedDelivered === 'string' ? accumulatedDelivered : '';
  if (accumulated.trim()) {
    if (text === accumulated || accumulated.includes(text)) return '';
    if (text.startsWith(accumulated)) return text.slice(accumulated.length);
    if (text.endsWith(accumulated)) return text.slice(0, text.length - accumulated.length);
  }

  const deliveredJoined = Array.isArray(deliveredTexts)
    ? deliveredTexts.map((entry) => typeof entry === 'string' ? entry : '').join('')
    : '';
  if (deliveredJoined.trim()) {
    if (text === deliveredJoined || deliveredJoined.includes(text)) return '';
    if (text.startsWith(deliveredJoined)) return text.slice(deliveredJoined.length);
    if (text.endsWith(deliveredJoined)) return text.slice(0, text.length - deliveredJoined.length);
  }

  const trimmedText = text.trim();
  const deliveredSet = new Set((deliveredTexts || []).map((entry) => String(entry || '').trim()).filter(Boolean));
  return deliveredSet.has(trimmedText) ? '' : text;
}

function buildUserContent({ userText, fileContent, imagePaths, workspace }) {
  let text = userText || '';
  if (fileContent) text += `\n\n---\n\n## 附件\n${fileContent}`;
  return [
    ...buildImageBlocks(imagePaths, workspace),
    { type: 'text', text },
  ];
}

function buildImageBlocks(imagePaths, workspace) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) return [];
  const imgDir = join(workspace, '.images');
  mkdirSync(imgDir, { recursive: true });
  const blocks = [];
  for (const imgPath of imagePaths) {
    const name = imgPath.split('/').pop();
    const dest = join(imgDir, name);
    copyFileSync(imgPath, dest);
    const ext = name.split('.').pop().toLowerCase();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const mediaType = mimeMap[ext] || 'image/png';
    const b64 = readFileSync(dest, 'base64');
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } });
    console.log(`[worker] attached image: ${name} (${mediaType}, ${Math.round(b64.length / 1024)}KB b64)`);
  }
  return blocks;
}

function schedulerSocketPathForPid(pid) {
  return join(tmpdir(), `orb-permission-scheduler-${pid}.sock`);
}

function buildWorkerMcpConfig({ threadTs, channel, userId, permissionTimeoutMs, workspace }) {
  const workspaceDir = workspace || process.env.WORKSPACE_DIR || process.cwd();
  const configPath = join(
    tmpdir(),
    `orb-mcp-${process.pid}-${sanitizeFileToken(threadTs)}.json`,
  );
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'mcp-permission-server.js');
  const baseServers = {
    orb_permission: {
      type: 'stdio',
      command: process.execPath,
      args: [serverPath],
      env: {
        ORB_SCHEDULER_SOCKET: schedulerSocketPathForPid(process.ppid),
        ORB_THREAD_TS: String(threadTs || ''),
        ORB_CHANNEL: String(channel || ''),
        ORB_USER_ID: String(userId || ''),
        ORB_PERMISSION_TIMEOUT_MS: String(permissionTimeoutMs || DEFAULT_PERMISSION_TIMEOUT_MS),
        ...(process.env.ORB_MCP_PERMISSION_LOG ? { ORB_MCP_PERMISSION_LOG: process.env.ORB_MCP_PERMISSION_LOG } : {}),
      },
    },
  };
  const extServers = collectWorkspaceMcpServers(workspaceDir, {
    ORB_THREAD_TS: String(threadTs || ''),
    ORB_CHANNEL: String(channel || ''),
    ORB_USER_ID: String(userId || ''),
    ORB_WORKSPACE_DIR: workspaceDir,
  });
  const mergedServers = { ...extServers, ...baseServers };
  const config = {
    mcpServers: mergedServers,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`[worker] wrote MCP config: ${configPath}`);
  return configPath;
}

function collectWorkspaceMcpServers(workspace, extraEnv) {
  const dir = join(workspace, '.claude', 'mcp-servers');
  if (!existsSync(dir)) return {};

  let fnames;
  try {
    fnames = readdirSync(dir);
  } catch (err) {
    console.warn(`[worker] failed to scan MCP registrations dir: ${err.message}`);
    return {};
  }

  const looksRelativePath = (s) => (
    typeof s === 'string' && (s.startsWith('./') || s.startsWith('../'))
  );

  const result = {};
  for (const fname of fnames) {
    if (!fname.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, fname), 'utf8'));
      for (const [name, def] of Object.entries(raw)) {
        if (!def || typeof def !== 'object' || !def.command) continue;
        const args = Array.isArray(def.args)
          ? def.args.map((arg) => (looksRelativePath(arg) ? join(workspace, arg) : arg))
          : [];
        // Workspace MCP runs inside the worker child process and can access Orb env.
        result[name] = {
          type: def.type || 'stdio',
          command: def.command,
          args,
          env: { ...(def.env || {}), ...extraEnv },
        };
      }
    } catch (err) {
      console.warn(`[worker] failed to load MCP registration ${fname}: ${err.message}`);
    }
  }
  return result;
}

const writePermissionMcpConfig = buildWorkerMcpConfig;

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
