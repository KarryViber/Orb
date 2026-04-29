import {
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TEXT_FINAL,
  CONTROL_PLANE_MESSAGE,
  RECEIPT_SILENT_SUPPRESSED,
  TASK_PROGRESS_APPEND,
  TASK_PROGRESS_START,
  TASK_PROGRESS_STOP,
  createTurnDeliveryRecord,
  makeTurnId,
  normalizeChannelSemantics,
  validateTurnDeliveryIntent,
} from './intents.js';
import { resolveDeliveryChannel } from './adapter-strategy.js';
import { TurnDeliveryLedger } from './ledger.js';

const STREAM_INTERRUPTED_TEXT = 'stream interrupted, continuing here';

function chunksText(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => {
      if (!chunk || typeof chunk !== 'object') return '';
      return [chunk.text, chunk.markdown_text, chunk.details, chunk.output, chunk.title]
        .filter((value) => typeof value === 'string' && value)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

function makeMutableTurnState(seed = {}) {
  return {
    turnId: String(seed.turnId || makeTurnId(seed)),
    attemptId: String(seed.attemptId || ''),
    channel: seed.channel || '',
    threadTs: seed.threadTs || '',
    platform: seed.platform || '',
    channelSemantics: normalizeChannelSemantics(seed.channelSemantics),
    streamId: seed.streamId || seed.taskCardState?.streamId || null,
    streamMessageTs: seed.streamMessageTs || null,
    taskCardState: seed.taskCardState || null,
    deliveredKeys: new Set(),
    assistantStreamTextLen: 0,
    streamFailed: false,
    streamFailureNotified: false,
  };
}

export class TurnDeliveryOrchestrator {
  constructor({ adapter, ledger, logger } = {}) {
    this.adapter = adapter || null;
    this.ledger = ledger || new TurnDeliveryLedger();
    this.logger = typeof logger === 'function' ? logger : () => {};
    this._turns = new Map();
  }

  beginTurn(seed = {}) {
    const turnId = String(seed.turnId || makeTurnId(seed));
    const state = makeMutableTurnState({ ...seed, turnId });
    this._turns.set(turnId, state);
    return state;
  }

  endTurn(turnId) {
    const state = this._turns.get(String(turnId || ''));
    if (state?.taskCardState && state.taskCardState.streamId === state.streamId) {
      state.taskCardState.streamId = null;
    }
    this._turns.delete(String(turnId || ''));
  }

  getTurnState(turnId) {
    return this._turns.get(String(turnId || '')) || null;
  }

  hasUserVisibleDelivery(turnId) {
    const state = this.getTurnState(turnId);
    if (!state) return false;
    return state.assistantStreamTextLen > 0
      || [...state.deliveredKeys].some((key) => key.includes('|assistant_text.') || key.includes('|control_plane.message'));
  }

  async emit(rawIntent) {
    const validationError = validateTurnDeliveryIntent(rawIntent);
    if (validationError) throw new Error(validationError);

    const intent = this._normalizeIntent(rawIntent);
    let turnState = this._turns.get(intent.turnId);
    if (!turnState) turnState = this.beginTurn(intent);

    if (intent.channelSemantics === 'silent' && intent.intent.startsWith('assistant_text.')) {
      return this._recordSilentSuppressed(intent, turnState, 'silent-semantics');
    }

    const strategySeed = resolveDeliveryChannel({ adapter: this.adapter, intent, turnState });
    let strategy = strategySeed;
    if (turnState.streamFailed && intent.intent === ASSISTANT_TEXT_FINAL) {
      strategy = { channel: 'postMessage', reason: 'stream-failed-fallback' };
    }

    const deliveredKey = this._deliveredKey(intent, strategy.channel);
    if (deliveredKey && turnState.deliveredKeys.has(deliveredKey)) {
      return { delivered: false, channel: strategy.channel, ts: null, reason: 'already-delivered' };
    }
    if (deliveredKey && this.ledger?.hasDeliveredKey?.(deliveredKey)) {
      return { delivered: false, channel: strategy.channel, ts: null, reason: 'replay-already-delivered' };
    }

    if (strategy.channel === 'silent') {
      const result = { delivered: false, channel: 'silent', ts: null, reason: strategy.reason };
      this._record(intent, turnState, strategy.channel, result, deliveredKey);
      return result;
    }

    try {
      const adapterResult = await this.adapter.deliver(intent, {
        channel: strategy.channel,
        reason: strategy.reason,
        turnState,
        orchestrator: this,
      });
      this._applyDeliverySideEffects(intent, turnState, strategy.channel, adapterResult);
      const result = {
        delivered: true,
        channel: strategy.channel,
        ts: adapterResult?.ts || adapterResult?.streamMessageTs || null,
        reason: strategy.reason,
      };
      if (deliveredKey) turnState.deliveredKeys.add(deliveredKey);
      this._record(intent, turnState, strategy.channel, result, deliveredKey);
      if (strategy.reason === 'stream-failed-fallback' && intent.intent === ASSISTANT_TEXT_FINAL) {
        await this.emitStreamInterruptedMarker(intent, turnState);
      }
      return result;
    } catch (err) {
      this._handleDeliveryFailure(intent, turnState, strategy.channel, err);
      if (intent.intent === ASSISTANT_TEXT_DELTA && strategy.channel === 'stream') {
        return { delivered: false, channel: strategy.channel, ts: null, reason: 'stream-delivery-failed', error: err.message };
      }
      throw err;
    }
  }

  _normalizeIntent(rawIntent) {
    const turnId = makeTurnId(rawIntent);
    return {
      ...rawIntent,
      turnId,
      attemptId: String(rawIntent.attemptId || ''),
      channel: rawIntent.channel || '',
      threadTs: rawIntent.threadTs || '',
      platform: rawIntent.platform || this.adapter?.platform || '',
      channelSemantics: normalizeChannelSemantics(rawIntent.channelSemantics),
      text: String(rawIntent.text || ''),
      source: String(rawIntent.source || ''),
      meta: rawIntent.meta && typeof rawIntent.meta === 'object' ? rawIntent.meta : {},
    };
  }

  _deliveredKey(intent, deliveryChannel) {
    const base = [
      intent.turnId,
      intent.attemptId,
      intent.intent,
      deliveryChannel,
      intent.source || '',
    ];
    if (intent.intent === ASSISTANT_TEXT_DELTA || intent.intent === TASK_PROGRESS_APPEND) {
      const id = intent.intentId || intent.meta?.intentId || intent.meta?.sequence;
      return id == null ? null : [...base, String(id)].join('|');
    }
    return base.join('|');
  }

  _applyDeliverySideEffects(intent, turnState, deliveryChannel, adapterResult) {
    if (deliveryChannel === 'stream') {
      if (intent.intent === TASK_PROGRESS_START) {
        turnState.streamId = adapterResult?.streamId || adapterResult?.stream_id || turnState.streamId;
        turnState.streamMessageTs = adapterResult?.ts || turnState.streamMessageTs;
        if (turnState.taskCardState) {
          turnState.taskCardState.streamId = turnState.streamId;
          turnState.taskCardState.failed = false;
        }
      } else if (intent.intent === ASSISTANT_TEXT_DELTA) {
        turnState.assistantStreamTextLen += intent.text.length;
      } else if (intent.intent === ASSISTANT_TEXT_FINAL || intent.intent === TASK_PROGRESS_STOP) {
        if (turnState.taskCardState?.streamId === turnState.streamId) turnState.taskCardState.streamId = null;
        turnState.streamId = null;
      }
    }
  }

  _handleDeliveryFailure(intent, turnState, deliveryChannel, err) {
    if (deliveryChannel === 'stream') {
      turnState.streamFailed = true;
      if (turnState.taskCardState) turnState.taskCardState.failed = true;
      this.logger(`[turn-delivery] stream delivery failed: ${err.message}`);
    }
  }

  _recordSilentSuppressed(intent, turnState, reason) {
    const receipt = {
      ...intent,
      intent: RECEIPT_SILENT_SUPPRESSED,
      source: intent.source || 'orchestrator.silent',
      meta: { ...intent.meta, suppressedIntent: intent.intent, reason },
    };
    const result = { delivered: false, channel: 'silent', ts: null, reason };
    this._record(receipt, turnState, 'silent', result, null);
    return result;
  }

  async emitStreamInterruptedMarker(intent, turnState) {
    if (turnState.streamFailureNotified) return null;
    turnState.streamFailureNotified = true;
    return this.emit({
      ...intent,
      intent: CONTROL_PLANE_MESSAGE,
      source: 'orchestrator.stream_failure',
      text: STREAM_INTERRUPTED_TEXT,
      meta: {
        ...intent.meta,
        blocks: [{
          type: 'context',
          elements: [{ type: 'mrkdwn', text: STREAM_INTERRUPTED_TEXT }],
        }],
      },
    });
  }

  _record(intent, turnState, deliveryChannel, result, deliveredKey) {
    const record = createTurnDeliveryRecord({
      turnId: intent.turnId,
      attemptId: intent.attemptId,
      channel: intent.channel || turnState.channel,
      threadTs: intent.threadTs || turnState.threadTs,
      platform: intent.platform || turnState.platform,
      intent: intent.intent,
      deliveryChannel,
      text: intent.text || chunksText(intent.meta?.chunks),
      streamMessageTs: turnState.streamMessageTs,
      postMessageTs: result?.channel === 'postMessage' ? result.ts || null : null,
      source: intent.source || 'unknown',
      meta: { ...intent.meta, reason: result?.reason || null },
    });
    try {
      this.ledger?.record?.(record, result?.delivered ? deliveredKey : null);
    } catch (err) {
      this.logger(`[turn-delivery] ledger record failed: ${err.message}`);
    }
    return record;
  }
}
