import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Scheduler } from '../../src/scheduler.js';

function createScheduler(options = {}) {
  const deliveries = [];
  const scheduler = new Scheduler({
    getProfile: () => ({ name: 'karry' }),
    startPermissionServer: false,
    startExternalSessionListener: false,
    ...options,
  });
  scheduler.addAdapter('slack', {
    async deliver(intent, ctx) {
      deliveries.push({ intent, ctx });
      return { ts: `ts-${deliveries.length}` };
    },
  });
  return { scheduler, deliveries };
}

test('external session result posts card and injects active worker with launcher_result origin', async () => {
  const sent = [];
  const { scheduler, deliveries } = createScheduler();
  scheduler.activeWorkers.set('1778141504.110239', {
    worker: { send: (msg) => { sent.push(msg); return true; } },
    platform: 'slack',
    channel: 'C1',
    userId: 'U1',
    deliveryThreadTs: '1778141504.110239',
    channelSemantics: 'reply',
    pendingInjects: new Map(),
    task: { attemptId: 'attempt-parent', channelSemantics: 'reply' },
  });

  await scheduler._handleExternalSessionResult({
    type: 'external_session_result',
    channel: 'C1',
    thread_ts: '1778141504.110239',
    label: 'spec-smoke',
    rc: 0,
    took_seconds: 5,
    log_path: '/tmp/spec-smoke.log',
    text: '✅ codex 完成｜spec-smoke',
  });

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].intent.intent, 'launcher_result_card');
  assert.equal(deliveries[0].intent.text, '✅ codex 完成｜spec-smoke');
  assert.equal(deliveries[0].ctx.channel, 'postMessage');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'inject');
  assert.equal(sent[0].origin.kind, 'launcher_result');
  assert.equal(sent[0].origin.name, 'spec-smoke');
  assert.match(sent[0].userText, /rc=0 took=5s/);
});

test('external session result does not spawn worker when thread is inactive', async () => {
  const { scheduler, deliveries } = createScheduler({
    spawnWorkerFn: () => {
      throw new Error('must not spawn');
    },
  });

  await scheduler._handleExternalSessionResult({
    type: 'external_session_result',
    channel: 'C1',
    thread_ts: '1778141504.110239',
    label: 'spec-smoke',
    rc: 0,
    text: '✅ codex 完成｜spec-smoke',
  });

  assert.equal(deliveries.length, 1);
});

test('external session socket listens with user-only permissions and accepts json line', async () => {
  const dir = mkdtempSync('/tmp/orb-es-');
  const socketPath = join(dir, 'external-session.sock');
  const { scheduler, deliveries } = createScheduler({
    startExternalSessionListener: true,
    externalSessionSocketPath: socketPath,
  });

  try {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const poll = () => {
        try {
          if ((statSync(socketPath).mode & 0o777) === 0o600) resolve();
          else setTimeout(poll, 20);
        } catch (err) {
          if (Date.now() > deadline) reject(err);
          else setTimeout(poll, 20);
        }
      };
      poll();
    });
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);

    await new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath);
      client.on('error', reject);
      client.on('connect', () => {
        client.end(`${JSON.stringify({
          type: 'external_session_result',
          channel: 'C1',
          thread_ts: '1778141504.110239',
          label: 'socket-smoke',
          rc: 0,
          text: '✅ codex 完成｜socket-smoke',
        })}\n`);
      });
      client.on('close', resolve);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].intent.meta.externalSessionResult.label, 'socket-smoke');
  } finally {
    await new Promise((resolve) => scheduler._externalSessionServer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
