import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnDeliveryOrchestrator } from '../src/turn-delivery/orchestrator.js';
import { TurnDeliveryLedger, ledgerPathForDataDir } from '../src/turn-delivery/ledger.js';

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayIsoDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function record(overrides = {}) {
  return {
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    channel: 'C1',
    threadTs: '111.222',
    platform: 'slack',
    intent: 'assistant_text.final',
    deliveryChannel: 'postMessage',
    textLen: 4,
    streamMessageTs: null,
    postMessageTs: 'p-1',
    createdAt: new Date().toISOString(),
    source: 'test',
    meta: {},
    ...overrides,
  };
}

function createAdapter() {
  const calls = [];
  return {
    calls,
    platform: 'slack',
    capabilities: { stream: false },
    async deliver(intent) {
      calls.push(['deliver', intent.intent, intent.text]);
      return { ts: 'p-2' };
    },
  };
}

async function writeLedgerFile(dataDir, date, lines) {
  const dir = join(dataDir, 'turn-delivery');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `turn-delivery-${date}.ndjson`), `${lines.join('\n')}\n`);
}

test('TurnDeliveryLedger hydrate skips already delivered assistant final after restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-ledger-hydrate-'));
  await writeLedgerFile(dataDir, todayIsoDate(), [JSON.stringify(record())]);
  const ledger = new TurnDeliveryLedger({ ndjsonPath: ledgerPathForDataDir(dataDir) });
  const adapter = createAdapter();
  const orchestrator = new TurnDeliveryOrchestrator({ adapter, ledger });
  orchestrator.beginTurn(record());

  const result = await orchestrator.emit({
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    channel: 'C1',
    threadTs: '111.222',
    platform: 'slack',
    intent: 'assistant_text.final',
    text: 'done',
    source: 'test',
  });

  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'replay-already-delivered');
  assert.deepEqual(adapter.calls, []);
});

test('TurnDeliveryLedger hydrate reads only today file', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-ledger-date-'));
  await writeLedgerFile(dataDir, yesterdayIsoDate(), [JSON.stringify(record())]);
  const ledger = new TurnDeliveryLedger({ ndjsonPath: ledgerPathForDataDir(dataDir) });
  const key = 'turn-1|attempt-1|assistant_text.final|postMessage|test';

  assert.equal(ledger.hasDeliveredKey(key), false);
});

test('TurnDeliveryLedger hydrate skips corrupt ndjson lines without throwing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-ledger-corrupt-'));
  const logs = [];
  await writeLedgerFile(dataDir, todayIsoDate(), [
    '{bad json',
    JSON.stringify(record({ intent: 'assistant_text.delta', meta: { sequence: 1 } })),
    JSON.stringify(record({
      intent: 'control_plane.message',
      deliveryChannel: 'postMessage',
      source: 'orchestrator.stream_failure',
    })),
  ]);

  const ledger = new TurnDeliveryLedger({
    ndjsonPath: ledgerPathForDataDir(dataDir),
    logger: (message) => logs.push(message),
  });

  assert.equal(
    ledger.hasDeliveredKey('turn-1|attempt-1|control_plane.message|postMessage|orchestrator.stream_failure'),
    true,
  );
  assert.equal(
    ledger.hasDeliveredKey('turn-1|attempt-1|assistant_text.delta|postMessage|test'),
    false,
  );
  assert.match(logs.join('\n'), /skipped=1/);
});

test('TurnDeliveryLedger hydrate can be disabled by env', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-ledger-disabled-'));
  await writeLedgerFile(dataDir, todayIsoDate(), [JSON.stringify(record())]);
  const old = process.env.ORB_LEDGER_HYDRATE;
  process.env.ORB_LEDGER_HYDRATE = '0';
  try {
    const ledger = new TurnDeliveryLedger({ ndjsonPath: ledgerPathForDataDir(dataDir) });
    assert.equal(
      ledger.hasDeliveredKey('turn-1|attempt-1|assistant_text.final|postMessage|test'),
      false,
    );
  } finally {
    if (old == null) delete process.env.ORB_LEDGER_HYDRATE;
    else process.env.ORB_LEDGER_HYDRATE = old;
  }
});
