import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cronHistoryProvider } from '../../src/context-providers/cron-history.js';

function tempDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), 'orb-cron-history-'));
  mkdirSync(join(dataDir, 'cron-results'), { recursive: true });
  return dataDir;
}

function dateKey(offsetDays = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - offsetDays);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function writeResult(dataDir, offsetDays, cronId, result) {
  const day = dateKey(offsetDays);
  const dir = join(dataDir, 'cron-results', day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${cronId}.json`), JSON.stringify({
    cron_id: cronId,
    cron_name: 'nightly-test',
    title: `${result.status} ${day}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: result.text || `body ${day}` } }],
    timestamp: `${day}T12:00:00+09:00`,
    ...result,
  }, null, 2), 'utf-8');
}

function ctx(dataDir, origin = { kind: 'cron', name: 'job-a' }) {
  return {
    dataDir,
    origin,
    retrievedAt: '2026-05-03T00:00:00.000Z',
  };
}

test('returns latest failures first, then successful results', async () => {
  const dataDir = tempDataDir();
  writeResult(dataDir, 0, 'job-a', { status: 'ok', text: 'ok today' });
  writeResult(dataDir, 1, 'job-a', { status: 'failed', text: 'failed yesterday' });
  writeResult(dataDir, 2, 'job-a', { status: 'error', text: 'failed before' });
  writeResult(dataDir, 3, 'job-a', { status: 'ok', text: 'old ok skipped' });

  const fragments = await cronHistoryProvider.prefetch(ctx(dataDir));

  assert.equal(fragments.length, 3);
  assert.deepEqual(fragments.map((fragment) => fragment.source_type), ['cron_history', 'cron_history', 'cron_history']);
  assert.deepEqual(fragments.map((fragment) => fragment.trusted), [true, true, true]);
  assert.deepEqual(fragments.map((fragment) => fragment.origin), [
    { kind: 'cron', name: 'job-a' },
    { kind: 'cron', name: 'job-a' },
    { kind: 'cron', name: 'job-a' },
  ]);
  assert.match(fragments[0].content, /failed yesterday/);
  assert.match(fragments[1].content, /failed before/);
  assert.match(fragments[2].content, /ok today/);
});

test('returns empty list when no result exists', async () => {
  assert.deepEqual(await cronHistoryProvider.prefetch(ctx(tempDataDir())), []);
});

test('returns empty list for non-cron origin', async () => {
  assert.deepEqual(await cronHistoryProvider.prefetch(ctx(tempDataDir(), { kind: 'user', name: 'job-a' })), []);
});

test('returns empty list when cron origin has no name', async () => {
  assert.deepEqual(await cronHistoryProvider.prefetch(ctx(tempDataDir(), { kind: 'cron' })), []);
});

test('truncates oversized result snippets to 1500 characters', async () => {
  const dataDir = tempDataDir();
  writeResult(dataDir, 0, 'job-a', { status: 'failed', title: 't'.repeat(8000), text: 'x'.repeat(8000) });

  const [fragment] = await cronHistoryProvider.prefetch(ctx(dataDir));

  assert.equal(fragment.content.length, 1500);
  assert.match(fragment.content, /^title:/);
});
