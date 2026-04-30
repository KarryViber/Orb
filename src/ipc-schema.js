export const IPC_TYPES = {
  TASK: 'task',
  INJECT: 'inject',
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  TURN_COMPLETE: 'turn_complete',
  CC_EVENT: 'cc_event',
  INJECT_FAILED: 'inject_failed',
  ERROR: 'error',
  RESULT: 'result',
};

function requireFields(payload, fields, factoryName) {
  for (const field of fields) {
    if (!Object.hasOwn(payload || {}, field) || payload[field] === undefined) {
      throw new TypeError(`${factoryName}: missing required field ${field}`);
    }
  }
}

function normalizeOptional(value) {
  return value ?? null;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function makeTask(payload = {}) {
  requireFields(payload, ['userText', 'threadTs', 'platform'], 'makeTask');
  return {
    type: IPC_TYPES.TASK,
    userText: payload.userText,
    fileContent: payload.fileContent ?? '',
    imagePaths: normalizeArray(payload.imagePaths),
    threadTs: payload.threadTs,
    channel: normalizeOptional(payload.channel),
    userId: normalizeOptional(payload.userId),
    platform: payload.platform,
    teamId: normalizeOptional(payload.teamId),
    attemptId: normalizeOptional(payload.attemptId),
    channelSemantics: normalizeOptional(payload.channelSemantics),
    channelMeta: normalizeOptional(payload.channelMeta),
    origin: normalizeOptional(payload.origin),
    threadHistory: normalizeOptional(payload.threadHistory),
    profile: normalizeOptional(payload.profile),
    model: normalizeOptional(payload.model),
    effort: normalizeOptional(payload.effort),
    maxTurns: normalizeOptional(payload.maxTurns),
    mode: normalizeOptional(payload.mode),
    priorConversation: normalizeOptional(payload.priorConversation),
    disablePermissionPrompt: payload.disablePermissionPrompt ?? false,
    fragments: normalizeArray(payload.fragments),
  };
}

export function makeInject(payload = {}) {
  requireFields(payload, ['userText'], 'makeInject');
  return {
    type: IPC_TYPES.INJECT,
    injectId: normalizeOptional(payload.injectId),
    attemptId: normalizeOptional(payload.attemptId),
    userText: payload.userText,
    fileContent: normalizeOptional(payload.fileContent),
    imagePaths: normalizeOptional(payload.imagePaths),
    channelMeta: normalizeOptional(payload.channelMeta),
    fragments: normalizeArray(payload.fragments),
    origin: normalizeOptional(payload.origin),
  };
}

export function makeTurnStart(payload = {}) {
  return {
    type: IPC_TYPES.TURN_START,
    injectId: normalizeOptional(payload.injectId),
    attemptId: normalizeOptional(payload.attemptId),
  };
}

export function makeTurnEnd() {
  return {
    type: IPC_TYPES.TURN_END,
  };
}

export function makeTurnComplete(payload = {}) {
  requireFields(payload, ['text', 'toolCount', 'channelSemantics'], 'makeTurnComplete');
  return {
    type: IPC_TYPES.TURN_COMPLETE,
    text: payload.text,
    toolCount: payload.toolCount,
    lastTool: normalizeOptional(payload.lastTool),
    stopReason: normalizeOptional(payload.stopReason),
    channelSemantics: payload.channelSemantics,
    gitDiffSummary: normalizeOptional(payload.gitDiffSummary),
  };
}

export function makeCcEvent(payload = {}) {
  requireFields(payload, ['turnId', 'eventType', 'payload'], 'makeCcEvent');
  return {
    type: IPC_TYPES.CC_EVENT,
    turnId: payload.turnId,
    attemptId: normalizeOptional(payload.attemptId),
    origin: normalizeOptional(payload.origin),
    eventType: payload.eventType,
    payload: payload.payload,
  };
}

export function makeInjectFailed(payload = {}) {
  requireFields(payload, ['userText'], 'makeInjectFailed');
  return {
    type: IPC_TYPES.INJECT_FAILED,
    injectId: normalizeOptional(payload.injectId),
    attemptId: normalizeOptional(payload.attemptId),
    userText: payload.userText,
    fileContent: normalizeOptional(payload.fileContent),
    imagePaths: normalizeOptional(payload.imagePaths),
    channelMeta: normalizeOptional(payload.channelMeta),
    fragments: normalizeArray(payload.fragments),
    origin: normalizeOptional(payload.origin),
  };
}

export function makeError(payload = {}) {
  requireFields(payload, ['error'], 'makeError');
  return {
    type: IPC_TYPES.ERROR,
    error: payload.error,
    errorContext: normalizeOptional(payload.errorContext),
  };
}

export function makeResult(payload = {}) {
  requireFields(payload, ['text', 'channelSemantics'], 'makeResult');
  return {
    type: IPC_TYPES.RESULT,
    text: payload.text,
    stopReason: normalizeOptional(payload.stopReason),
    channelSemantics: payload.channelSemantics,
    exitOnly: true,
    toolCount: normalizeOptional(payload.toolCount),
    lastTool: normalizeOptional(payload.lastTool),
    exitCode: normalizeOptional(payload.exitCode),
    stderrSummary: normalizeOptional(payload.stderrSummary),
  };
}
