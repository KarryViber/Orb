import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORB_MCP_PERMISSION_LOG,
  ORB_PERMISSION_TIMEOUT_MS,
  WORKSPACE_DIR,
} from './runtime-env.js';

const DEFAULT_PERMISSION_TIMEOUT_MS = ORB_PERMISSION_TIMEOUT_MS;

function sanitizeFileToken(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

function schedulerSocketPathForPid(pid) {
  return join(tmpdir(), `orb-permission-scheduler-${pid}.sock`);
}

export function buildWorkerMcpConfig({ threadTs, channel, userId, permissionTimeoutMs, workspace }) {
  const workspaceDir = workspace || WORKSPACE_DIR;
  if (!workspaceDir) {
    throw new Error('buildWorkerMcpConfig: workspace path is required');
  }
  const configPath = join(
    tmpdir(),
    `orb-mcp-${process.pid}-${sanitizeFileToken(threadTs)}.json`,
  );
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'mcp-permission-server.js');
  const baseServers = {
    orb_permission: {
      type: 'stdio',
      command: process.execPath,
      args: [serverPath],
      env: {
        ORB_SCHEDULER_SOCKET: schedulerSocketPathForPid(process.ppid),
        ORB_THREAD_TS: String(threadTs || ''),
        ORB_CHANNEL: String(channel || ''),
        ORB_USER_ID: String(userId || ''),
        ORB_PERMISSION_TIMEOUT_MS: String(permissionTimeoutMs || DEFAULT_PERMISSION_TIMEOUT_MS),
        ...(ORB_MCP_PERMISSION_LOG ? { ORB_MCP_PERMISSION_LOG } : {}),
      },
    },
  };
  const extServers = collectWorkspaceMcpServers(workspaceDir, {
    ORB_THREAD_TS: String(threadTs || ''),
    ORB_CHANNEL: String(channel || ''),
    ORB_USER_ID: String(userId || ''),
    ORB_WORKSPACE_DIR: workspaceDir,
  });
  const mergedServers = { ...extServers, ...baseServers };
  const config = {
    mcpServers: mergedServers,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`[worker] wrote MCP config: ${configPath}`);
  return configPath;
}

export function collectWorkspaceMcpServers(workspace, extraEnv) {
  const dir = join(workspace, '.claude', 'mcp-servers');
  if (!existsSync(dir)) return {};

  let fnames;
  try {
    fnames = readdirSync(dir);
  } catch (err) {
    console.warn(`[worker] failed to scan MCP registrations dir: ${err.message}`);
    return {};
  }

  const looksRelativePath = (s) => (
    typeof s === 'string' && (s.startsWith('./') || s.startsWith('../'))
  );

  const result = {};
  for (const fname of fnames) {
    if (!fname.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, fname), 'utf8'));
      for (const [name, def] of Object.entries(raw)) {
        if (!def || typeof def !== 'object' || !def.command) continue;
        const args = Array.isArray(def.args)
          ? def.args.map((arg) => (looksRelativePath(arg) ? join(workspace, arg) : arg))
          : [];
        // Workspace MCP runs inside the worker child process and can access Orb env.
        const entry = {
          type: def.type || 'stdio',
          command: def.command,
          args,
          env: { ...(def.env || {}), ...extraEnv },
        };
        if (def.alwaysLoad === true) entry.alwaysLoad = true;
        result[name] = entry;
      }
    } catch (err) {
      console.warn(`[worker] failed to load MCP registration ${fname}: ${err.message}`);
    }
  }
  return result;
}
