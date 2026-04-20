import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionId, updateSession } from '../src/session.js';

function createTempDataDir() {
  const root = mkdtempSync(join(tmpdir(), 'orb-session-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

test('updateSession writes data that can be read back', async () => {
  const dataDir = createTempDataDir();

  await updateSession(dataDir, 'slack:thread-1', {
    sessionId: 'session-123',
    userId: 'user-123',
  });

  assert.equal(getSessionId(dataDir, 'slack:thread-1'), 'session-123');

  const sessions = JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8'));
  assert.deepEqual(Object.keys(sessions), ['slack:thread-1']);
  assert.equal(sessions['slack:thread-1'].sessionId, 'session-123');
  assert.equal(sessions['slack:thread-1'].userId, 'user-123');
  assert.match(sessions['slack:thread-1'].createdAt, /\d{4}-\d{2}-\d{2}T/);
  assert.match(sessions['slack:thread-1'].lastActive, /\d{4}-\d{2}-\d{2}T/);
});

test('corrupt session json is quarantined and logged', () => {
  const dataDir = createTempDataDir();
  const file = join(dataDir, 'sessions.json');
  const errors = [];
  const originalConsoleError = console.error;

  writeFileSync(file, '{"broken":', 'utf8');
  console.error = (...args) => {
    errors.push(args.join(' '));
  };

  try {
    assert.equal(getSessionId(dataDir, 'slack:thread-1'), null);
  } finally {
    console.error = originalConsoleError;
  }

  const files = readdirSync(dataDir);
  const corruptName = files.find((name) => name.startsWith('sessions.json.corrupt.'));

  assert.ok(corruptName);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(join(dataDir, corruptName), 'utf8'), '{"broken":');
  assert.match(errors.join('\n'), /\[ERROR\] \[session\] failed to load .*moved corrupt file to/);
});
