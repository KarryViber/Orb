import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStopReason,
  isSuccessfulStopReason,
  isTruncatedStopReason,
} from '../src/stop-reason.js';

test('classifies successful stop reasons', () => {
  for (const stopReason of [null, undefined, '', 'success', 'stop', 'end_turn']) {
    assert.equal(isSuccessfulStopReason(stopReason), true);
    assert.equal(classifyStopReason(stopReason), 'successful');
  }
});

test('classifies truncated stop reasons', () => {
  for (const stopReason of ['tool_use', 'max_turns_reached']) {
    assert.equal(isSuccessfulStopReason(stopReason), false);
    assert.equal(isTruncatedStopReason(stopReason), true);
    assert.equal(classifyStopReason(stopReason), 'truncated');
  }
});

test('classifies unknown stop reasons as failed', () => {
  for (const stopReason of ['api_error', 'cancelled', 'worker_failed']) {
    assert.equal(isSuccessfulStopReason(stopReason), false);
    assert.equal(isTruncatedStopReason(stopReason), false);
    assert.equal(classifyStopReason(stopReason), 'failed');
  }
});
