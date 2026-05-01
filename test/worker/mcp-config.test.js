import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWorkspaceMcpServers } from '../../src/worker.js';

function writeMcpServer(def) {
  const workspace = mkdtempSync(join(tmpdir(), 'orb-worker-mcp-'));
  const dir = join(workspace, '.claude', 'mcp-servers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'foo.json'), `${JSON.stringify({ foo: def }, null, 2)}\n`);
  return workspace;
}

test('collectWorkspaceMcpServers passes alwaysLoad=true through to mcp config', () => {
  const workspace = writeMcpServer({
    command: 'node',
    alwaysLoad: true,
  });

  const result = collectWorkspaceMcpServers(workspace, {});

  assert.equal(result.foo.alwaysLoad, true);
});

test('collectWorkspaceMcpServers omits alwaysLoad when not set', () => {
  const workspace = writeMcpServer({
    command: 'node',
  });

  const result = collectWorkspaceMcpServers(workspace, {});

  assert.equal(result.foo.alwaysLoad, undefined);
});

test('collectWorkspaceMcpServers does not pass arbitrary unknown fields', () => {
  const workspace = writeMcpServer({
    command: 'node',
    randomField: 'x',
  });

  const result = collectWorkspaceMcpServers(workspace, {});

  assert.equal(result.foo.randomField, undefined);
});
