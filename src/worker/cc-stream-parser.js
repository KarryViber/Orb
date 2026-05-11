import { resolveTurnCompleteText } from '../worker-turn-text.js';

export function createCcStreamParseState() {
  return {
    turnBuffer: [],
    lastEmittedText: '',
    blocksSinceLastEmit: 0,
    turnStopReasonOverride: null,
  };
}

export function normalizeCcUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheCreate: usage.cache_creation_input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheCreate1h: usage.cache_creation?.ephemeral_1h_input_tokens || 0,
    cacheCreate5m: usage.cache_creation?.ephemeral_5m_input_tokens || 0,
  };
}

function hasAttachmentType(node, targetType) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((item) => hasAttachmentType(item, targetType));
  if (node.type === targetType) return true;
  if (node.attachment?.type === targetType) return true;
  for (const value of Object.values(node)) {
    if (hasAttachmentType(value, targetType)) return true;
  }
  return false;
}

function parseStreamMessage(msg, parseState = createCcStreamParseState()) {
  const state = {
    ...createCcStreamParseState(),
    ...parseState,
    turnBuffer: Array.isArray(parseState.turnBuffer) ? [...parseState.turnBuffer] : [],
  };
  const events = [];

  if (hasAttachmentType(msg, 'max_turns_reached')) {
    state.turnStopReasonOverride = 'max_turns_reached';
  }

  if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block?.type === 'text') {
        state.turnBuffer.push(block.text);
        state.blocksSinceLastEmit += 1;
        events.push({ type: 'cc_event', eventType: 'text', payload: block });
      } else if (block?.type === 'tool_use') {
        events.push({ type: 'cc_event', eventType: 'tool_use', payload: block });
      }
    }
  }

  if (msg?.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block?.type === 'tool_result') {
        events.push({ type: 'cc_event', eventType: 'tool_result', payload: block });
      }
    }
  }

  if (msg?.type === 'result') {
    const stopReason = state.turnStopReasonOverride || msg.stop_reason || msg.subtype || null;
    const usage = normalizeCcUsage(msg.usage);
    events.push({ type: 'cc_event', eventType: 'result', payload: msg, stopReason });
    const resolvedTurn = resolveTurnCompleteText({
      turnBuffer: state.turnBuffer,
      msgResult: msg.result,
      lastEmittedText: state.lastEmittedText,
      blocksSinceLastEmit: state.blocksSinceLastEmit,
    });
    events.push({ type: 'turn_result', resolvedTurn, stopReason, usage });
    if (resolvedTurn.shouldEmit) {
      state.lastEmittedText = resolvedTurn.text;
      state.blocksSinceLastEmit = 0;
    }
    state.turnBuffer = [];
    state.turnStopReasonOverride = null;
  }

  return { events, newState: state };
}

export function parseStreamLine(line, parseState = createCcStreamParseState()) {
  if (!String(line || '').trim()) {
    return { events: [], newState: parseState };
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    return {
      events: [{ type: 'parse_error', error: err, line }],
      newState: parseState,
    };
  }
  const parsedEvents = parseStreamMessage(parsed, parseState);
  return {
    events: [{ type: 'stream_msg', payload: parsed }, ...parsedEvents.events],
    newState: parsedEvents.newState,
  };
}
