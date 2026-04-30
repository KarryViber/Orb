import { warn } from '../log.js';
import { createPlanStreamProcessor, createQiStreamProcessor } from './task-card-streams.js';
import { createTextStreamProcessor } from './text-stream.js';
import { createStatusProcessor } from './status.js';

const TAG = 'turn-delivery-cc-event';

function isSupportedContext(ctx) {
  const platform = ctx?.platform || ctx?.adapter?.platform || 'slack';
  return platform === 'slack';
}

async function safeHandle(name, processor, msg, ctx) {
  try {
    await processor.handle(msg, ctx);
  } catch (err) {
    warn(TAG, `${name} processor failed: ${err.message}`);
  }
}

export function createTurnDeliveryCcEventSubscriber({
  textDebounceMs,
  statusHeartbeatMs,
} = {}) {
  const qi = createQiStreamProcessor();
  const plan = createPlanStreamProcessor();
  const text = createTextStreamProcessor({ debounceMs: textDebounceMs });
  const status = createStatusProcessor({ heartbeatMs: statusHeartbeatMs });
  const processors = [
    ['qi', qi],
    ['plan', plan],
    ['text', text],
    ['status', status],
  ];

  return {
    match: (msg, ctx) => msg?.type === 'cc_event' && isSupportedContext(ctx),
    async handle(msg, ctx = {}) {
      if (msg.eventType === 'turn_abort') {
        for (const [name, processor] of processors) {
          await safeHandle(name, processor, msg, ctx);
        }
        return;
      }
      if (!['tool_use', 'text', 'result'].includes(msg.eventType)) return;
      if (msg.eventType === 'result') {
        for (const [name, processor] of [['text', text], ['qi', qi], ['plan', plan], ['status', status]]) {
          await safeHandle(name, processor, msg, ctx);
        }
        return;
      }
      for (const [name, processor] of processors) {
        await safeHandle(name, processor, msg, ctx);
      }
    },
    clearByContext({ channel, threadTs } = {}) {
      status.clearByContext({ channel, threadTs });
    },
  };
}
