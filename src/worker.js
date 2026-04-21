import { spawn } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
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
 *                   mode?, priorConversation?, disablePermissionPrompt? }
 *     - mode: 'skill-review' enters a dedicated branch that requires
 *       priorConversation; context.js injects it as "## 待审查会话".
 *     - priorConversation: [{role: 'user'|'assistant', content: string}, ...]
 *   { type: 'inject', userText, fileContent?, imagePaths? }
 *
 * Worker -> Scheduler:
 *   { type: 'result', text, toolCount, lastTool?, stopReason? }
 *   { type: 'error', error, errorContext? }
 *   { type: 'turn_complete', text, toolCount, lastTool, stopReason, deliveredTexts, undeliveredText? }  — Phase ③: includes delivered set + remaining text
 *   { type: 'progress_update', text }  — Phase ①: fired on each TodoWrite event;
 *     scheduler posts/edits a single progress message in-thread (ts owned by scheduler)
 *     only outside the task-card path / error fallback scenes.
 *   { type: 'tool_call', task_id, tool_name, title, details }  — task-card path:
 *     emitted for selected tool_use blocks so scheduler can update Slack task cards.
 *   { type: 'tool_result', task_id, status, output }  — task-card path:
 *     emitted from tool_result blocks; status is 'complete' | 'error'.
 *   { type: 'status_update', text }  — short assistant thread status text;
 *     emitted when a tool starts, and cleared with empty text on turn_complete.
 *   { type: 'turn_start' }  — explicit turn ownership start on task/inject receipt
 *   { type: 'turn_end' }  — explicit turn ownership end when Claude emits result
 *   { type: 'intermediate_text', text }  — Phase ③: mid-turn text block, debounced 2s
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
  'TodoWrite', 'Task', 'Agent',
  'Bash', 'Write', 'Edit', 'NotebookEdit',
  'WebFetch', 'WebSearch',
  'Skill',
]);

let _activeCli = null;   // reference to active interactive CLI session

process.on('message', async (msg) => {
  if (msg.type === 'inject') {
    if (_activeCli) {
      const injected = _activeCli.inject(msg.userText, msg.fileContent, msg.imagePaths);
      if (injected) {
        await ipcSend({ type: 'turn_start' }).catch(() => {});
        console.log(`[worker] injected: "${(msg.userText || '').slice(0, 60)}"`);
      } else {
        console.warn('[worker] inject rejected by CLI');
      }
    } else {
      console.warn('[worker] inject received but no active CLI');
    }
    return;
  }
  if (msg.type !== 'task') return;

  await ipcSend({ type: 'turn_start' }).catch(() => {});

  let { userText, fileContent, imagePaths, threadTs, channel, userId, platform, profile, threadHistory, model, effort, mode, priorConversation, disablePermissionPrompt } = msg;

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
      mcpConfigPath = writePermissionMcpConfig({
        threadTs,
        channel,
        userId,
        permissionTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
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
    const streamArgs = [
      '--max-turns', String(MAX_TURNS),
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
          await ipcSend({ type: 'turn_complete', text: turn.text, toolCount: turn.toolCount, lastTool: turn.lastTool, stopReason: turn.stopReason, deliveredTexts: turn.deliveredTexts || [] });
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
      mcpConfigPath = writePermissionMcpConfig({
        threadTs,
        channel,
        userId,
        permissionTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
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

    // Send final result (last turn's output)
    await ipcSend({
      type: 'result',
      text: exitResult.lastTurnText || '',
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

function renderTodos(todos) {
  const lines = ['📋 进度'];
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

function summarizeToolDetails(toolName, input) {
  const parsedInput = parseToolInput(input);

  if (toolName === 'TodoWrite') {
    return truncateText(summarizeTodos(parsedInput?.todos), 200);
  }
  if (toolName === 'Bash') {
    const command = parsedInput?.command ?? parsedInput?.cmd ?? input;
    return truncateText(String(command || '').trim(), 200);
  }
  if (toolName === 'Write' || toolName === 'NotebookEdit') {
    return truncateText(summarizeWriteDetails(parsedInput), 200);
  }
  if (toolName === 'Edit') {
    return truncateText(summarizeEditDetails(parsedInput), 200);
  }
  if (toolName === 'Skill') {
    return truncateText(
      parsedInput?.skill_description
      || parsedInput?.description
      || parsedInput?.prompt
      || summarizePrimitiveParams(parsedInput),
      200,
    );
  }
  if (toolName === 'WebFetch') {
    return truncateText(String(parsedInput?.url || input || ''), 200);
  }

  return truncateText(summarizePrimitiveParams(parsedInput), 200);
}

function buildToolTitle(toolName, input) {
  const parsedInput = parseToolInput(input);

  if (toolName === 'TodoWrite') return 'Plan update';
  if (toolName === 'Bash') {
    const command = parsedInput?.command ?? parsedInput?.cmd ?? input;
    return `Bash: ${firstNonFlagToken(command)}`;
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const filePath = parsedInput?.file_path || parsedInput?.notebook_path || 'unknown';
    const baseName = String(filePath).split('/').filter(Boolean).pop() || filePath;
    return `${toolName}: ${baseName}`;
  }
  if (toolName === 'Skill') {
    const skillName = parsedInput?.skill_name || parsedInput?.name || parsedInput?.skill || 'unknown';
    return `Skill: ${skillName}`;
  }
  if (toolName === 'WebFetch') {
    const url = parsedInput?.url || '';
    try {
      return `WebFetch: ${new URL(url).hostname || url}`;
    } catch {
      return `WebFetch: ${truncateText(url, 80) || 'unknown'}`;
    }
  }

  return String(toolName || 'unknown');
}

function buildStatusText(toolName, input) {
  const parsedInput = parseToolInput(input);

  if (toolName === 'TodoWrite') return 'updating plan';
  if (toolName === 'Bash') {
    const command = truncateText(String(parsedInput?.command ?? parsedInput?.cmd ?? input ?? '').trim(), 80);
    return command ? `running: ${command}` : 'running bash';
  }
  if (toolName === 'Write' || toolName === 'NotebookEdit') {
    const filePath = parsedInput?.file_path || parsedInput?.notebook_path || 'unknown';
    return `writing: ${String(filePath).split('/').filter(Boolean).pop() || filePath}`;
  }
  if (toolName === 'Edit') {
    const filePath = parsedInput?.file_path || 'unknown';
    return `editing: ${String(filePath).split('/').filter(Boolean).pop() || filePath}`;
  }
  if (toolName === 'Skill') {
    const skillName = parsedInput?.skill_name || parsedInput?.name || parsedInput?.skill || 'skill';
    return `using skill: ${truncateText(String(skillName), 40)}`;
  }
  if (toolName === 'WebFetch') {
    const url = parsedInput?.url || '';
    try {
      return `fetching: ${new URL(url).hostname || url}`;
    } catch {
      return `fetching: ${truncateText(String(url), 60) || 'url'}`;
    }
  }
  if (toolName === 'WebSearch') return 'searching web';
  if (toolName === 'Task' || toolName === 'Agent') return 'delegating task';

  return `working: ${truncateText(String(toolName || 'task'), 40)}`;
}

function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyToolValue(content);
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (item?.type === 'text' && typeof item.text === 'string') return item.text;
    return stringifyToolValue(item);
  }).filter(Boolean).join('\n');
}

function runClaudeInteractive(args, initialContent, workspace) {
  const child = spawn(CLAUDE_PATH, args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let idleTimer = null;
  let turnBuffer = [];
  let totalToolCount = 0;
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
  const pendingTaskCards = new Map();

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
        handleStreamMsg(parsed);
      } catch {}
    }
  });

  function handleStreamMsg(msg) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          turnBuffer.push(block.text);
          queueIntermediate(block.text);
        }
        if (block.type === 'tool_use') {
          totalToolCount++;
          lastTool = block.name || null;
          ipcSend({
            type: 'status_update',
            text: buildStatusText(block.name, block.input),
          }).catch(() => {});
          if (TASK_CARD_TOOLS.has(block.name) && block.id) {
            pendingTaskCards.set(block.id, { toolName: block.name });
            ipcSend({
              type: 'tool_call',
              task_id: block.id,
              tool_name: block.name,
              title: buildToolTitle(block.name, block.input),
              details: summarizeToolDetails(block.name, block.input),
            }).catch(() => {});
          }
          if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
            ipcSend({ type: 'progress_update', text: renderTodos(block.input.todos) }).catch(() => {});
          }
        }
      }
    }
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (!block?.tool_use_id || !pendingTaskCards.has(block.tool_use_id)) continue;
        ipcSend({
          type: 'tool_result',
          task_id: block.tool_use_id,
          status: block.is_error ? 'error' : 'complete',
          output: truncateText(extractToolResultText(block.content), 500),
        }).catch(() => {});
        pendingTaskCards.delete(block.tool_use_id);
      }
    }
    if (msg.type === 'result') {
      lastSessionId = msg.session_id || lastSessionId;
      lastStopReason = msg.stop_reason || msg.subtype || null;
      const turnText = msg.result || turnBuffer.join('\n');
      if (turnOpen && onTurnEnd) {
        turnOpen = false;
        onTurnEnd();
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
      resolve({
        code,
        stderr: Buffer.concat(errChunks).toString(),
        sessionId: lastSessionId,
        toolCount: totalToolCount,
        lastTool,
        stopReason: lastStopReason,
        lastTurnText,
      });
    });
  });

  // Send initial message (do NOT close stdin)
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
  const text = String(finalText || '').trim();
  if (!text) return '';

  const accumulated = String(accumulatedDelivered || '').trim();
  if (accumulated) {
    if (text === accumulated || accumulated.includes(text)) return '';
    if (text.startsWith(accumulated)) return text.slice(accumulated.length).trimStart();
    if (text.endsWith(accumulated)) return text.slice(0, text.length - accumulated.length).trimEnd();
  }

  const deliveredSet = new Set((deliveredTexts || []).map((entry) => String(entry || '').trim()).filter(Boolean));
  return deliveredSet.has(text) ? '' : text;
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

function writePermissionMcpConfig({ threadTs, channel, userId, permissionTimeoutMs }) {
  const configPath = join(
    tmpdir(),
    `orb-mcp-${process.pid}-${sanitizeFileToken(threadTs)}.json`,
  );
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'mcp-permission-server.js');
  const config = {
    mcpServers: {
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
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`[worker] wrote MCP config: ${configPath}`);
  return configPath;
}

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
