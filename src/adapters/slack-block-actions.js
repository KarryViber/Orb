import { spawn as spawnProcess } from 'node:child_process';
import { info, error as logError, warn } from '../log.js';
import { updateBlockActionCard } from './slack-block-action-card.js';
import {
  createHandlerLog,
  HANDLER_EXTENSIONS,
  HANDLER_HARD_TIMEOUT_MS,
  HANDLER_LOG_DIR,
  HANDLER_PID_LOG,
  getHandlerCommand,
  resolveHandlerScript,
  runBlockActionScript,
} from './slack-block-action-script.js';

const TAG = 'slack';

// @internal: test-only — constants below are exported so tests can introspect them; not part of public API.
export const BLOCK_ACTION_HANDLER_RE = /^[a-z][a-z0-9_]{0,63}$/;
// @internal: adapter-owned action ids must never route to user handler scripts.
export const ORB_RESERVED_ACTION_IDS = new Set([
  'orb_approve_once',
  'orb_approve_session',
  'orb_approve_always',
  'orb_deny',
]);
// @internal: test-only
export { HANDLER_EXTENSIONS };
// @internal: test-only
const HANDLER_DEDUP_TTL = 10 * 60 * 1000;
// @internal: test-only
export { HANDLER_HARD_TIMEOUT_MS };
// @internal: test-only
export { HANDLER_LOG_DIR };
// @internal: test-only
export { HANDLER_PID_LOG };

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

async function updateMissingHandlerCard({ updateCard, actionId, userId, logMessage, overrideText = null }) {
  warn(TAG, logMessage);
  try {
    await updateCard(overrideText || `⚠️ 未注册 handler: ${formatSlackInlineCode(actionId || 'unknown')} · <@${userId || 'unknown'}>`);
  } catch (err) {
    logError(TAG, `failed to update unregistered handler message: ${err.message}`);
  }
}

function attachHandlerCompletion({ completion, inFlight, messageTs, updateCard, rawActionId }) {
  completion.then((result) => {
    if (result.timedOut) {
      releaseBlockActionMessage(inFlight, messageTs);
      updateCard(`⚠️ handler 超时（5min）已强制终止: ${formatSlackInlineCode(rawActionId)}`).catch((updateErr) => {
        logError(TAG, `failed to update handler timeout message: ${updateErr.message}`);
      });
    } else if (result.code && result.code !== 0) {
      releaseBlockActionMessage(inFlight, messageTs);
      logError(TAG, `handler exited nonzero: action_id=${rawActionId} message_ts=${messageTs} code=${result.code}`);
    }
  }).catch((err) => {
    releaseBlockActionMessage(inFlight, messageTs);
    logError(TAG, `handler spawn error: action_id=${rawActionId} message_ts=${messageTs} error=${err.message}`);
    updateCard(`⚠️ handler 启动失败: ${formatSlackInlineCode(rawActionId)}`).catch((updateErr) => {
      logError(TAG, `failed to update handler spawn error message: ${updateErr.message}`);
    });
  });
}

function findQuestionBlock(blocks, requestId, qIdx) {
  if (!requestId || !Number.isInteger(qIdx)) return null;
  const blockId = `orb_auq_${requestId}_question_${qIdx}`;
  return (blocks || []).find((block) => block?.block_id === blockId) || null;
}

function findQuestionTextByBlockId(blocks, requestId, qIdx) {
  const text = findQuestionBlock(blocks, requestId, qIdx)?.text?.text || null;
  if (!text) return null;
  const newlineIndex = text.indexOf('\n');
  return newlineIndex === -1 ? text : text.slice(newlineIndex + 1);
}

function findHeaderByBlockId(blocks, requestId, qIdx) {
  const block = findQuestionBlock(blocks, requestId, qIdx);
  const fieldText = Array.isArray(block?.fields) ? block.fields.find((field) => field?.text)?.text : null;
  if (fieldText) return fieldText;
  const text = block?.text?.text || '';
  const firstLine = text.split('\n')[0]?.replace(/^\*/, '').replace(/\*$/, '').trim();
  return firstLine ? firstLine.slice(0, 12) : null;
}

function decodeStructuredValue(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim().startsWith('{')) return null;
  try {
    const payload = JSON.parse(rawValue);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function selectedOptionValues(action) {
  const values = [];
  if (action.value) values.push(action.value);
  if (action.selected_option?.value) values.push(action.selected_option.value);
  if (Array.isArray(action.selected_options)) {
    for (const option of action.selected_options) {
      if (option?.value) values.push(option.value);
    }
  }
  return values;
}

function selectedOtherPayload(action) {
  for (const value of selectedOptionValues(action)) {
    const payload = decodeStructuredValue(value);
    if (payload?.optIdx === 'other') return payload;
  }
  return null;
}

function primaryValuePayload(action) {
  const other = selectedOtherPayload(action);
  if (other) return other;
  for (const value of selectedOptionValues(action)) {
    const payload = decodeStructuredValue(value);
    if (payload) return payload;
  }
  return null;
}

// @internal: test-only
export function buildBlockActionContext({ body, action, rawActionId, userId, channel, messageTs, threadTs, profilePaths, originalBlocks }) {
  const rawValue = action.value || action.selected_option?.value || action.selected_options?.[0]?.value || '';
  const valuePayload = primaryValuePayload(action);
  const selectedOptions = Array.isArray(action.selected_options)
    ? action.selected_options.map((option) => ({ text: option.text?.text || '', value: option.value || '' }))
    : null;
  const selectedOption = action.selected_option
    ? { text: action.selected_option.text?.text || '', value: action.selected_option.value || '' }
    : null;
  const requestId = valuePayload?.requestId || null;
  const questionIdx = Number.isInteger(valuePayload?.qIdx) ? valuePayload.qIdx : null;
  const optionIdx = Number.isInteger(valuePayload?.optIdx) || valuePayload?.optIdx === 'other' ? valuePayload.optIdx : null;
  const optionLabel = action.text?.text || selectedOption?.text || selectedOptions?.[0]?.text || null;
  return {
    action_id: rawActionId,
    value: action.value ?? null,
    block_id: action.block_id || null,
    requestId,
    question_idx: questionIdx,
    option_idx: optionIdx,
    option_label: optionLabel,
    question: findQuestionTextByBlockId(originalBlocks, requestId, questionIdx),
    header: findHeaderByBlockId(originalBlocks, requestId, questionIdx),
    socket_path: process.env.ORB_SCHEDULER_SOCKET || null,
    trigger_id: body.trigger_id || null,
    is_multi: /^orb_auq_select_\d+$/.test(rawActionId),
    selected_option: selectedOption,
    selected_options: selectedOptions,
    user_id: userId,
    channel,
    message_ts: messageTs,
    thread_ts: threadTs,
    profile: profilePaths?.name || null,
    response_url: body.response_url || body.response_urls?.[0]?.response_url || null,
    message_blocks: originalBlocks,
  };
}

// @internal: test-only
export function resolveHandlerActionId(rawActionId, action = null) {
  if (/^orb_auq_pick_\d+_other$/.test(rawActionId)) return 'orb_auq_other_open';
  if (/^orb_auq_select_\d+$/.test(rawActionId) && action && selectedOtherPayload(action)) return 'orb_auq_other_open';
  if (/^orb_auq_pick_\d+_\d+$/.test(rawActionId)) return 'orb_auq_pick';
  if (/^orb_auq_select_\d+$/.test(rawActionId)) return 'orb_auq_stash';
  if (rawActionId === 'orb_auq_submit') return 'orb_auq_submit';
  return rawActionId;
}

// @internal: test-only
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

// @internal: test-only
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

export { updateBlockActionCard, resolveHandlerScript, getHandlerCommand };

function parseOtherCallback(callbackId) {
  const prefix = 'orb_auq_other_';
  if (!String(callbackId || '').startsWith(prefix)) return null;
  const suffix = String(callbackId).slice(prefix.length);
  const idx = suffix.lastIndexOf('_');
  if (idx === -1) return null;
  const requestId = suffix.slice(0, idx);
  const qIdx = Number.parseInt(suffix.slice(idx + 1), 10);
  if (!requestId || !Number.isInteger(qIdx)) return null;
  return { requestId, qIdx };
}

function extractViewInputValue(view) {
  const block = view?.state?.values?.orb_auq_other_value;
  if (!block || typeof block !== 'object') return '';
  for (const item of Object.values(block)) {
    if (item?.type === 'plain_text_input') return String(item.value || '').trim();
  }
  return '';
}

function buildViewSubmissionContext({ body, profilePaths }) {
  const parsed = parseOtherCallback(body.view?.callback_id);
  let metadata = {};
  try {
    metadata = JSON.parse(body.view?.private_metadata || '{}');
  } catch {
    metadata = {};
  }
  const requestId = String(metadata.requestId || parsed?.requestId || '');
  const qIdx = Number.isInteger(metadata.qIdx) ? metadata.qIdx : parsed?.qIdx;
  return {
    action_id: 'orb_auq_other_submit',
    requestId,
    question_idx: Number.isInteger(qIdx) ? qIdx : null,
    option_idx: 'other',
    option_label: extractViewInputValue(body.view),
    question: metadata.question || null,
    header: metadata.header || null,
    socket_path: metadata.socket_path || process.env.ORB_SCHEDULER_SOCKET || null,
    trigger_id: body.trigger_id || null,
    is_multi: Boolean(metadata.is_multi),
    user_id: body.user?.id || '',
    channel: metadata.channel || null,
    message_ts: metadata.message_ts || null,
    thread_ts: metadata.thread_ts || null,
    profile: profilePaths?.name || null,
    response_url: metadata.response_url || null,
    view: body.view || null,
  };
}

export async function dispatchViewSubmissionHandler({
  body,
  ack,
  slack,
  getProfilePaths,
  resolveLedger,
  spawnImpl = spawnProcess,
  logDir = HANDLER_LOG_DIR,
  pidLog = HANDLER_PID_LOG,
  handlerTimeoutMs = HANDLER_HARD_TIMEOUT_MS,
}) {
  const callbackId = String(body.view?.callback_id || '');
  if (!parseOtherCallback(callbackId)) {
    try { await ack(); } catch (_) {}
    return;
  }

  const value = extractViewInputValue(body.view);
  if (!value) {
    try {
      await ack({
        response_action: 'errors',
        errors: { orb_auq_other_value: 'Please enter a value.' },
      });
    } catch (_) {}
    return;
  }
  try { await ack(); } catch (_) {}

  const userId = body.user?.id || '';
  let profilePaths = null;
  try {
    profilePaths = getProfilePaths ? getProfilePaths(userId) : null;
  } catch (err) {
    logError(TAG, `profile resolution failed for modal user=${userId}: ${err.message}`);
  }
  const profileName = profilePaths?.name || 'unknown';
  const handlerActionId = 'orb_auq_other_submit';
  const handlerPath = resolveHandlerScript(profilePaths, handlerActionId);
  if (!handlerPath) {
    warn(TAG, `unregistered modal handler: action_id=${handlerActionId} profile=${profileName}`);
    return;
  }

  const context = buildViewSubmissionContext({ body, profilePaths });
  const messageTs = context.message_ts || body.view?.id || 'modal';
  const logPath = createHandlerLog({
    logDir,
    actionId: handlerActionId,
    messageTs,
    profileName,
    userId,
    context,
  });
  try {
    const { child, completion } = runBlockActionScript({
      handlerPath,
      profilePaths,
      context,
      spawnImpl,
      timeoutMs: handlerTimeoutMs,
      logPath,
      pidLog,
      profileName,
      actionId: handlerActionId,
      messageTs,
    });
    completion.catch((err) => {
      logError(TAG, `modal handler spawn error: action_id=${handlerActionId} error=${err.message}`);
    }).then((result) => {
      if (result?.timedOut) logError(TAG, `modal handler timed out: action_id=${handlerActionId}`);
      else if (result?.code && result.code !== 0) logError(TAG, `modal handler exited nonzero: action_id=${handlerActionId} code=${result.code}`);
    });
    try {
      resolveLedger?.({ userId })?.recordAdapterEvent?.({
        source: 'slack.view_submission',
        eventType: 'adapter.block_action.handler_spawned',
        channel: context.channel,
        ts: context.message_ts,
        platform: 'slack',
        meta: { actionId: handlerActionId, callbackId },
      });
    } catch (err) {
      warn(TAG, `ledger record failed: ${err.message}`);
    }
    info(TAG, `modal handler spawned: pid=${child.pid} profile=${profileName} action_id=${handlerActionId} callback_id=${callbackId} log=${logPath}`);
  } catch (err) {
    logError(TAG, `failed to spawn modal handler: action_id=${handlerActionId} error=${err.message}`);
  }
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
  handlerTimeoutMs = HANDLER_HARD_TIMEOUT_MS,
}) {
  const channel = body.channel?.id || body.container?.channel_id;
  const messageTs = body.container?.message_ts || body.message?.ts;
  const threadTs = body.message?.thread_ts || messageTs || null;
  const userId = body.user?.id || '';
  const rawActionId = String(actionId || '').replace(/-/g, '_');
  const handlerActionId = resolveHandlerActionId(rawActionId, action);
  const skipProcessingUpdate = handlerActionId === 'orb_auq_stash' || handlerActionId === 'orb_auq_other_open';
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
    await updateMissingHandlerCard({
      updateCard,
      actionId: rawActionId,
      userId,
      logMessage: `rejected block_action with invalid action_id: ${rawActionId || 'unknown'}`,
    });
    return;
  }

  if (ORB_RESERVED_ACTION_IDS.has(handlerActionId)) {
    await updateMissingHandlerCard({
      updateCard,
      actionId: handlerActionId,
      userId,
      overrideText: '⏰ 此权限请求已过期或因 daemon 重启失效，请触发动作重新弹卡。',
      logMessage: `orb_* approval fallthrough (likely daemon restart / timeout): action_id=${handlerActionId} profile=unknown`,
    });
    return;
  }

  let profilePaths = null;
  try {
    profilePaths = getProfilePaths ? getProfilePaths(userId) : null;
  } catch (err) {
    logError(TAG, `profile resolution failed for handler user=${userId}: ${err.message}`);
  }
  const profileName = profilePaths?.name || 'unknown';

  const handlerPath = resolveHandlerScript(profilePaths, handlerActionId);
  if (!handlerPath) {
    await updateMissingHandlerCard({
      updateCard,
      actionId: handlerActionId,
      userId,
      logMessage: `unregistered handler: action_id=${rawActionId} profile=${profileName}`,
    });
    return;
  }

  if (!skipProcessingUpdate && inFlight.has(messageTs)) {
    info(TAG, `block_action dedup: action_id=${rawActionId || 'unknown'} message_ts=${messageTs}`);
    return;
  }
  if (!skipProcessingUpdate) rememberBlockActionMessage(inFlight, messageTs);

  if (!skipProcessingUpdate) {
    const processingText = `⏳ 处理中… <@${userId}> clicked ${formatSlackInlineCode(rawActionId)}`;
    try {
      await updateCard(processingText);
    } catch (err) {
      logError(TAG, `failed to update handler processing message: ${err.message}`);
    }
  }

  const context = buildBlockActionContext({ body, action, rawActionId, userId, channel, messageTs, threadTs, profilePaths, originalBlocks });

  const logPath = createHandlerLog({
    logDir,
    actionId: rawActionId,
    messageTs,
    profileName,
    userId,
    context,
  });
  try {
    const { child, completion } = runBlockActionScript({
      handlerPath,
      profilePaths,
      context,
      spawnImpl,
      timeoutMs: handlerTimeoutMs,
      logPath,
      pidLog,
      profileName,
      actionId: handlerActionId,
      messageTs,
    });
    attachHandlerCompletion({ completion, inFlight, messageTs, updateCard, rawActionId });
    info(TAG, `handler spawned: pid=${child.pid} profile=${profileName} action_id=${rawActionId} message_ts=${messageTs} log=${logPath}`);
  } catch (err) {
    releaseBlockActionMessage(inFlight, messageTs);
    logError(TAG, `failed to spawn handler: action_id=${rawActionId} message_ts=${messageTs} error=${err.message}`);
    try {
      await updateCard(`⚠️ handler 启动失败: ${formatSlackInlineCode(rawActionId)}`);
    } catch (updateErr) {
      logError(TAG, `failed to update handler launch error message: ${updateErr.message}`);
    }
  }
}
