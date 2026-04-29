import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateTurnDeliveryRecord } from './intents.js';

const TAG = 'turn-delivery-ledger';

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
