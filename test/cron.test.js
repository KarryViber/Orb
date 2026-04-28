import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function createScheduler(dataDir, spawnCronWorker, deliverResult = async () => {}) {
  const scheduler = new CronScheduler({
    getProfilePaths: () => ({ dataDir, workspaceDir: dataDir, scriptsDir: dataDir }),
    spawnCronWorker,
    deliverResult,
  });
  scheduler.setProfileNames(['karry']);
  return scheduler;
}

function createMultiProfileScheduler(profileDirs, spawnCronWorker) {
  const scheduler = new CronScheduler({
    getProfilePaths: (profileName) => {
      const dataDir = profileDirs[profileName];
      return { dataDir, workspaceDir: dataDir, scriptsDir: dataDir };
    },
    spawnCronWorker,
    deliverResult: async () => {},
  });
  scheduler.setProfileNames(Object.keys(profileDirs));
  return scheduler;
}

test('tick releases the scheduler lock before worker completion', async () => {
  const dataDir = createTempDataDir();
  const gate = deferred();
  const spawned = [];

  const scheduler = createScheduler(dataDir, async (job) => {
    spawned.push(job.id);
    if (job.id === 'job-1') return gate.promise;
    return 'ok';
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
  assert.deepEqual(spawned, ['job-1', 'job-2']);

  gate.resolve('ok');
  await delay(20);
  await scheduler._awaitJobWrites(dataDir);
});

test('per-job guard prevents concurrent execution of the same job', async () => {
  const dataDir = createTempDataDir();
  const gate = deferred();
  let spawnCount = 0;

  const scheduler = createScheduler(dataDir, async () => {
    spawnCount += 1;
    return gate.promise;
  });

  writeJobs(dataDir, [createJob('job-1')]);

  await scheduler.tick();

  const jobs = readJobs(dataDir);
  jobs[0].nextRunAt = new Date(Date.now() - 60_000).toISOString();
  writeJobs(dataDir, jobs);

  await scheduler.tick();
  assert.equal(spawnCount, 1);

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
  const spawnedProfiles = [];

  const scheduler = createMultiProfileScheduler(
    { alpha: alphaDataDir, beta: betaDataDir },
    async (job) => {
      spawnedProfiles.push(job.profileName);
      return gate.promise;
    }
  );

  writeJobs(alphaDataDir, [createJob('shared-job', { profileName: 'alpha' })]);
  writeJobs(betaDataDir, [createJob('shared-job', { profileName: 'beta' })]);

  await scheduler.tick();
  assert.deepEqual(spawnedProfiles.sort(), ['alpha', 'beta']);

  gate.resolve('ok');
  await delay(20);
  await Promise.all([
    scheduler._awaitJobWrites(alphaDataDir),
    scheduler._awaitJobWrites(betaDataDir),
  ]);
});

test('fire-and-forget execution still persists job state', async () => {
  const dataDir = createTempDataDir();
  const scheduler = createScheduler(dataDir, async () => 'ok');

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

test('cron worker failure sends one DM and persists failed status', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];
  const scheduler = createScheduler(
    dataDir,
    async () => {
      throw new Error('script exited 1');
    },
    async (job, text) => {
      deliveries.push({ deliver: job.deliver, text });
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
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].deliver, { platform: 'slack', channel: 'D0ANGB3M1CZ', threadTs: null });
  assert.match(deliveries[0].text, /^:warning: cron 失败 — Failing Cron /);
  assert.match(deliveries[0].text, /reason: script exited 1/);
});

test('cron failed result text is treated as failure without normal delivery', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];
  const scheduler = createScheduler(
    dataDir,
    async () => ({ text: 'failed: boom', stopReason: 'success' }),
    async (job, text) => {
      deliveries.push({ deliver: job.deliver, text });
    },
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
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].deliver.channel, 'D0ANGB3M1CZ');
  assert.match(deliveries[0].text, /reason: boom/);
});
