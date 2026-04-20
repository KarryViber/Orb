import { spawn } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync } from 'node:fs';
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
 *                   mode?, priorConversation? }
 *     - mode: 'skill-review' enters a dedicated branch that requires
 *       priorConversation; context.js injects it as "## 待审查会话".
 *     - priorConversation: [{role: 'user'|'assistant', content: string}, ...]
 *   { type: 'inject', userText, fileContent?, imagePaths? }
 *
 * Worker -> Scheduler:
 *   { type: 'result', text, toolCount, lastTool?, stopReason? }
 *   { type: 'error', error, errorContext? }
 *   { type: 'turn_complete', text, toolCount, lastTool, stopReason, deliveredTexts }  — Phase ③: includes delivered set
 *   { type: 'progress_update', text }  — Phase ①: fired on each TodoWrite event;
 *     scheduler posts/edits a single progress message in-thread (ts owned by scheduler).
 *   { type: 'typing_heartbeat', channel, threadTs }  — Phase ②: 8s pulse while Claude CLI is running
 *   { type: 'intermediate_text', text }  — Phase ③: mid-turn text block, debounced 2s
 *   { type: 'idle' }  — worker activity idle (typing heartbeat suppressed)
 *   { type: 'busy' }  — worker activity resumed
 */

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const MAX_TURNS = parseInt(process.env.MAX_TURNS, 10) || 50;

let _activeCli = null;   // reference to active interactive CLI session

process.on('message', async (msg) => {
  if (msg.type === 'inject') {
    if (_activeCli) {
      _activeCli.inject(msg.userText, msg.fileContent);
      console.log(`[worker] injected: "${(msg.userText || '').slice(0, 60)}"`);
    } else {
      console.warn('[worker] inject received but no active CLI');
    }
    return;
  }
  if (msg.type !== 'task') return;

  let { userText, fileContent, imagePaths, threadTs, channel, userId, platform, profile, threadHistory, model, effort, mode, priorConversation } = msg;

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

  // Typing heartbeat — Slack TTL is ~5s; pulse every 8s while CLI runs
  const heartbeatInterval = setInterval(() => {
    ipcSend({ type: 'typing_heartbeat', channel, threadTs }).catch(() => {});
  }, 8_000);

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

    // Build image content blocks for stream-json mode
    const hasImages = Array.isArray(imagePaths) && imagePaths.length > 0;
    const imageBlocks = [];
    if (hasImages) {
      const imgDir = join(WORKSPACE, '.images');
      mkdirSync(imgDir, { recursive: true });
      for (const imgPath of imagePaths) {
        const name = imgPath.split('/').pop();
        const dest = join(imgDir, name);
        copyFileSync(imgPath, dest);
        const ext = name.split('.').pop().toLowerCase();
        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
        const mediaType = mimeMap[ext] || 'image/png';
        const b64 = readFileSync(dest, 'base64');
        imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } });
        console.log(`[worker] attached image: ${name} (${mediaType}, ${Math.round(b64.length / 1024)}KB b64)`);
      }
    }

    // ── Build initial content (unified stream-json format) ──
    const initialContent = [];
    if (hasImages) initialContent.push(...imageBlocks);
    initialContent.push({ type: 'text', text: prompt.userPrompt || String(prompt) });

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

    if (sessionId) {
      streamArgs.push('--resume', sessionId);
    } else if (prompt.systemPrompt) {
      streamArgs.push('--append-system-prompt', prompt.systemPrompt);
    }

    console.log(`[worker] cli args: ${streamArgs.join(' ')}`);
    console.log(`[worker] starting interactive CLI session`);
    const cli = runClaudeInteractive(streamArgs, initialContent, WORKSPACE);
    _activeCli = cli;

    // Each turn completed → send to scheduler for delivery
    cli.setOnTurnComplete(async (turn) => {
      if (turn.text?.trim()) {
        await ipcSend({ type: 'turn_complete', text: turn.text, toolCount: turn.toolCount, lastTool: turn.lastTool, stopReason: turn.stopReason, deliveredTexts: turn.deliveredTexts || [] });
      }
    });
    cli.setOnActivity(async (state) => {
      await ipcSend({ type: state });
    });

    // Phase ③: stream mid-turn text blocks as they arrive
    cli.setOnIntermediateText(async (text) => {
      await ipcSend({ type: 'intermediate_text', text }).catch(() => {});
    });

    // Wait for CLI to exit (idle timeout or stdin.end)
    const exitResult = await cli.exitPromise;
    _activeCli = null;

    console.log(`[worker] CLI exited: code=${exitResult.code} tools=${exitResult.toolCount}`);

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
    clearInterval(heartbeatInterval);
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
  let lastActivityAt = 0;
  let idleNotified = false;
  let activityTimer = null;
  let onTurnComplete = null;
  let onIntermediateText = null;
  let onActivity = null;
  let deliveredTexts = [];
  let pendingText = '';
  let pendingTimer = null;
  let closed = false;

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
    markActivity();
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          turnBuffer.push(block.text);
          queueIntermediate(block.text);
        }
        if (block.type === 'tool_use') {
          totalToolCount++;
          lastTool = block.name || null;
          if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
            ipcSend({ type: 'progress_update', text: renderTodos(block.input.todos) }).catch(() => {});
          }
        }
      }
    }
    if (msg.type === 'result') {
      lastSessionId = msg.session_id || lastSessionId;
      lastStopReason = msg.stop_reason || msg.subtype || null;
      const turnText = msg.result || turnBuffer.join('\n');

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
          });
        }
      } else if (!lastTurnText && turnText) {
        lastTurnText = turnText;
      }
      deliveredTexts = [];
      turnBuffer = [];
      resetIdleTimer();
    }
  }

  function markActivity() {
    lastActivityAt = Date.now();
    if (idleNotified) {
      idleNotified = false;
      if (onActivity) onActivity('busy');
    }
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      if (Date.now() - lastActivityAt < 2000) return;
      idleNotified = true;
      if (onActivity) onActivity('idle');
    }, 2000);
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log('[worker] idle timeout, closing CLI stdin');
      close();
    }, IDLE_TIMEOUT);
  }

  function inject(userText, fileContent) {
    if (closed) return false;
    let text = userText || '';
    if (fileContent) text += `\n\n---\n\n## 附件\n${fileContent}`;
    const content = [{ type: 'text', text }];
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
    child.stdin.write(msg + '\n');
    // Reset idle timer — new message means stay alive
    resetIdleTimer();
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (activityTimer) clearTimeout(activityTimer);
    try { child.stdin.end(); } catch {}
  }

  const errChunks = [];
  child.stderr.on('data', (d) => errChunks.push(d));

  const exitPromise = new Promise((resolve) => {
    child.on('close', (code) => {
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (activityTimer) clearTimeout(activityTimer);
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
    setOnActivity: (fn) => { onActivity = fn; },
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
