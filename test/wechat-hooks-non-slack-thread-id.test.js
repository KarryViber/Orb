import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

test('wechat user-id threadTs is accepted by lesson and memory hook counters', () => {
  const scheduler = new Scheduler({
    getProfile: () => ({ name: 'karry', workspaceDir: '/tmp/ws', dataDir: '/tmp/data', scriptsDir: '/tmp/scripts' }),
    startPermissionServer: false,
  });
  const task = {
    userText: 'run a tool',
    threadTs: 'wx_user_openid_123',
    channel: 'wx_user_openid_123',
    userId: 'wx_user_openid_123',
    platform: 'wechat',
  };

  assert.doesNotThrow(() => scheduler._checkSkillReview('karry', 1, task, 'done'));
  assert.doesNotThrow(() => scheduler._checkMemorySync('karry', 1, task));
  assert.equal(scheduler._skillToolCounts.get('karry'), 1);
  assert.equal(scheduler._memorySyncCounts.get('karry'), 1);
});
