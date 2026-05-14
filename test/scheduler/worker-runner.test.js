import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from '../../src/scheduler.js';

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'orb-worker-runner-test-'));
const TEST_PROFILE_DIR = mkdtempSync(join(tmpdir(), 'orb-worker-runner-profile-'));
const profile = {
  name: 'test-profile',
  scriptsDir: join(TEST_PROFILE_DIR, 'scripts'),
  workspaceDir: join(TEST_PROFILE_DIR, 'workspace'),
  dataDir: TEST_DATA_DIR,
};

function createAdapter() {
  const deliveries = [];
  return {
    platform: 'slack',
    deliveries,
    async deliver(intent) {
      deliveries.push(intent);
      return { ts: `ts-${deliveries.length}` };
    },
    async cleanupIndicator() {},
    async setThreadStatus() {},
    clearStatusByContext() {},
  };
}

function createFakeWorker() {
  const worker = new EventEmitter();
  worker.pid = 4242;
  worker.killCalls = [];
  worker.kill = (signal) => {
    worker.killCalls.push(signal);
    worker.emit('exit', null, signal);
  };
  worker.send = () => true;
  return worker;
}

function createScheduler(script) {
  const calls = [];
  const adapter = createAdapter();
  const scheduler = new Scheduler({
    getProfile: () => profile,
    startPermissionServer: false,
    spawnWorkerFn: (opts) => {
      const worker = createFakeWorker();
      calls.push({ opts, worker });
      setImmediate(() => script(opts, worker, calls.length));
      return { worker };
    },
  });
  scheduler.setAdapter(adapter);
  return { scheduler, adapter, calls };
}

test('fake worker smoke preserves cc_event event bus sequence', async () => {
  const { scheduler, calls } = createScheduler(async (opts) => {
    await opts.onMessage({ type: 'turn_start', turnId: 'turn-1', attemptId: 'attempt-1' });
    await opts.onMessage({ type: 'cc_event', turnId: 'turn-1', eventType: 'tool_use', payload: { name: 'Read', input: {} } });
    await opts.onMessage({ type: 'cc_event', turnId: 'turn-1', eventType: 'tool_result', payload: { tool_use_id: 'tool-1', content: 'ok' } });
    await opts.onMessage({ type: 'turn_complete', text: 'done', toolCount: 1, lastTool: 'Read', stopReason: 'success', channelSemantics: 'reply' });
    await opts.onMessage({ type: 'result', text: '', channelSemantics: 'reply', stopReason: 'success', exitOnly: true, toolCount: 1, lastTool: 'Read', exitCode: 0 });
    await opts.onExit(0, null);
  });
  const events = [];
  scheduler.eventBus.subscribe((msg) => {
    if (msg.type === 'cc_event') events.push(msg.eventType);
  });

  await scheduler.executeTask({
    userText: 'hello',
    threadTs: 'thread-1',
    channel: 'C1',
    userId: 'U1',
    platform: 'slack',
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(events, ['tool_use', 'tool_result', 'turn_abort']);
});

test('stopReason smoke sends failure receipt for api_error and suppresses silent success', async () => {
  const { scheduler, adapter } = createScheduler(async (opts, _worker, index) => {
    const stopReason = index === 1 ? 'api_error' : 'success';
    const channelSemantics = index === 1 ? 'reply' : 'silent';
    await opts.onMessage({ type: 'turn_start', turnId: `turn-${index}`, attemptId: `attempt-${index}` });
    if (index === 2) {
      await opts.onMessage({ type: 'turn_complete', text: 'done', toolCount: 0, lastTool: null, stopReason, channelSemantics });
    }
    await opts.onMessage({ type: 'result', text: '', channelSemantics, stopReason, exitOnly: true, toolCount: 0, exitCode: index === 1 ? 1 : 0, stderrSummary: index === 1 ? 'API Error: overloaded' : '' });
    await opts.onExit(index === 1 ? 1 : 0, null);
  });

  await scheduler.executeTask({ userText: 'fail', threadTs: 'thread-fail', channel: 'C1', userId: 'U1', platform: 'slack' });
  await scheduler.executeTask({ userText: 'ok', threadTs: 'thread-ok', channel: 'C1', userId: 'U1', platform: 'slack', channelSemantics: 'silent' });

  assert.equal(adapter.deliveries.length, 1);
  assert.equal(adapter.deliveries[0].source, 'scheduler.result_failure');
  assert.match(adapter.deliveries[0].text, /API Error/);
});

test('inject_failed smoke respawns through queued replay path', async () => {
  const { scheduler, calls } = createScheduler(async (opts, _worker, index) => {
    if (index === 1) {
      await opts.onMessage({ type: 'inject_failed', injectId: 'inject-1', userText: 'replay me' });
      await opts.onExit(0, null);
      return;
    }
    await opts.onMessage({ type: 'turn_start', turnId: 'turn-replay', attemptId: 'attempt-replay' });
    await opts.onMessage({ type: 'turn_complete', text: 'done', channelSemantics: 'reply', stopReason: 'success', toolCount: 0, lastTool: null });
    await opts.onMessage({ type: 'result', text: '', channelSemantics: 'reply', stopReason: 'success', exitOnly: true, toolCount: 0, exitCode: 0 });
    await opts.onExit(0, null);
  });

  await scheduler.executeTask({
    userText: 'first',
    threadTs: 'thread-inject',
    channel: 'C1',
    userId: 'U1',
    platform: 'slack',
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.task.userText, 'replay me');
});

test('turn_complete does not deliver summary-only receipt when final text is empty', async () => {
  const { scheduler, adapter } = createScheduler(async (opts) => {
    await opts.onMessage({ type: 'turn_start', turnId: 'turn-receipt', attemptId: 'attempt-receipt' });
    await opts.onMessage({
      type: 'turn_complete',
      text: '',
      channelSemantics: 'reply',
      stopReason: 'success',
      toolCount: 1,
      lastTool: 'Bash',
      dailyNotesSummary: { count: 1 },
    });
    await opts.onMessage({ type: 'result', text: '', channelSemantics: 'reply', stopReason: 'success', exitOnly: true, toolCount: 1, exitCode: 0 });
    await opts.onExit(0, null);
  });

  await scheduler.executeTask({
    userText: 'append note',
    threadTs: 'thread-receipt',
    channel: 'C1',
    userId: 'U1',
    platform: 'slack',
  });

  assert.equal(adapter.deliveries.length, 0);
});
