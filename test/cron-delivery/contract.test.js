import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchCronDelivery,
  parseCronOutput,
  resolveDeliveryMode,
} from '../../src/cron-delivery.js';
import { CronScheduler } from '../../src/cron.js';
import { PlatformAdapter } from '../../src/adapters/interface.js';
import { SlackAdapter } from '../../src/adapters/slack.js';
import { WeChatAdapter } from '../../src/adapters/wechat.js';

function job(mode, overrides = {}) {
  return {
    id: `job-${mode}`,
    name: `Job ${mode}`,
    prompt: 'write protocol',
    schedule: { display: 'daily' },
    deliver: {
      platform: 'slack',
      channel: 'C123',
      mode,
      category: mode === 'evolution_state' ? 'routine_health' : undefined,
      onFailDM: 'D123',
    },
    ...overrides,
  };
}

function createMockAdapter() {
  const calls = [];
  return {
    calls,
    async sendReply(channel, threadTs, text, extra = {}) {
      calls.push({ channel, threadTs, text, extra });
      return { ok: true, ts: calls.length === 1 ? '111.222' : undefined };
    },
  };
}

class FallbackAdapter extends PlatformAdapter {
  constructor() {
    super();
    this.calls = [];
  }

  async sendReply(channel, threadTs, text, extra = {}) {
    this.calls.push({ channel, threadTs, text, extra });
    return { ok: true, ts: this.calls.length === 1 ? '111.222' : undefined };
  }
}

test('cron delivery dry-run smoke covers direct mode', async () => {
  const result = await dispatchCronDelivery({
    job: job('direct'),
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(job('direct'), 'D123'),
    output: parseCronOutput({ text: '{"main":"hello","thread_md":"detail","status":"ok"}', cronId: 'job-direct' }),
    dryRun: true,
  });

  assert.equal(result.mode, 'direct');
  assert.equal(result.delivered, true);
});

test('dispatchCronDelivery direct mode passes native Block Kit through to adapter sendReply extra.blocks', async () => {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'native block' } }];
  const result = await dispatchCronDelivery({
    job: job('direct'),
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(job('direct'), 'D123'),
    output: { status: 'ok', main: 'native', blocks },
    dryRun: true,
  });

  assert.equal(result.blocks, true);
  assert.equal(result.attachments, false);
});

test('dispatchCronDelivery direct mode keeps color attachment-shape blocks as Slack attachments', async () => {
  const result = await dispatchCronDelivery({
    job: job('direct'),
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(job('direct'), 'D123'),
    output: {
      status: 'ok',
      main: 'legacy',
      blocks: [{ color: '#5865F2', header: 'h', body: 'b' }],
    },
    dryRun: true,
  });

  assert.equal(result.blocks, false);
  assert.equal(result.attachments, true);
});

test('dispatchCronDelivery direct mode converts no-color attachment-shape blocks to native blocks', async () => {
  const result = await dispatchCronDelivery({
    job: job('direct'),
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(job('direct'), 'D123'),
    output: {
      status: 'ok',
      main: 'legacy',
      blocks: [{ header: 'h', body: 'b' }],
    },
    dryRun: true,
  });

  assert.equal(result.blocks, true);
  assert.equal(result.attachments, false);
});

test('dispatchCronDelivery direct mode mixes native and attachment-shape correctly', async () => {
  const result = await dispatchCronDelivery({
    job: job('direct'),
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(job('direct'), 'D123'),
    output: {
      status: 'ok',
      main: 'mixed',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'native block' } },
        { color: '#5865F2', header: 'h', body: 'b' },
      ],
    },
    dryRun: true,
  });

  assert.equal(result.blocks, true);
  assert.equal(result.attachments, true);
});

test('parseCronOutput rejects malformed block items with shape error', () => {
  assert.throws(
    () => parseCronOutput({ text: '{"status":"ok","blocks":[{"foo":"bar"}]}', cronId: 'bad-block' }),
    /invalid blocks shape \(turn_complete\.text\): item\[0\].*keys=foo/,
  );
});

test('cron delivery direct mode sends color attachment-shape blocks as Slack attachments', async () => {
  const adapter = createMockAdapter();
  const j = job('direct');

  await dispatchCronDelivery({
    job: j,
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(j, 'D123'),
    output: {
      status: 'ok',
      main: 'X',
      blocks: [{ color: '#5865F2', header: 'h', body: 'b' }],
    },
    adapter,
  });

  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[1].extra.attachments[0].color, '#5865F2');
  assert.equal(adapter.calls[1].extra.attachments[0].blocks[0].type, 'section');
  assert.deepEqual(adapter.calls[1].extra.attachments[0].blocks[0].text, { type: 'mrkdwn', text: '*h*' });
  assert.deepEqual(adapter.calls[1].extra.attachments[0].blocks[1].text, { type: 'mrkdwn', text: 'b' });
});

test('cron delivery direct mode sends no-color attachment-shape blocks as native thread blocks', async () => {
  const adapter = createMockAdapter();
  const j = job('direct');

  await dispatchCronDelivery({
    job: j,
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(j, 'D123'),
    output: {
      status: 'ok',
      main: 'X',
      blocks: [
        { header: 'h1', body: 'b1' },
        { header: 'h2', body: 'b2' },
      ],
    },
    adapter,
  });

  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[1].text, ' ');
  assert.equal(adapter.calls[1].extra.attachments, undefined);
  assert.deepEqual(adapter.calls[1].extra.blocks, [
    { type: 'section', text: { type: 'mrkdwn', text: '*h1*' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'b1' } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*h2*' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'b2' } },
  ]);
});

test('cron delivery direct mode sends blocks as thread reply only', async () => {
  const adapter = createMockAdapter();
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'block text' } }];
  const j = job('direct');

  const result = await dispatchCronDelivery({
    job: j,
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(j, 'D123'),
    output: {
      status: 'ok',
      main: 'X',
      thread_md: 'detail',
      blocks,
    },
    adapter,
  });

  assert.equal(result.mode, 'direct');
  assert.equal(result.ts, '111.222');
  assert.deepEqual(adapter.calls, [
    { channel: 'C123', threadTs: undefined, text: 'X', extra: {} },
    { channel: 'C123', threadTs: '111.222', text: 'detail', extra: {} },
    { channel: 'C123', threadTs: '111.222', text: ' ', extra: { blocks } },
  ]);
});

test('cron delivery direct mode delegates once to adapter deliverCronOutput when implemented', async () => {
  const calls = [];
  const adapter = {
    async deliverCronOutput(payload) {
      calls.push(payload);
      return { ts: '999.000', deliveredCount: 1 };
    },
  };
  const j = job('direct', { deliver: { ...job('direct').deliver, platform: 'wechat', threadTs: 'thread-1' } });
  const output = {
    status: 'ok',
    main: 'main',
    thread_md: 'detail',
    blocks: [{ header: 'h', body: 'b' }],
  };

  const result = await dispatchCronDelivery({
    job: j,
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(j, 'D123'),
    output,
    adapter,
  });

  assert.equal(result.ts, '999.000');
  assert.equal(result.deliveredCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'C123');
  assert.equal(calls[0].threadTs, 'thread-1');
  assert.equal(calls[0].output, output);
  assert.equal(calls[0].deliveryConfig.platform, 'wechat');
});

test('cron delivery direct mode falls back when adapter only inherits optional cron method', async () => {
  const adapter = new FallbackAdapter();
  const j = job('direct');

  await dispatchCronDelivery({
    job: j,
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(j, 'D123'),
    output: { status: 'ok', main: 'main', thread_md: 'detail' },
    adapter,
  });

  assert.deepEqual(adapter.calls, [
    { channel: 'C123', threadTs: undefined, text: 'main', extra: {} },
    { channel: 'C123', threadTs: '111.222', text: 'detail', extra: {} },
  ]);
});

test('SlackAdapter deliverCronOutput preserves three-part direct delivery shape', async () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  const calls = [];
  adapter.sendReply = async (channel, threadTs, text, extra = {}) => {
    calls.push({ channel, threadTs, text, extra });
    return { ok: true, ts: calls.length === 1 ? '111.222' : undefined };
  };

  const result = await adapter.deliverCronOutput({
    channel: 'C123',
    threadTs: null,
    output: {
      status: 'ok',
      main: 'main',
      thread_md: 'detail',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'block text' } }],
    },
    deliveryConfig: { mode: 'direct', platform: 'slack', channel: 'C123' },
  });

  assert.equal(result.ts, '111.222');
  assert.equal(result.deliveredCount, 3);
  assert.deepEqual(calls, [
    { channel: 'C123', threadTs: undefined, text: 'main', extra: {} },
    { channel: 'C123', threadTs: '111.222', text: 'detail', extra: {} },
    {
      channel: 'C123',
      threadTs: '111.222',
      text: ' ',
      extra: { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'block text' } }] },
    },
  ]);
});

test('WeChatAdapter deliverCronOutput merges main thread and block text into one bubble', async () => {
  const adapter = new WeChatAdapter({ accountId: 'test', token: 'token' });
  const calls = [];
  adapter.sendReply = async (channel, threadTs, text, extra = {}) => {
    calls.push({ channel, threadTs, text, extra });
    return { ts: 'wx-1' };
  };

  const result = await adapter.deliverCronOutput({
    channel: 'wx-user',
    threadTs: null,
    output: {
      status: 'ok',
      main: '# 主标题',
      thread_md: 'thread **detail**',
      blocks: [{ header: '块标题', body: '[链接](https://example.com)' }],
    },
    deliveryConfig: { mode: 'direct', platform: 'wechat', channel: 'wx-user' },
  });

  assert.equal(result.ts, 'wx-1');
  assert.equal(result.deliveredCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'wx-user');
  assert.equal(calls[0].threadTs, 'wx-user');
  assert.match(calls[0].text, /【主标题】/);
  assert.match(calls[0].text, /thread \*\*detail\*\*/);
  assert.match(calls[0].text, /———/);
  assert.match(calls[0].text, /块标题/);
  assert.match(calls[0].text, /链接 \(https:\/\/example\.com\)/);
});

test('cron delivery dry-run smoke covers evolution_state mode', async () => {
  const j = job('evolution_state');
  const result = await dispatchCronDelivery({
    job: j,
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(j, 'D123'),
    output: parseCronOutput({ text: '{"main":"state title","blocks":[{"type":"section"}],"status":"ok"}', cronId: j.id }),
    dryRun: true,
  });

  assert.equal(result.mode, 'evolution_state');
  assert.equal(result.content, 'blocks');
});

test('cron delivery dry-run smoke covers dm_only mode', async () => {
  const j = job('dm_only');
  const result = await dispatchCronDelivery({
    job: j,
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(j, 'D123'),
    output: parseCronOutput({ text: '{"main":"dm text","status":"ok"}', cronId: j.id }),
    dryRun: true,
  });

  assert.equal(result.mode, 'dm_only');
  assert.equal(result.channel, 'D123');
});

test('cron delivery dry-run smoke covers silent mode', async () => {
  const j = job('silent');
  const result = await dispatchCronDelivery({
    job: j,
    paths: { scriptsDir: '/tmp' },
    delivery: resolveDeliveryMode(j, 'D123'),
    output: parseCronOutput({ text: '[SILENT]', cronId: j.id }),
    dryRun: true,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'silent-mode');
});

test('cron delivery reads file protocol when turn text has no JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orb-cron-output-'));
  writeFileSync(join(dir, 'cron-output-file-job.json'), '{"main":"from file","status":"ok"}\n', 'utf-8');

  const output = parseCronOutput({ text: 'done', cronId: 'file-job', tmpDir: dir });

  assert.equal(output.protocol.endsWith('cron-output-file-job.json'), true);
  assert.equal(output.main, 'from file');
});

test('cron delivery treats literal silent as skip when no file protocol exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orb-cron-output-'));

  const output = parseCronOutput({ text: '[SILENT]', cronId: 'silent-job', tmpDir: dir });

  assert.equal(output.protocol, 'silent');
  assert.equal(output.status, 'skip');
});

test('cron delivery reads file protocol when literal silent is paired with tmp output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orb-cron-output-'));
  writeFileSync(
    join(dir, 'cron-output-silent-file-job.json'),
    JSON.stringify({
      main: 'from tmp',
      status: 'ok',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'block text' } }],
    }),
    'utf-8',
  );

  const output = parseCronOutput({ text: '[SILENT]', cronId: 'silent-file-job', tmpDir: dir });

  assert.equal(output.protocol.endsWith('cron-output-silent-file-job.json'), true);
  assert.equal(output.status, 'ok');
  assert.equal(output.main, 'from tmp');
  assert.deepEqual(output.blocks, [{ type: 'section', text: { type: 'mrkdwn', text: 'block text' } }]);
});

test('cron delivery keeps stdout JSON protocol ahead of tmp output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orb-cron-output-'));
  writeFileSync(join(dir, 'cron-output-json-priority-job.json'), '{"main":"from file","status":"ok"}', 'utf-8');

  const output = parseCronOutput({
    text: 'progress\n{"main":"from stdout","status":"ok"}',
    cronId: 'json-priority-job',
    tmpDir: dir,
  });

  assert.equal(output.protocol, 'turn_complete.text');
  assert.equal(output.main, 'from stdout');
});

test('cron delivery reads file protocol when multiline stdout ends with literal silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orb-cron-output-'));
  writeFileSync(join(dir, 'cron-output-multiline-silent-job.json'), '{"main":"from multiline file","status":"ok"}', 'utf-8');

  const output = parseCronOutput({
    text: 'preparing output\nwrote tmp file\n[SILENT]',
    cronId: 'multiline-silent-job',
    tmpDir: dir,
  });

  assert.equal(output.protocol.endsWith('cron-output-multiline-silent-job.json'), true);
  assert.equal(output.main, 'from multiline file');
});

test('cron delivery parse failure persists failed delivery status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orb-cron-delivery-fail-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'cron-jobs.json'), JSON.stringify([
    {
      ...job('direct', {
        id: 'bad-json',
        profileName: 'karry',
        enabled: true,
        nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        schedule: { kind: 'interval', minutes: 1, display: 'every 1m' },
      }),
    },
  ], null, 2), 'utf-8');

  const scheduler = new CronScheduler({
    getProfilePaths: () => ({ dataDir, workspaceDir: dataDir, scriptsDir: dataDir }),
    getProfileNotifyDm: () => 'D123',
    scheduler: {
      executeTask: async () => ({ text: '{"main":', stopReason: 'success' }),
    },
  });
  scheduler.setProfileNames(['karry']);

  await scheduler.tick();
  await scheduler._awaitJobWrites(dataDir);

  const [stored] = JSON.parse(readFileSync(join(dataDir, 'cron-jobs.json'), 'utf-8'));
  assert.equal(stored.lastStatus, 'failed');
  assert.match(stored.lastError, /parse failed/);
  assert.match(stored.lastDeliveryError, /parse failed/);
});

test('cron delivery malformed blocks persists failed delivery status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orb-cron-delivery-block-fail-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'cron-jobs.json'), JSON.stringify([
    {
      ...job('direct', {
        id: 'bad-blocks',
        profileName: 'karry',
        enabled: true,
        nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        schedule: { kind: 'interval', minutes: 1, display: 'every 1m' },
      }),
    },
  ], null, 2), 'utf-8');

  const scheduler = new CronScheduler({
    getProfilePaths: () => ({ dataDir, workspaceDir: dataDir, scriptsDir: dataDir }),
    getProfileNotifyDm: () => 'D123',
    scheduler: {
      executeTask: async () => ({ text: '{"status":"ok","blocks":[{"foo":"bar"}]}', stopReason: 'success' }),
    },
  });
  scheduler.setProfileNames(['karry']);

  await scheduler.tick();
  await scheduler._awaitJobWrites(dataDir);

  const [stored] = JSON.parse(readFileSync(join(dataDir, 'cron-jobs.json'), 'utf-8'));
  assert.equal(stored.lastStatus, 'failed');
  assert.match(stored.lastError, /invalid blocks shape/);
  assert.match(stored.lastDeliveryError, /invalid blocks shape/);
  assert.match(stored.lastDeliveryError, /item\[0\]/);
});
