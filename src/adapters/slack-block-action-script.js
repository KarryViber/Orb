import { spawn as spawnProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// @internal: test-only
export const HANDLER_EXTENSIONS = ['.py', '.sh', '.js'];
// @internal: test-only
export const HANDLER_HARD_TIMEOUT_MS = 5 * 60 * 1000;
// @internal: test-only
export const HANDLER_LOG_DIR = join(__dirname, '..', '..', 'logs', 'handlers');
// @internal: test-only
export const HANDLER_PID_LOG = join(HANDLER_LOG_DIR, 'pids.log');

// @internal: test-only
export function resolveHandlerScript(profilePaths, actionId) {
  if (!profilePaths?.scriptsDir) return null;
  const handlersDir = resolve(join(profilePaths.scriptsDir, 'handlers'));
  for (const ext of HANDLER_EXTENSIONS) {
    const candidate = resolve(join(handlersDir, `${actionId}${ext}`));
    if (!candidate.startsWith(handlersDir + sep)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// @internal: test-only
export function getHandlerCommand(handlerPath) {
  if (handlerPath.endsWith('.py')) return { command: 'python3', args: [handlerPath] };
  if (handlerPath.endsWith('.sh')) return { command: '/bin/bash', args: [handlerPath] };
  return { command: process.execPath, args: [handlerPath] };
}

export function createHandlerLog({ logDir, actionId, messageTs, profileName, userId, context }) {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(
    logDir,
    `${actionId}-${Date.now()}-${String(messageTs).replace(/[^\d]+/g, '_') || 'message'}.log`,
  );
  writeFileSync(
    logPath,
    `${new Date().toISOString()} action_id=${actionId} profile=${profileName} user_id=${userId || 'unknown'}\n${JSON.stringify(context)}\n\n`,
    { flag: 'a' },
  );
  return logPath;
}

export function runBlockActionScript({
  handlerPath,
  profilePaths,
  context,
  spawnImpl = spawnProcess,
  timeoutMs = HANDLER_HARD_TIMEOUT_MS,
  logPath = null,
  pidLog = HANDLER_PID_LOG,
  profileName = 'unknown',
  actionId = context?.action_id || 'unknown',
  messageTs = context?.message_ts || 'unknown',
}) {
  const { command, args } = getHandlerCommand(handlerPath);
  const child = spawnImpl(command, args, {
    cwd: profilePaths?.scriptsDir || undefined,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let killHandle = null;

  const appendLog = (text) => {
    if (!logPath || !text) return;
    appendFileSync(logPath, text, 'utf-8');
  };

  child.stdout?.on('data', (chunk) => {
    const text = String(chunk);
    stdout += text;
    appendLog(text);
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderr += text;
    appendLog(text);
  });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(child.pid, 'SIGTERM');
      killHandle = setTimeout(() => {
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
      }, 5_000);
      killHandle.unref?.();
    } catch {}
  }, timeoutMs);
  timeoutHandle.unref?.();

  const completion = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      resolve({ code, signal, timedOut, stdout, stderr, pid: child.pid });
    });
  });

  child.stdin?.on('error', () => {});
  child.stdin?.write(`${JSON.stringify(context)}\n`);
  child.stdin?.end();
  child.unref?.();

  appendFileSync(
    pidLog,
    `${new Date().toISOString()} pid=${child.pid} profile=${profileName} action_id=${actionId} message_ts=${messageTs}\n`,
    'utf-8',
  );
  return { child, completion };
}
