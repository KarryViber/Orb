import { join } from 'node:path';
import { recallMemory } from '../memory.js';
import { memoryManifestItem, sha16 } from './interface.js';

export function memoriesToFragments(memories, retrievedAt) {
  return (Array.isArray(memories) ? memories : []).map((m) => {
    const itemKind = m.category === 'lesson' ? 'lesson' : 'fact';
    const itemId = m.path || m.file || m.fact_id || m.id || sha16(m.content);
    return {
      source_type: 'memory_fact',
      trusted: true,
      origin: itemId,
      content: m.content || '',
      retrieved_at: retrievedAt,
      trust_score: m.trust_score,
      content_hash: sha16(m.content || m.id),
      metadata: { category: m.category, source_kind: m.source_kind },
      manifest: memoryManifestItem(itemKind, itemId, m.content),
    };
  }).filter((f) => f.content);
}

export const holographicProvider = {
  name: 'holographic',
  async prefetch(ctx) {
    const dbPath = ctx.dataDir ? join(ctx.dataDir, 'memory.db') : undefined;
    const memories = await recallMemory(ctx.userText, ctx.userId, dbPath);
    return memoriesToFragments(memories, ctx.retrievedAt || new Date().toISOString());
  },
};
