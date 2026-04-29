import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TEXT_FINAL,
  METADATA_STATUS,
  RECEIPT_SILENT_SUPPRESSED,
  TURN_DELIVERY_CHANNELS,
  TURN_DELIVERY_INTENTS,
  createTurnDeliveryRecord,
} from './intents.js';

const TAG = 'turn-delivery-shadow';
const STREAM_FINAL_COVERAGE_RATIO = 0.95;

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function shadowRecorderPathForDataDir(dataDir) {
  return join(dataDir, 'shadow-egress', 'turn-delivery-{YYYY-MM-DD}.ndjson');
}

export class TurnDeliveryShadowRecorder {
  constructor({ logger, ndjsonPath } = {}) {
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._ndjsonPath = ndjsonPath || null;
    this._recordsByTurn = new Map();
  }

  observe(record) {
    try {
      const validationError = this._validate(record);
      if (validationError) {
        if (process.env.NODE_ENV !== 'production') {
          this._logger(`[${TAG}] invalid record: ${validationError}`);
        }
        return;
      }

      const normalized = {
        ...record,
        createdAt: record.createdAt || new Date().toISOString(),
        meta: record.meta && typeof record.meta === 'object' ? record.meta : {},
      };
      const records = this._recordsByTurn.get(normalized.turnId) || [];
      records.push(normalized);
      this._recordsByTurn.set(normalized.turnId, records);
      this._appendNdjson(normalized);
    } catch (err) {
      this._safeLog(`observe failed: ${err.message}`);
    }
  }

  getRecordsForTurn(turnId) {
    return [...(this._recordsByTurn.get(String(turnId || '')) || [])];
  }

  computeShadowDecision(turnId) {
    try {
      const records = this.getRecordsForTurn(turnId);
      if (records.some((record) => record.intent === RECEIPT_SILENT_SUPPRESSED
        || record.deliveryChannel === 'silent'
        || record.meta?.channelSemantics === 'silent')) {
        return { wouldSend: false, channel: null, reason: 'silent-semantics' };
      }

      const finals = records.filter((record) => record.intent === ASSISTANT_TEXT_FINAL && record.textLen > 0);
      const final = finals.at(-1);
      if (!final) return { wouldSend: false, channel: null, reason: 'no-final-text' };

      if (final.platform === 'wechat') {
        return { wouldSend: true, channel: final.deliveryChannel || 'postMessage', reason: 'wechat-sendReply-only' };
      }

      const streamRecords = records.filter((record) => (
        record.intent === ASSISTANT_TEXT_DELTA
        && record.deliveryChannel === 'stream'
        && record.textLen > 0
      ));
      const streamLen = streamRecords.reduce((sum, record) => sum + record.textLen, 0);
      const matchingFingerprint = streamRecords.some((record) => (
        record.fingerprint && final.fingerprint && record.fingerprint === final.fingerprint
      ));
      const coverageRatio = final.textLen > 0 ? streamLen / final.textLen : 0;

      if (streamRecords.length > 0 && matchingFingerprint && coverageRatio >= STREAM_FINAL_COVERAGE_RATIO) {
        return { wouldSend: false, channel: null, reason: 'stream-already-carries-final' };
      }
      if (streamRecords.length > 0 && streamLen < final.textLen) {
        return { wouldSend: true, channel: 'postMessage', reason: 'stream-partial-coverage' };
      }
      return { wouldSend: true, channel: 'postMessage', reason: 'final-postMessage' };
    } catch (err) {
      this._safeLog(`computeShadowDecision failed: ${err.message}`);
      return { wouldSend: false, channel: null, reason: 'shadow-error' };
    }
  }

  assertConsistency(turnId, actualEvent = {}) {
    try {
      const records = this.getRecordsForTurn(turnId);
      const platform = actualEvent.platform || records.find((record) => record.platform)?.platform || '';
      const decision = this.computeShadowDecision(turnId);
      if (platform === 'wechat') {
        return { consistent: true, decision, reason: 'wechat-shadow-observe-only' };
      }

      const actualSent = Boolean(actualEvent.actualSendReply || actualEvent.actualPostMessage || actualEvent.actualEdit);
      const consistent = actualSent === decision.wouldSend;
      const result = {
        consistent,
        decision,
        actualSent,
        actualEvent,
      };

      if (!consistent) {
        this.observe(createTurnDeliveryRecord({
          turnId,
          attemptId: actualEvent.attemptId || records.at(-1)?.attemptId || '',
          channel: actualEvent.channel || records.at(-1)?.channel || '',
          threadTs: actualEvent.threadTs || records.at(-1)?.threadTs || '',
          platform,
          intent: METADATA_STATUS,
          deliveryChannel: 'silent',
          source: 'shadow.assertConsistency',
          meta: {
            kind: 'shadow-consistency-diff',
            decision,
            actualEvent,
          },
        }));
      }
      return result;
    } catch (err) {
      this._safeLog(`assertConsistency failed: ${err.message}`);
      return { consistent: true, decision: { wouldSend: false, channel: null, reason: 'shadow-error' }, error: err.message };
    }
  }

  _validate(record) {
    if (!record || typeof record !== 'object') return 'record must be an object';
    for (const field of ['turnId', 'attemptId', 'channel', 'threadTs', 'platform', 'intent', 'deliveryChannel', 'source']) {
      if (typeof record[field] !== 'string') return `${field} must be a string`;
    }
    if (!TURN_DELIVERY_INTENTS.has(record.intent)) return `unknown intent ${record.intent}`;
    if (!TURN_DELIVERY_CHANNELS.has(record.deliveryChannel)) return `unknown deliveryChannel ${record.deliveryChannel}`;
    if (!Number.isFinite(Number(record.textLen))) return 'textLen must be a number';
    if (record.streamMessageTs !== null && record.streamMessageTs !== undefined && typeof record.streamMessageTs !== 'string') return 'streamMessageTs must be string|null';
    if (record.postMessageTs !== null && record.postMessageTs !== undefined && typeof record.postMessageTs !== 'string') return 'postMessageTs must be string|null';
    if (typeof record.fingerprint !== 'string') return 'fingerprint must be a string';
    if (record.createdAt !== undefined && typeof record.createdAt !== 'string') return 'createdAt must be a string';
    if (record.meta !== undefined && (!record.meta || typeof record.meta !== 'object' || Array.isArray(record.meta))) return 'meta must be an object';
    return null;
  }

  _resolveNdjsonPath() {
    if (!this._ndjsonPath) return null;
    return this._ndjsonPath.replace('{YYYY-MM-DD}', todayIsoDate());
  }

  _appendNdjson(record) {
    const filePath = this._resolveNdjsonPath();
    if (!filePath) return;
    const line = `${JSON.stringify(record)}\n`;
    mkdir(dirname(filePath), { recursive: true })
      .then(() => appendFile(filePath, line, 'utf8'))
      .catch((err) => this._safeLog(`ndjson append failed: ${err.message}`));
  }

  _safeLog(message) {
    try {
      this._logger(`[${TAG}] ${message}`);
    } catch {
      // Shadow mode must never affect delivery.
    }
  }
}
