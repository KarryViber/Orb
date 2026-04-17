import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recallMemory, searchDocs } from './memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// No default soul dir — profile must always be resolved

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

// Cache soul files per directory (cleared on SIGHUP via invalidateSoulCache)
const soulCache = new Map();

export function invalidateSoulCache() {
  soulCache.clear();
}

function loadSoul(soulDir, filename) {
  const key = `${soulDir}:${filename}`;
  if (soulCache.has(key)) return soulCache.get(key);
  try {
    const content = readFileSync(join(soulDir, filename), 'utf-8');
    soulCache.set(key, content);
    return content;
  } catch {
    return '';
  }
}

// ── Framework Directives (hardcoded, not file-based) ──

const MEMORY_GUIDANCE = `\
Save durable facts proactively — don't wait for "remember this":
- User corrections, explicit preferences, environment facts, key decisions.
- Skip: one-off task results, temporary plans, assistant's own actions.
- Priority: reduce future corrections > signal over noise > lasting over ephemeral.`;

/**
 * Build the full prompt injected into Claude CLI.
 *
 * Layers:
 *   1. Soul    — identity, behavior rules, collaboration boundaries
 *   2. User    — user profile + inject context
 *   3a. Memory  — Holographic conversation recall
 *   3b. Docs    — DocStore file knowledge recall
 *   4. Thread   — conversation history (now passed in, not fetched here)
 *   5. Message  — user message + file attachments
 */
export async function buildPrompt({ userText, fileContent, threadTs, userId, channel, soulDir, scriptsDir, threadHistory, dataDir, mode, priorConversation }) {
  const systemParts = [];
  const userParts = [];

  const dir = soulDir;
  if (!dir) return { systemPrompt: '', userPrompt: userText || '' };

  // Layer 1: Soul (stable → system)
  const soul = loadSoul(dir, 'SOUL.md');
  if (soul) systemParts.push(soul);

  // Layer 2: User context (stable → system)
  const userProfile = loadSoul(dir, 'USER.md');
  if (userProfile) systemParts.push(userProfile);

  // Layer 2b: Built-in memory — agent-maintained durable facts (fresh read, not cached)
  if (dataDir) {
    const memoryMdPath = join(dataDir, 'MEMORY.md');
    try {
      if (existsSync(memoryMdPath)) {
        const memoryMd = readFileSync(memoryMdPath, 'utf-8').trim();
        if (memoryMd) systemParts.push(memoryMd);
      }
    } catch { /* missing or unreadable — skip */ }
  }

  // Layer 2c: Skills index (scan profiles/{name}/skills/*.md, inject name+description)
  const skillsDir = join(dir, '..', 'skills');
  try {
    if (existsSync(skillsDir)) {
      const skillFiles = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
      if (skillFiles.length > 0) {
        const skillIndex = skillFiles.map(f => {
          try {
            const content = readFileSync(join(skillsDir, f), 'utf8');
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*(.+)$/m);
            const name = nameMatch?.[1]?.trim() || f.replace('.md', '');
            const desc = descMatch?.[1]?.trim() || '';
            return `- **${name}**: ${desc} [${f}]`;
          } catch { return null; }
        }).filter(Boolean);
        if (skillIndex.length > 0) {
          systemParts.push(`## Available Skills\n${skillIndex.join('\n')}\n\nSkill files are at: ${skillsDir}/\nRead the full file when you need the detailed steps.`);
        }
      }
    }
  } catch { /* no skills — fine */ }

  // Layer 2d: Scripts path (so agent knows where user scripts live)
  if (scriptsDir && existsSync(scriptsDir)) {
    systemParts.push(`## Scripts\nUser scripts are at: ${scriptsDir}/`);
  }

  // Framework directive: memory guidance (injected if memory is enabled)
  if (process.env.MEMORY_ENABLED !== 'false') {
    systemParts.push(MEMORY_GUIDANCE);
  }

  // Layer 3a+3b: Memory + Docs — parallel fetch to cut latency (~15s each worst-case)
  const dbPath = dataDir ? join(dataDir, 'memory.db') : undefined;
  const [memoryResult, docsResult] = await Promise.allSettled([
    recallMemory(userText, userId, dbPath),
    (async () => {
      const slug = inferSlugFromThread(threadHistory);
      return searchDocs(userText, dataDir, slug);
    })(),
  ]);

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
  }

  if (docs.length > 0) {
    const docBlock = docs
      .map((d) => `- [${d.slug}/${d.doc_type}] ${d.title} §${d.section}\n  ${d.snippet || d.content || ''}`)
      .join('\n');
    userParts.push(`## 相关文档\n${docBlock}`);
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
  };
}
