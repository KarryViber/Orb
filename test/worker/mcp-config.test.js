import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkerMcpConfig, collectWorkspaceMcpServers } from '../../src/worker-mcp-boot.js';

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

test('buildWorkerMcpConfig injects Slack thread env into workspace MCP servers', () => {
  const workspace = writeMcpServer({
    command: 'python3',
    args: ['tools/skill-manager-mcp/server.py'],
    alwaysLoad: true,
  });

  const configPath = buildWorkerMcpConfig({
    threadTs: '1746144000.000100',
    channel: 'C123',
    userId: 'U123',
    workspace,
  });
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  assert.equal(config.mcpServers.foo.env.ORB_CHANNEL, 'C123');
  assert.equal(config.mcpServers.foo.env.ORB_THREAD_TS, '1746144000.000100');
  assert.equal(config.mcpServers.foo.env.ORB_USER_ID, 'U123');
  assert.equal(config.mcpServers.foo.env.ORB_WORKSPACE_DIR, workspace);
});
