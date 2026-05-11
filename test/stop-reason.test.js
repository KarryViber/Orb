import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStopReason,
  isInterruptedStopReason,
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

test('isInterruptedStopReason: worker_timeout / worker_crash always interrupted', () => {
  for (const stopReason of ['worker_timeout', 'worker_crash']) {
    assert.equal(isInterruptedStopReason(stopReason), true);
    assert.equal(isInterruptedStopReason(stopReason, { exitCode: 0 }), true);
    assert.equal(isInterruptedStopReason(stopReason, { exitCode: 137 }), true);
  }
});

test('isInterruptedStopReason: api_error / cli_error require non-zero exitCode', () => {
  for (const stopReason of ['api_error', 'cli_error']) {
    assert.equal(isInterruptedStopReason(stopReason, { exitCode: 1 }), true);
    assert.equal(isInterruptedStopReason(stopReason, { exitCode: 0 }), false);
    assert.equal(isInterruptedStopReason(stopReason, { exitCode: null }), true);
    assert.equal(isInterruptedStopReason(stopReason), true);
  }
});

test('isInterruptedStopReason: success / truncated / unknown not interrupted', () => {
  for (const stopReason of ['success', 'stop', 'end_turn', 'tool_use', 'max_turns_reached', '', null, undefined, 'cancelled']) {
    assert.equal(isInterruptedStopReason(stopReason), false);
  }
});
