// 单一定义。scheduler / cron / 任何后续消费者必须 import 这里，禁止再写本地副本。

export const SUCCESSFUL_STOP_REASONS = new Set(['success', 'stop', 'end_turn']);
export const TRUNCATED_STOP_REASONS = new Set(['tool_use', 'max_turns_reached']);

export function isSuccessfulStopReason(stopReason) {
  return !stopReason || SUCCESSFUL_STOP_REASONS.has(stopReason);
}

export function isTruncatedStopReason(stopReason) {
  return TRUNCATED_STOP_REASONS.has(stopReason);
}

export function classifyStopReason(stopReason) {
  if (isSuccessfulStopReason(stopReason)) return 'successful';
  if (isTruncatedStopReason(stopReason)) return 'truncated';
  return 'failed';
}
