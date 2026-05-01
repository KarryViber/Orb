import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TurnDeliveryOrchestrator } from '../src/turn-delivery/orchestrator.js';
import { TurnDeliveryLedger } from '../src/turn-delivery/ledger.js';

function createAdapter({ stream = true, failAppend = false, platform = 'slack' } = {}) {
  const calls = [];
  let streamSeq = 0;
  let postSeq = 0;
  return {
    calls,
    platform,
    capabilities: { stream, edit: true, metadata: true },
    async deliver(intent, { channel, turnState }) {
      if (channel === 'stream') {
        if (intent.intent === 'task_progress.start') {
          streamSeq += 1;
          const streamId = `stream-${streamSeq}`;
          calls.push(['startStream', intent.channel, intent.threadTs, intent.meta.chunks || []]);
          return { streamId, ts: `${streamSeq}.000` };
        }
        if (intent.intent === 'assistant_text.delta') {
          calls.push(['appendStream', turnState.streamId, [{ type: 'markdown_text', text: intent.text }]]);
          if (failAppend) throw new Error('append failed');
          return { ts: turnState.streamMessageTs };
        }
        if (intent.intent === 'assistant_text.final') {
          calls.push(['stopStream', turnState.streamId, intent.text]);
          return { ts: turnState.streamMessageTs };
        }
        if (intent.intent === 'task_progress.append') {
          calls.push(['appendStream', intent.meta.streamId || turnState.streamId, intent.meta.chunks]);
          return { ts: turnState.streamMessageTs };
        }
        if (intent.intent === 'task_progress.stop') {
          calls.push(['stopStream', intent.meta.streamId || turnState.streamId, intent.meta.chunks]);
          return { ts: turnState.streamMessageTs };
        }
      }
      if (channel === 'postMessage') {
        postSeq += 1;
        calls.push(['sendReply', intent.channel, intent.threadTs, intent.text, intent.intent]);
        return { ts: `p-${postSeq}` };
      }
      if (channel === 'metadata') {
        calls.push(['metadata', intent.intent, intent.text]);
        return { ts: null };
      }
      return { ts: null };
    },
  };
}

function intent(overrides = {}) {
  return {
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    channel: 'C1',
    threadTs: '111.222',
    platform: 'slack',
    source: 'test',
    ...overrides,
  };
}

async function startStream(orchestrator, overrides = {}) {
  return orchestrator.emit(intent({
    intent: 'task_progress.start',
    text: 'start',
    meta: { chunks: [{ type: 'plan_update', title: 'Started' }] },
    ...overrides,
  }));
}

test('1053/1062 sample uses stream finalization without postMessage assistant duplicate', async () => {
  const adapter = createAdapter();
  const ledger = new TurnDeliveryLedger();
  const orchestrator = new TurnDeliveryOrchestrator({ adapter, ledger });
  orchestrator.beginTurn(intent());
  await startStream(orchestrator);

  for (let i = 0; i < 24; i += 1) {
    await orchestrator.emit(intent({
      intent: 'assistant_text.delta',
      text: 'x'.repeat(i === 23 ? 64 : 43),
      meta: { sequence: i },
      intentId: `delta-${i}`,
      source: 'subscriber.text',
    }));
  }
  await orchestrator.emit(intent({
    intent: 'assistant_text.final',
    text: `${'x'.repeat(1053)}${'y'.repeat(9)}`,
    source: 'scheduler.turn_complete',
  }));

  assert.equal(adapter.calls.filter((call) => call[0] === 'appendStream').length, 24);
  assert.equal(adapter.calls.filter((call) => call[0] === 'stopStream').length, 1);
  assert.equal(adapter.calls.filter((call) => call[0] === 'sendReply' && call[4] === 'assistant_text.final').length, 0);
  assert.equal(ledger.getRecordsForTurn('turn-1').some((record) => record.deliveryChannel === 'postMessage' && record.intent === 'assistant_text.final'), false);
});

test('short final without stream uses one postMessage', async () => {
  const adapter = createAdapter();
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn(intent());

  await orchestrator.emit(intent({ intent: 'assistant_text.final', text: 'short answer' }));

  assert.deepEqual(adapter.calls, [['sendReply', 'C1', '111.222', 'short answer', 'assistant_text.final']]);
});

test('cron silent records receipt and sends nothing', async () => {
  const adapter = createAdapter();
  const ledger = new TurnDeliveryLedger();
  const orchestrator = new TurnDeliveryOrchestrator({ adapter, ledger });
  orchestrator.beginTurn(intent({ channelSemantics: 'silent' }));

  const result = await orchestrator.emit(intent({
    intent: 'assistant_text.final',
    text: 'quiet',
    channelSemantics: 'silent',
  }));

  assert.equal(result.delivered, false);
  assert.deepEqual(adapter.calls, []);
  assert.equal(ledger.getRecordsForTurn('turn-1').at(-1).intent, 'receipt.silent_suppressed');
});

test('inject fresh attempt state delivers again in same thread', async () => {
  const adapter = createAdapter();
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn(intent({ turnId: 'turn-1', attemptId: 'attempt-1' }));
  await orchestrator.emit(intent({ turnId: 'turn-1', attemptId: 'attempt-1', intent: 'assistant_text.final', text: 'one' }));
  orchestrator.beginTurn(intent({ turnId: 'turn-2', attemptId: 'attempt-2' }));
  await orchestrator.emit(intent({ turnId: 'turn-2', attemptId: 'attempt-2', intent: 'assistant_text.final', text: 'two' }));

  assert.deepEqual(adapter.calls.map((call) => call[3]), ['one', 'two']);
});

test('same attempt replay is skipped by ledger state', async () => {
  const adapter = createAdapter();
  const ledger = new TurnDeliveryLedger();
  const first = new TurnDeliveryOrchestrator({ adapter, ledger });
  first.beginTurn(intent());
  await first.emit(intent({ intent: 'assistant_text.final', text: 'done' }));

  const second = new TurnDeliveryOrchestrator({ adapter, ledger });
  second.beginTurn(intent());
  const replay = await second.emit(intent({ intent: 'assistant_text.final', text: 'done' }));

  assert.equal(replay.delivered, false);
  assert.equal(replay.reason, 'replay-already-delivered');
  assert.equal(adapter.calls.filter((call) => call[0] === 'sendReply').length, 1);
});

test('stream failure falls back to final reply and emits continuation marker', async () => {
  const adapter = createAdapter({ failAppend: true });
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn(intent());
  await startStream(orchestrator);
  const delta = await orchestrator.emit(intent({
    intent: 'assistant_text.delta',
    text: 'partial',
    intentId: 'd-1',
    meta: { sequence: 1 },
  }));
  assert.equal(delta.delivered, false);

  await orchestrator.emit(intent({ intent: 'assistant_text.final', text: 'complete answer' }));

  const sends = adapter.calls.filter((call) => call[0] === 'sendReply');
  assert.deepEqual(sends.map((call) => [call[3], call[4]]), [
    ['complete answer', 'assistant_text.final'],
    ['stream interrupted, continuing here', 'control_plane.message'],
  ]);
});

test('wechat without stream delivers final once and ignores task progress externally', async () => {
  const adapter = createAdapter({ stream: false, platform: 'wechat' });
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn(intent({ platform: 'wechat' }));

  await startStream(orchestrator, { platform: 'wechat' });
  await orchestrator.emit(intent({ platform: 'wechat', intent: 'task_progress.append', text: 'tool', meta: { chunks: [{ type: 'task_update', title: 'tool' }], sequence: 1 } }));
  await orchestrator.emit(intent({ platform: 'wechat', intent: 'assistant_text.final', text: 'wechat answer' }));

  assert.deepEqual(adapter.calls, [['sendReply', 'C1', '111.222', 'wechat answer', 'assistant_text.final']]);
});

test('control plane message is independent from assistant stream', async () => {
  const adapter = createAdapter();
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn(intent());
  await startStream(orchestrator);
  await orchestrator.emit(intent({ intent: 'control_plane.message', text: 'approval' }));
  await orchestrator.emit(intent({ intent: 'assistant_text.delta', text: 'answer', intentId: 'd-1', meta: { sequence: 1 } }));
  await orchestrator.emit(intent({ intent: 'assistant_text.final', text: 'answer' }));

  assert.equal(adapter.calls.some((call) => call[0] === 'sendReply' && call[3] === 'approval'), true);
  assert.equal(adapter.calls.some((call) => call[0] === 'appendStream'), true);
});

test('metadata status does not create a message', async () => {
  const adapter = createAdapter();
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn(intent());
  await orchestrator.emit(intent({ intent: 'metadata.status', text: 'Working' }));
  await orchestrator.emit(intent({ intent: 'assistant_text.final', text: 'done' }));

  assert.deepEqual(adapter.calls.map((call) => call[0]), ['metadata', 'sendReply']);
});

test('duplicate final emit is skipped inside one turn', async () => {
  const adapter = createAdapter();
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn(intent());
  await orchestrator.emit(intent({ intent: 'assistant_text.final', text: 'same' }));
  const second = await orchestrator.emit(intent({ intent: 'assistant_text.final', text: 'same' }));

  assert.equal(second.delivered, false);
  assert.equal(second.reason, 'already-delivered');
  assert.equal(adapter.calls.filter((call) => call[0] === 'sendReply').length, 1);
});

test('delta without stream is held until final postMessage', async () => {
  const adapter = createAdapter();
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn(intent());

  const delta = await orchestrator.emit(intent({
    intent: 'assistant_text.delta',
    text: 'partial',
    intentId: 'd-1',
    meta: { sequence: 1 },
  }));
  await orchestrator.emit(intent({ intent: 'assistant_text.final', text: 'complete' }));

  assert.equal(delta.delivered, false);
  assert.deepEqual(adapter.calls, [['sendReply', 'C1', '111.222', 'complete', 'assistant_text.final']]);
});

test('scheduler source routes adapter message APIs through orchestrator', () => {
  const source = readFileSync(new URL('../src/scheduler.js', import.meta.url), 'utf8');
  assert.equal(/adapter\.sendReply|adapter\.appendStream|adapter\.startStream/.test(source), false);
});

test('Slack subscriber source does not call adapter message APIs directly', () => {
  const source = readFileSync(new URL('../src/adapters/slack.js', import.meta.url), 'utf8');
  assert.equal(/adapter\.sendReply|adapter\.appendStream|adapter\.startStream/.test(source), false);
});
