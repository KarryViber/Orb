import test from 'node:test';
import assert from 'node:assert/strict';
import { isUserCorrectionText } from '../src/lesson-candidates.js';

test('detects Chinese user correction text', () => {
  for (const text of [
    '不对',
    '错了',
    '重做',
    '重来',
    '不是这样',
    '你搞错了',
    '应该是',
    '改一下',
    '方向错了',
  ]) {
    assert.equal(isUserCorrectionText(text), true, text);
  }
});

test('detects English user correction text', () => {
  for (const text of [
    'wrong',
    'redo',
    'try again',
    'not what I asked for',
    'should be',
  ]) {
    assert.equal(isUserCorrectionText(text), true, text);
  }
});

test('does not detect neutral continuation text as correction', () => {
  for (const text of ['好的', '继续', 'ok', 'next']) {
    assert.equal(isUserCorrectionText(text), false, text);
  }
});
