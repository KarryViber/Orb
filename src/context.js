import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recallMemory, searchDocs } from './memory.js';
import { warn } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = 'context';

function sha16(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function snippet(value, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function memoryManifestItem(kind, itemId, content) {
  return {
    item_kind: kind,
    item_id: String(itemId || ''),
    content: snippet(content),
    content_hash: sha16(content || itemId),
  };
}

function walkSkillDirs(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_archive')) continue;
    const skillPath = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    try {
      const body = readFileSync(skillPath, 'utf-8');
      out.push(memoryManifestItem('skill', skillPath, body));
    } catch {}
  }
  return out;
}

export function encodeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('encodeCwd(cwd) requires a non-empty string');
  }
  return cwd.replaceAll('/', '-');
}

function serializeError(error) {
  if (!error) return 'Error: unknown';
  const name = error.name || 'Error';
  const message = error.message || String(error);
  return `${name}: ${message}`;
}

function logRecallFailure(operation, dbPath, error) {
  const parts = [
    `operation=${operation}`,
    `db=${basename(dbPath || 'unknown')}`,
    `error=${serializeError(error)}`,
  ];
  if (error?.kind === 'timeout' || error?.code === 'ETIMEDOUT' || /timed out/i.test(error?.message || '')) {
    parts.push('kind=timeout');
  }
  warn(TAG, parts.join(' '));
}

// ── DocStore slug inference (thread-scoped search) ──

const REGISTRY_PATH = (() => {
  if (process.env.DOC_REGISTRY_PATH) return process.env.DOC_REGISTRY_PATH;
  if (process.env.DOC_PROJECTS_ROOT) return join(process.env.DOC_PROJECTS_ROOT, 'registry.md');
  return null;
})();

/**
 * Parse registry.md into a list of { slug, aliases[] } objects.
 * Mirrors docquery.py::parse_registry — skips partner section.
 */
function parseRegistry() {
  if (!REGISTRY_PATH) return [];
  try {
    const lines = readFileSync(REGISTRY_PATH, 'utf-8').split('\n');
    const projects = [];
    let section = 'projects';
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('## ')) {
        const lower = line.toLowerCase();
        section = lower.includes('partner') ? 'partner'
                : lower.includes('internal') ? 'internal' : 'projects';
        continue;
      }
      if (section === 'partner') continue;
      if (!line.startsWith('|')) continue;
      const cells = line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (cells.length < 4 || cells[0] === 'slug' || /^-+$/.test(cells[0])) continue;
      const [slug, , , aliasesRaw] = cells;
      if (!slug) continue;
      const aliases = [slug, ...aliasesRaw.split('/').map(a => a.trim()).filter(Boolean)];
      projects.push({ slug, aliases: [...new Set(aliases)] });
    }
    return projects;
  } catch {
    return [];
  }
}

/**
 * Build a word-boundary-aware regex for an alias token.
 * ASCII-only aliases use word boundaries; mixed/CJK use literal match.
 */
function aliasRegex(alias) {
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^[A-Za-z0-9_-]+$/.test(alias)) {
    return new RegExp(`(?<![A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])`, 'i');
  }
  return new RegExp(esc, 'i');
}

/**
 * Infer a project slug from the first message in threadHistory.
 * Returns the matched slug string, or null if zero or ambiguous matches.
 *
 * @param {string|null} threadHistory - Full thread history string (one line per msg)
 * @returns {string|null}
 */
function inferSlugFromThread(threadHistory) {
  if (!threadHistory) return null;
  const projects = parseRegistry();
  if (projects.length === 0) return null;

  const firstLine = threadHistory.split('\n')[0] || '';
  const colonIdx = firstLine.indexOf(': ');
  const msg = colonIdx >= 0 ? firstLine.slice(colonIdx + 2) : firstLine;

  const matched = new Set();
  for (const project of projects) {
    const sortedAliases = [...project.aliases].sort((a, b) => b.length - a.length);
    for (const alias of sortedAliases) {
      if (aliasRegex(alias).test(msg)) {
        matched.add(project.slug);
        break;
      }
    }
  }
  return matched.size === 1 ? [...matched][0] : null;
}

/**
 * Build the prompt injected into Claude CLI.
 *
 * System prompt is now minimal — CLI auto-loads CLAUDE.md / skills / agents /
 * auto-memory natively via --append-system-prompt. Orb only adds the pieces
 * CLI doesn't have: Scripts pointer, Holographic recall, DocStore recall,
 * Thread history, Skill-review context.
 *
 * User prompt layers:
 *   1. Holographic memory recall (cross-thread)
 *   2. DocStore recall (file knowledge)
 *   3. Skill-review prior conversation (conditional)
 *   4. Thread history (from adapter)
 *   5. Thread metadata + file attachments + user message
 */
export async function buildPrompt({ userText, fileContent, threadTs, userId, channel, scriptsDir, threadHistory, dataDir, mode, priorConversation }) {
  const systemParts = [];
  const userParts = [];
  const memoryManifest = [];

  if (!dataDir) throw new Error('context.js: profile.dataDir missing — upstream bug');

  // Soul, USER.md, and MEMORY.md all moved to CLI-native paths:
  // - Soul → profiles/{name}/workspace/CLAUDE.md (CLI auto-discovery)
  // - MEMORY.md → ~/.claude/projects/{cwd}/memory/MEMORY.md (CLI auto-memory)
  // - USER.md → tracked by CLI auto-memory same path
  // Scheduler memory-sync worker only does housekeeping now (purge/lint/GC).

  // Skills: now CLI-native. Auto-discovered from {cwd}/.claude/skills/*/SKILL.md
  // per-profile isolation via worker cwd = profiles/{name}/workspace/.
  //
  // Layer 2d: Scripts path (so agent knows where user scripts live)
  if (scriptsDir && existsSync(scriptsDir)) {
    systemParts.push(`## Scripts\nUser scripts are at: ${scriptsDir}/`);
  }

  // Memory guidance directive retired — CLI auto-memory handles this natively.

  // Layer 3a+3b: Memory + Docs — parallel fetch to cut latency (~15s each worst-case)
  const dbPath = dataDir ? join(dataDir, 'memory.db') : undefined;
  const [memoryResult, docsResult] = await Promise.allSettled([
    recallMemory(userText, userId, dbPath),
    (async () => {
      const slug = inferSlugFromThread(threadHistory);
      return searchDocs(userText, dataDir, slug);
    })(),
  ]);

  if (memoryResult.status === 'rejected') {
    logRecallFailure('buildPrompt.recallMemory', dbPath, memoryResult.reason);
  }
  if (docsResult.status === 'rejected') {
    const docsDbPath = (dataDir ? join(dataDir, 'doc-index.db') : process.env.DOC_INDEX_DB) || 'doc-index.db';
    logRecallFailure('buildPrompt.searchDocs', docsDbPath, docsResult.reason);
  }

  const memories = memoryResult.status === 'fulfilled' ? (memoryResult.value || []) : [];
  const docs = docsResult.status === 'fulfilled' ? (docsResult.value || []) : [];

  if (memories.length > 0) {
    const memoryBlock = memories
      .map((m) => {
        const prefix = m.category === 'lesson' ? '⚠️ ' : '';
        return `- [trust:${m.trust_score?.toFixed(2) || '?'}] ${prefix}${m.content}`;
      })
      .join('\n');
    userParts.push(`## 相关上下文\n${memoryBlock}`);
    for (const m of memories) {
      const itemKind = m.category === 'lesson' ? 'lesson' : 'fact';
      const itemId = m.path || m.file || m.fact_id || m.id || sha16(m.content);
      memoryManifest.push(memoryManifestItem(itemKind, itemId, m.content));
    }
  }

  if (docs.length > 0) {
    const docBlock = docs
      .map((d) => `- [${d.slug}/${d.doc_type}] ${d.title} §${d.section}\n  ${d.snippet || d.content || ''}`)
      .join('\n');
    userParts.push(`## 相关文档\n${docBlock}`);
    for (const d of docs) {
      const itemId = [d.slug, d.doc_type, d.path || d.title, d.section].filter(Boolean).join('#');
      memoryManifest.push(memoryManifestItem('doc', itemId, d.snippet || d.content || d.title));
    }
  }

  const workspaceDir = scriptsDir ? dirname(scriptsDir) : null;
  if (workspaceDir) {
    memoryManifest.push(...walkSkillDirs(join(workspaceDir, '.claude', 'skills')));
  }

  // Skill-review mode: inject the just-completed turn as explicit context,
  // since the synthetic skill-review-* threadTs has no real thread history.
  if (mode === 'skill-review' && Array.isArray(priorConversation) && priorConversation.length > 0) {
    const priorText = priorConversation
      .map((m) => `${m.role || 'unknown'}: ${m.content || ''}`)
      .join('\n\n');
    userParts.push(`## 待审查会话\n${priorText}\n## 审查会话结束`);
  }

  // Layer 4: Thread history (now passed in from adapter, not fetched here)
  if (threadHistory) {
    userParts.push(`## Thread 历史\n${threadHistory}\n## 历史结束`);
  }

  // Thread metadata (dynamic → user)
  userParts.push(`## 消息信息\n- thread: ${threadTs}\n- user: ${userId}\n- time: ${new Date().toISOString()}`);

  // Attached file content (dynamic → user)
  if (fileContent) {
    userParts.push(`## 附件\n${fileContent}`);
  }

  // User message (always last → user)
  userParts.push(`## 用户消息\n${userText || '(仅附件)'}`);

  return {
    systemPrompt: systemParts.join('\n\n---\n\n'),
    userPrompt: userParts.join('\n\n---\n\n'),
    memoryManifest,
  };
}
