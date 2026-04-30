export function threadHistoryToFragments(threadHistory, channel, threadTs, retrievedAt) {
  if (!threadHistory) return [];
  return [{
    source_type: 'thread_history',
    trusted: 'mixed',
    origin: `slack:${channel || 'unknown'}/${threadTs || 'unknown'}`,
    content: threadHistory,
    retrieved_at: retrievedAt,
    platform: 'slack',
    channel,
    thread_ts: threadTs,
  }];
}

export const threadHistoryProvider = {
  name: 'thread-history',
  async prefetch(ctx) {
    return threadHistoryToFragments(ctx.threadHistory, ctx.channel, ctx.threadTs, ctx.retrievedAt || new Date().toISOString());
  },
};
