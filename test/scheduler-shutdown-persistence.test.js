import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  INTERRUPTED_RUNS_FILE,
  SHUTDOWN_QUEUE_FILE,
  persistShutdownQueues,
} from '../src/scheduler-shutdown-persistence.js';

test('shutdown persistence skips cron queued and interrupted tasks', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orb-shutdown-persistence-'));
  const profile = { name: 'test', dataDir };
  const threadQueues = new Map([
    ['cron:test:daily', [
      {
        userText: 'cron queued',
        threadTs: 'cron:test:daily',
        platform: 'slack',
        origin: { kind: 'cron', name: 'daily', parentAttemptId: null },
        profile,
      },
    ]],
    ['thread-user', [
      {
        userText: 'user queued',
        threadTs: 'thread-user',
        platform: 'slack',
        attemptId: 'attempt-user-queued',
        profile,
      },
    ]],
  ]);
  const activeWorkers = new Map([
    ['cron:test:active', {
      task: {
        userText: 'cron active',
        threadTs: 'cron:test:active',
        platform: 'slack',
        attemptId: 'attempt-cron-active',
        origin: { kind: 'cron', name: 'active', parentAttemptId: null },
        profile,
      },
    }],
    ['thread-active', {
      task: {
        userText: 'user active',
        threadTs: 'thread-active',
        platform: 'slack',
        attemptId: 'attempt-user-active',
        profile,
      },
    }],
  ]);

  try {
    persistShutdownQueues({
      threadQueues,
      activeWorkers,
      getProfile: () => profile,
    });

    const shutdownQueue = JSON.parse(readFileSync(join(dataDir, SHUTDOWN_QUEUE_FILE), 'utf8'));
    assert.deepEqual(Object.keys(shutdownQueue.threadQueues), ['thread-user']);
    assert.equal(shutdownQueue.threadQueues['thread-user'][0].userText, 'user queued');

    const interruptedRuns = JSON.parse(readFileSync(join(dataDir, INTERRUPTED_RUNS_FILE), 'utf8'));
    assert.equal(interruptedRuns.length, 1);
    assert.equal(interruptedRuns[0].threadTs, 'thread-active');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
