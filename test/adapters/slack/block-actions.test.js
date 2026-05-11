import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchBlockActionHandler } from '../../../src/adapters/slack-block-actions.js';

test('reserved orb approval actions update stale card without resolving handler scripts', async () => {
  const calls = [];
  let profileResolutionCalls = 0;

  await dispatchBlockActionHandler({
    body: {
      type: 'block_actions',
      channel: { id: 'C1' },
      container: { channel_id: 'C1', message_ts: '1777.3' },
      message: {
        ts: '1777.3',
        thread_ts: '1777.1',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '*权限请求*' } },
          { type: 'actions', elements: [] },
        ],
      },
      user: { id: 'U1' },
      actions: [{ action_id: 'orb_approve_once', value: 'missing-approval' }],
    },
    action: { action_id: 'orb_approve_once', value: 'missing-approval' },
    actionId: 'orb_approve_once',
    slack: {
      chat: {
        async update(payload) {
          calls.push(['update', payload]);
          return { ts: payload.ts };
        },
      },
    },
    getProfilePaths() {
      profileResolutionCalls += 1;
      throw new Error('should not resolve profile for reserved approval action');
    },
    resolveLedger: () => null,
    inFlight: new Set(),
  });

  assert.equal(profileResolutionCalls, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].text, /过期或因 daemon 重启失效/);
  assert.doesNotMatch(calls[0][1].text, /未注册 handler/);
});
