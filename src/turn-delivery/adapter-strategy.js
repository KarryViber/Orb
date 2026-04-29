import {
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TEXT_FINAL,
  CONTROL_PLANE_MESSAGE,
  CONTROL_PLANE_UPDATE,
  METADATA_STATUS,
  METADATA_TITLE,
  RECEIPT_SILENT_SUPPRESSED,
  TASK_PROGRESS_APPEND,
  TASK_PROGRESS_START,
  TASK_PROGRESS_STOP,
} from './intents.js';

export function resolveDeliveryChannel({ adapter, intent, turnState }) {
  const capabilities = adapter?.capabilities || {};
  const type = intent.intent;

  if (intent.channelSemantics === 'silent') return { channel: 'silent', reason: 'silent-semantics' };

  if (type === CONTROL_PLANE_MESSAGE) return { channel: 'postMessage', reason: 'control-plane' };
  if (type === CONTROL_PLANE_UPDATE) return { channel: 'edit', reason: 'control-plane-update' };

  if (type === METADATA_STATUS) return { channel: 'metadata', reason: 'metadata-status' };
  if (type === METADATA_TITLE) return { channel: 'metadata', reason: 'metadata-title' };

  if (type === TASK_PROGRESS_START || type === TASK_PROGRESS_APPEND || type === TASK_PROGRESS_STOP) {
    if (capabilities.stream) return { channel: 'stream', reason: 'task-progress-with-stream' };
    return { channel: 'silent', reason: 'task-progress-no-stream-platform' };
  }

  if (type === ASSISTANT_TEXT_DELTA || type === ASSISTANT_TEXT_FINAL) {
    if (turnState?.streamId && capabilities.stream) {
      return { channel: 'stream', reason: 'assistant-text-via-stream' };
    }
    if (type === ASSISTANT_TEXT_FINAL) {
      return { channel: 'postMessage', reason: 'assistant-text-no-stream' };
    }
    return { channel: 'silent', reason: 'delta-without-stream' };
  }

  if (type === RECEIPT_SILENT_SUPPRESSED) return { channel: 'silent', reason: 'receipt' };

  throw new Error(`unknown intent type: ${type}`);
}
