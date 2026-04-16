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
 *   { type: 'task', userText, fileContent, imagePaths, threadTs, channel, userId, platform, threadHistory, profile, model }
 *   { type: 'approval_result', approved, scope, userId }
 *
 * Worker -> Scheduler:
 *   { type: 'result', text, toolCount }
 *   { type: 'error', error }
 *   { type: 'update', text, messageTs }
 *   { type: 'file', filePath, filename }
 *   { type: 'approval', prompt }
 */

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const MAX_TURNS = parseInt(process.env.MAX_TURNS, 10) || 50;

let _approvalResolve = null;

process.on('message', async (msg) => {
  if (msg.type === 'approval_result') {
    if (_approvalResolve) _approvalResolve(msg);
    return;
  }
  if (msg.type !== 'task') return;

  let { userText, fileContent, imagePaths, threadTs, channel, userId, platform, profile, threadHistory, model } = msg;

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
      soulDir: profile?.soulDir,
      scriptsDir: profile?.scriptsDir,
      threadHistory,
      dataDir,
    });
    const promptLen = (prompt.systemPrompt?.length || 0) + (prompt.userPrompt?.length || prompt.length || 0);
    console.log(`[worker] prompt built (${promptLen} chars), session=${sessionId || 'new'}`);

    const args = [
      '--print',
      '--output-format', 'json',
      '--max-turns', String(MAX_TURNS),
      '--model', model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    ];

    if (sessionId) {
      // Resume existing session — skip system-prompt (already in session history)
      args.push('--resume', sessionId);
    } else if (prompt.systemPrompt) {
      // New session — inject soul/agents/user via system-prompt
      args.push('--system-prompt', prompt.systemPrompt);
    }

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

    let result;
    if (hasImages) {
      // Use stream-json input to pass images natively
      // Remove --print and --output-format from base args (incompatible with stream-json)
      const streamArgs = args.filter(a => a !== '--print' && a !== '--output-format' && a !== 'json');
      streamArgs.push('--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose');
      const userContent = [
        ...imageBlocks,
        { type: 'text', text: prompt.userPrompt || String(prompt) },
      ];
      const streamMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: userContent } });
      console.log(`[worker] calling claude (stream-json with ${imageBlocks.length} image(s))`);
      result = await runClaudeStream(streamArgs, streamMsg, WORKSPACE);
    } else {
      args.push('-p', '-');
      const stdinData = prompt.userPrompt || prompt;
      console.log(`[worker] calling claude: ${CLAUDE_PATH} ${args.join(' ').slice(0, 100)}...`);
      try {
        result = await runClaude(args, stdinData, WORKSPACE);
      } catch (err) {
        if (sessionId && err.message.includes('No conversation found')) {
          console.warn(`[worker] session ${sessionId} expired, retrying without --resume`);
          const freshArgs = args.filter(a => a !== '--resume' && a !== sessionId);
          result = await runClaude(freshArgs, stdinData, WORKSPACE);
        } else {
          throw err;
        }
      }
    }
    if (result.exitError) {
      console.warn(`[worker] claude exited with error but produced output: ${result.exitError.message}`);
    }
    console.log(`[worker] claude returned: stdout=${result.stdout.length} chars, stderr=${result.stderr.length} chars`);


    const newSessionId = extractSessionId(result.stdout);
    if (newSessionId) {
      await updateSession(dataDir, sessionKey, { sessionId: newSessionId, userId });
    }

    const { text: responseText, toolCount, lastTool, stopReason } = parseClaudeOutput(result.stdout);

    await ipcSend({ type: 'result', text: responseText, toolCount, lastTool, stopReason });

    const memDbPath = join(dataDir, 'memory.db');
    storeConversation({ userText, responseText, threadTs, userId, dbPath: memDbPath }).catch(() => {});

  } catch (err) {
    await ipcSend({
      type: 'error',
      error: err.message,
      // 附带上下文供教训蒸馏
      errorContext: { userText: (userText || '').slice(0, 2000) },
    }).catch(() => {});
  }

  // Defer exit to ensure IPC message is delivered to parent
  setImmediate(() => process.exit(0));
});

function runClaude(args, stdinData, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_PATH, args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));

    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString();
      const stderr = Buffer.concat(errChunks).toString();
      if (code !== 0) {
        if (stdout.trim()) {
          resolve({ stdout, stderr, exitError: new Error(`exit ${code}`) });
        } else {
          reject(new Error(`Claude CLI exit ${code}\n${stderr}`));
        }
      } else {
        resolve({ stdout, stderr });
      }
    });

    if (stdinData) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}

function runClaudeStream(args, streamMsg, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_PATH, args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));

    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString();
      const stderr = Buffer.concat(errChunks).toString();

      // Parse stream-json output: extract result text from NDJSON lines
      let resultText = '';
      let sessionId = null;
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'result' && msg.result) {
            resultText = msg.result;
            sessionId = msg.session_id;
          } else if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text') resultText += block.text;
            }
          }
        } catch {}
      }

      // Convert to same format as runClaude output for parseClaudeOutput compatibility
      const fakeJson = JSON.stringify({ type: 'result', result: resultText || '(无回复)', session_id: sessionId });
      if (code !== 0 && !resultText) {
        reject(new Error(`Claude CLI exit ${code}\n${stderr}`));
      } else {
        resolve({ stdout: fakeJson, stderr, exitError: code !== 0 ? new Error(`exit ${code}`) : undefined });
      }
    });

    // Send stream-json message then close stdin once flushed to kernel buffer
    child.stdin.write(streamMsg + '\n', () => {
      child.stdin.end();
    });
  });
}

function parseClaudeOutput(stdout) {
  const lines = stdout.trim().split('\n');
  const results = [];
  let toolCount = 0;
  let lastTool = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === 'result') {
      const stopReason = parsed.stop_reason || parsed.subtype || null;
      if (parsed.result) {
        return { text: parsed.result, toolCount, lastTool, stopReason };
      }
    }
    if (parsed.type === 'assistant' && parsed.message?.content) {
      for (const block of parsed.message.content) {
        if (block.type === 'text') results.push(block.text);
        if (block.type === 'tool_use') { toolCount++; lastTool = block.name || null; }
      }
    }
  }

  return { text: results.join('\n') || '', toolCount, lastTool, stopReason: null };
}

function ipcSend(msg) {
  return new Promise((resolve, reject) => {
    process.send(msg, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function extractSessionId(stdout) {
  let lastId = null;
  try {
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.session_id) lastId = parsed.session_id;
      } catch {}
    }
  } catch {}
  return lastId;
}
