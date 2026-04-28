// Slack message limits
const MAX_LENGTH = 3900;        // plain text chunk safe limit
const MAX_BLOCK_TEXT = 2800;    // mrkdwn text within a single block
const MAX_BLOCKS_PER_PAYLOAD = 50;
const FALLBACK_MAX = 180;

/**
 * Convert Markdown to Slack mrkdwn.
 * Headers → 【text】, bold/italic → mrkdwn, links → <url|text>, etc.
 */
import { splitText } from '../format-utils.js';

function protectStructuralHeadings(text, headingMarks) {
  const lines = text.split('\n');
  const out = [];

  const pushHeading = (rendered) => {
    headingMarks.push(rendered);
    out.push(`\x00HD${headingMarks.length - 1}\x00`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;

    if ((m = line.match(/^#\s+(.+)$/))) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      pushHeading(`【${m[1]}】`);
      if (i < lines.length - 1 && lines[i + 1] !== '') out.push('');
      continue;
    }

    if ((m = line.match(/^##\s+(.+)$/))) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      pushHeading(`*${m[1]}*`);
      continue;
    }

    if ((m = line.match(/^###\s+(.+)$/))) {
      pushHeading(`*${m[1]}*`);
      continue;
    }

    if ((m = line.match(/^#{4,6}\s+(.+)$/))) {
      pushHeading(`_${m[1]}_`);
      continue;
    }

    if ((m = line.match(/^\*([^*].{0,78}[^*])\*$/))) {
      pushHeading(`*${m[1]}*`);
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

export function markdownToMrkdwn(text) {
  if (!text) return '';

  let result = text;
  result = result.replace(/\u200b/g, '');

  // ── Phase 0: Protect non-convertible tokens ──

  // Protect code blocks (may span paragraphs)
  const codeBlocks = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code
  const inlineCodes = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Protect Slack entities: <@U...>, <#C...>, <!here>, <https://...|label>
  // These must not be touched by any escaping pass
  const slackEntities = [];
  result = result.replace(/<(?:@[A-Z0-9]+|#[A-Z0-9]+(?:\|[^>]*)?|![a-z]+(?:\|[^>]*)?)>/g, (match) => {
    slackEntities.push(match);
    return `\x00SE${slackEntities.length - 1}\x00`;
  });

  // ── Phase 1: Structural conversion ──

  // Headers map to distinct Slack visual tiers. Protect generated mrkdwn
  // markers so the later inline italic pass does not reinterpret them.
  const headingMarks = [];
  result = protectStructuralHeadings(result, headingMarks);

  // Blockquotes: > text → (indented, Slack supports > natively in mrkdwn)
  // Just ensure single > at line start is preserved (Slack mrkdwn blockquote)
  result = result.replace(/^>\s?/gm, '> ');

  // ── Phase 2: Inline formatting ──

  // CJK boundary regex: Slack mrkdwn formatting chars (* _ ~) need word
  // boundaries to render. CJK and fullwidth punctuation aren't recognized
  // as boundaries, so we insert U+200B (zero-width space) where needed.
  const CJK_BOUNDARY = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

  // ***bold italic*** → *_text_* (Slack bold+italic)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '*_$1_*');

  // Bold: **text** or __text__ → *text* (Slack bold)
  // Protect converted bold from italic pass by using placeholder
  const boldMarks = [];
  result = result.replace(/\*\*(.+?)\*\*/g, (_, inner) => {
    boldMarks.push(inner);
    return `\x00BD${boldMarks.length - 1}\x00`;
  });
  result = result.replace(/__(.+?)__/g, (_, inner) => {
    boldMarks.push(inner);
    return `\x00BD${boldMarks.length - 1}\x00`;
  });

  // Italic: single *text* → _text_ (only matches genuine italic, not converted bold).
  // If inner contains CJK, preserve *text* — Slack mrkdwn uses * for bold, so
  // agents that already write Slack-style bold stay idempotent instead of
  // silently flipping to italic. ZWSP is inserted OUTSIDE the stars only.
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (match, inner, offset, str) => {
    const before = str[offset - 1] || '';
    const after = str[offset + match.length] || '';
    const innerHasCjk = CJK_BOUNDARY.test(inner);
    let out = innerHasCjk ? `*${inner}*` : `_${inner}_`;
    if (CJK_BOUNDARY.test(before)) out = '\u200b' + out;
    if (CJK_BOUNDARY.test(after)) out = out + '\u200b';
    return out;
  });

  // Restore bold with CJK boundary awareness.
  // Invariant: ZWSP is only inserted OUTSIDE the stars (`\u200b*X*\u200b`),
  // never between them, so adjacent output never produces `**X*\u200b*`.
  result = result.replace(/\x00BD(\d+)\x00/g, (match, i, offset, str) => {
    const before = str[offset - 1] || '';
    const after = str[offset + match.length] || '';
    let out = `*${boldMarks[i]}*`;
    if (CJK_BOUNDARY.test(before)) out = '\u200b' + out;
    if (CJK_BOUNDARY.test(after)) out = out + '\u200b';
    return out;
  });

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Restore structural headings before protected code/entities are restored.
  result = result.replace(/\x00HD(\d+)\x00/g, (_, i) => headingMarks[i]);

  // ── Phase 3: Links ──

  // Images before links (! prefix)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<$2|$1>');

  // Links: [text](url) → <url|text> (handle balanced parens in URLs)
  result = result.replace(/\[([^\]]+)\]\(((?:[^()]+|\([^()]*\))+)\)/g, '<$2|$1>');

  // Horizontal rules → ———
  result = result.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '———');

  // ── Phase 4: HTML entity cleanup ──

  // Prevent double-escaping: &amp; → & (only if not already part of an entity)
  result = result.replace(/&amp;(#?\w+;)/g, '&$1');

  // ── Phase 5: Restore protected tokens (reverse order) ──

  // Restore Slack entities
  result = result.replace(/\x00SE(\d+)\x00/g, (_, i) => slackEntities[i]);

  // Restore inline code
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[i]);

  // Restore code blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[i]);

  return result;
}

/**
 * Walk a Block Kit block tree in-place and translate any markdown-bearing
 * text fields to Slack mrkdwn. Covers the surfaces agents actually populate
 * (section/header/context + section.fields); leaves rich_text/table/actions
 * alone because those carry their own styled-element structure.
 */
function convertBlockTextFields(block) {
  if (!block || typeof block !== 'object') return;
  switch (block.type) {
    case 'section': {
      const t = block.text;
      if (t && t.type === 'mrkdwn' && typeof t.text === 'string') {
        t.text = markdownToMrkdwn(t.text);
      }
      if (Array.isArray(block.fields)) {
        for (const field of block.fields) {
          if (field && field.type === 'mrkdwn' && typeof field.text === 'string') {
            field.text = markdownToMrkdwn(field.text);
          }
        }
      }
      break;
    }
    case 'header': {
      const t = block.text;
      if (t && typeof t.text === 'string') {
        t.text = stripMarkdown(t.text);
      }
      break;
    }
    case 'context': {
      if (Array.isArray(block.elements)) {
        for (const el of block.elements) {
          if (el && el.type === 'mrkdwn' && typeof el.text === 'string') {
            el.text = markdownToMrkdwn(el.text);
          }
        }
      }
      break;
    }
  }
}

/**
 * Try to parse explicit Block Kit JSON from agent output.
 * Applies markdown→mrkdwn translation to block text fields and cleans the
 * fallback text so we never ship raw `**bold**` / inline code to Slack.
 */
export function parseBlockKit(text) {
  if (!text || !text.trimStart().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed.blocks && Array.isArray(parsed.blocks) && parsed.text) {
      for (const block of parsed.blocks) convertBlockTextFields(block);
      return { blocks: parsed.blocks, text: buildFallbackText(parsed.text) };
    }
  } catch (_) {}
  return null;
}

/**
 * Heuristic: auto-use Block Kit for structured/long content.
 */
function shouldUseBlocks(text) {
  if (text.length >= 700) return true;
  if (text.split(/\n\n+/).length >= 2) return true;
  if (text.split('\n').length >= 8) return true;
  return false;
}

/**
 * Generate compact fallback text for push notifications (max 180 chars).
 * Strips code fences, inline code, header markers, and markdown emphasis so
 * notifications don't display literal `**X**` / `~~Y~~` noise.
 */
function buildFallbackText(text) {
  const stripped = text
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/【([^\]]+)】/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(?<!~)~(?!~)(.+?)(?<!~)~(?!~)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/​/g, '');
  const firstLine = stripped.split('\n').find((l) => l.trim()) || '';
  const clean = firstLine.trim();
  return clean.length <= FALLBACK_MAX ? clean : clean.slice(0, FALLBACK_MAX - 1) + '…';
}

/**
 * Detect whether text ends inside an open code fence.
 */
function detectFenceState(text) {
  let insideFence = false;
  let lang = '';
  for (const line of text.split('\n')) {
    const m = line.match(/^```(\w*)/);
    if (m) {
      if (!insideFence) {
        insideFence = true;
        lang = m[1];
      } else {
        insideFence = false;
        lang = '';
      }
    }
  }
  return { insideFence, lang };
}

/**
 * Split text into chunks under maxLen, preserving code fence continuity.
 * Each chunk is annotated with （N/total） if multiple.
 */
function splitFenceAware(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;

    let chunk = remaining.slice(0, splitAt).trimEnd();
    const { insideFence, lang } = detectFenceState(chunk);
    if (insideFence) chunk += '\n```';

    chunks.push(chunk);
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
    if (insideFence) remaining = '```' + lang + '\n' + remaining;
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Split block-level text to fit under MAX_BLOCK_TEXT, with fence continuity.
 */
function splitBlockText(text) {
  return splitFenceAware(text, MAX_BLOCK_TEXT);
}

// --- Table block construction ---

const MD_FORMAT_RE = /(\*\*(.+?)\*\*|\*(.+?)\*|__(.+?)__|_(.+?)_|~~(.+?)~~|`([^`]+)`)/;

/**
 * Convert a markdown-formatted cell string to a Slack table cell.
 * Uses rich_text for cells with formatting, raw_text for plain cells.
 */
function cellToBlock(text) {
  const t = (text || '').trim() || ' ';
  if (!MD_FORMAT_RE.test(t)) {
    return { type: 'raw_text', text: t };
  }

  const elements = [];
  const TOKEN_RE = /(\*\*(.+?)\*\*|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|__(.+?)__|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)|~~(.+?)~~|`([^`]+)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = TOKEN_RE.exec(t)) !== null) {
    if (match.index > lastIndex) {
      elements.push({ type: 'text', text: t.slice(lastIndex, match.index) });
    }
    if (match[2]) {
      elements.push({ type: 'text', text: match[2], style: { bold: true } });
    } else if (match[3]) {
      elements.push({ type: 'text', text: match[3], style: { italic: true } });
    } else if (match[4]) {
      elements.push({ type: 'text', text: match[4], style: { bold: true } });
    } else if (match[5]) {
      elements.push({ type: 'text', text: match[5], style: { italic: true } });
    } else if (match[6]) {
      elements.push({ type: 'text', text: match[6], style: { strike: true } });
    } else if (match[7]) {
      elements.push({ type: 'text', text: match[7], style: { code: true } });
    }
    lastIndex = match.index + match[1].length;
  }

  if (lastIndex < t.length) {
    elements.push({ type: 'text', text: t.slice(lastIndex) });
  }

  if (elements.length === 0) {
    return { type: 'raw_text', text: t };
  }

  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements }],
  };
}

/**
 * Strip markdown formatting markers from text (for plain_text contexts).
 */
function stripMarkdown(text) {
  return (text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * Parse a markdown table string into a Slack table block.
 * Supports alignment from separator row (:--, :-:, --:).
 */
function markdownTableToBlock(tableStr) {
  const lines = tableStr.trim().split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;

  const parseRow = (line) =>
    line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  const headerCells = parseRow(lines[0]);
  const sepCells = parseRow(lines[1]);

  // Parse alignment from separator row
  const columnSettings = sepCells.map((sep) => {
    const left = sep.startsWith(':');
    const right = sep.endsWith(':');
    const align = (left && right) ? 'center' : right ? 'right' : 'left';
    return { align, is_wrapped: true };
  });

  // Header row: strip formatting (headers are already visually distinct)
  const rows = [headerCells.map((c) => ({ type: 'raw_text', text: stripMarkdown(c) || ' ' }))];

  // Data rows: use rich_text for cells with formatting
  for (let i = 2; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    while (cells.length < headerCells.length) cells.push('');
    rows.push(cells.slice(0, headerCells.length).map((c) => cellToBlock(c)));
  }

  return {
    type: 'table',
    rows,
    column_settings: columnSettings.slice(0, headerCells.length),
  };
}

// --- Block Kit construction ---

function isHeadingLine(line) {
  if (!line || line.includes('\n')) return false;
  const t = line.trim();
  if (t.length > 100) return false;
  // Lines already containing emphasis/code must not get another outer * wrapper.
  if (/[*_`]/.test(t.replace(/^\*(.+)\*$/, ''))) return false;
  if (/^【.{1,80}】$/.test(t)) return true;     // converted # heading
  if (t.endsWith('：')) return true;             // Japanese colon title
  if (/^\*.{2,80}\*$/.test(t)) return true;     // *bold title* alone
  return false;
}

function extractHeadingText(line) {
  return line.trim()
    .replace(/^【(.+)】$/, '$1')
    .replace(/^\*(.+)\*$/, '$1')
    .replace(/：$/, '')
    .replace(/:$/, '')
    .trim()
    .slice(0, 150); // Slack header block max length
}

function paragraphToBlocks(para) {
  const lines = para.trim().split('\n');
  const firstLine = lines[0];

  // Single heading line → bold section (not header block, which is too large)
  if (isHeadingLine(para.trim()) && lines.length === 1) {
    return [{
      type: 'section',
      text: { type: 'mrkdwn', text: `*${extractHeadingText(para)}*` },
    }];
  }

  // Heading line followed by content → bold heading + content in same/adjacent sections
  if (isHeadingLine(firstLine) && lines.length > 1) {
    const headerText = extractHeadingText(firstLine);
    const content = lines.slice(1).join('\n').trim();
    const combined = `*${headerText}*\n${content}`;
    return splitBlockText(combined).map((chunk) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: chunk },
    }));
  }

  // Regular content
  return splitBlockText(para.trim()).map((chunk) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: chunk },
  }));
}

function buildBlocks(convertedText, tableBlocks = []) {
  // Protect code blocks from paragraph splitting
  const saved = [];
  const guarded = convertedText.replace(/```[\s\S]*?```/g, (m) => {
    saved.push(m);
    return `\x00CB${saved.length - 1}\x00`;
  });

  // Replace table placeholders %%TABLE_N%% with actual table blocks
  const tablePlaceholderRe = /%%TABLE_(\d+)%%/;

  const paragraphs = guarded
    .split(/\n\n+/)
    .map((p) => p.replace(/\x00CB(\d+)\x00/g, (_, i) => saved[i]))
    .filter((p) => p.trim());

  const blocks = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const paraBlocks = paragraphToBlocks(paragraphs[i]);

    // Check for table placeholder
    const tblMatch = paragraphs[i].trim().match(tablePlaceholderRe);
    if (tblMatch) {
      const tblBlock = tableBlocks[parseInt(tblMatch[1])];
      if (tblBlock) {
        blocks.push(tblBlock);
        continue;
      }
    }

    blocks.push(...paraBlocks);
  }

  return blocks;
}

function buildBlockGroups(blocks) {
  if (blocks.length <= MAX_BLOCKS_PER_PAYLOAD) return [blocks];

  const groups = [];
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_PAYLOAD) {
    const group = blocks.slice(i, i + MAX_BLOCKS_PER_PAYLOAD);
    if (group.length > 0) groups.push(group);
  }
  return groups;
}

function formatDiffCount(value, prefix) {
  const n = Number(value) || 0;
  return `${prefix}${n}`;
}

function formatGitDiffFileLine(file) {
  const status = String(file?.status || '').trim() || '?';
  const path = String(file?.path || '').trim();
  if (!path) return null;
  const added = Number(file?.linesAdded) || 0;
  const deleted = Number(file?.linesDeleted) || 0;
  const lineStats = added || deleted ? ` (${formatDiffCount(added, '+')} ${formatDiffCount(deleted, '-')})` : '';
  return `> • \`${status}\` ${path}${lineStats}`;
}

export function formatGitDiffSummary(summary) {
  if (!summary?.hasChanges) return '';
  const totals = summary.totals || {};
  const filesChanged = Number(totals.filesChanged) || (Array.isArray(summary.files) ? summary.files.length : 0);
  const insertions = Number(totals.insertions) || 0;
  const deletions = Number(totals.deletions) || 0;
  const lines = [
    `> _📝 改动 · ${filesChanged} files (${formatDiffCount(insertions, '+')} ${formatDiffCount(deletions, '-')})_`,
  ];
  for (const file of Array.isArray(summary.files) ? summary.files : []) {
    const line = formatGitDiffFileLine(file);
    if (line) lines.push(line);
  }
  if (summary.truncated) {
    const remaining = Math.max(0, filesChanged - (Array.isArray(summary.files) ? summary.files.length : 0));
    lines.push(remaining > 0
      ? `> _…还有 ${remaining} 个文件，详见 VS Code Source Control_`
      : `> _…还有更多文件，详见 VS Code Source Control_`);
  }
  return lines.join('\n');
}

function buildGitDiffContextBlock(summary) {
  const diffText = formatGitDiffSummary(summary);
  if (!diffText) return null;
  return {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: markdownToMrkdwn(diffText),
    }],
  };
}

// --- Public API ---

/**
 * Build send payloads from agent output.
 * Returns Array<{ blocks?: Block[], text: string }>
 *
 * Always returns an array. Each element is one Slack message.
 * If blocks present: send as Block Kit. Otherwise: plain text.
 */
export function buildSendPayloads(text, options = {}) {
  const gitDiffSummary = options?.gitDiffSummary;
  const diffOnly = !text && gitDiffSummary?.hasChanges;
  if (!text && !diffOnly) return [{ text: '(无回复)' }];
  const diffContextBlock = buildGitDiffContextBlock(gitDiffSummary);
  if (diffOnly) {
    const blocks = [diffContextBlock];
    return [{ blocks, text: '改动摘要' }];
  }

  // Agent explicitly output Block Kit JSON
  const explicit = parseBlockKit(text);
  if (explicit) {
    if (diffContextBlock) explicit.blocks.push(diffContextBlock);
    return [{ blocks: explicit.blocks, text: explicit.text }];
  }

  // Extract markdown tables BEFORE mrkdwn conversion (preserves raw markdown)
  const tableBlocks = [];
  const TABLE_RE = /^(\|.+\|)\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/gm;
  const withPlaceholders = text.replace(TABLE_RE, (match) => {
    const block = markdownTableToBlock(match);
    if (block) {
      tableBlocks.push(block);
      return `%%TABLE_${tableBlocks.length - 1}%%`;
    }
    return match; // fallback: leave as-is
  });

  const converted = markdownToMrkdwn(withPlaceholders);

  // Force blocks mode if we have tables
  const useBlocks = Boolean(diffContextBlock) || shouldUseBlocks(converted) || tableBlocks.length > 0;

  if (!useBlocks) {
    return [{ text: converted }];
  }

  const blocks = buildBlocks(converted, tableBlocks);
  if (blocks.length === 0) {
    if (diffContextBlock) return [{ blocks: [diffContextBlock], text: buildFallbackText(text) || '改动摘要' }];
    return [{ text: converted }];
  }
  if (diffContextBlock) blocks.push(diffContextBlock);

  const fallback = buildFallbackText(text);
  const groups = buildBlockGroups(blocks);

  return groups.map((groupBlocks, i) => ({
    blocks: groupBlocks,
    text: groups.length > 1 ? `${fallback} (${i + 1}/${groups.length})` : fallback,
  }));
}

/**
 * Split long plain text into Slack-safe chunks with pagination indicators.
 * Code fences are closed/reopened across chunk boundaries.
 */
export function splitPlainText(text) {
  if (!text) return ['(无回复)'];
  const converted = markdownToMrkdwn(text);
  const chunks = splitFenceAware(converted, MAX_LENGTH);
  if (chunks.length > 1) {
    const total = chunks.length;
    return chunks.map((c, i) => `${c}\n（${i + 1}/${total}）`);
  }
  return chunks;
}

function richTextFromString(text) {
  const normalized = String(text || '').trim();
  return {
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: normalized ? [{ type: 'text', text: normalized }] : [{ type: 'text', text: ' ' }],
    }],
  };
}

function buildPromptMessage(action) {
  const normalized = String(action || '').trim().replace(/[。？?！!]+$/g, '');
  if (!normalized) return '';
  if (/^(请|继续|直接|顺手|把|将|帮我|帮我把|帮我将)/.test(normalized)) return normalized;
  return `请${normalized}`;
}

function buildPromptTitle(action) {
  const normalized = String(action || '').trim()
    .replace(/^[，、\s]+/, '')
    .replace(/[。？?！!]+$/g, '')
    .replace(/^(帮我|帮我把|帮我将|请|继续|直接|顺手|把|将)/, '')
    .trim();
  return (normalized || action || '继续').slice(0, 24);
}

export function extractSuggestedPrompts(text) {
  const source = String(text || '');
  if (!source.trim()) return [];

  const prompts = [];
  const seen = new Set();
  const pushPrompt = (action) => {
    const trimmed = String(action || '').trim();
    if (!trimmed || trimmed.length > 40 || /[。；;，,、\n]/.test(trimmed)) return;
    const message = buildPromptMessage(trimmed);
    const title = buildPromptTitle(trimmed);
    if (!message || !title) return;
    const key = `${title}::${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    prompts.push({ title, message });
  };

  for (const match of source.matchAll(/要我([^。；;，,、\n]+?)吗[？?]/g)) {
    pushPrompt(match[1]);
    if (prompts.length >= 4) return prompts;
  }

  for (const match of source.matchAll(/需要(?:我)?([^。；;，,、\n]+?)吗[？?]/g)) {
    pushPrompt(match[1]);
    if (prompts.length >= 4) return prompts;
  }

  for (const match of source.matchAll(/\*\*(.+?)\*\*\s*[\/／]\s*\*\*(.+?)\*\*/g)) {
    pushPrompt(match[1]);
    if (prompts.length >= 4) return prompts;
    pushPrompt(match[2]);
    if (prompts.length >= 4) return prompts;
  }

  return prompts;
}

function normalizeTaskStatus(status, fallback = 'in_progress') {
  if (status === 'completed') return 'complete';
  if (status === 'pending' || status === 'in_progress' || status === 'complete' || status === 'error') return status;
  return fallback;
}

function truncateText(text, maxChars) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function truncateTaskField(text) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= 256) return normalized;
  return `${normalized.slice(0, 255)}…`;
}

function mapTodoStatus(status) {
  if (status === 'completed') return 'complete';
  if (status === 'in_progress') return 'in_progress';
  return 'pending';
}

export function buildPlanSnapshotRows(todos) {
  if (!Array.isArray(todos)) return [];
  return todos.map((todo, index) => ({
    task_id: `todowrite-todo-${index}`,
    title: truncateTaskField(todo?.content || `Todo ${index + 1}`),
    status: mapTodoStatus(todo?.status),
  }));
}

export function buildPlanSnapshotTitle(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const total = list.length;
  const completed = list.filter((todo) => todo?.status === 'completed').length;
  const activeTodo = list.find((todo) => todo?.status === 'in_progress');

  if (activeTodo) {
    return `进度 ${completed}/${total}｜${truncateText(activeTodo.content || '进行中', 40)}`;
  }
  if (total > 0 && completed === total) {
    return `进度 ${total}/${total}｜完成`;
  }
  return `进度 ${completed}/${total}`;
}

export function buildTaskUpdateChunks(taskCardsMap, { updateOnly = false } = {}) {
  return [...(taskCardsMap?.entries?.() || [])].map(([task_id, card]) => {
    const chunk = {
      type: 'task_update',
      id: String(task_id || ''),
      status: normalizeTaskStatus(card?.status, 'in_progress'),
    };
    const output = String(card?.output || '').trim();
    if (updateOnly) {
      chunk.title = String(card?.title || 'Task').slice(0, 256);
      if (output) chunk.output = output.slice(0, 256);
      return chunk;
    }
    chunk.title = String(card?.title || 'Task').slice(0, 256);
    const details = String(card?.details || '').trim();
    if (details) chunk.details = details.slice(0, 256);
    if (output) chunk.output = output.slice(0, 256);
    return chunk;
  }).filter((chunk) => chunk.id);
}

export function categorizeTool(toolName) {
  if (/^(Bash|Read|Edit|Write|Grep|Glob|NotebookEdit|WebFetch|WebSearch)$/.test(toolName)) return 'Probe';
  if (/^(Task|Agent|Skill|mcp__)/.test(toolName)) return 'Delegate';
  if (toolName === 'summary') return 'Distill';
  return null;
}



export { sanitizeErrorText } from '../format-utils.js';
