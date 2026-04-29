import crypto from 'node:crypto';

export const ASSISTANT_TEXT_DELTA = 'assistant_text.delta';
export const ASSISTANT_TEXT_FINAL = 'assistant_text.final';
export const TASK_PROGRESS_START = 'task_progress.start';
export const TASK_PROGRESS_APPEND = 'task_progress.append';
export const TASK_PROGRESS_STOP = 'task_progress.stop';
export const CONTROL_PLANE_MESSAGE = 'control_plane.message';
export const CONTROL_PLANE_UPDATE = 'control_plane.update';
export const METADATA_STATUS = 'metadata.status';
export const METADATA_TITLE = 'metadata.title';
export const RECEIPT_SILENT_SUPPRESSED = 'receipt.silent_suppressed';

export const TURN_DELIVERY_INTENTS = new Set([
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TEXT_FINAL,
  TASK_PROGRESS_START,
  TASK_PROGRESS_APPEND,
  TASK_PROGRESS_STOP,
  CONTROL_PLANE_MESSAGE,
  CONTROL_PLANE_UPDATE,
  METADATA_STATUS,
  METADATA_TITLE,
  RECEIPT_SILENT_SUPPRESSED,
]);

export const TURN_DELIVERY_CHANNELS = new Set(['stream', 'postMessage', 'edit', 'silent']);

const FINGERPRINT_SAMPLE = 1000;

/**
 * @typedef {Object} TurnDeliveryRecord
 * @property {string} turnId `${threadTs}#${turnSeq}` or `${threadTs}#${attemptId}`.
 * @property {string} attemptId Attempt id with the same semantics as 8e6aaad.
 * @property {string} channel Slack channel id.
 * @property {string} threadTs Slack thread ts.
 * @property {string} platform 'slack' | 'wechat' | ...
 * @property {string} intent One of the constants exported from this module.
 * @property {string} deliveryChannel 'stream' | 'postMessage' | 'edit' | 'silent'.
 * @property {number} textLen Emitted character count when the intent carries text.
 * @property {string|null} streamMessageTs startStream-created ts, if applicable.
 * @property {string|null} postMessageTs chat.postMessage-returned ts, if applicable.
 * @property {string} fingerprint Invariant text fingerprint: trim + NFC + first 1k hash.
 * @property {string} createdAt ISO timestamp.
 * @property {string} source 'subscriber.text' | 'subscriber.qi' | 'scheduler.turn_complete' | ...
 * @property {Object} meta Free metadata such as gitDiffSummary, payloadIndex, or errorCode.
 */

export function fingerprintText(text) {
  const normalized = String(text || '').trim().normalize('NFC').slice(0, FINGERPRINT_SAMPLE);
  if (!normalized) return '';
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

export function textLength(text) {
  return String(text || '').length;
}

export function makeTurnId({ turnId, threadTs, attemptId }) {
  if (turnId) return String(turnId);
  const left = threadTs || 'unknown-thread';
  const right = attemptId || 'unknown-attempt';
  return `${left}#${right}`;
}

export function createTurnDeliveryRecord({
  turnId,
  attemptId = '',
  channel = '',
  threadTs = '',
  platform = '',
  intent,
  deliveryChannel,
  text = '',
  textLen = null,
  streamMessageTs = null,
  postMessageTs = null,
  fingerprint = null,
  source,
  meta = {},
}) {
  const safeText = String(text || '');
  return {
    turnId: String(turnId || makeTurnId({ threadTs, attemptId })),
    attemptId: String(attemptId || ''),
    channel: String(channel || ''),
    threadTs: String(threadTs || ''),
    platform: String(platform || ''),
    intent,
    deliveryChannel,
    textLen: textLen != null && Number.isFinite(Number(textLen)) ? Number(textLen) : textLength(safeText),
    streamMessageTs: streamMessageTs == null ? null : String(streamMessageTs),
    postMessageTs: postMessageTs == null ? null : String(postMessageTs),
    fingerprint: fingerprint == null ? fingerprintText(safeText) : String(fingerprint),
    createdAt: new Date().toISOString(),
    source: String(source || ''),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
}
