/**
 * Cron scheduler — ticks every 60s, spawns workers for due jobs.
 *
 * Job storage: profiles/{name}/data/cron-jobs.json (per-profile).
 * Schedule types: cron (5-field), interval ("every Nm/Nh"), one-shot (ISO or duration).
 *
 * The agent manages jobs by reading/writing the JSON file directly.
 * This module only reads the file and executes due jobs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { info, error as logError, warn } from './log.js';

const TAG = 'cron';
const TICK_INTERVAL = 60_000; // 60 seconds

// ── Minimal 5-field cron parser ──

// Parse a cron field (e.g. "0", "*", "1-5", "star/15", "1,3,5").
// Returns a Set of valid integers for that field.
function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    // */N — step from min
    const stepMatch = trimmed.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
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
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }
    // N-M/S — range with step
    const rangeStepMatch = trimmed.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (rangeStepMatch) {
      const start = parseInt(rangeStepMatch[1], 10);
      const end = parseInt(rangeStepMatch[2], 10);
      const step = parseInt(rangeStepMatch[3], 10);
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }
    // N — single value
    const num = parseInt(trimmed, 10);
    if (!isNaN(num)) values.add(num);
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

function loadJobs(dataDir) {
  const p = jobsPath(dataDir);
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, 'utf-8');
    const jobs = JSON.parse(raw);
    return Array.isArray(jobs) ? jobs : [];
  } catch (err) {
    logError(TAG, `failed to load jobs from ${p}: ${err.message}`);
    return [];
  }
}

function saveJobs(dataDir, jobs) {
  const p = jobsPath(dataDir);
  const tmp = p + '.tmp.' + process.pid;
  try {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(tmp, JSON.stringify(jobs, null, 2) + '\n', 'utf-8');
    renameSync(tmp, p);
  } catch (err) {
    logError(TAG, `failed to save jobs to ${p}: ${err.message}`);
    try { unlinkSync(tmp); } catch {}
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

// ── CronScheduler ──

export class CronScheduler {
  /**
   * @param {object} opts
   * @param {Function} opts.getProfilePaths - (profileName) => { dataDir, soulDir, workspaceDir }
   * @param {Function} opts.spawnCronWorker - (job, profilePaths) => Promise<string> (response text)
   * @param {Function} opts.deliverResult - (job, text) => Promise<void>
   */
  constructor({ getProfilePaths, spawnCronWorker, deliverResult }) {
    this._getProfilePaths = getProfilePaths;
    this._spawnCronWorker = spawnCronWorker;
    this._deliverResult = deliverResult;
    this._timer = null;
    this._running = false;
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

        const jobs = loadJobs(paths.dataDir);
        if (jobs.length === 0) continue;

        let dirty = false;
        const dueJobs = [];

        for (const job of jobs) {
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
            dirty = true;
            continue;
          }

          // Advance next run BEFORE execution (at-most-once for recurring)
          if (job.schedule.kind !== 'once') {
            const next = computeNextRun(job.schedule, now);
            job.nextRunAt = next ? next.toISOString() : null;
          }
          dirty = true;

          dueJobs.push(job);
        }

        // Execute all due jobs in parallel within this profile
        if (dueJobs.length > 0) {
          await Promise.allSettled(
            dueJobs.map((job) => this._executeCronJob(job, paths, now))
          );
        }

        if (dirty) saveJobs(paths.dataDir, jobs);
      }
    } catch (err) {
      logError(TAG, `tick error: ${err.stack || err.message}`);
    } finally {
      this._running = false;
    }
  }

  async _executeCronJob(job, paths, now) {
    info(TAG, `executing job ${job.id} "${job.name}" (profile=${job.profileName})`);

    try {
      const responseText = await this._spawnCronWorker(job, paths);
      const silent = responseText?.startsWith('[SILENT]');

      job.lastRunAt = now.toISOString();
      job.lastStatus = 'ok';
      job.lastError = null;

      if (!silent && responseText && job.deliver) {
        try {
          await this._deliverResult(job, responseText);
          job.lastDeliveryError = null;
        } catch (err) {
          job.lastDeliveryError = err.message;
          logError(TAG, `delivery failed for job ${job.id}: ${err.message}`);
        }
      }
    } catch (err) {
      job.lastRunAt = now.toISOString();
      job.lastStatus = 'error';
      job.lastError = err.message;
      logError(TAG, `job ${job.id} failed: ${err.message}`);
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
