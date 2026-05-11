import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeThreadQueueForPersistence,
  serializeShutdownState,
} from '../src/scheduler-shutdown-persistence.js';

function task(overrides = {}) {
  return {
    userText: 'hello',
    threadTs: 'T1',
    attemptId: 'A1',
    secret: 'drop-me',
    profile: { name: 'karry', dataDir: '/tmp/data' },
    ...overrides,
  };
}

test('normalizeThreadQueueForPersistence sanitizes and filters queues', () => {
  assert.deepEqual(normalizeThreadQueueForPersistence([
    null,
    task({ userText: 'keep' }),
    task({ threadTs: 'cron:karry:job-a' }),
  ]), [{
    userText: 'keep',
    threadTs: 'T1',
    attemptId: 'A1',
    profile: { name: 'karry', dataDir: '/tmp/data' },
  }]);
});

test('serializeShutdownState emits versioned queue state', () => {
  const serialized = serializeShutdownState([], {
    globalQueue: [task()],
    threadQueues: { T1: [task()], T2: [] },
  });
  assert.equal(serialized.version, 2);
  assert.equal(serialized.globalQueue.length, 1);
  assert.deepEqual(Object.keys(serialized.threadQueues), ['T1']);
});
