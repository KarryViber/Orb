import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CronScheduler } from '../src/cron.js';

test('default cron path skips scheduler eventBus but preserves cc-events JSONL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orb-cron-jsonl-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const ccDir = join(dataDir, 'cc-events');
  const ccFile = join(ccDir, '2026-04-25.jsonl');
  const job = {
    id: 'job-jsonl',
    name: 'job-jsonl',
    enabled: true,
    profileName: 'karry',
    prompt: 'run job',
    schedule: { kind: 'interval', minutes: 1, display: 'every 1m' },
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    deliver: null,
  };
  writeFileSync(join(dataDir, 'cron-jobs.json'), `${JSON.stringify([job], null, 2)}\n`, 'utf-8');

  const events = [];
  const previousScheduler = globalThis.__orbSchedulerInstance;
  globalThis.__orbSchedulerInstance = {
    eventBus: { publish: (msg) => events.push(msg) },
    executeTask: async () => {
      throw new Error('scheduler executeTask should not be used by default cron path');
    },
  };

  try {
    const scheduler = new CronScheduler({
      getProfilePaths: () => ({ dataDir, workspaceDir: dataDir, scriptsDir: dataDir }),
      spawnCronWorker: async () => {
        mkdirSync(ccDir, { recursive: true });
        appendFileSync(ccFile, `${JSON.stringify({
          ts: '2026-04-25T00:00:00+09:00',
          thread_ts: 'cron:job-jsonl',
          turn_id: 'turn-1',
          job_id: 'cron:job-jsonl',
          profile: 'karry',
          event_type: 'tool_use',
          payload: { name: 'Bash' },
        })}\n`);
        return { text: 'ok', stopReason: null };
      },
      deliverResult: async () => {},
    });
    scheduler.setProfileNames(['karry']);

    await scheduler.tick();
    await delay(20);
    await scheduler._awaitJobWrites(dataDir);

    assert.equal(events.length, 0);
    assert.equal(existsSync(ccFile), true);
    const rows = readFileSync(ccFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'tool_use');
    assert.equal(rows[0].thread_ts, 'cron:job-jsonl');
  } finally {
    if (previousScheduler === undefined) delete globalThis.__orbSchedulerInstance;
    else globalThis.__orbSchedulerInstance = previousScheduler;
  }
});
