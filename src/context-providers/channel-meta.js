export function channelMetaToFragments({ channelMeta, channel, retrievedAt }) {
  if (!channelMeta || (!channelMeta.topic && !channelMeta.purpose)) return [];
  return [{
    source_type: 'slack_channel_meta',
    trusted: false,
    origin: `slack:channel:${channel || 'unknown'}`,
    content: JSON.stringify({ topic: channelMeta.topic || '', purpose: channelMeta.purpose || '' }, null, 2),
    retrieved_at: retrievedAt,
    platform: 'slack',
    channel,
  }];
}

export const channelMetaProvider = {
  name: 'channel-meta',
  async prefetch(ctx) {
    return channelMetaToFragments(ctx);
  },
};
