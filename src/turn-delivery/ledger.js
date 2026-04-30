import { existsSync, readFileSync } from 'node:fs';
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TEXT_FINAL,
  CONTROL_PLANE_MESSAGE,
  RECEIPT_SILENT_SUPPRESSED,
  TASK_PROGRESS_APPEND,
  validateTurnDeliveryRecord,
} from './intents.js';

const TAG = 'turn-delivery-ledger';
const HYDRATE_STABLE_INTENTS = new Set([
  ASSISTANT_TEXT_FINAL,
  CONTROL_PLANE_MESSAGE,
  RECEIPT_SILENT_SUPPRESSED,
]);

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function ledgerPathForDataDir(dataDir) {
  return join(dataDir, 'turn-delivery', 'turn-delivery-{YYYY-MM-DD}.ndjson');
}

export class TurnDeliveryLedger {
  constructor({ logger, ndjsonPath } = {}) {
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._ndjsonPath = ndjsonPath || null;
    this._recordsByTurn = new Map();
    this._deliveredKeys = new Set();
    this._hydrateDeliveredKeys();
  }

  record(record, deliveredKey = null) {
    const validationError = validateTurnDeliveryRecord(record);
    if (validationError) throw new Error(validationError);

    const normalized = {
      ...record,
      createdAt: record.createdAt || new Date().toISOString(),
      meta: record.meta && typeof record.meta === 'object' ? record.meta : {},
    };
    const records = this._recordsByTurn.get(normalized.turnId) || [];
    records.push(normalized);
    this._recordsByTurn.set(normalized.turnId, records);
    if (deliveredKey) this._deliveredKeys.add(String(deliveredKey));
    this._appendNdjson(normalized);
    return normalized;
  }

  recordAdapterEvent({ source, eventType, channel, ts, platform, meta = {} }) {
    const normalized = {
      kind: 'adapter_event',
      eventType,
      source,
      channel,
      ts,
      platform,
      meta: meta && typeof meta === 'object' ? meta : {},
      recordedAt: new Date().toISOString(),
    };
    this._appendNdjson(normalized);
    return normalized;
  }

  hasDeliveredKey(key) {
    return this._deliveredKeys.has(String(key || ''));
  }

  getRecordsForTurn(turnId) {
    return [...(this._recordsByTurn.get(String(turnId || '')) || [])];
  }

  _resolveNdjsonPath() {
    if (!this._ndjsonPath) return null;
    return this._ndjsonPath.replace('{YYYY-MM-DD}', todayIsoDate());
  }

  _deliveredKeyFromRecord(record) {
    if (!record || typeof record !== 'object') return null;
    if (!HYDRATE_STABLE_INTENTS.has(record.intent)) return null;
    if (record.intent === ASSISTANT_TEXT_DELTA || record.intent === TASK_PROGRESS_APPEND) return null;
    for (const field of ['turnId', 'attemptId', 'intent', 'deliveryChannel', 'source']) {
      if (typeof record[field] !== 'string') return null;
    }
    return [
      record.turnId,
      record.attemptId,
      record.intent,
      record.deliveryChannel,
      record.source || '',
    ].join('|');
  }

  _hydrateDeliveredKeys() {
    if (process.env.ORB_LEDGER_HYDRATE === '0') return;
    const filePath = this._resolveNdjsonPath();
    if (!filePath || !existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf8');
      let hydrated = 0;
      let skipped = 0;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed);
          const key = this._deliveredKeyFromRecord(record);
          if (key) {
            this._deliveredKeys.add(key);
            hydrated += 1;
          }
        } catch {
          skipped += 1;
        }
      }
      if (hydrated || skipped) {
        this._safeLog(`hydrated delivered keys: hydrated=${hydrated} skipped=${skipped} path=${filePath}`);
      }
    } catch (err) {
      this._safeLog(`hydrate failed: ${err.message}`);
    }
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
      // Ledger failures must not interrupt delivery.
    }
  }
}
