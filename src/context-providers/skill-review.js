export function priorConversationToFragments(priorConversation, threadTs, retrievedAt, mode = 'skill-review') {
  if (mode !== 'skill-review' || !Array.isArray(priorConversation)) return [];
  return priorConversation.map((m, i) => ({
    source_type: 'skill_review_conversation',
    trusted: m.role === 'assistant' ? true : 'mixed',
    origin: `skill-review:${threadTs || 'unknown'}:${i}`,
    content: m.content || '',
    retrieved_at: retrievedAt,
    author_role: m.role || 'unknown',
  })).filter((f) => f.content);
}

export const skillReviewProvider = {
  name: 'skill-review',
  async prefetch(ctx) {
    return priorConversationToFragments(
      ctx.priorConversation,
      ctx.threadTs,
      ctx.retrievedAt || new Date().toISOString(),
      ctx.mode,
    );
  },
};
