import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TurnEgressLedger } from '../src/turn-egress-ledger.js';
import { deliverTurnText } from '../src/deliver-turn-text.js';

function ledgerWith(segments) {
  const ledger = new TurnEgressLedger();
  for (const [phase, text] of segments) ledger.record(phase, text);
  return ledger;
}

function createAdapter() {
  const calls = [];
  return {
    calls,
    async sendReply(channel, threadTs, text) {
      calls.push({ channel, threadTs, text });
      return { ts: '123.456' };
    },
  };
}

test('computeUndelivered returns full text when no segments exist', () => {
  const ledger = new TurnEgressLedger();
  assert.equal(ledger.computeUndelivered('完整最终答复'), '完整最终答复');
});

test('computeUndelivered skips a single exact segment', () => {
  const ledger = ledgerWith([['intermediate', 'A']]);
  assert.equal(ledger.computeUndelivered('A'), '');
  assert.equal(ledger.isAlreadyDelivered('A'), true);
});

test('computeUndelivered keeps suffix after one starting segment', () => {
  const ledger = ledgerWith([['intermediate', 'A']]);
  assert.equal(ledger.computeUndelivered('A 后续'), ' 后续');
});

test('computeUndelivered keeps prefix before one ending segment', () => {
  const ledger = ledgerWith([['turn_complete', 'B']]);
  assert.equal(ledger.computeUndelivered('前置 B'), '前置 ');
});

test('computeUndelivered keeps both sides around an embedded segment', () => {
  const ledger = ledgerWith([['intermediate', 'B']]);
  assert.equal(ledger.computeUndelivered('A B C'), 'A  C');
});

test('computeUndelivered skips ordered segments separated only by whitespace', () => {
  const ledger = ledgerWith([['intermediate', 'A'], ['intermediate', 'B']]);
  assert.equal(ledger.computeUndelivered('A\n\nB'), '');
});

test('computeUndelivered preserves true increment between or after ordered segments', () => {
  const ledger = ledgerWith([['intermediate', 'A'], ['intermediate', 'B']]);
  assert.equal(ledger.computeUndelivered('A\n\nB\n\n新结论'), '\n\n新结论');
  assert.equal(ledger.computeUndelivered('A\n\n新增\n\nB'), '\n\n新增\n\n');
});

test('computeUndelivered returns full text when a segment is not found', () => {
  const ledger = ledgerWith([['intermediate', 'A'], ['intermediate', 'B']]);
  assert.equal(ledger.computeUndelivered('完全不同'), '完全不同');
});

test('deliverTurnText suppresses successful silent turns and writes a receipt', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orb-egress-'));
  try {
    const ledger = new TurnEgressLedger();
    const adapter = createAdapter();

    const result = await deliverTurnText({
      ledger,
      phase: 'turn_complete',
      fullText: '已完成',
      channelSemantics: 'silent',
      stopReason: 'success',
      channel: 'C1',
      threadTs: '111.222',
      adapter,
      profile: { dataDir },
    });

    assert.deepEqual(result, { delivered: false, reason: 'silent' });
    assert.deepEqual(adapter.calls, []);
    const date = new Date().toISOString().slice(0, 10);
    const receipt = JSON.parse(readFileSync(join(dataDir, 'silent-suppressed', `${date}.jsonl`), 'utf8').trim());
    assert.equal(receipt.phase, 'turn_complete');
    assert.equal(receipt.textLength, 3);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('deliverTurnText delivers failed silent turns', async () => {
  const ledger = new TurnEgressLedger();
  const adapter = createAdapter();

  const result = await deliverTurnText({
    ledger,
    phase: 'turn_complete',
    fullText: '失败回执',
    channelSemantics: 'silent',
    stopReason: 'error',
    channel: 'C1',
    threadTs: '111.222',
    adapter,
    profile: null,
  });

  assert.deepEqual(result, { delivered: true, ts: '123.456' });
  assert.deepEqual(adapter.calls, [{ channel: 'C1', threadTs: '111.222', text: '失败回执' }]);
  assert.equal(ledger.isAlreadyDelivered('失败回执'), true);
});
