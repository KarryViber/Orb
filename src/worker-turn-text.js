/**
 * Decide whether to emit turn_complete and which text to carry.
 *
 * Invariant: turnBuffer is the authoritative source of turn assistant text.
 * msg.result from Claude CLI may carry only the last text block in a multi-block
 * turn, so it is treated as a last-resort fallback only when the buffer is empty.
 *
 * Block-level dedup: emit only when the current result event follows new
 * assistant text blocks since the last emission. String comparison alone can
 * re-emit a tail-only fallback when the CLI emits multiple result lines.
 *
 * @param {object} args
 * @param {string[]} args.turnBuffer
 * @param {string} args.msgResult
 * @param {string} args.lastEmittedText
 * @param {number} args.blocksSinceLastEmit
 * @returns {{ shouldEmit: boolean, text: string, mismatch: boolean }}
 */
export function resolveTurnCompleteText({
  turnBuffer,
  msgResult,
  lastEmittedText,
  blocksSinceLastEmit,
}) {
  const bufferText = Array.isArray(turnBuffer) ? turnBuffer.join('\n') : '';
  const result = msgResult || '';
  const emitted = lastEmittedText || '';

  if (blocksSinceLastEmit === 0 && emitted) {
    return { shouldEmit: false, text: '', mismatch: false };
  }

  const text = bufferText || result;
  if (!text) return { shouldEmit: false, text: '', mismatch: false };
  if (text === emitted) return { shouldEmit: false, text: '', mismatch: false };

  const mismatch = !!(
    bufferText
    && result
    && bufferText !== result
    && !bufferText.includes(result)
    && !result.includes(bufferText)
  );

  return { shouldEmit: true, text, mismatch };
}
