import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snippet } from './interface.js';

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function recentDateKeys(days = 14) {
  const out = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; i < days; i += 1) {
    out.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return out;
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.text?.text === 'string') return block.text.text;
  if (Array.isArray(block.elements)) {
    return block.elements.map((element) => element?.text || element?.text?.text || '').filter(Boolean).join('\n');
  }
  return '';
}

function blocksSummary(blocks) {
  if (!Array.isArray(blocks)) return '';
  return snippet(blocks.map(blockText).filter(Boolean).join('\n\n'), 1200);
}

function fragmentContent(result) {
  return snippet([
    `title: ${result.title || ''}`,
    `status: ${result.status || ''}`,
    `cron_name: ${result.cron_name || ''}`,
    `blocks: ${blocksSummary(result.blocks)}`,
  ].join('\n'), 1500);
}

function resultTime(result, fallbackDate) {
  const parsed = Date.parse(result?.timestamp || '');
  if (Number.isFinite(parsed)) return parsed;
  const fallback = Date.parse(`${fallbackDate}T00:00:00Z`);
  return Number.isFinite(fallback) ? fallback : 0;
}

function cronResultToFragment(result, cronId, retrievedAt, sourcePath) {
  return {
    source_type: 'cron_history',
    trusted: true,
    origin: { kind: 'cron', name: cronId },
    content: fragmentContent(result),
    retrieved_at: retrievedAt,
    source_path: sourcePath,
    source_id: `${cronId}:${result.timestamp || 'unknown'}`,
  };
}

export const cronHistoryProvider = {
  name: 'cron-history',
  async prefetch(ctx) {
    const cronId = ctx?.origin?.kind === 'cron' ? ctx.origin.name : null;
    if (!cronId || !ctx?.dataDir) return [];

    const root = join(ctx.dataDir, 'cron-results');
    if (!existsSync(root)) return [];

    const failures = [];
    const successes = [];
    for (const day of recentDateKeys(14)) {
      const filePath = join(root, day, `${cronId}.json`);
      if (!existsSync(filePath)) continue;
      try {
        const result = JSON.parse(readFileSync(filePath, 'utf-8'));
        const item = {
          result,
          filePath,
          time: resultTime(result, day),
        };
        if (result?.status !== 'ok') failures.push(item);
        else successes.push(item);
      } catch {}
    }

    const selected = [
      ...failures.sort((a, b) => b.time - a.time),
      ...successes.sort((a, b) => b.time - a.time),
    ].slice(0, 3);

    return selected.map(({ result, filePath }) => cronResultToFragment(
      result,
      cronId,
      ctx.retrievedAt || new Date().toISOString(),
      filePath,
    ));
  },
};
