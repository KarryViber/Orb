import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSlackTextSubscriber } from '../src/adapters/slack.js';
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
    createTextSubscriber() {
      return createSlackTextSubscriber(this, { debounceMs: 0 });
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
