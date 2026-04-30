import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { searchDocs } from '../docstore.js';
import { warn } from '../log.js';
import {
  DOC_INDEX_DB,
  DOC_PROJECTS_ROOT,
  DOC_REGISTRY_PATH,
} from '../runtime-env.js';
import { memoryManifestItem, sha16 } from './interface.js';

const TAG = 'context-provider:docstore';
const REGISTRY_PATH = DOC_REGISTRY_PATH || (DOC_PROJECTS_ROOT ? join(DOC_PROJECTS_ROOT, 'registry.md') : null);

function serializeError(error) {
  if (!error) return 'Error: unknown';
  return `${error.name || 'Error'}: ${error.message || String(error)}`;
}

function logSearchFailure(dataDir, error) {
  const docsDbPath = (dataDir ? join(dataDir, 'doc-index.db') : DOC_INDEX_DB) || 'doc-index.db';
  const parts = [
    'operation=docstoreProvider.searchDocs',
    `db=${basename(docsDbPath)}`,
    `error=${serializeError(error)}`,
  ];
  if (error?.kind === 'timeout' || error?.code === 'ETIMEDOUT' || /timed out/i.test(error?.message || '')) {
    parts.push('kind=timeout');
  }
  warn(TAG, parts.join(' '));
}

function parseRegistry() {
  if (!REGISTRY_PATH) return [];
  try {
    const projects = [];
    let section = 'projects';
    for (const raw of readFileSync(REGISTRY_PATH, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('## ')) {
        const lower = line.toLowerCase();
        section = lower.includes('partner') ? 'partner' : lower.includes('internal') ? 'internal' : 'projects';
        continue;
      }
      if (section === 'partner' || !line.startsWith('|')) continue;
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.length < 4 || cells[0] === 'slug' || /^-+$/.test(cells[0])) continue;
      const [slug, , , aliasesRaw] = cells;
      if (!slug) continue;
      const aliases = [slug, ...aliasesRaw.split('/').map((a) => a.trim()).filter(Boolean)];
      projects.push({ slug, aliases: [...new Set(aliases)] });
    }
    return projects;
  } catch {
    return [];
  }
}

function aliasRegex(alias) {
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^[A-Za-z0-9_-]+$/.test(alias)) {
    return new RegExp(`(?<![A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])`, 'i');
  }
  return new RegExp(esc, 'i');
}

export function inferSlugFromThread(threadHistory) {
  if (!threadHistory) return null;
  const firstLine = threadHistory.split('\n')[0] || '';
  const colonIdx = firstLine.indexOf(': ');
  const msg = colonIdx >= 0 ? firstLine.slice(colonIdx + 2) : firstLine;
  const matched = new Set();
  for (const project of parseRegistry()) {
    for (const alias of [...project.aliases].sort((a, b) => b.length - a.length)) {
      if (aliasRegex(alias).test(msg)) {
        matched.add(project.slug);
        break;
      }
    }
  }
  return matched.size === 1 ? [...matched][0] : null;
}

export function docsToFragments(docs, retrievedAt) {
  return (Array.isArray(docs) ? docs : []).map((d) => {
    const itemId = [d.slug, d.doc_type, d.path || d.title, d.section].filter(Boolean).join('#');
    const content = d.snippet || d.content || '';
    return {
      source_type: 'doc_snippet',
      trusted: true,
      origin: itemId,
      source_path: d.path || null,
      content,
      retrieved_at: retrievedAt,
      content_hash: sha16(content || d.title),
      metadata: { slug: d.slug, doc_type: d.doc_type, title: d.title, section: d.section },
      manifest: memoryManifestItem('doc', itemId, content || d.title),
    };
  }).filter((f) => f.content);
}

export const docstoreProvider = {
  name: 'docstore',
  async prefetch(ctx) {
    try {
      const docs = await searchDocs(ctx.userText, ctx.dataDir, inferSlugFromThread(ctx.threadHistory));
      return docsToFragments(docs, ctx.retrievedAt || new Date().toISOString());
    } catch (error) {
      logSearchFailure(ctx.dataDir, error);
      return [];
    }
  },
};
