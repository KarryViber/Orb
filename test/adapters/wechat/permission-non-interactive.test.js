import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from '../../../src/scheduler.js';
import { WeChatAdapter } from '../../../src/adapters/wechat.js';

function createSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.payload = null;
  socket.end = (text) => {
    socket.payload = JSON.parse(text);
    socket.destroyed = true;
    socket.emit('close');
  };
  return socket;
}

function callPermissionServerWithoutScheduler() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/mcp-permission-server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, ORB_SCHEDULER_SOCKET: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`mcp permission server timed out: ${stderr}`));
    }, 3000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newlineIndex = stdout.indexOf('\n');
      if (newlineIndex === -1) return;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(JSON.parse(stdout.slice(0, newlineIndex)));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'orb_request_permission',
        arguments: {
          tool_name: 'Bash',
          tool_use_id: 'toolu_1',
          input: { command: 'echo denied' },
        },
      },
    })}\n`);
  });
}

test('wechat permission approval in slack mode denies without auto-approve', async () => {
  const previousMode = process.env.ORB_PERMISSION_APPROVAL_MODE;
  process.env.ORB_PERMISSION_APPROVAL_MODE = 'slack';
  try {
    const sent = [];
    const adapter = {
      platform: 'wechat',
      supportsInteractiveApproval: false,
      async deliver() {
        return { ts: null };
      },
      async sendApproval(channel, threadTs, prompt) {
        sent.push({ channel, threadTs, prompt });
        return { approved: true, userId: channel };
      },
    };
    const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
    scheduler.addAdapter('wechat', adapter);
    scheduler.activeWorkers.set('wx-user-1', { platform: 'wechat', channel: 'wx-user-1' });

    const socket = createSocket();
    await scheduler._handlePermissionRequest({
      type: 'permission_request',
      requestId: 'req-1',
      threadTs: 'wx-user-1',
      channel: 'wx-user-1',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /tmp/nope' },
      toolUseId: 'toolu_1',
    }, socket);

    assert.equal(socket.payload.allow, false);
    assert.match(socket.payload.reason, /does not support interactive approval/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].prompt.toolName, 'Bash');
  } finally {
    if (previousMode === undefined) delete process.env.ORB_PERMISSION_APPROVAL_MODE;
    else process.env.ORB_PERMISSION_APPROVAL_MODE = previousMode;
  }
});

test('mcp permission server deny response includes behavior schema field', async () => {
  const response = await callPermissionServerWithoutScheduler();
  const text = response.result.content[0].text;
  assert.deepEqual(JSON.parse(text), {
    behavior: 'deny',
    message: 'scheduler unavailable: ORB_SCHEDULER_SOCKET missing',
  });
});

test('permission_response resolves pending AskUserQuestion with answers', async () => {
  const previousMode = process.env.ORB_PERMISSION_APPROVAL_MODE;
  process.env.ORB_PERMISSION_APPROVAL_MODE = 'slack';
  try {
    const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
    scheduler.addAdapter('slack', {
      platform: 'slack',
      supportsInteractiveApproval: true,
      async deliver() {
        return { ts: null };
      },
      async sendAskUserQuestion() {
        return { ts: '1777.1' };
      },
    });
    scheduler.activeWorkers.set('111.222', { platform: 'slack', channel: 'C1' });

    const requestSocket = createSocket();
    await scheduler._handlePermissionRequest({
      type: 'permission_request',
      requestId: 'req-auq',
      threadTs: '111.222',
      channel: 'C1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Format?', options: [{ label: 'Bullets' }, { label: 'Table' }] }] },
      toolUseId: 'toolu_auq',
    }, requestSocket);
    assert.equal(requestSocket.payload, null);

    const responseSocket = createSocket();
    await scheduler._handlePermissionRequest({
      type: 'permission_response',
      requestId: 'req-auq',
      allow: true,
      answers: { 'Format?': 'Bullets' },
    }, responseSocket);

    assert.deepEqual(requestSocket.payload, { allow: true, answers: { 'Format?': 'Bullets' } });
    assert.equal(responseSocket.payload.allow, true);
  } finally {
    if (previousMode === undefined) delete process.env.ORB_PERMISSION_APPROVAL_MODE;
    else process.env.ORB_PERMISSION_APPROVAL_MODE = previousMode;
  }
});

test('pending AskUserQuestion socket close cancels card and deletes pending json', async () => {
  const previousMode = process.env.ORB_PERMISSION_APPROVAL_MODE;
  process.env.ORB_PERMISSION_APPROVAL_MODE = 'slack';
  try {
    const dataDir = mkdtempSync(join(tmpdir(), 'orb-auq-cancel-'));
    const pendingDir = join(dataDir, 'auq-pending');
    mkdirSync(pendingDir, { recursive: true });
    const pendingPath = join(pendingDir, 'req-cancel.json');
    writeFileSync(pendingPath, '{"questions":{}}\n');

    const cancelled = [];
    const scheduler = new Scheduler({ getProfile: () => ({ name: 'test', dataDir }), startPermissionServer: false });
    scheduler.addAdapter('slack', {
      platform: 'slack',
      supportsInteractiveApproval: true,
      async deliver() {
        return { ts: null };
      },
      async sendAskUserQuestion() {
        return { ts: '1777.1' };
      },
      async cancelAskUserQuestionCard(args) {
        cancelled.push(args);
        return { ok: true };
      },
    });
    scheduler.activeWorkers.set('111.333', {
      platform: 'slack',
      channel: 'C1',
      userId: 'U1',
      task: { profile: { name: 'test', dataDir } },
    });

    const socket = createSocket();
    await scheduler._handlePermissionRequest({
      type: 'permission_request',
      requestId: 'req-cancel',
      threadTs: '111.333',
      channel: 'C1',
      userId: 'U1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Format?', options: [{ label: 'Bullets' }] }] },
      toolUseId: 'toolu_cancel',
    }, socket);

    socket.emit('close');

    assert.deepEqual(cancelled, [{ channel: 'C1', messageTs: '1777.1', reason: 'worker exited' }]);
    assert.equal(existsSync(pendingPath), false);
    assert.equal(scheduler._pendingPermissionRequests.size, 0);
  } finally {
    if (previousMode === undefined) delete process.env.ORB_PERMISSION_APPROVAL_MODE;
    else process.env.ORB_PERMISSION_APPROVAL_MODE = previousMode;
  }
});

test('wechat sendApproval formats object prompts and rejects in slack mode', async () => {
  const previousMode = process.env.ORB_PERMISSION_APPROVAL_MODE;
  process.env.ORB_PERMISSION_APPROVAL_MODE = 'slack';
  try {
    const replies = [];
    const adapter = new WeChatAdapter({ accountId: 'acct', token: 'token', baseUrl: 'https://wechat.test' });
    adapter.sendReply = async (channel, threadTs, text) => replies.push({ channel, threadTs, text });

    const decision = await adapter.sendApproval('wx-user-1', 'wx-user-1', {
      kind: 'permission',
      toolName: 'Bash',
      toolInput: { command: 'echo ok' },
      requestId: 'req-1',
    });

    assert.equal(decision.approved, false);
    assert.equal(replies.length, 1);
    assert.doesNotMatch(replies[0].text, /\[object Object\]/);
    assert.match(replies[0].text, /工具: Bash/);
    assert.match(replies[0].text, /"command": "echo ok"/);
    assert.match(replies[0].text, /不支持交互式审批/);
  } finally {
    if (previousMode === undefined) delete process.env.ORB_PERMISSION_APPROVAL_MODE;
    else process.env.ORB_PERMISSION_APPROVAL_MODE = previousMode;
  }
});
