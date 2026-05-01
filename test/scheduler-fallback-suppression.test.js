import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Scheduler } from '../src/scheduler.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'orb-scheduler-fallback-'));
  return {
    name: 'test',
    workspaceDir: dir,
    scriptsDir: dir,
    dataDir: dir,
  };
}

function makeAdapter() {
  const calls = [];
  return {
    calls,
    buildPayloads(text) {
      return [{ text }];
    },
    async sendReply(channel, threadTs, text, extra = {}) {
      calls.push(['sendReply', channel, threadTs, text, extra]);
    },
    async deliver(intent, { channel: deliveryChannel } = {}) {
      if (deliveryChannel !== 'postMessage') return { ts: null };
      calls.push(['sendReply', intent.channel, intent.threadTs, intent.text, intent.meta || {}]);
      return { ts: 'reply-1' };
    },
    async cleanupIndicator(channel, threadTs, typingSet, errorMsg) {
      calls.push(['cleanupIndicator', channel, threadTs, typingSet, errorMsg]);
    },
    async setThreadStatus(channel, threadTs, status, loadingMessages) {
      calls.push(['setThreadStatus', channel, threadTs, status, loadingMessages]);
    },
    clearStatusByContext(ctx) {
      calls.push(['clearStatusByContext', ctx]);
    },
  };
}

function makeScheduler(sequence, adapter) {
  const scheduler = new Scheduler({
    maxWorkers: 1,
    startPermissionServer: false,
    getProfile: makeProfile,
    spawnWorkerFn({ onMessage, onExit }) {
      const worker = {
        pid: 4242,
        kill() {},
        send() {},
        on() {},
      };
      setImmediate(async () => {
        for (const step of sequence) {
          if (step.delay) await sleep(step.delay);
          if (step.msg) await onMessage(step.msg);
          if (step.exit) await onExit(step.exit.code, step.exit.signal);
        }
      });
      return { worker };
    },
  });
  scheduler.addAdapter('slack', adapter);
  return scheduler;
}

async function runTask(sequence, { warnLines, taskOverrides = {} } = {}) {
  const adapter = makeAdapter();
  const scheduler = makeScheduler(sequence, adapter);
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  await scheduler.submit({
    userText: 'test task',
    fileContent: '',
    imagePaths: [],
    threadTs: '111.222',
    channel: 'C1',
    userId: 'U1',
    platform: 'slack',
    ...taskOverrides,
    _completion: { resolve: resolveCompletion, reject: rejectCompletion },
  });
  try {
    await completion;
  } catch (err) {
    if (!warnLines) throw err;
  }
  await sleep(5);
  return adapter.calls;
}

function fallbackWarnings(calls) {
  return calls.filter((call) => (
    call[0] === 'cleanupIndicator'
    && call[4] === '处理过程中出错，请重试。'
  ));
}

test('turn_end alone marks responded=true (no fallback warning on subsequent exit)', async () => {
  const calls = await runTask([
    { msg: { type: 'turn_start' } },
    { msg: { type: 'cc_event', turnId: 'turn-1', eventType: 'text', payload: { type: 'text', text: 'delivered text' } } },
    { msg: { type: 'turn_end' } },
    { exit: { code: 0, signal: null } },
  ]);

  assert.equal(fallbackWarnings(calls).length, 0);
});

test('worker exit clears Slack status subscriber context after clearing thread status', async () => {
  const calls = await runTask([
    { msg: { type: 'turn_start' } },
    { exit: { code: 0, signal: null } },
  ], { warnLines: [] });

  const clearStatusIndex = calls.findIndex((call) => call[0] === 'setThreadStatus' && call[3] === '');
  const clearSubscriberIndex = calls.findIndex((call) => call[0] === 'clearStatusByContext');

  assert.notEqual(clearStatusIndex, -1);
  assert.notEqual(clearSubscriberIndex, -1);
  assert.ok(clearStatusIndex < clearSubscriberIndex);
  assert.deepEqual(calls[clearSubscriberIndex][1], { channel: 'C1', threadTs: '111.222' });
});

test('cc_event stream delivery suppresses fallback warning when IPC signals missing', async (t) => {
  const warnLines = [];
  t.mock.method(console, 'warn', (line) => warnLines.push(String(line)));

  const calls = await runTask([
    { msg: { type: 'turn_start' } },
    { msg: { type: 'cc_event', turnId: 'turn-stream', eventType: 'text', payload: { type: 'text', text: 'stream delivered' } } },
    { delay: 5 },
    { exit: { code: 0, signal: null } },
  ], { warnLines });

  assert.equal(fallbackWarnings(calls).length, 1);
  assert.equal(warnLines.some((line) => line.includes('suppressed user-facing warning')), false);
});

test('genuine crash (signal/non-zero exit, no delivery) still triggers warning', async () => {
  const calls = await runTask([
    { msg: { type: 'turn_start' } },
    { exit: { code: null, signal: 'SIGKILL' } },
  ], { warnLines: [] });

  assert.equal(fallbackWarnings(calls).length, 1);
});

test('non-success result sends cron failure receipt instead of auto-continue', async () => {
  const calls = await runTask([
    { msg: { type: 'turn_start' } },
    {
      msg: {
        type: 'result',
        text: '',
        exitOnly: true,
        stopReason: 'api_error',
        exitCode: 1,
        stderrSummary: 'API Error: 500 Internal server error',
        channelSemantics: 'silent',
      },
    },
    { exit: { code: 0, signal: null } },
  ], {
    taskOverrides: {
      threadTs: 'cron:skill-promotion-tick',
      deliveryThreadTs: null,
      channelSemantics: 'silent',
      cronName: 'skill-promotion-tick',
    },
  });

  const replies = calls.filter((call) => call[0] === 'sendReply');
  assert.equal(fallbackWarnings(calls).length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0][1], 'C1');
  assert.match(replies[0][3], /^⚠️ skill-promotion-tick \d{2}\/\d{2}｜失败：LLM｜API Error: 500 Internal server error$/);
});

test('tool_use exit result sends turn-limit notice instead of failure warning', async () => {
  const calls = await runTask([
    { msg: { type: 'turn_start' } },
    {
      msg: {
        type: 'result',
        text: '',
        exitOnly: true,
        stopReason: 'tool_use',
        exitCode: 1,
        stderrSummary: '',
        channelSemantics: 'reply',
      },
    },
    { exit: { code: 0, signal: null } },
  ], {
    taskOverrides: {
      maxTurns: 50,
    },
  });

  const replies = calls.filter((call) => call[0] === 'sendReply');
  assert.equal(fallbackWarnings(calls).length, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0][3], /^⏳ LLM 在工具调用中触达 turn 上限（50 turn）。任务未完成，可发「继续」让我从此处续做。$/);
});

test('empty silent successful turn_complete suppresses result auto-continue', async (t) => {
  const warnLines = [];
  t.mock.method(console, 'warn', (line) => warnLines.push(String(line)));

  const calls = await runTask([
    { msg: { type: 'turn_start' } },
    {
      msg: {
        type: 'turn_complete',
        text: '',
        toolCount: 0,
        stopReason: 'success',
        channelSemantics: 'silent',
      },
    },
    {
      msg: {
        type: 'result',
        text: '',
        exitOnly: true,
        stopReason: 'success',
        channelSemantics: 'silent',
      },
    },
    { exit: { code: 0, signal: null } },
  ], {
    taskOverrides: {
      threadTs: 'cron:empty-silent',
      deliveryThreadTs: null,
      channelSemantics: 'silent',
      deferDeliveryUntilResult: true,
    },
  });

  assert.equal(fallbackWarnings(calls).length, 0);
  assert.equal(warnLines.some((line) => line.includes('auto-continue')), false);
});

test('startup interrupted-run scan keeps only latest acked audit files', async () => {
  const profilesDir = mkdtempSync(join(tmpdir(), 'orb-interrupted-acked-'));
  const dataDir = join(profilesDir, 'test', 'data');
  mkdirSync(dataDir, { recursive: true });
  for (let i = 0; i < 25; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    writeFileSync(join(dataDir, `interrupted-runs.acked.2026-05-${day}T00-00-00-000Z.json`), '[]\n');
  }

  const scheduler = new Scheduler({
    startPermissionServer: false,
    getProfile: makeProfile,
  });
  await scheduler._notifyInterruptedRuns({ profilesDir });

  const remaining = readdirSync(dataDir)
    .filter((name) => name.startsWith('interrupted-runs.acked.'))
    .sort();
  assert.equal(remaining.length, 20);
  assert.equal(existsSync(join(dataDir, 'interrupted-runs.acked.2026-05-01T00-00-00-000Z.json')), false);
  assert.equal(remaining[0], 'interrupted-runs.acked.2026-05-06T00-00-00-000Z.json');
});
