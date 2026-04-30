import { spawn as spawnProcess } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { info, error as logError, warn } from '../log.js';
import { markdownToMrkdwn } from './slack-format.js';

const TAG = 'slack';
const __dirname = dirname(fileURLToPath(import.meta.url));

export const BLOCK_ACTION_HANDLER_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const HANDLER_EXTENSIONS = ['.py', '.sh', '.js'];
export const HANDLER_DEDUP_TTL = 10 * 60 * 1000;
export const HANDLER_LOG_DIR = join(__dirname, '..', '..', 'logs', 'handlers');
export const HANDLER_PID_LOG = join(HANDLER_LOG_DIR, 'pids.log');

function extractBlockKitText(blocks) {
  const parts = [];
  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'section') {
      if (block.text?.text) parts.push(block.text.text);
      if (Array.isArray(block.fields)) {
        for (const f of block.fields) {
          if (f?.text) parts.push(f.text);
        }
      }
    } else if (block.type === 'context' && Array.isArray(block.elements)) {
      for (const el of block.elements) {
        if (el?.text) parts.push(el.text);
      }
    }
  }
  return parts.join('\n');
}

function formatSlackInlineCode(value) {
  return `\`${String(value ?? 'unknown').replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;
}

export function rememberBlockActionMessage(inFlight, messageTs, ttl = HANDLER_DEDUP_TTL) {
  inFlight.add(messageTs);
  const timer = setTimeout(() => {
    inFlight.delete(messageTs);
  }, ttl);
  timer.unref?.();
  return timer;
}

export function releaseBlockActionMessage(inFlight, messageTs) {
  if (!messageTs) return;
  inFlight.delete(messageTs);
}

export function isBlockActionProcessingMessage(message) {
  if (!message) return false;
  const text = [message.text || '', extractBlockKitText(message.blocks)]
    .filter(Boolean)
    .join('\n');
  return text.includes('⏳ 处理中…');
}

export function handleBlockActionMessageChanged(event, inFlight) {
  const messageTs = event?.message?.ts || event?.previous_message?.ts;
  if (!messageTs || !inFlight.has(messageTs)) return false;
  if (isBlockActionProcessingMessage(event.message)) return false;
  releaseBlockActionMessage(inFlight, messageTs);
  info(TAG, `block_action released: message_ts=${messageTs}`);
  return true;
}

export async function updateBlockActionCard({
  slack,
  resolveLedger,
  channel,
  messageTs,
  text,
  originalBlocks = null,
  ledgerHint = {},
}) {
  const safeText = markdownToMrkdwn(String(text || ''));
  const statusBlock = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: safeText }],
  };
  const preserved = Array.isArray(originalBlocks)
    ? originalBlocks.filter((block) => block && block.type !== 'actions')
    : [];
  const blocks = preserved.length
    ? [statusBlock, ...preserved]
    : [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: safeText },
      },
    ];
  const result = await slack.chat.update({
    channel,
    ts: messageTs,
    text: safeText,
    blocks,
  });
  const ledger = resolveLedger?.(ledgerHint);
  try {
    ledger?.recordAdapterEvent({
      source: 'slack._updateBlockActionCard',
      eventType: 'adapter.handler.update',
      channel,
      ts: result?.ts || messageTs,
      platform: 'slack',
      meta: { messageTs },
    });
  } catch (err) {
    warn(TAG, `ledger record failed: ${err.message}`);
  }
  return result;
}

export function resolveHandlerScript(profilePaths, actionId) {
  if (!profilePaths?.scriptsDir) return null;
  const handlersDir = join(profilePaths.scriptsDir, 'handlers');
  for (const ext of HANDLER_EXTENSIONS) {
    const candidate = join(handlersDir, `${actionId}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function getHandlerCommand(handlerPath) {
  if (handlerPath.endsWith('.py')) return { command: 'python3', args: [handlerPath] };
  if (handlerPath.endsWith('.sh')) return { command: '/bin/bash', args: [handlerPath] };
  return { command: process.execPath, args: [handlerPath] };
}

export async function dispatchBlockActionHandler({
  body,
  action,
  actionId,
  slack,
  getProfilePaths,
  resolveLedger,
  inFlight,
  spawnImpl = spawnProcess,
  logDir = HANDLER_LOG_DIR,
  pidLog = HANDLER_PID_LOG,
}) {
  const channel = body.channel?.id || body.container?.channel_id;
  const messageTs = body.container?.message_ts || body.message?.ts;
  const threadTs = body.message?.thread_ts || messageTs || null;
  const userId = body.user?.id || '';
  const rawActionId = String(actionId || '').replace(/-/g, '_');
  const originalBlocks = Array.isArray(body.message?.blocks) ? body.message.blocks : null;
  const updateCard = (text) => updateBlockActionCard({
    slack,
    resolveLedger,
    channel,
    messageTs,
    text,
    originalBlocks,
    ledgerHint: { userId },
  });

  if (!channel || !messageTs) {
    warn(TAG, `block_action missing channel/message_ts: action_id=${rawActionId || 'unknown'}`);
    return;
  }

  if (!BLOCK_ACTION_HANDLER_RE.test(rawActionId)) {
    warn(TAG, `rejected block_action with invalid action_id: ${rawActionId || 'unknown'}`);
    try {
      await updateCard(`⚠️ 未注册 handler: ${formatSlackInlineCode(rawActionId || 'unknown')} · <@${userId || 'unknown'}>`);
    } catch (err) {
      logError(TAG, `failed to update invalid handler message: ${err.message}`);
    }
    return;
  }

  let profilePaths = null;
  try {
    profilePaths = getProfilePaths ? getProfilePaths(userId) : null;
  } catch (err) {
    logError(TAG, `profile resolution failed for handler user=${userId}: ${err.message}`);
  }
  const profileName = profilePaths?.name || 'unknown';

  const handlerPath = resolveHandlerScript(profilePaths, rawActionId);
  if (!handlerPath) {
    warn(TAG, `unregistered handler: action_id=${rawActionId} profile=${profileName}`);
    try {
      await updateCard(`⚠️ 未注册 handler: ${formatSlackInlineCode(rawActionId)} · <@${userId || 'unknown'}>`);
    } catch (err) {
      logError(TAG, `failed to update unregistered handler message: ${err.message}`);
    }
    return;
  }

  if (inFlight.has(messageTs)) {
    info(TAG, `block_action dedup: action_id=${rawActionId || 'unknown'} message_ts=${messageTs}`);
    return;
  }
  rememberBlockActionMessage(inFlight, messageTs);

  const processingText = `⏳ 处理中… <@${userId}> clicked ${formatSlackInlineCode(rawActionId)}`;
  try {
    await updateCard(processingText);
  } catch (err) {
    logError(TAG, `failed to update handler processing message: ${err.message}`);
  }

  const responseUrl = body.response_url || body.response_urls?.[0]?.response_url || null;
  const context = {
    action_id: rawActionId,
    value: action.value ?? null,
    user_id: userId,
    channel,
    message_ts: messageTs,
    thread_ts: threadTs,
    profile: profilePaths?.name || null,
    response_url: responseUrl,
    message_blocks: originalBlocks,
  };

  mkdirSync(logDir, { recursive: true });
  const logPath = join(
    logDir,
    `${rawActionId}-${Date.now()}-${String(messageTs).replace(/[^\d]+/g, '_') || 'message'}.log`
  );
  writeFileSync(
    logPath,
    `${new Date().toISOString()} action_id=${rawActionId} profile=${profileName} user_id=${userId || 'unknown'}\n${JSON.stringify(context)}\n\n`,
    { flag: 'a' },
  );

  let logFd = null;
  try {
    const { command, args } = getHandlerCommand(handlerPath);
    logFd = openSync(logPath, 'a');
    const child = spawnImpl(command, args, {
      cwd: profilePaths?.scriptsDir || undefined,
      detached: true,
      stdio: ['pipe', logFd, logFd],
    });

    child.on('error', (err) => {
      releaseBlockActionMessage(inFlight, messageTs);
      logError(TAG, `handler spawn error: action_id=${rawActionId} message_ts=${messageTs} error=${err.message}`);
      updateCard(`⚠️ handler 启动失败: ${formatSlackInlineCode(rawActionId)}`).catch((updateErr) => {
        logError(TAG, `failed to update handler spawn error message: ${updateErr.message}`);
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(context)}\n`);
    child.stdin.end();
    child.unref();
    closeSync(logFd);
    logFd = null;

    appendFileSync(
      pidLog,
      `${new Date().toISOString()} pid=${child.pid} profile=${profileName} action_id=${rawActionId} message_ts=${messageTs}\n`,
      'utf-8',
    );
    info(TAG, `handler spawned: pid=${child.pid} profile=${profileName} action_id=${rawActionId} message_ts=${messageTs} log=${logPath}`);
  } catch (err) {
    releaseBlockActionMessage(inFlight, messageTs);
    logError(TAG, `failed to spawn handler: action_id=${rawActionId} message_ts=${messageTs} error=${err.message}`);
    try {
      await updateCard(`⚠️ handler 启动失败: ${formatSlackInlineCode(rawActionId)}`);
    } catch (updateErr) {
      logError(TAG, `failed to update handler launch error message: ${updateErr.message}`);
    }
  } finally {
    if (logFd != null) closeSync(logFd);
  }
}
