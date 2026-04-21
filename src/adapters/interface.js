export class PlatformAdapter {
  async start(onMessage, onInteractive) { throw new Error('not implemented'); }
  async disconnect() { throw new Error('not implemented'); }
  async sendReply(channel, threadTs, text, extra) { throw new Error('not implemented'); }
  async editMessage(channel, ts, text, extra) { throw new Error('not implemented'); }
  async uploadFile(channel, threadTs, filePath, filename) { throw new Error('not implemented'); }
  async setTyping(channel, threadTs, status) { throw new Error('not implemented'); }
  async startTypingIndicator(channel, threadTs) { return this.setTyping(channel, threadTs, 'is thinking…'); }
  async stopTypingIndicator(channel, threadTs) { return this.setTyping(channel, threadTs, ''); }
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
}
