import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../../src/context.js';
import { cronProtocolProvider } from '../../src/context-providers/cron-protocol.js';

test('cron protocol provider returns trusted scheduler protocol for cron origin', async () => {
  const [fragment] = await cronProtocolProvider.prefetch({
    origin: { kind: 'cron', name: 'job-a' },
  });

  assert.equal(fragment.label, 'cron-protocol');
  assert.equal(fragment.source_type, 'system_protocol');
  assert.equal(fragment.trusted, true);
  assert.equal(fragment.origin, 'scheduler:cron-dispatch');
  assert.match(fragment.content, /deliver\.mode/);
  assert.match(fragment.content, /\[SILENT\]/);
  assert.match(fragment.content, /failed: <reason>/);
  assert.match(fragment.content, /\/tmp\/cron-output-<cron_id>\.json/);
  assert.match(fragment.content, /Slack 原生 Block Kit/);
  assert.match(fragment.content, /attachment-shape/);
});

test('cron protocol provider skips non-cron origins', async () => {
  assert.deepEqual(await cronProtocolProvider.prefetch({ origin: { kind: 'user' } }), []);
  assert.deepEqual(await cronProtocolProvider.prefetch({}), []);
});

test('cron protocol provider renders profile data dir path when available', async () => {
  const [withDataDir] = await cronProtocolProvider.prefetch({
    dataDir: '/profiles/example/data',
    origin: { kind: 'cron', name: 'job-a' },
  });
  const [withoutDataDir] = await cronProtocolProvider.prefetch({
    origin: { kind: 'cron', name: 'job-a' },
  });

  assert.match(withDataDir.content, /\/profiles\/example\/data\/evolution\/categories\.yaml/);
  assert.doesNotMatch(withDataDir.content, /profiles\/karry\/data\/evolution\/categories\.yaml/);
  assert.match(withoutDataDir.content, /<profile-data-dir>\/evolution\/categories\.yaml/);
});

test('cron protocol is injected into rendered prompt for cron tasks only', async () => {
  const cronPrompt = await buildPrompt({
    userText: 'run cron',
    dataDir: '/tmp',
    origin: { kind: 'cron', name: 'job-a' },
  });
  const userPrompt = await buildPrompt({
    userText: 'hello',
    dataDir: '/tmp',
    origin: { kind: 'user' },
  });

  assert.match(cronPrompt.userPrompt, /label="cron-protocol"/);
  assert.match(cronPrompt.userPrompt, /source_type="system_protocol"/);
  assert.match(cronPrompt.userPrompt, /scheduler:cron-dispatch/);
  assert.doesNotMatch(userPrompt.userPrompt, /label="cron-protocol"/);
});

test('launcher_result origin is rendered explicitly in current user message', async () => {
  const prompt = await buildPrompt({
    userText: '外部 session `spec-smoke` rc=0 took=5s，详情见上方卡片。',
    dataDir: '/tmp',
    origin: { kind: 'launcher_result', name: 'spec-smoke' },
  });

  assert.match(prompt.userPrompt, /source_type="launcher_result"/);
  assert.match(prompt.userPrompt, /origin="launcher_result:spec-smoke"/);
});
