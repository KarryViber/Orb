export const STREAM_TASK_FIELD_LIMIT = 256;

export class StreamAPIError extends Error {
  constructor(message, cause, slackErrorCode = null) {
    super(message);
    this.name = 'StreamAPIError';
    this.cause = cause;
    this.slackErrorCode = slackErrorCode || getSlackStreamErrorCode(cause) || null;
  }
}

export function getSlackStreamErrorCode(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.error === 'string' && value.error) return value.error;
  if (typeof value.data?.error === 'string' && value.data.error) return value.data.error;
  return null;
}

export function isStreamingStateError(value) {
  return getSlackStreamErrorCode(value) === 'message_not_in_streaming_state';
}

export function buildStreamAPIError(method, codeOrMessage, cause, details = '') {
  const code = typeof codeOrMessage === 'string' && /^[a-z_]+$/.test(codeOrMessage) ? codeOrMessage : getSlackStreamErrorCode(cause);
  const message = details || codeOrMessage || 'unknown_error';
  return new StreamAPIError(`chat.${method} failed: ${message}`, cause, code);
}

export function assertStreamTaskField(fieldName, value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (text.length > STREAM_TASK_FIELD_LIMIT) {
    throw buildStreamAPIError(
      'appendStream',
      'invalid_chunks',
      null,
      `invalid_chunks (${fieldName} exceeds ${STREAM_TASK_FIELD_LIMIT} chars)`,
    );
  }
  return text;
}

export function preserveStreamTaskField(fieldName, value) {
  if (value == null) return '';
  const text = String(value);
  if (text.length > STREAM_TASK_FIELD_LIMIT) {
    throw buildStreamAPIError(
      'appendStream',
      'invalid_chunks',
      null,
      `invalid_chunks (${fieldName} exceeds ${STREAM_TASK_FIELD_LIMIT} chars)`,
    );
  }
  return text;
}
