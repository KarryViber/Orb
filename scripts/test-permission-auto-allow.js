#!/usr/bin/env node

import { fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)));
const profilesRoot = join(repoRoot, 'profiles');
const baseDir = mkdtempSync(join(profilesRoot, 'permission-e2e-'));
const workspaceDir = join(baseDir, 'workspace');
const dataDir = join(baseDir, 'data');
const targetFile = join(workspaceDir, 'permission-e2e.txt');
const socketPath = join(tmpdir(), `orb-permission-scheduler-${process.pid}.sock`);
const mcpLogPath = join(baseDir, 'mcp-permission.log');

mkdirSync(workspaceDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(workspaceDir, '.claude'), { recursive: true });

writeFileSync(join(workspaceDir, '.claude', 'settings.json'), `${JSON.stringify({
  permissions: {
    ask: ['Write'],
    allow: ['Read(*)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(rg *)'],
    deny: [],
    defaultMode: 'default',
  },
}, null, 2)}\n`);

if (existsSync(socketPath)) unlinkSync(socketPath);

let permissionRequest = null;
const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) return;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) return;
    permissionRequest = JSON.parse(line);
    socket.end(`${JSON.stringify({ allow: true, reason: 'mock auto-allow' })}\n`);
  });
});

const cleanup = async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch {}
  try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
};

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socketPath, resolve);
});

const worker = fork(join(repoRoot, 'src', 'worker.js'), [], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: {
    ...process.env,
    WORKER_IDLE_TIMEOUT_MS: '15000',
    ORB_PERMISSION_TIMEOUT_MS: '30000',
    ORB_MCP_PERMISSION_LOG: mcpLogPath,
  },
});

worker.stdout?.on('data', (chunk) => process.stdout.write(chunk));
worker.stderr?.on('data', (chunk) => process.stderr.write(chunk));

let finalResult = null;
let workerError = null;

const finished = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    try { worker.kill('SIGTERM'); } catch {}
    reject(new Error('worker test timed out after 180s'));
  }, 180_000);

  worker.on('message', (msg) => {
    if (msg?.type === 'turn_complete' && !finalResult) finalResult = msg;
    if (msg?.type === 'result') finalResult = msg;
    if (msg?.type === 'error') workerError = msg;
  });

  worker.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (workerError) {
      reject(new Error(`worker error: ${workerError.error}`));
      return;
    }
    if (code !== 0) {
      reject(new Error(`worker exited with code=${code} signal=${signal}`));
      return;
    }
    resolve();
  });
});

worker.send({
  type: 'task',
  userText: '请严格使用 Write 工具创建 permission-e2e.txt，文件内容必须精确为 "permission auto allow test"。完成后只回复 DONE。',
  fileContent: '',
  imagePaths: [],
  threadTs: `permission-e2e-${Date.now()}`,
  channel: 'C_PERMISSION_TEST',
  userId: 'U_PERMISSION_TEST',
  platform: 'slack',
  threadHistory: null,
  model: process.env.CLAUDE_MODEL || null,
  effort: 'low',
  profile: {
    name: 'permission-e2e',
    workspaceDir,
    dataDir,
    scriptsDir: join(repoRoot, 'scripts'),
  },
});

try {
  await finished;
  if (!permissionRequest) {
    throw new Error('mock scheduler did not receive a permission_request');
  }
  if (permissionRequest.type !== 'permission_request') {
    throw new Error(`unexpected socket payload type: ${permissionRequest.type}`);
  }
  if (permissionRequest.toolName !== 'Write') {
    throw new Error(`expected toolName=Write, got ${permissionRequest.toolName}`);
  }
  if (!existsSync(targetFile)) {
    throw new Error(`expected file to be written: ${targetFile}`);
  }
  const content = readFileSync(targetFile, 'utf8').trim();
  if (content !== 'permission auto allow test') {
    throw new Error(`unexpected file content: ${JSON.stringify(content)}`);
  }

  console.log('permission auto-allow E2E passed');
  console.log(`toolName=${permissionRequest.toolName}`);
  console.log(`result=${finalResult?.text || '(empty)'}`);
} finally {
  if (existsSync(mcpLogPath)) {
    console.log('--- mcp permission log ---');
    console.log(readFileSync(mcpLogPath, 'utf8'));
  }
  await cleanup();
}
