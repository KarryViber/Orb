import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SlackAdapter } from '../src/adapters/slack.js';
import { Scheduler } from '../src/scheduler.js';
import { TurnDeliveryLedger } from '../src/turn-delivery/ledger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn) {
  for (let i = 0; i < 50; i += 1) {
    const value = fn();
    if (value) return value;
    await sleep(10);
  }
  assert.fail('condition was not met');
}

function createSlackAdapter(ledger) {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', ledger });
  adapter._slack = {
    chat: {
      async postMessage() {
        return { ts: '1777.000001' };
      },
    },
  };
  return adapter;
}

function settleApproval(adapter, promise) {
  const pending = adapter._pendingApprovals.values().next().value;
  assert.ok(pending);
  clearTimeout(pending.timeoutHandle);
  pending.resolve({ approved: true, scope: 'once', userId: 'U1' });
  return promise;
}

test('SlackAdapter sendApproval records adapter event NDJSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orb-adapter-event-ledger-'));
  const ndjsonPath = join(dir, 'turn-delivery-{YYYY-MM-DD}.ndjson');
  const actualPath = ndjsonPath.replace('{YYYY-MM-DD}', new Date().toISOString().slice(0, 10));
  const ledger = new TurnDeliveryLedger({ ndjsonPath });
  const seen = [];
  const originalRecordAdapterEvent = ledger.recordAdapterEvent.bind(ledger);
  ledger.recordAdapterEvent = (event) => {
    seen.push(event);
    return originalRecordAdapterEvent(event);
  };
  const adapter = createSlackAdapter(ledger);

  const approval = adapter.sendApproval('C1', '111.222', { kind: 'permission', timeoutMs: 30_000 });
  await waitFor(() => seen.length === 1);
  await settleApproval(adapter, approval);
  const fileText = await waitFor(() => existsSync(actualPath) && readFileSync(actualPath, 'utf8'));
  const record = JSON.parse(fileText.trim().split('\n').at(-1));

  assert.equal(seen[0].eventType, 'adapter.approval.created');
  assert.equal(record.kind, 'adapter_event');
  assert.equal(record.eventType, 'adapter.approval.created');
  assert.equal(record.channel, 'C1');
  assert.equal(record.ts, '1777.000001');
});

test('SlackAdapter sendApproval ignores adapter event ledger failures', async () => {
  const ledger = {
    recordAdapterEvent() {
      throw new Error('ledger unavailable');
    },
  };
  const adapter = createSlackAdapter(ledger);

  const approval = adapter.sendApproval('C1', '111.222', { kind: 'permission', timeoutMs: 30_000 });
  await waitFor(() => adapter._pendingApprovals.size === 1);
  const result = await settleApproval(adapter, approval);

  assert.equal(result.approved, true);
});

test('scheduler rejects adapters without deliver implementation', () => {
  const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
  assert.throws(() => scheduler.addAdapter('slack', {}), /adapter must implement deliver\(\)/);
});

test('scheduler no longer contains delivery adapter wrapper', () => {
  const source = readFileSync(new URL('../src/scheduler.js', import.meta.url), 'utf8');
  const removedName = 'makeAdapter' + 'ForDelivery';
  assert.equal(source.includes(removedName), false);
});
