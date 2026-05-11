// 单一定义。scheduler / cron / 任何后续消费者必须 import 这里，禁止再写本地副本。

export const SUCCESSFUL_STOP_REASONS = new Set(['success', 'stop', 'end_turn', 'auto_compact']);
export const TRUNCATED_STOP_REASONS = new Set(['tool_use', 'max_turns_reached']);
export const INTERRUPTED_STOP_REASONS = new Set(['worker_timeout', 'worker_crash', 'api_error', 'cli_error']);

export function isSuccessfulStopReason(stopReason) {
  return !stopReason || SUCCESSFUL_STOP_REASONS.has(stopReason);
}

export function isTruncatedStopReason(stopReason) {
  return TRUNCATED_STOP_REASONS.has(stopReason);
}

export function isInterruptedStopReason(stopReason, { exitCode = null } = {}) {
  if (!INTERRUPTED_STOP_REASONS.has(stopReason)) return false;
  if ((stopReason === 'api_error' || stopReason === 'cli_error') && exitCode === 0) return false;
  return true;
}

export function classifyStopReason(stopReason) {
  if (isSuccessfulStopReason(stopReason)) return 'successful';
  if (isTruncatedStopReason(stopReason)) return 'truncated';
  return 'failed';
}
