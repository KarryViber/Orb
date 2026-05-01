import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  dispatchBlockActionHandler,
  getHandlerCommand,
  rememberBlockActionMessage,
  resolveHandlerScript,
} from '../src/adapters/slack-block-actions.js';

function makeBody(overrides = {}) {
  return {
    channel: { id: 'C1' },
    container: { channel_id: 'C1', message_ts: '111.222' },
    message: {
      ts: '111.222',
      thread_ts: '111.000',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'Original' } },
        { type: 'actions', elements: [] },
      ],
    },
    user: { id: 'U1' },
    response_url: 'https://hooks.slack.test/response',
    ...overrides,
  };
}

function makeSlackRecorder() {
  const updates = [];
  return {
    updates,
    slack: {
      chat: {
        async update(payload) {
          updates.push(payload);
          return { ok: true, ts: payload.ts };
        },
      },
    },
  };
}

function fakeChild(stdinWrites, pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new EventEmitter();
  child.stdin.write = (value) => stdinWrites.push(value);
  child.stdin.end = () => {};
  child.unref = () => {};
  return child;
}

test('block action rejects invalid action_id and writes error back to card', async () => {
  const { slack, updates } = makeSlackRecorder();
  let spawned = false;

  await dispatchBlockActionHandler({
    body: makeBody(),
    action: { action_id: '../bad', value: 'v1' },
    actionId: '../bad',
    slack,
    getProfilePaths: () => ({ name: 'test', scriptsDir: '/tmp/missing' }),
    resolveLedger: () => null,
    inFlight: new Set(),
    spawnImpl: () => { spawned = true; },
  });

  assert.equal(spawned, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].channel, 'C1');
  assert.match(updates[0].text, /未注册 handler/);
  assert.match(updates[0].text, /bad/);
});

test('resolveHandlerScript finds supported handler extension in profile handlers dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'orb-handler-path-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(join(scriptsDir, 'handlers'), { recursive: true });
  const handlerPath = join(scriptsDir, 'handlers', 'seed_water.py');
  writeFileSync(handlerPath, 'print("ok")\n');

  assert.equal(resolveHandlerScript({ scriptsDir }, 'seed_water'), handlerPath);
  assert.deepEqual(getHandlerCommand(handlerPath), { command: 'python3', args: [handlerPath] });
});

test('block action spawns handler with stdin context and logs pid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orb-handler-spawn-'));
  const scriptsDir = join(root, 'scripts');
  const logDir = join(root, 'logs');
  const pidLog = join(logDir, 'pids.log');
  mkdirSync(join(scriptsDir, 'handlers'), { recursive: true });
  const handlerPath = join(scriptsDir, 'handlers', 'seed_water.py');
  writeFileSync(handlerPath, 'print("ok")\n');
  const { slack, updates } = makeSlackRecorder();
  const stdinWrites = [];
  const spawnCalls = [];

  await dispatchBlockActionHandler({
    body: makeBody(),
    action: { action_id: 'seed-water', value: 'seed-1' },
    actionId: 'seed-water',
    slack,
    getProfilePaths: () => ({ name: 'test', scriptsDir }),
    resolveLedger: () => null,
    inFlight: new Set(),
    logDir,
    pidLog,
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return fakeChild(stdinWrites);
    },
  });

  assert.equal(updates.length, 1);
  assert.match(updates[0].text, /处理中/);
  assert.equal(spawnCalls[0].command, 'python3');
  assert.deepEqual(spawnCalls[0].args, [handlerPath]);
  assert.equal(spawnCalls[0].options.cwd, scriptsDir);
  const context = JSON.parse(stdinWrites[0]);
  assert.equal(context.action_id, 'seed_water');
  assert.equal(context.value, 'seed-1');
  assert.equal(context.channel, 'C1');
  assert.equal(context.thread_ts, '111.000');
  assert.match(readFileSync(pidLog, 'utf8'), /pid=4242 profile=test action_id=seed_water/);
});

test('block action spawn failure releases dedup and writes launch error back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orb-handler-fail-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(join(scriptsDir, 'handlers'), { recursive: true });
  writeFileSync(join(scriptsDir, 'handlers', 'seed_water.py'), 'print("ok")\n');
  const { slack, updates } = makeSlackRecorder();
  const inFlight = new Set();

  await dispatchBlockActionHandler({
    body: makeBody(),
    action: { action_id: 'seed_water', value: 'seed-1' },
    actionId: 'seed_water',
    slack,
    getProfilePaths: () => ({ name: 'test', scriptsDir }),
    resolveLedger: () => null,
    inFlight,
    logDir: join(root, 'logs'),
    pidLog: join(root, 'logs', 'pids.log'),
    spawnImpl() {
      throw new Error('spawn blocked');
    },
  });

  assert.equal(inFlight.has('111.222'), false);
  assert.equal(updates.length, 2);
  assert.match(updates[1].text, /handler 启动失败/);
});

test('block action handler timeout kills child, releases dedup, and updates card', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orb-handler-timeout-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(join(scriptsDir, 'handlers'), { recursive: true });
  writeFileSync(join(scriptsDir, 'handlers', 'seed_water.py'), 'print("ok")\n');
  const { slack, updates } = makeSlackRecorder();
  const inFlight = new Set();
  const killed = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    killed.push([pid, signal]);
    return true;
  });

  await dispatchBlockActionHandler({
    body: makeBody(),
    action: { action_id: 'seed_water', value: 'seed-1' },
    actionId: 'seed_water',
    slack,
    getProfilePaths: () => ({ name: 'test', scriptsDir }),
    resolveLedger: () => null,
    inFlight,
    logDir: join(root, 'logs'),
    pidLog: join(root, 'logs', 'pids.log'),
    handlerTimeoutMs: 5,
    spawnImpl() {
      return fakeChild([], 999999);
    },
  });

  assert.equal(inFlight.has('111.222'), true);
  await delay(25);
  assert.deepEqual(killed[0], [999999, 'SIGTERM']);
  assert.equal(inFlight.has('111.222'), false);
  assert.equal(updates.length, 2);
  assert.match(updates[1].text, /handler 超时（5min）已强制终止/);
  assert.match(updates[1].text, /seed_water/);
});

test('block action dedup entry expires after ttl', async () => {
  const inFlight = new Set();
  rememberBlockActionMessage(inFlight, '111.222', 5);
  assert.equal(inFlight.has('111.222'), true);
  await delay(20);
  assert.equal(inFlight.has('111.222'), false);
});
