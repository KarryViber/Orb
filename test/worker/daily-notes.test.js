import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyNotesAppendToolUse } from '../../src/worker-daily-notes.js';

test('parseDailyNotesAppendToolUse extracts append command arguments', () => {
  const entry = parseDailyNotesAppendToolUse({
    name: 'Bash',
    input: {
      command: 'python3 daily-notes-append.py --mode line --time 12:46 --layer 配置层 --body "daemon 重启 + 验真 落地"',
    },
  });

  assert.deepEqual(entry, {
    mode: 'line',
    time: '12:46',
    layer: '配置层',
    snippet: 'daemon 重启 + 验真 落地',
  });
});

test('parseDailyNotesAppendToolUse prefers title for snippet and parses JSON tool input', () => {
  const entry = parseDailyNotesAppendToolUse({
    name: 'Bash',
    input: JSON.stringify({
      command: "python3 /tmp/daily-notes-append.py --mode narrative --time=13:10 --title 'daily-notes 回执时序修复 A+B 上线' --body ignored",
    }),
  });

  assert.deepEqual(entry, {
    mode: 'narrative',
    time: '13:10',
    title: 'daily-notes 回执时序修复 A+B 上线',
    snippet: 'daily-notes 回执时序修复 A+B 上线',
  });
});

test('parseDailyNotesAppendToolUse falls back from unexpanded shell time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-05-11T04:27:00.000Z') });

  const entry = parseDailyNotesAppendToolUse({
    name: 'Bash',
    input: {
      command: 'python3 daily-notes-append.py --mode narrative --time "$(date +%H:%M)" --body ok',
    },
  });

  assert.equal(entry.time, '13:27');
});

test('parseDailyNotesAppendToolUse falls back when time is missing', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-05-11T04:28:00.000Z') });

  const entry = parseDailyNotesAppendToolUse({
    name: 'Bash',
    input: {
      command: 'python3 daily-notes-append.py --mode narrative --body ok',
    },
  });

  assert.equal(entry.time, '13:28');
});

test('parseDailyNotesAppendToolUse ignores unrelated Bash commands', () => {
  assert.equal(parseDailyNotesAppendToolUse({
    name: 'Bash',
    input: { command: 'python3 other.py --mode line' },
  }), null);
});
