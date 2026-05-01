import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CronScheduler } from '../src/cron.js';

function createTempDataDir() {
  const root = mkdtempSync(join(tmpdir(), 'orb-cron-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function writeJobs(dataDir, jobs) {
  writeFileSync(join(dataDir, 'cron-jobs.json'), JSON.stringify(jobs, null, 2) + '\n', 'utf-8');
}

function readJobs(dataDir) {
  return JSON.parse(readFileSync(join(dataDir, 'cron-jobs.json'), 'utf-8'));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createJob(id, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    profileName: 'karry',
    prompt: `run ${id}`,
    schedule: { kind: 'interval', minutes: 1, display: 'every 1m' },
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    deliver: null,
    ...overrides,
  };
}

function createScheduler(dataDir, executeTask) {
  const scheduler = new CronScheduler({
    getProfilePaths: () => ({ dataDir, workspaceDir: dataDir, scriptsDir: dataDir }),
    scheduler: { executeTask },
    getProfileNotifyDm: () => 'D0ANGB3M1CZ',
  });
  scheduler.setProfileNames(['karry']);
  return scheduler;
}

function createMultiProfileScheduler(profileDirs, executeTask) {
  const scheduler = new CronScheduler({
    getProfilePaths: (profileName) => {
      const dataDir = profileDirs[profileName];
      return { dataDir, workspaceDir: dataDir, scriptsDir: dataDir };
    },
    scheduler: { executeTask },
    getProfileNotifyDm: () => 'D0ANGB3M1CZ',
  });
  scheduler.setProfileNames(Object.keys(profileDirs));
  return scheduler;
}

test('tick releases the scheduler lock before worker completion', async () => {
  const dataDir = createTempDataDir();
  const gate = deferred();
  const executed = [];

  const scheduler = createScheduler(dataDir, async (job) => {
    executed.push(job.threadTs);
    if (job.threadTs === 'cron:karry:job-1') return gate.promise;
    return { text: 'ok' };
  });

  writeJobs(dataDir, [createJob('job-1')]);

  const tickPromise = scheduler.tick();
  assert.equal(await Promise.race([tickPromise.then(() => 'resolved'), delay(50, 'timeout')]), 'resolved');

  const persisted = readJobs(dataDir);
  writeJobs(dataDir, [
    persisted[0],
    createJob('job-2'),
  ]);

  await scheduler.tick();
  assert.deepEqual(executed, ['cron:karry:job-1', 'cron:karry:job-2']);

  gate.resolve('ok');
  await delay(20);
  await scheduler._awaitJobWrites(dataDir);
});

test('per-job guard prevents concurrent execution of the same job', async () => {
  const dataDir = createTempDataDir();
  const gate = deferred();
  let executeCount = 0;

  const scheduler = createScheduler(dataDir, async () => {
    executeCount += 1;
    return gate.promise;
  });

  writeJobs(dataDir, [createJob('job-1')]);

  await scheduler.tick();

  const jobs = readJobs(dataDir);
  jobs[0].nextRunAt = new Date(Date.now() - 60_000).toISOString();
  writeJobs(dataDir, jobs);

  await scheduler.tick();
  assert.equal(executeCount, 1);

  gate.resolve('ok');
  await delay(20);
  await scheduler._awaitJobWrites(dataDir);
});

test('queued job writes merge concurrent scheduler updates', async () => {
  const dataDir = createTempDataDir();
  const scheduler = createScheduler(dataDir, async () => 'ok');

  writeJobs(dataDir, [
    createJob('job-1', { nextRunAt: '2026-01-01T00:00:00.000Z' }),
    createJob('job-2', { nextRunAt: '2026-01-01T00:00:00.000Z' }),
  ]);

  await Promise.all([
    scheduler._queueJobWrite(dataDir, (jobs) => {
      jobs.find((job) => job.id === 'job-1').nextRunAt = '2026-01-01T00:01:00.000Z';
      return true;
    }),
    scheduler._queueJobWrite(dataDir, (jobs) => {
      jobs.find((job) => job.id === 'job-2').nextRunAt = '2026-01-01T00:02:00.000Z';
      return true;
    }),
  ]);

  assert.deepEqual(readJobs(dataDir).map((job) => [job.id, job.nextRunAt]), [
    ['job-1', '2026-01-01T00:01:00.000Z'],
    ['job-2', '2026-01-01T00:02:00.000Z'],
  ]);
});

test('per-job guard is scoped per profile for identical job ids', async () => {
  const alphaDataDir = createTempDataDir();
  const betaDataDir = createTempDataDir();
  const gate = deferred();
  const executedProfiles = [];

  const scheduler = createMultiProfileScheduler(
    { alpha: alphaDataDir, beta: betaDataDir },
    async (job) => {
      executedProfiles.push(job.profile.name);
      return gate.promise;
    }
  );

  writeJobs(alphaDataDir, [createJob('shared-job', { profileName: 'alpha' })]);
  writeJobs(betaDataDir, [createJob('shared-job', { profileName: 'beta' })]);

  await scheduler.tick();
  assert.deepEqual(executedProfiles.sort(), ['alpha', 'beta']);

  gate.resolve('ok');
  await delay(20);
  await Promise.all([
    scheduler._awaitJobWrites(alphaDataDir),
    scheduler._awaitJobWrites(betaDataDir),
  ]);
});

test('fire-and-forget execution still persists job state', async () => {
  const dataDir = createTempDataDir();
  const scheduler = createScheduler(dataDir, async () => ({ text: 'ok' }));

  writeJobs(dataDir, [
    createJob('job-1', {
      schedule: { kind: 'once', runAt: new Date(Date.now() - 60_000).toISOString(), display: 'once' },
    }),
  ]);

  await scheduler.tick();
  await delay(20);
  await scheduler._awaitJobWrites(dataDir);

  const [job] = readJobs(dataDir);
  assert.equal(job.enabled, false);
  assert.equal(job.nextRunAt, null);
  assert.equal(job.lastStatus, 'ok');
  assert.equal(job.lastError, null);
  assert.match(job.lastRunAt, /\d{4}-\d{2}-\d{2}T/);
});

test('cron scheduler failure persists failed status and uses the failure DM channel', async () => {
  const dataDir = createTempDataDir();
  const executed = [];
  const scheduler = createScheduler(
    dataDir,
    async (task) => {
      executed.push(task);
      throw new Error('script exited 1');
    },
  );

  writeJobs(dataDir, [createJob('job-fail', { name: 'Failing Cron' })]);

  await scheduler.tick();
  await delay(20);
  await scheduler._awaitJobWrites(dataDir);

  const [job] = readJobs(dataDir);
  assert.equal(job.lastStatus, 'failed');
  assert.equal(job.lastError, 'script exited 1');
  assert.equal(job.lastDeliveryError, null);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].channel, 'D0ANGB3M1CZ');
  assert.equal(executed[0].platform, 'slack');
  assert.equal(executed[0].channelSemantics, 'silent');
});

test('cron failed result text is treated as failure without direct delivery', async () => {
  const dataDir = createTempDataDir();
  const scheduler = createScheduler(
    dataDir,
    async () => ({ text: 'failed: boom', stopReason: 'success' }),
  );

  writeJobs(dataDir, [createJob('job-failed-text', {
    deliver: { platform: 'slack', channel: 'C1', threadTs: null },
  })]);

  await scheduler.tick();
  await delay(20);
  await scheduler._awaitJobWrites(dataDir);

  const [job] = readJobs(dataDir);
  assert.equal(job.lastStatus, 'failed');
  assert.equal(job.lastError, 'boom');
  assert.equal(job.lastDeliveryError, null);
});

test('cron non-success stopReason records stderr summary as failed status', async () => {
  const dataDir = createTempDataDir();
  const executed = [];
  const scheduler = createScheduler(
    dataDir,
    async (task) => {
      executed.push(task);
      return {
        text: '',
        stopReason: 'api_error',
        errorSummary: 'API Error: 500 Internal server error',
      };
    },
  );

  writeJobs(dataDir, [createJob('skill-promotion-tick')]);

  await scheduler.tick();
  await delay(20);
  await scheduler._awaitJobWrites(dataDir);

  const [job] = readJobs(dataDir);
  assert.equal(job.lastStatus, 'failed');
  assert.equal(job.lastError, 'api_error: API Error: 500 Internal server error');
  assert.equal(job.lastDeliveryError, null);
  assert.equal(executed[0].cronName, 'skill-promotion-tick');
  assert.deepEqual(executed[0].origin, {
    kind: 'cron',
    name: 'skill-promotion-tick',
    parentAttemptId: null,
  });
});

test('cron path uses scheduler executeTask and preserves cc-events JSONL side effects', async () => {
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

  const tasks = [];
  const scheduler = new CronScheduler({
    getProfilePaths: () => ({ dataDir, workspaceDir: dataDir, scriptsDir: dataDir }),
    getProfileNotifyDm: () => 'D0ANGB3M1CZ',
    scheduler: {
      executeTask: async (task) => {
        tasks.push(task);
        mkdirSync(ccDir, { recursive: true });
        appendFileSync(ccFile, `${JSON.stringify({
          ts: '2026-04-25T00:00:00+09:00',
          thread_ts: 'cron:karry:job-jsonl',
          turn_id: 'turn-1',
          job_id: 'cron:karry:job-jsonl',
          profile: 'karry',
          event_type: 'tool_use',
          payload: { name: 'Bash' },
        })}\n`);
        return { text: 'ok', stopReason: null };
      },
    },
  });
  scheduler.setProfileNames(['karry']);

  await scheduler.tick();
  await delay(20);
  await scheduler._awaitJobWrites(dataDir);

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].threadTs, 'cron:karry:job-jsonl');
  assert.equal(tasks[0].channel, 'D0ANGB3M1CZ');
  assert.equal(tasks[0].channelSemantics, 'silent');
  assert.match(tasks[0].jobRunId, /^job-jsonl:\d+:[0-9a-f-]+$/);
  assert.equal(existsSync(ccFile), true);
  const rows = readFileSync(ccFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'tool_use');
  assert.equal(rows[0].thread_ts, 'cron:karry:job-jsonl');
});
