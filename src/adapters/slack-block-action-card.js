import { warn } from '../log.js';
import { markdownToMrkdwn } from './slack-format.js';

const TAG = 'slack';

export async function updateBlockActionCard({
  slack,
  resolveLedger,
  channel,
  messageTs,
  text,
  originalBlocks = null,
  ledgerHint = {},
}) {
  const safeText = markdownToMrkdwn(String(text || ''));
  const statusBlock = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: safeText }],
  };
  const preserved = Array.isArray(originalBlocks)
    ? originalBlocks.filter((block) => block && block.type !== 'actions')
    : [];
  const blocks = preserved.length
    ? [statusBlock, ...preserved]
    : [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: safeText },
      },
    ];
  const result = await slack.chat.update({
    channel,
    ts: messageTs,
    text: safeText,
    blocks,
  });
  const ledger = resolveLedger?.(ledgerHint);
  try {
    ledger?.recordAdapterEvent({
      source: 'slack._updateBlockActionCard',
      eventType: 'adapter.handler.update',
      channel,
      ts: result?.ts || messageTs,
      platform: 'slack',
      meta: { messageTs },
    });
  } catch (err) {
    warn(TAG, `ledger record failed: ${err.message}`);
  }
  return result;
}
