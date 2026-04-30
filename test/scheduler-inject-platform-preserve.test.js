import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRespawnTaskForInjectFailed, Scheduler } from '../src/scheduler.js';

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
    attemptId: 'attempt-follow-up',
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
  assert.equal(respawnTask.attemptId, 'attempt-follow-up');
  assert.deepEqual(respawnTask.imagePaths, ['a.png']);
});

test('startup replay dedupes shutdown tasks by thread and attempt id', () => {
  const scheduler = new Scheduler({
    startPermissionServer: false,
    getProfile: () => ({ name: 'test', dataDir: '/tmp/orb-test' }),
  });

  const restored = scheduler._normalizeShutdownQueue({
    version: 2,
    globalQueue: [
      { threadTs: 'T1', userText: 'first', attemptId: 'attempt-1' },
      { threadTs: 'T2', userText: 'other', attemptId: 'attempt-1' },
    ],
    threadQueues: {
      T1: [
        { threadTs: 'T1', userText: 'duplicate pending inject', attemptId: 'attempt-1' },
        { threadTs: 'T1', userText: 'next turn', attemptId: 'attempt-2' },
      ],
    },
  }, '/tmp/shutdown-queue.json');

  assert.deepEqual(restored.globalQueue.map((task) => task.userText), ['first', 'other']);
  assert.deepEqual(restored.threadQueues.T1.map((task) => task.userText), ['next turn']);
});

test('scheduler tags first-touch and same-thread inject origins', async () => {
  const spawnedTasks = [];
  const sentMessages = [];
  const scheduler = new Scheduler({
    maxWorkers: 1,
    startPermissionServer: false,
    getProfile: () => ({ name: 'test', workspaceDir: '/tmp/ws', dataDir: '/tmp/data', scriptsDir: '/tmp/scripts' }),
    spawnWorkerFn({ task }) {
      spawnedTasks.push(task);
      return {
        worker: {
          pid: 1234,
          send(msg) { sentMessages.push(msg); },
          kill() {},
          on() {},
        },
      };
    },
  });
  scheduler.addAdapter('slack', { async deliver() {} });

  await scheduler.submit({
    userText: 'first',
    fileContent: '',
    imagePaths: [],
    threadTs: '111.222',
    channel: 'C1',
    userId: 'U1',
    platform: 'slack',
  });

  assert.equal(spawnedTasks.length, 1);
  assert.deepEqual(spawnedTasks[0].origin, {
    kind: 'user',
    name: 'first-touch',
    parentAttemptId: null,
  });

  await scheduler.submit({
    userText: 'follow up',
    fileContent: '',
    imagePaths: [],
    threadTs: '111.222',
    channel: 'C1',
    userId: 'U1',
    platform: 'slack',
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, 'inject');
  assert.deepEqual(sentMessages[0].origin, {
    kind: 'inject',
    name: 'replay',
    parentAttemptId: spawnedTasks[0].attemptId,
  });
});
