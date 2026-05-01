import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIncomingIpc } from '../src/ipc-schema.js';

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
});
