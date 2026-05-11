import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeExternalSessionResult,
  makeTurnComplete,
  validateExternalSessionResult,
  validateIncomingIpc,
} from '../src/ipc-schema.js';

test('validateIncomingIpc rejects malformed worker messages', () => {
  assert.equal(validateIncomingIpc(null), 'invalid msg shape');
  assert.equal(validateIncomingIpc({}), 'invalid msg shape');
  assert.equal(validateIncomingIpc({ type: 'unknown' }), 'unknown ipc type: unknown');
  assert.equal(validateIncomingIpc({ type: 'cc_event' }), 'cc_event missing required field: turnId');
  assert.equal(
    validateIncomingIpc({ type: 'turn_complete', text: '', toolCount: 0 }),
    'turn_complete missing required field: channelSemantics',
  );
});

test('validateIncomingIpc accepts valid minimal worker messages', () => {
  assert.equal(validateIncomingIpc({ type: 'turn_start' }), null);
  assert.equal(validateIncomingIpc({ type: 'turn_end' }), null);
  assert.equal(validateIncomingIpc({ type: 'inject' }), null);
  assert.equal(validateIncomingIpc({
    type: 'cc_event',
    turnId: 'turn-1',
    eventType: 'text',
    payload: {},
  }), null);
  assert.equal(validateIncomingIpc({
    type: 'turn_complete',
    text: '',
    toolCount: 0,
    channelSemantics: 'silent',
  }), null);
  assert.equal(validateIncomingIpc({ type: 'result', channelSemantics: 'reply' }), null);
  assert.equal(validateIncomingIpc({
    type: 'external_session_result',
    channel: 'C1',
    thread_ts: '1778141504.110239',
    label: 'smoke',
    rc: 0,
    text: 'done',
  }), null);
});

test('external_session_result schema validates launcher payload shape', () => {
  assert.deepEqual(makeExternalSessionResult({
    channel: 'C1',
    thread_ts: '1778141504.110239',
    label: 'smoke',
    rc: 0,
    text: 'done',
  }), {
    type: 'external_session_result',
    channel: 'C1',
    thread_ts: '1778141504.110239',
    label: 'smoke',
    rc: 0,
    took_seconds: null,
    log_path: null,
    spec_archived: null,
    next_spec: null,
    text: 'done',
  });
  assert.equal(validateExternalSessionResult({
    type: 'external_session_result',
    channel: 'C1',
    thread_ts: '1778141504.110239',
    label: 'smoke',
    rc: 0,
    text: 'done',
  }), null);
  assert.equal(validateExternalSessionResult({
    type: 'external_session_result',
    channel: 'C1',
    thread_ts: '1778141504.110239',
    label: 'smoke',
    rc: '0',
    text: 'done',
  }), 'external_session_result rc must be integer');
});

test('turn_complete schema preserves daily notes summary', () => {
  const msg = makeTurnComplete({
    text: 'done',
    toolCount: 1,
    channelSemantics: 'reply',
    dailyNotesSummary: { count: 1 },
  });

  assert.deepEqual(msg.dailyNotesSummary, { count: 1 });
  assert.deepEqual(validateIncomingIpc({
    type: 'turn_complete',
    text: 'done',
    toolCount: 1,
    channelSemantics: 'reply',
    dailyNotesSummary: { count: 1 },
  }), null);
});
