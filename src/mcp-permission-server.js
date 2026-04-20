import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import net from 'node:net';

const SERVER_NAME = 'orb_permission';
const TOOL_NAME = 'orb_request_permission';
const STDIO_ENCODING = 'utf8';
const PERMISSION_TIMEOUT_MS = parseInt(process.env.ORB_PERMISSION_TIMEOUT_MS, 10) || 300_000;
const threadTs = process.env.ORB_THREAD_TS || '';
const channel = process.env.ORB_CHANNEL || '';
const userId = process.env.ORB_USER_ID || '';
const schedulerSocketPath = process.env.ORB_SCHEDULER_SOCKET || '';
const debugLogPath = process.env.ORB_MCP_PERMISSION_LOG || '';

process.stdin.on('error', () => {});
process.stdout.on('error', () => {});

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  parseIncomingMessages();
});

function parseIncomingMessages() {
  while (true) {
    const linePayload = tryReadJsonLine(buffer);
    if (linePayload) {
      buffer = linePayload.rest;
      handleParsedBody(linePayload.body);
      continue;
    }

    const header = findHeaderBoundary(buffer);
    if (!header) return;

    const headerText = buffer.subarray(0, header.index).toString(STDIO_ENCODING);
    const contentLength = parseContentLength(headerText);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      logError(`invalid Content-Length header: ${headerText}`);
      process.exitCode = 1;
      return;
    }

    const bodyStart = header.index + header.length;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) return;

    const body = buffer.subarray(bodyStart, bodyEnd).toString(STDIO_ENCODING);
    buffer = buffer.subarray(bodyEnd);

    handleParsedBody(body);
  }
}

function parseContentLength(headerText) {
  const match = headerText.match(/content-length:\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : NaN;
}

function findHeaderBoundary(bufferValue) {
  const crlfIndex = bufferValue.indexOf('\r\n\r\n');
  const lfIndex = bufferValue.indexOf('\n\n');

  if (crlfIndex === -1 && lfIndex === -1) return null;
  if (crlfIndex !== -1 && (lfIndex === -1 || crlfIndex < lfIndex)) {
    return { index: crlfIndex, length: 4 };
  }
  return { index: lfIndex, length: 2 };
}

function tryReadJsonLine(bufferValue) {
  const firstByte = bufferValue[0];
  if (firstByte !== 0x7b && firstByte !== 0x5b) return null;
  const newlineIndex = bufferValue.indexOf('\n');
  if (newlineIndex === -1) return null;
  return {
    body: bufferValue.subarray(0, newlineIndex).toString(STDIO_ENCODING).trim(),
    rest: bufferValue.subarray(newlineIndex + 1),
  };
}

function handleParsedBody(body) {
  let message;
  try {
    message = JSON.parse(body);
  } catch (err) {
    logError(`failed to parse JSON-RPC payload: ${err.message}`);
    return;
  }

  debugLog(`IN ${body}`);

  handleMessage(message).catch((err) => {
    logError(`message handling failed: ${err.stack || err.message}`);
    if (message?.id !== undefined) {
      sendMessage(jsonRpcError(message.id, -32603, 'Internal error'));
    }
  });
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.method === 'notifications/initialized') return;
  if (message.method?.startsWith('notifications/')) return;
  if (message.method === '$/cancelRequest') return;

  if (message.id === undefined) return;

  switch (message.method) {
    case 'initialize':
      sendMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || '2025-03-26',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version: '0.1.0',
          },
        },
      });
      return;
    case 'tools/list':
      sendMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: TOOL_NAME,
              description: 'Relay Claude Code permission requests to the Orb scheduler.',
              inputSchema: {
                type: 'object',
                properties: {
                  tool_name: { type: 'string' },
                  input: { type: 'object' },
                  tool_use_id: { type: 'string' },
                },
                required: ['tool_name', 'input', 'tool_use_id'],
                additionalProperties: true,
              },
            },
          ],
        },
      });
      return;
    case 'tools/call':
      await handleToolCall(message);
      return;
    case 'ping':
      sendMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {},
      });
      return;
    default:
      sendMessage(jsonRpcError(message.id, -32601, `Method not found: ${message.method}`));
  }
}

async function handleToolCall(message) {
  const toolName = message.params?.name;
  if (toolName !== TOOL_NAME) {
    sendMessage(jsonRpcError(message.id, -32602, `Unknown tool: ${toolName}`));
    return;
  }

  const args = message.params?.arguments || {};
  if (!args.tool_name || !args.tool_use_id || typeof args.input !== 'object' || args.input == null) {
    sendMessage(jsonRpcError(message.id, -32602, 'Expected arguments.tool_name, arguments.input, and arguments.tool_use_id'));
    return;
  }

  const decision = await requestSchedulerDecision({
    type: 'permission_request',
    requestId: randomUUID(),
    toolName: String(args.tool_name),
    toolInput: args.input,
    toolUseId: String(args.tool_use_id),
    threadTs,
    channel,
    userId,
    metaToolUseId: message.params?._meta?.['claudecode/toolUseId'] || null,
  });

  const text = decision.allow
    ? JSON.stringify({ behavior: 'allow', updatedInput: args.input })
    : JSON.stringify({ message: decision.reason || 'Denied by Orb approval flow' });

  sendMessage({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      content: [{ type: 'text', text }],
    },
  });
}

function requestSchedulerDecision(payload) {
  return new Promise((resolve) => {
    if (!schedulerSocketPath) {
      resolve({ allow: false, reason: 'scheduler unavailable: ORB_SCHEDULER_SOCKET missing' });
      return;
    }

    const socket = net.createConnection(schedulerSocketPath);
    let settled = false;
    let responseBuffer = '';
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        allow: false,
        reason: `timeout: no response from Slack approval in ${Math.round(PERMISSION_TIMEOUT_MS / 1000)}s`,
      });
    }, PERMISSION_TIMEOUT_MS);

    const finish = (decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      socket.destroy();
      resolve(normalizeDecision(decision));
    };

    socket.setEncoding(STDIO_ENCODING);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk) => {
      responseBuffer += chunk;
      const newlineIndex = responseBuffer.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = responseBuffer.slice(0, newlineIndex).trim();
      responseBuffer = responseBuffer.slice(newlineIndex + 1);
      if (!line) return;

      try {
        finish(JSON.parse(line));
      } catch (err) {
        finish({ allow: false, reason: `scheduler response parse error: ${err.message}` });
      }
    });
    socket.on('error', (err) => {
      finish({ allow: false, reason: `scheduler unavailable: ${err.message}` });
    });
    socket.on('end', () => {
      if (!settled) {
        finish({ allow: false, reason: 'scheduler closed permission socket before replying' });
      }
    });
  });
}

function normalizeDecision(decision) {
  if (decision?.allow) {
    return {
      allow: true,
      reason: decision.reason || 'allow',
    };
  }

  return {
    allow: false,
    reason: decision?.reason || 'Denied by Orb approval flow',
  };
}

function sendMessage(message) {
  const body = JSON.stringify(message);
  debugLog(`OUT ${body}`);
  process.stdout.write(`${body}\n`);
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

function logError(message) {
  debugLog(`ERR ${message}`);
  process.stderr.write(`[mcp-permission-server] ${message}\n`);
}

function debugLog(message) {
  if (!debugLogPath) return;
  try {
    appendFileSync(debugLogPath, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}
