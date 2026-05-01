import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
