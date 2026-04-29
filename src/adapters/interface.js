export class PlatformAdapter {
  async start(onMessage, onInteractive) { throw new Error('not implemented'); }
  async disconnect() { throw new Error('not implemented'); }
  async sendReply(channel, threadTs, text, extra) { throw new Error('not implemented'); }
  async editMessage(channel, ts, text, extra) { throw new Error('not implemented'); }
  async deliver(intent, ctx) { throw new Error('not implemented'); }
  async uploadFile(channel, threadTs, filePath, filename) { throw new Error('not implemented'); }
  async setTyping(channel, threadTs, status) { throw new Error('not implemented'); }
  /**
   * Set thread/conversation status indicator (typing, "agent is thinking", etc.).
   * Optional capability — adapters that support presence/typing should override.
   * @param {string} channel
   * @param {string|null} threadTs
   * @param {string} status — non-empty enables, empty/null clears
   * @param {Array<string>} [loadingMessages] — optional rotating UX hints (Slack-style)
   */
  async setThreadStatus(_channel, _threadTs, _status, _loadingMessages) {
    // Default: no-op for adapters without status support.
  }
  async sendApproval(channel, threadTs, prompt) { throw new Error('not implemented'); }
  buildPayloads(text) { throw new Error('not implemented'); }
  async cleanupIndicator(channel, threadTs, typingSet, errorMsg) { throw new Error('not implemented'); }

  /**
   * Fetch conversation history for a thread.
   * Returns formatted string or null.
   * Each platform implements its own history fetching logic.
   */
  async fetchThreadHistory(threadTs, channel) { return null; }

  get botUserId() { throw new Error('not implemented'); }
  get platform() { return 'unknown'; }
  get capabilities() { return { stream: false, edit: false, metadata: false }; }
  get supportsInteractiveApproval() { return false; }
}
