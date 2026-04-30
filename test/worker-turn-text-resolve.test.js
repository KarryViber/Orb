import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurnCompleteText } from '../src/worker-turn-text.js';

test('resolveTurnCompleteText uses full turnBuffer for multi-block markdown turn', () => {
  const resolved = resolveTurnCompleteText({
    turnBuffer: ['## A', '## B', 'tail'],
    msgResult: 'tail',
    lastEmittedText: '',
    blocksSinceLastEmit: 3,
  });

  assert.deepEqual(resolved, {
    shouldEmit: true,
    text: '## A\n## B\ntail',
    mismatch: false,
  });
});

test('resolveTurnCompleteText emits matching single-block reply', () => {
  const resolved = resolveTurnCompleteText({
    turnBuffer: ['hi'],
    msgResult: 'hi',
    lastEmittedText: '',
    blocksSinceLastEmit: 1,
  });

  assert.deepEqual(resolved, {
    shouldEmit: true,
    text: 'hi',
    mismatch: false,
  });
});

test('resolveTurnCompleteText suppresses empty tool-only turn', () => {
  const resolved = resolveTurnCompleteText({
    turnBuffer: [],
    msgResult: '',
    lastEmittedText: '',
    blocksSinceLastEmit: 0,
  });

  assert.deepEqual(resolved, {
    shouldEmit: false,
    text: '',
    mismatch: false,
  });
});

test('resolveTurnCompleteText suppresses repeated result tail after prior emit', () => {
  const resolved = resolveTurnCompleteText({
    turnBuffer: [],
    msgResult: 'tail',
    lastEmittedText: '## A\n## B\ntail',
    blocksSinceLastEmit: 0,
  });

  assert.deepEqual(resolved, {
    shouldEmit: false,
    text: '',
    mismatch: false,
  });
});

test('resolveTurnCompleteText flags unrelated buffer/result mismatch', () => {
  const resolved = resolveTurnCompleteText({
    turnBuffer: ['full body'],
    msgResult: 'completely different',
    lastEmittedText: '',
    blocksSinceLastEmit: 1,
  });

  assert.deepEqual(resolved, {
    shouldEmit: true,
    text: 'full body',
    mismatch: true,
  });
});
