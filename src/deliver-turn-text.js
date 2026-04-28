import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function normalizeChannelSemantics(value) {
  return value === 'silent' || value === 'broadcast' ? value : 'reply';
}

function isSuccessfulStopReason(stopReason) {
  return !stopReason || stopReason === 'success' || stopReason === 'stop' || stopReason === 'end_turn';
}

function shouldSuppressForChannelSemantics(channelSemantics, stopReason) {
  return normalizeChannelSemantics(channelSemantics) === 'silent' && isSuccessfulStopReason(stopReason);
}

function writeSilentReceipt(profile, payload) {
  if (!profile?.dataDir) return;
  const dir = join(profile.dataDir, 'silent-suppressed');
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(join(dir, `${date}.jsonl`), `${JSON.stringify({
    ts: new Date().toISOString(),
    ...payload,
  })}\n`);
}

export async function deliverTurnText({
  ledger,
  phase,
  fullText,
  channelSemantics,
  stopReason,
  channel,
  threadTs,
  adapter,
  profile,
}) {
  const text = typeof fullText === 'string' ? fullText : '';
  const effectiveChannelSemantics = normalizeChannelSemantics(channelSemantics);

  if (shouldSuppressForChannelSemantics(effectiveChannelSemantics, stopReason)) {
    writeSilentReceipt(profile, {
      phase,
      threadTs,
      channel,
      channelSemantics: effectiveChannelSemantics,
      stopReason: stopReason || null,
      textLength: text.length,
    });
    return { delivered: false, reason: 'silent' };
  }

  const deliveryText = ledger.computeUndelivered(text);
  if (!deliveryText.trim()) {
    return { delivered: false, reason: 'already_delivered' };
  }

  const result = await adapter.sendReply(channel, threadTs, deliveryText);
  ledger.record(phase, deliveryText);
  return { delivered: true, ts: result?.ts };
}
