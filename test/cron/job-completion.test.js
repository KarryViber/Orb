import test from 'node:test';
import assert from 'node:assert/strict';
import { applyJobCompletion } from '../../src/cron/job-completion.js';

const now = '2026-05-05T00:00:00.000Z';

function job(overrides = {}) {
  return {
    id: 'job-a',
    enabled: true,
    nextRunAt: '2026-05-05T00:01:00.000Z',
    schedule: { kind: 'interval', minutes: 1 },
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    lastRunAt: now,
    lastStatus: 'ok',
    lastError: null,
    lastDeliveryError: null,
    applyCompletionRules: true,
    ...overrides,
  };
}

test('persists ok direct delivery status without disabling recurring jobs', () => {
  const next = applyJobCompletion(job({ deliver: { mode: 'direct' } }), result(), {});
  assert.equal(next.lastStatus, 'ok');
  assert.equal(next.enabled, true);
  assert.equal(next.nextRunAt, '2026-05-05T00:01:00.000Z');
});

test('persists failed dm_only status without repeat completion changes', () => {
  const next = applyJobCompletion(job({ deliver: { mode: 'dm_only' } }), result({
    lastStatus: 'failed',
    lastError: 'worker_error',
  }), {});
  assert.equal(next.lastStatus, 'failed');
  assert.equal(next.lastError, 'worker_error');
  assert.equal(next.enabled, true);
});

test('persists truncated silent status as non-disabled recurring completion', () => {
  const next = applyJobCompletion(job({ deliver: { mode: 'silent' } }), result({
    lastStatus: 'truncated',
    lastError: 'max_turns: limit',
  }), {});
  assert.equal(next.lastStatus, 'truncated');
  assert.equal(next.enabled, true);
});

test('increments repeat completion below the repeat limit', () => {
  const next = applyJobCompletion(job({
    repeat: { times: 3, completed: 1 },
  }), result(), {});
  assert.deepEqual(next.repeat, { times: 3, completed: 2 });
  assert.equal(next.enabled, true);
});

test('disables repeat job when completion reaches repeat limit', () => {
  const next = applyJobCompletion(job({
    repeat: { times: 2, completed: 1 },
  }), result(), {});
  assert.equal(next.repeat.completed, 2);
  assert.equal(next.enabled, false);
  assert.equal(next.nextRunAt, null);
});

test('does not increment repeat when completion rules are disabled', () => {
  const next = applyJobCompletion(job({
    repeat: { times: 2, completed: 1 },
  }), result({ applyCompletionRules: false }), {});
  assert.deepEqual(next.repeat, { times: 2, completed: 1 });
  assert.equal(next.enabled, true);
});

test('disables one-shot jobs after execution', () => {
  const next = applyJobCompletion(job({
    schedule: { kind: 'once', runAt: now },
  }), result(), {});
  assert.equal(next.enabled, false);
  assert.equal(next.nextRunAt, null);
});

test('disables job on explicit disable result even when completion rules are disabled', () => {
  const next = applyJobCompletion(job(), result({
    applyCompletionRules: false,
    disableJob: true,
  }), {});
  assert.equal(next.enabled, false);
  assert.equal(next.nextRunAt, null);
});
