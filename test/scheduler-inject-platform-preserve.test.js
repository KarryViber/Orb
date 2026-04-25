import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRespawnTaskForInjectFailed } from '../src/scheduler.js';

test('inject_failed respawn preserves wechat routing fields', () => {
  const profile = { name: 'karry', workspaceDir: '/tmp/ws', dataDir: '/tmp/data', scriptsDir: '/tmp/scripts' };
  const failedTask = {
    userText: 'new turn',
    fileContent: 'file',
    imagePaths: ['a.png'],
    threadTs: 'wx-user-1',
    deliveryThreadTs: 'wx-user-1',
    channel: 'wx-user-1',
    userId: 'wx-user-1',
    platform: 'wechat',
    teamId: null,
    threadHistory: 'history',
    profile,
    deferDeliveryUntilResult: false,
  };

  const respawnTask = buildRespawnTaskForInjectFailed({
    msg: { type: 'inject_failed', injectId: 'inject-1', userText: 'from worker' },
    failedTask,
    task: { userText: 'original', teamId: 'T1', threadHistory: 'old', enableTaskCard: true },
    threadTs: 'wx-user-1',
    effectiveThreadTs: 'wx-user-1',
    channel: 'wx-user-1',
    userId: 'wx-user-1',
    platform: 'wechat',
    profile,
    deferDeliveryUntilResult: false,
  });

  assert.equal(respawnTask.platform, 'wechat');
  assert.equal(respawnTask.channel, 'wx-user-1');
  assert.equal(respawnTask.threadTs, 'wx-user-1');
  assert.equal(respawnTask.deliveryThreadTs, 'wx-user-1');
  assert.equal(respawnTask.userText, 'from worker');
  assert.deepEqual(respawnTask.imagePaths, ['a.png']);
});
