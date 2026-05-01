/**
 * Cron scheduler — ticks every 60s, spawns workers for due jobs.
 *
 * Job storage: profiles/{name}/data/cron-jobs.json (per-profile).
 * Schedule types: cron (5-field), interval ("every Nm/Nh"), one-shot (ISO or duration).
 *
 * The agent manages jobs by reading/writing the JSON file directly.
 * This module only reads the file and executes due jobs.
 */

import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { info, error as logError, warn } from './log.js';
import { writeLessonCandidate } from './lesson-candidates.js';

const TAG = 'cron';
const TICK_INTERVAL = 60_000; // 60 seconds
const JOBS_LOCK_TIMEOUT_MS = 5_000;
const JOBS_LOCK_STALE_MS = 60_000;
const PROFILE_DM_CHANNELS = {
  karry: 'D0ANGB3M1CZ',
};
const missingJobsLogged = new Set();

export class BadCronExpr extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'BadCronExpr';
    this.field = field;
  }
}

// ── Minimal 5-field cron parser ──

// Parse a cron field (e.g. "0", "*", "1-5", "star/15", "1,3,5").
// Returns a Set of valid integers for that field.
export function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    // */N — step from min
    const stepMatch = trimmed.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      if (step <= 0) throw new BadCronExpr(trimmed, 'step must be > 0');
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }
    // * — all values
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    // N-M — range
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end) throw new BadCronExpr(trimmed, 'range start must be <= end');
      if (start < min || end > max) throw new BadCronExpr(trimmed, 'value out of range');
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }
    // N-M/S — range with step
    const rangeStepMatch = trimmed.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (rangeStepMatch) {
      const start = parseInt(rangeStepMatch[1], 10);
      const end = parseInt(rangeStepMatch[2], 10);
      const step = parseInt(rangeStepMatch[3], 10);
      if (step <= 0) throw new BadCronExpr(trimmed, 'step must be > 0');
      if (start > end) throw new BadCronExpr(trimmed, 'range start must be <= end');
      if (start < min || end > max) throw new BadCronExpr(trimmed, 'value out of range');
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }
    // N — single value
    const numMatch = trimmed.match(/^\d+$/);
    if (numMatch) {
      const num = parseInt(trimmed, 10);
      if (num < min || num > max) throw new BadCronExpr(trimmed, 'value out of range');
      values.add(num);
      continue;
    }
    throw new BadCronExpr(trimmed, 'invalid token');
  }
  return values;
}

/**
 * Check if a Date matches a 5-field cron expression.
 * Fields: minute hour day-of-month month day-of-week
 */
function matchesCron(expr, date) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12);
  const dow = parseCronField(fields[4], 0, 6); // 0 = Sunday

  return (
    minute.has(date.getMinutes()) &&
    hour.has(date.getHours()) &&
    dom.has(date.getDate()) &&
    month.has(date.getMonth() + 1) &&
    dow.has(date.getDay())
  );
}

/**
 * Compute the next run time for a cron expression after `after`.
 * Brute-force minute-by-minute scan (max 366 days ahead).
 */
function nextCronRun(expr, after) {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = 366 * 24 * 60; // max iterations
  for (let i = 0; i < limit; i++) {
    if (matchesCron(expr, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ── Schedule parsing ──

const DURATION_RE = /^(\d+)\s*(m|min|h|hr|hour|d|day)s?$/i;
const EVERY_RE = /^every\s+(\d+)\s*(m|min|h|hr|hour|d|day)s?$/i;

function parseDurationMinutes(amount, unit) {
  const n = parseInt(amount, 10);
  const u = unit.toLowerCase();
  if (u.startsWith('h')) return n * 60;
  if (u.startsWith('d')) return n * 1440;
  return n; // minutes
}

/**
 * Parse a schedule string into a structured object.
 * Returns { kind, expr?, minutes?, runAt?, display }
 */
export function parseSchedule(input) {
  const s = input.trim();

  // "every 30m" → interval
  const everyMatch = s.match(EVERY_RE);
  if (everyMatch) {
    const minutes = parseDurationMinutes(everyMatch[1], everyMatch[2]);
    return { kind: 'interval', minutes, display: s };
  }

  // "30m", "2h" → one-shot duration from now
  const durMatch = s.match(DURATION_RE);
  if (durMatch) {
    const minutes = parseDurationMinutes(durMatch[1], durMatch[2]);
    const runAt = new Date(Date.now() + minutes * 60_000);
    return { kind: 'once', runAt: runAt.toISOString(), display: s };
  }

  // ISO timestamp → one-shot
  const isoDate = Date.parse(s);
  if (!isNaN(isoDate) && s.includes('-')) {
    return { kind: 'once', runAt: new Date(isoDate).toISOString(), display: s };
  }

  // 5-field cron expression
  if (s.split(/\s+/).length === 5) {
    return { kind: 'cron', expr: s, display: s };
  }

  throw new Error(`cannot parse schedule: "${s}"`);
}

/**
 * Compute the next run time for a job.
 */
export function computeNextRun(schedule, after = new Date()) {
  if (schedule.kind === 'once') {
    return schedule.runAt ? new Date(schedule.runAt) : null;
  }
  if (schedule.kind === 'interval') {
    return new Date(after.getTime() + schedule.minutes * 60_000);
  }
  if (schedule.kind === 'cron') {
    return nextCronRun(schedule.expr, after);
  }
  return null;
}

// ── Job persistence ──

function jobsPath(dataDir) {
  return join(dataDir, 'cron-jobs.json');
}

function lastGoodJobsPath(dataDir) {
  return join(dataDir, 'cron-jobs.last-good.json');
}

function profileNameFromDataDir(dataDir) {
  return basename(dirname(dataDir));
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeLastGoodJobs(dataDir, raw) {
  const p = lastGoodJobsPath(dataDir);
  const tmp = p + '.tmp.' + process.pid;
  writeFileSync(tmp, raw, 'utf-8');
  renameSync(tmp, p);
}

function updateLastGoodJobs(dataDir) {
  const p = jobsPath(dataDir);
  writeLastGoodJobs(dataDir, readFileSync(p, 'utf-8'));
}

function postFailureDm(profileName, corruptPath, fallback) {
  const channel = PROFILE_DM_CHANNELS[profileName];
  const token = process.env.SLACK_BOT_TOKEN;
  if (!channel || !token || typeof fetch !== 'function') return;

  const text = [
    '🚨 cron-jobs.json 损坏已隔离',
    `profile: ${profileName}`,
    `quarantine: ${basename(corruptPath)}`,
    `fallback: ${fallback}`,
  ].join('\n').slice(0, 200);

  fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text }),
  }).catch((err) => {
    warn(TAG, `failed to send cron corrupt DM: ${err.message}`);
  });
}

function postCronPersistenceFailureDm(profileName, dataDir, reason) {
  const channel = PROFILE_DM_CHANNELS[profileName] || PROFILE_DM_CHANNELS.karry;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!channel || !token || typeof fetch !== 'function') return;

  const text = [
    '🚨 cron-jobs.json 写入失败',
    `profile: ${profileName}`,
    `dataDir: ${dataDir}`,
    `reason: ${reason}`,
    'nextRunAt 未落盘；修复磁盘/权限后下次 tick 会重试 due 窗口。',
  ].join('\n').slice(0, 500);

  fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text }),
  }).catch((err) => {
    warn(TAG, `failed to send cron persistence failure DM: ${err.message}`);
  });
}

function recordCronPersistenceFailure(dataDir, reason, job = null) {
  try {
    writeLessonCandidate(dataDir, {
      source: 'cron-persistence-failure',
      stopReason: 'cron_jobs_write_failed',
      errorContext: String(reason || '').slice(0, 500),
      threadId: job?.id ? `cron:${job.id}` : 'cron:persist',
      cronName: job?.name || job?.id || 'cron-jobs.json',
      kind: 'cron',
      origin: { kind: 'cron-persist', jobId: job?.id || null },
    });
  } catch (err) {
    warn(TAG, `failed to write cron persistence failure lesson candidate: ${err.message}`);
  }
  postCronPersistenceFailureDm(profileNameFromDataDir(dataDir), dataDir, reason);
}

function loadJobs(dataDir) {
  const p = jobsPath(dataDir);
  if (!existsSync(p)) {
    if (!missingJobsLogged.has(p)) {
      info(TAG, `jobs file not found at ${p}; starting empty`);
      missingJobsLogged.add(p);
    }
    return [];
  }

  let raw;
  try {
    raw = readFileSync(p, 'utf-8');
    const jobs = JSON.parse(raw);
    if (Array.isArray(jobs) && jobs.length > 0) {
      try { writeLastGoodJobs(dataDir, raw); } catch (err) { warn(TAG, `failed to update last-good jobs snapshot: ${err.message}`); }
    }
    return Array.isArray(jobs) ? jobs : [];
  } catch (err) {
    if (raw == null) {
      logError(TAG, `failed to load jobs from ${p}: ${err.message}`);
      return [];
    }

    const corruptPath = join(dataDir, `cron-jobs.corrupt.${timestampForPath()}.json`);
    try {
      renameSync(p, corruptPath);
    } catch (renameErr) {
      logError(TAG, `failed to quarantine corrupt jobs file ${p}: ${renameErr.message}`);
    }

    try {
      writeLessonCandidate(dataDir, {
        source: 'cron-jobs-corrupt',
        stopReason: 'json_parse_error',
        errorContext: raw.slice(0, 500),
        threadId: 'cron:loadJobs',
        cronName: 'cron-jobs.json',
        kind: 'cron',
        origin: { kind: 'cron-load', file: p, corruptPath },
      });
    } catch (lessonErr) {
      warn(TAG, `failed to write cron corrupt lesson candidate: ${lessonErr.message}`);
    }

    const profileName = profileNameFromDataDir(dataDir);
    const lastGood = lastGoodJobsPath(dataDir);
    if (existsSync(lastGood)) {
      try {
        const fallbackRaw = readFileSync(lastGood, 'utf-8');
        const jobs = JSON.parse(fallbackRaw);
        warn(TAG, `quarantined corrupt jobs file to ${corruptPath}; loaded last-good snapshot`);
        postFailureDm(profileName, corruptPath, 'last-good');
        return Array.isArray(jobs) ? jobs : [];
      } catch (fallbackErr) {
        logError(TAG, `failed to load last-good jobs from ${lastGood}: ${fallbackErr.message}`);
      }
    }

    logError(TAG, `quarantined corrupt jobs file to ${corruptPath}; no last-good snapshot, starting empty`);
    postFailureDm(profileName, corruptPath, 'empty');
    return [];
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readLockPid(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function withJobsFileLock(dataDir, fn) {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, 'cron-jobs.json.lock');
  const startedAt = Date.now();
  let fd = null;

  while (fd == null) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n', 'utf-8');
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const pid = readLockPid(lockPath);
      let stale = !isPidAlive(pid);
      try {
        stale = stale || Date.now() - statSync(lockPath).mtimeMs > JOBS_LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        try { unlinkSync(lockPath); } catch {}
        continue;
      }
      if (Date.now() - startedAt >= JOBS_LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for ${lockPath}`);
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

export function saveJobs(dataDir, jobs) {
  const p = jobsPath(dataDir);
  const tmp = p + '.tmp.' + process.pid;
  try {
    withJobsFileLock(dataDir, () => {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(tmp, JSON.stringify(jobs, null, 2) + '\n', 'utf-8');
      renameSync(tmp, p);
      if (Array.isArray(jobs) && jobs.length > 0) updateLastGoodJobs(dataDir);
    });
  } catch (err) {
    logError(TAG, `failed to save jobs to ${p}: ${err.message}`);
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ── Grace window for stale jobs ──

function graceMs(schedule) {
  if (schedule.kind === 'once') return 120_000; // 2 min
  if (schedule.kind === 'interval') {
    return Math.min(Math.max(schedule.minutes * 30_000, 120_000), 7_200_000);
  }
  // cron: default 2 hours
  return 7_200_000;
}

function isSuccessfulStopReason(stopReason) {
  return !stopReason || stopReason === 'success' || stopReason === 'stop' || stopReason === 'end_turn';
}

function failureReasonFromResult(responseText, stopReason, errorSummary = '') {
  const text = String(responseText || '').trim();
  if (text.toLowerCase().startsWith('failed:')) return text.slice('failed:'.length).trim() || 'failed';
  if (!isSuccessfulStopReason(stopReason)) {
    const summary = truncateErrorContext(errorSummary, 160);
    return summary ? `${stopReason}: ${summary}` : `stopReason=${stopReason}`;
  }
  return null;
}

function truncateErrorContext(value, limit = 500) {
  return String(value || '').replace(/\s+$/g, '').slice(0, limit);
}

// ── CronScheduler ──

export class CronScheduler {
  /**
   * @param {object} opts
   * @param {Function} opts.getProfilePaths - (profileName) => { dataDir, workspaceDir, scriptsDir }
   * @param {object} [opts.scheduler] - Scheduler with executeTask()
   */
  constructor({ getProfilePaths, scheduler = null }) {
    this._getProfilePaths = getProfilePaths;
    this._scheduler = scheduler;
    this._running = false;
    this._inflightJobs = new Set();
    this._jobWriteChains = new Map();
  }

  start() {
    if (this._interval || this._delay) return; // #18: guard against double-start during 10s delay
    info(TAG, 'cron scheduler started (60s tick)');
    // First tick after 10s (let adapters connect), then every 60s
    this._delay = setTimeout(() => {
      this._delay = null;
      this.tick();
      this._interval = setInterval(() => this.tick(), TICK_INTERVAL);
    }, 10_000);
  }

  stop() {
    if (this._delay) { clearTimeout(this._delay); this._delay = null; }
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    info(TAG, 'cron scheduler stopped');
  }

  async tick() {
    if (this._running) {
      warn(TAG, 'tick skipped: previous tick still running');
      return;
    }
    this._running = true;
    const now = new Date();

    try {
      const profileNames = this._getProfileNames();

      for (const profileName of profileNames) {
        let paths;
        try {
          paths = this._getProfilePaths(profileName);
        } catch {
          continue;
        }

        await this._awaitJobWrites(paths.dataDir);
        const jobs = loadJobs(paths.dataDir);
        if (jobs.length === 0) continue;

        const dueJobs = [];
        const nextRunUpdates = new Map();

        for (const job of jobs) {
          try {
            if (!job.enabled) continue;
            if (!job.nextRunAt) continue;

            const nextRun = new Date(job.nextRunAt);
            if (nextRun > now) continue;

            // Check grace window — skip if too stale (fast-forward instead)
            const grace = graceMs(job.schedule);
            const stale = now.getTime() - nextRun.getTime();

            if (stale > grace) {
              const next = computeNextRun(job.schedule, now);
              job.nextRunAt = next ? next.toISOString() : null;
              warn(TAG, `fast-forwarded stale job ${job.id} "${job.name}" (missed by ${Math.round(stale / 60_000)}m)`);
              nextRunUpdates.set(job.id, { nextRunAt: job.nextRunAt });
              continue;
            }

            // Advance next run BEFORE execution (at-most-once for recurring)
            if (job.schedule.kind !== 'once') {
              const next = computeNextRun(job.schedule, now);
              job.nextRunAt = next ? next.toISOString() : null;
              nextRunUpdates.set(job.id, { nextRunAt: job.nextRunAt });
            }

            dueJobs.push(job);
          } catch (err) {
            if (err instanceof BadCronExpr) {
              await this._disableBadCronJob(paths.dataDir, job, err);
              continue;
            }
            throw err;
          }
        }

        if (nextRunUpdates.size > 0) {
          try {
            await this._queueJobWrite(paths.dataDir, (storedJobs) => {
              let dirty = false;

              for (const storedJob of storedJobs) {
                const updates = nextRunUpdates.get(storedJob.id);
                if (!updates) continue;
                if (storedJob.nextRunAt === updates.nextRunAt) continue;
                storedJob.nextRunAt = updates.nextRunAt;
                dirty = true;
              }

              return dirty;
            });
          } catch (err) {
            logError(TAG, `failed to persist cron nextRunAt updates: ${err.message}`);
            recordCronPersistenceFailure(paths.dataDir, err.message);
            for (const job of dueJobs) {
              const storedJob = jobs.find((item) => item.id === job.id);
              if (storedJob) job.nextRunAt = storedJob.nextRunAt;
            }
          }
        }

        for (const job of dueJobs) {
          this._executeCronJob(job, paths, now).catch((err) => {
            logError(TAG, `job ${job.id} failed: ${err.message}`);
          });
        }
      }
    } catch (err) {
      logError(TAG, `tick error: ${err.stack || err.message}`);
    } finally {
      this._running = false;
    }
  }

  async _executeCronJob(job, paths, now) {
    const inflightKey = this._inflightKey(paths.dataDir, job.id);

    if (this._inflightJobs.has(inflightKey)) {
      warn(TAG, `job ${job.id} still running from previous tick, skipping this fire`);
      return;
    }

    this._inflightJobs.add(inflightKey);
    info(TAG, `executing job ${job.id} "${job.name}" (profile=${job.profileName})`);
    const origin = { kind: 'cron', name: job.id, parentAttemptId: null };
    const recordFailureLesson = (reason, errorContext = '') => {
      try {
        writeLessonCandidate(paths.dataDir, {
          source: 'cron-failure',
          stopReason: reason,
          errorContext: JSON.stringify({ error: errorContext, origin }).slice(0, 500),
          threadId: `cron:${job.id}`,
          cronName: job.name || job.id,
          kind: 'cron',
          origin,
        });
      } catch (err) {
        warn(TAG, `failed to write cron failure lesson candidate: ${err.message}`);
      }
    };

    try {
      const scheduler = this._getScheduler();
      if (typeof scheduler?.executeTask !== 'function') {
        throw new Error('scheduler executeTask unavailable for cron job');
      }
      const delivery = this._resolveDelivery(job);
      const jobRunId = `${job.id}:${now.getTime()}:${randomUUID()}`;
      let responseText = '';
      let stopReason = null;

      const result = await scheduler.executeTask({
        userText: job.prompt,
        fileContent: '',
        imagePaths: [],
        threadTs: `cron:${job.id}`,
        deliveryThreadTs: delivery.threadTs || null,
        channel: delivery.channel,
        userId: null,
        platform: delivery.platform,
        channelSemantics: 'silent',
        threadHistory: null,
        model: job.model || null,
        effort: job.effort || null,
        maxTurns: job.maxTurns || null,
        enableTaskCard: false,
        forceNewWorker: true,
        jobRunId,
        cronName: job.name || job.id,
        origin,
        profile: {
          name: job.profileName,
          workspaceDir: paths.workspaceDir,
          dataDir: paths.dataDir,
          scriptsDir: paths.scriptsDir,
        },
      });
      responseText = result?.text || '';
      stopReason = result?.stopReason || null;

      const failureReason = failureReasonFromResult(responseText, stopReason, result?.errorSummary || '');

      job.lastRunAt = now.toISOString();
      if (failureReason) {
        job.lastStatus = 'failed';
        job.lastError = truncateErrorContext(failureReason);
        recordFailureLesson(failureReason, responseText || stopReason || '');
        job.lastDeliveryError = null;
      } else {
        job.lastStatus = 'ok';
        job.lastError = null;
        job.lastDeliveryError = null;
      }
    } catch (err) {
      job.lastRunAt = now.toISOString();
      job.lastStatus = 'failed';
      job.lastError = truncateErrorContext(err.message);
      logError(TAG, `job ${job.id} failed: ${err.message}`);
      recordFailureLesson(err.message || 'worker_error', err.stack || err.message);
      job.lastDeliveryError = null;
    }

    // Repeat tracking
    if (job.repeat?.times != null) {
      job.repeat.completed = (job.repeat.completed || 0) + 1;
      if (job.repeat.completed >= job.repeat.times) {
        job.enabled = false;
        job.nextRunAt = null;
        info(TAG, `job ${job.id} completed (${job.repeat.completed}/${job.repeat.times})`);
      }
    }

    // One-shot: disable after execution
    if (job.schedule.kind === 'once') {
      job.enabled = false;
      job.nextRunAt = null;
    }

    try {
      await this._persistJobState(paths.dataDir, job);
    } catch (err) {
      logError(TAG, `failed to persist job ${job.id}: ${err.message}`);
      recordCronPersistenceFailure(paths.dataDir, err.message, job);
    } finally {
      this._inflightJobs.delete(inflightKey);
    }
  }

  _inflightKey(dataDir, jobId) {
    return `${dataDir}:${jobId}`;
  }

  _getScheduler() {
    return this._scheduler || globalThis.__orbSchedulerInstance;
  }

  _resolveDelivery(job) {
    return {
      platform: 'slack',
      channel: PROFILE_DM_CHANNELS[job.profileName] || PROFILE_DM_CHANNELS.karry,
      threadTs: null,
    };
  }

  async _awaitJobWrites(dataDir) {
    const pending = this._jobWriteChains.get(dataDir);
    if (!pending) return;
    await pending.catch(() => {});
  }

  _queueJobWrite(dataDir, mutateJobs) {
    const previous = this._jobWriteChains.get(dataDir) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        const jobs = loadJobs(dataDir);
        if (!mutateJobs(jobs)) return;
        saveJobs(dataDir, jobs);
      });

    let tracked;
    tracked = next.finally(() => {
      if (this._jobWriteChains.get(dataDir) === tracked) {
        this._jobWriteChains.delete(dataDir);
      }
    });

    this._jobWriteChains.set(dataDir, tracked);
    return tracked;
  }

  _persistJobState(dataDir, job) {
    return this._queueJobWrite(dataDir, (jobs) => {
      const storedJob = jobs.find((item) => item.id === job.id);
      if (!storedJob) return false;

      storedJob.lastRunAt = job.lastRunAt;
      storedJob.lastStatus = job.lastStatus;
      storedJob.lastError = job.lastError;
      storedJob.lastDeliveryError = job.lastDeliveryError;

      if (job.repeat) {
        storedJob.repeat = { ...(storedJob.repeat || {}), ...job.repeat };
      }

      if (!job.enabled) {
        storedJob.enabled = false;
        storedJob.nextRunAt = null;
      }

      return true;
    });
  }

  async _disableBadCronJob(dataDir, job, err) {
    const lastError = `BadCronExpr: ${err.message}`;
    if (job.lastError !== lastError) {
      warn(TAG, `cron job ${job.id} (${job.name}) has bad expr: ${err.message}; disabling`);
    }

    job.enabled = false;
    job.nextRunAt = null;
    job.lastStatus = 'failed';
    job.lastError = lastError;

    try {
      await this._queueJobWrite(dataDir, (jobs) => {
        const storedJob = jobs.find((item) => item.id === job.id);
        if (!storedJob) return false;
        if (
          storedJob.enabled === false &&
          storedJob.nextRunAt == null &&
          storedJob.lastStatus === 'failed' &&
          storedJob.lastError === lastError
        ) {
          return false;
        }
        storedJob.enabled = false;
        storedJob.nextRunAt = null;
        storedJob.lastStatus = 'failed';
        storedJob.lastError = lastError;
        return true;
      });
    } catch {}
  }

  /**
   * Get list of profile names. Populated externally.
   * @type {string[]}
   */
  _profileNames = [];

  setProfileNames(names) {
    this._profileNames = names;
  }

  _getProfileNames() {
    return this._profileNames;
  }
}
