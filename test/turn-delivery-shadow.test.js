import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Scheduler } from '../src/scheduler.js';
import {
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TEXT_FINAL,
  METADATA_STATUS,
  RECEIPT_SILENT_SUPPRESSED,
  createTurnDeliveryRecord,
} from '../src/turn-delivery/intents.js';
import { TurnDeliveryShadowRecorder } from '../src/turn-delivery/shadow-recorder.js';

function record(overrides) {
  return createTurnDeliveryRecord({
    turnId: '111.222#attempt-1',
    attemptId: 'attempt-1',
    channel: 'C1',
    threadTs: '111.222',
    platform: 'slack',
    source: 'test',
    ...overrides,
  });
}

function makeText(len, char = 'a') {
  return char.repeat(len);
}

test('shadow detects stream already carries final text from audit sample shape', () => {
  const recorder = new TurnDeliveryShadowRecorder();
  const streamText = makeText(1053);
  const finalText = `${makeText(1053)}${makeText(9, 'b')}`;

  recorder.observe(record({
    intent: ASSISTANT_TEXT_DELTA,
    deliveryChannel: 'stream',
    text: streamText,
    source: 'subscriber.text',
  }));
  recorder.observe(record({
    intent: ASSISTANT_TEXT_FINAL,
    deliveryChannel: 'postMessage',
    text: finalText,
    source: 'scheduler.turn_complete',
  }));

  const records = recorder.getRecordsForTurn('111.222#attempt-1');
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((item) => [item.intent, item.deliveryChannel, item.textLen]),
    [
      [ASSISTANT_TEXT_DELTA, 'stream', 1053],
      [ASSISTANT_TEXT_FINAL, 'postMessage', 1062],
    ],
  );
  assert.deepEqual(recorder.computeShadowDecision('111.222#attempt-1'), {
    wouldSend: false,
    channel: null,
    reason: 'stream-already-carries-final',
  });

  const result = recorder.assertConsistency('111.222#attempt-1', {
    actualSendReply: true,
    channel: 'C1',
    threadTs: '111.222',
    platform: 'slack',
  });
  assert.equal(result.consistent, false);
  assert.equal(
    recorder.getRecordsForTurn('111.222#attempt-1').at(-1).meta.kind,
    'shadow-consistency-diff',
  );
});

test('shadow allows final postMessage when subscriber emitted no assistant text', () => {
  const recorder = new TurnDeliveryShadowRecorder();
  recorder.observe(record({
    intent: ASSISTANT_TEXT_FINAL,
    deliveryChannel: 'postMessage',
    text: 'final answer',
    source: 'scheduler.turn_complete',
  }));

  assert.deepEqual(recorder.computeShadowDecision('111.222#attempt-1'), {
    wouldSend: true,
    channel: 'postMessage',
    reason: 'final-postMessage',
  });
});

test('shadow suppresses cron silent semantics', () => {
  const recorder = new TurnDeliveryShadowRecorder();
  recorder.observe(record({
    intent: RECEIPT_SILENT_SUPPRESSED,
    deliveryChannel: 'silent',
    text: '[SILENT] done',
    source: 'scheduler.turn_complete',
    meta: { channelSemantics: 'silent' },
  }));

  assert.deepEqual(recorder.computeShadowDecision('111.222#attempt-1'), {
    wouldSend: false,
    channel: null,
    reason: 'silent-semantics',
  });
});

test('wechat shadow observes postMessage without reporting Slack stream diffs', () => {
  const recorder = new TurnDeliveryShadowRecorder();
  recorder.observe(record({
    platform: 'wechat',
    intent: ASSISTANT_TEXT_FINAL,
    deliveryChannel: 'postMessage',
    text: 'wechat final',
    source: 'scheduler.turn_complete',
  }));

  assert.deepEqual(recorder.computeShadowDecision('111.222#attempt-1'), {
    wouldSend: true,
    channel: 'postMessage',
    reason: 'wechat-sendReply-only',
  });
  const result = recorder.assertConsistency('111.222#attempt-1', {
    actualSendReply: true,
    platform: 'wechat',
  });
  assert.equal(result.consistent, true);
  assert.equal(
    recorder.getRecordsForTurn('111.222#attempt-1').some((item) => item.intent === METADATA_STATUS),
    false,
  );
});

test('shadow requires final postMessage when stream only partially covers final text', () => {
  const recorder = new TurnDeliveryShadowRecorder();
  recorder.observe(record({
    intent: ASSISTANT_TEXT_DELTA,
    deliveryChannel: 'stream',
    text: makeText(100),
    source: 'subscriber.text',
  }));
  recorder.observe(record({
    intent: ASSISTANT_TEXT_FINAL,
    deliveryChannel: 'postMessage',
    text: makeText(1000),
    source: 'scheduler.turn_complete',
  }));

  assert.deepEqual(recorder.computeShadowDecision('111.222#attempt-1'), {
    wouldSend: true,
    channel: 'postMessage',
    reason: 'stream-partial-coverage',
  });
  const result = recorder.assertConsistency('111.222#attempt-1', {
    actualSendReply: true,
    platform: 'slack',
  });
  assert.equal(result.consistent, true);
});

test('shadow observe failures do not block scheduler sendReply', async () => {
  const calls = [];
  const profile = {
    name: 'test',
    workspaceDir: mkdtempSync(join(tmpdir(), 'orb-shadow-workspace-')),
    scriptsDir: mkdtempSync(join(tmpdir(), 'orb-shadow-scripts-')),
    dataDir: mkdtempSync(join(tmpdir(), 'orb-shadow-data-')),
  };
  const adapter = {
    buildPayloads(text) {
      return [{ text }];
    },
    async sendReply(channel, threadTs, text, extra = {}) {
      calls.push(['sendReply', channel, threadTs, text, extra]);
    },
    async cleanupIndicator(channel, threadTs, typingSet, errorMsg) {
      calls.push(['cleanupIndicator', channel, threadTs, typingSet, errorMsg]);
    },
    async setThreadStatus() {},
  };
  const scheduler = new Scheduler({
    maxWorkers: 1,
    startPermissionServer: false,
    getProfile: () => profile,
    spawnWorkerFn({ onMessage, onExit }) {
      const worker = { pid: 1234, kill() {}, send() {}, on() {} };
      setImmediate(async () => {
        await onMessage({ type: 'turn_start', turnId: '111.222#attempt-1' });
        await onMessage({ type: 'turn_complete', turnId: '111.222#attempt-1', text: 'still delivered', stopReason: 'success' });
        await onExit(0, null);
      });
      return { worker };
    },
  });
  scheduler._getTurnDeliveryShadowRecorder = () => ({
    observe() {
      throw new Error('shadow boom');
    },
    assertConsistency() {
      throw new Error('shadow assert boom');
    },
  });
  scheduler.addAdapter('slack', adapter);

  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  await scheduler.submit({
    userText: 'test',
    fileContent: '',
    imagePaths: [],
    threadTs: '111.222',
    channel: 'C1',
    userId: 'U1',
    platform: 'slack',
    _completion: { resolve: resolveCompletion, reject: rejectCompletion },
  });
  await completion;

  assert.deepEqual(calls, [
    ['sendReply', 'C1', '111.222', 'still delivered', {}],
  ]);
});
