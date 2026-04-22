import crypto from 'node:crypto';

const MAX_SAMPLE = 1000;
const MAX_ENTRIES = 32;

function fingerprint(text) {
  if (!text) return null;
  const sample = String(text).trim().slice(0, MAX_SAMPLE);
  if (!sample) return null;
  return crypto.createHash('sha1').update(sample).digest('hex');
}

export class EgressGate {
  constructor(logger) {
    this._seen = new Set();
    this._log = typeof logger === 'function' ? logger : () => {};
  }

  admit(text, source) {
    const fp = fingerprint(text);
    if (!fp) return true;
    if (this._seen.has(fp)) {
      this._log(`[EgressGate] DROP dup text (source=${source}, fp=${fp.slice(0, 8)})`);
      return false;
    }
    if (this._seen.size >= MAX_ENTRIES) {
      this._log(`[EgressGate] WARN entries=${this._seen.size}, resetting safety valve`);
      this._seen.clear();
    }
    this._seen.add(fp);
    return true;
  }

  reset() {
    this._seen.clear();
  }
}
