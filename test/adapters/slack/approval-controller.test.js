import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalController } from '../../../src/adapters/slack/approval-controller.js';

function controllerWithCalls(calls = [], overrides = {}) {
  const controller = createApprovalController({
    webClient: {
      chat: {
        async postMessage(payload) {
          calls.push(['postMessage', payload]);
          return { ts: '1777.1' };
        },
        async update(payload) {
          calls.push(['update', payload]);
          return { ts: payload.ts };
        },
      },
    },
    getProfilePaths: overrides.getProfilePaths || null,
    resolveLedger: overrides.resolveLedger || (() => null),
  });
  return controller;
}

test('generic approval blocks include four decision buttons', () => {
  const controller = controllerWithCalls();
  const blocks = controller._buildApprovalBlocks('approve?', 'A1');
  assert.equal(blocks[1].elements.length, 4);
  assert.deepEqual(blocks[1].elements.map((button) => button.action_id), [
    'orb_approve_once',
    'orb_approve_session',
    'orb_approve_always',
    'orb_deny',
  ]);
});

test('permission approval blocks use compact permission semantics', () => {
  const controller = controllerWithCalls();
  const blocks = controller._buildApprovalBlocks({ kind: 'permission', toolName: 'Bash', toolInput: { command: 'ls' } }, 'A1');
  assert.equal(blocks.at(-1).type, 'actions');
  assert.match(JSON.stringify(blocks), /权限请求/);
  assert.match(JSON.stringify(blocks), /Bash/);
});

test('truncateForSlackCodeBlock removes fenced code delimiters and clips long text', () => {
  const controller = controllerWithCalls();
  const text = controller._truncateForSlackCodeBlock('```abcdef```', 8);
  assert.equal(text, '` ` `...');
});

test('handleInteractive resolves pending approval and updates status card', async () => {
  const calls = [];
  const controller = controllerWithCalls(calls);
  const approval = controller.sendApproval('C1', '111.222', { kind: 'permission', timeoutMs: 30_000, toolName: 'Read' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller._pendingApprovals.size, 1);
  const approvalId = controller._pendingApprovals.keys().next().value;

  await controller._handleInteractive({
    body: {
      type: 'block_actions',
      user: { id: 'U1' },
      actions: [{ action_id: 'orb_approve_once', value: approvalId }],
    },
    ack: async () => {},
  });

  const result = await approval;
  assert.deepEqual(result, { approved: true, scope: 'once', userId: 'U1' });
  assert.equal(controller._pendingApprovals.size, 0);
  assert.equal(calls.at(-1)[0], 'update');
});

test('handleInteractive marks stale orb approval expired without dispatching block action handlers', async () => {
  const calls = [];
  let profileResolutionCalls = 0;
  const controller = controllerWithCalls(calls, {
    getProfilePaths() {
      profileResolutionCalls += 1;
      throw new Error('should not dispatch reserved approval action');
    },
  });

  await controller._handleInteractive({
    body: {
      type: 'block_actions',
      channel: { id: 'C1' },
      container: { message_ts: '1777.2', channel_id: 'C1' },
      message: { ts: '1777.2' },
      user: { id: 'U1' },
      actions: [{ action_id: 'orb_approve_once', value: 'missing-approval' }],
    },
    ack: async () => {},
  });

  assert.equal(profileResolutionCalls, 0);
  const update = calls.find(([method]) => method === 'update');
  assert.ok(update);
  assert.equal(update[1].text, '权限请求已失效');
  assert.match(JSON.stringify(update[1].blocks), /过期或因 daemon 重启失效/);
});
