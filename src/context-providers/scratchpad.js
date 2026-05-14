import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const THREAD_TS_RE = /^\d+\.\d+$/;

export const scratchpadProvider = {
  name: 'scratchpad',
  async prefetch(ctx) {
    const threadTs = ctx.threadTs || '';
    if (!THREAD_TS_RE.test(threadTs)) {
      // scratchpad is Slack-only by design (path-traversal-safe regex);
      // non-Slack platform thread_ts is inapplicable, not invalid.
      return [];
    }
    if (!ctx.dataDir) return [];

    const scratchDir = join(ctx.dataDir, 'scratchpad', threadTs);
    const scratchPath = join(scratchDir, 'scratchpad.md');
    const metaPath = join(scratchDir, 'meta.json');
    if (!existsSync(scratchPath)) return [];

    let contentHash;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        contentHash = meta?.content_hash;
      } catch {}
    }

    return [{
      source_type: 'scratchpad',
      trusted: false,
      origin: `file://${scratchPath}`,
      retrieved_at: ctx.retrievedAt || new Date().toISOString(),
      content: readFileSync(scratchPath, 'utf-8'),
      thread_ts: threadTs,
      content_hash: contentHash,
      metadata: { thread_ts: threadTs, content_hash: contentHash },
    }];
  },
};
