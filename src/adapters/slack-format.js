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

// CJK boundary regex: Slack mrkdwn formatting chars (* _ ~) need word
// boundaries to render. CJK and fullwidth punctuation aren't recognized
// as boundaries, so we insert U+200B (zero-width space) where needed.
const CJK_BOUNDARY = /[⺀-鿿豈-﫿︰-﹏＀-￯]/;

function protectTokens(text, store) {
  let result = text;
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    store.codeBlocks.push(match);
    return `\x00CB${store.codeBlocks.length - 1}\x00`;
  });
  result = result.replace(/`[^`]+`/g, (match) => {
    store.inlineCodes.push(match);
    return `\x00IC${store.inlineCodes.length - 1}\x00`;
  });
  result = result.replace(/<(?:@[A-Z0-9]+|#[A-Z0-9]+(?:\|[^>]*)?|![a-z]+(?:\|[^>]*)?)>/g, (match) => {
    store.slackEntities.push(match);
    return `\x00SE${store.slackEntities.length - 1}\x00`;
  });
  return result;
}

function convertStructural(text, store) {
  let result = protectStructuralHeadings(text, store.headingMarks);
  result = result.replace(/^>\s?/gm, '> ');
  return result;
}

function convertInline(text, store) {
  let result = text;

  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '*_$1_*');

  result = result.replace(/\*\*(.+?)\*\*/g, (_, inner) => {
    store.boldMarks.push(inner);
    return `\x00BD${store.boldMarks.length - 1}\x00`;
  });
  result = result.replace(/__(.+?)__/g, (_, inner) => {
    store.boldMarks.push(inner);
    return `\x00BD${store.boldMarks.length - 1}\x00`;
  });

  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (match, inner, offset, str) => {
    const before = str[offset - 1] || '';
    const after = str[offset + match.length] || '';
    const innerHasCjk = CJK_BOUNDARY.test(inner);
    let out = innerHasCjk ? `*${inner}*` : `_${inner}_`;
    if (CJK_BOUNDARY.test(before)) out = '​' + out;
    if (CJK_BOUNDARY.test(after)) out = out + '​';
    return out;
  });

  result = result.replace(/\x00BD(\d+)\x00/g, (match, i, offset, str) => {
    const before = str[offset - 1] || '';
    const after = str[offset + match.length] || '';
    let out = `*${store.boldMarks[i]}*`;
    if (CJK_BOUNDARY.test(before)) out = '​' + out;
    if (CJK_BOUNDARY.test(after)) out = out + '​';
    return out;
  });

  result = result.replace(/~~(.+?)~~/g, '~$1~');

  result = result.replace(/\x00HD(\d+)\x00/g, (_, i) => store.headingMarks[i]);

  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<$2|$1>');

  result = result.replace(/\[([^\]]+)\]\(((?:[^()]+|\([^()]*\))+)\)/g, '<$2|$1>');

  result = result.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '———');

  result = result.replace(/&amp;(#?\w+;)/g, '&$1');

  return result;
}

function restoreTokens(text, store) {
  let result = text;
  result = result.replace(/\x00SE(\d+)\x00/g, (_, i) => store.slackEntities[i]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i) => store.inlineCodes[i]);
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i) => store.codeBlocks[i]);
  return result;
}

export function markdownToMrkdwn(text) {
  if (!text) return '';

  const store = {
    codeBlocks: [],
    inlineCodes: [],
    slackEntities: [],
    headingMarks: [],
    boldMarks: [],
  };

  let result = text.replace(/\u200b/g, '');
  result = protectTokens(result, store);
  result = convertStructural(result, store);
  result = convertInline(result, store);
  result = restoreTokens(result, store);
  return result;
}

function normalizeBlockMrkdwn(block) {
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
 * Walk Block Kit blocks in-place and translate markdown-bearing text fields
 * to Slack mrkdwn. Plain text surfaces, rich_text, tables, actions, and
 * dividers are intentionally left unchanged.
 */
function normalizeBlocksMrkdwn(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  for (const block of blocks) normalizeBlockMrkdwn(block);
  return blocks;
}

/**
 * Try to parse explicit Block Kit JSON from agent output.
 * Cleans the fallback text so we never ship raw `**bold**` / inline code to Slack.
 */
export function parseBlockKit(text) {
  if (!text || !text.trimStart().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed.blocks && Array.isArray(parsed.blocks) && parsed.text) {
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
const EMOJI_RE = /:([a-z0-9_+-]+):/;
const EMOJI_TOKEN_RE = /:([a-z0-9_+-]+):/g;

function collectMarkdownCellTokens(t) {
  const tokens = [];
  const TOKEN_RE = /(\*\*(.+?)\*\*|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|__(.+?)__|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)|~~(.+?)~~|`([^`]+)`)/g;
  let m;
  while ((m = TOKEN_RE.exec(t)) !== null) {
    let el = null;
    if (m[2]) el = { type: 'text', text: m[2], style: { bold: true } };
    else if (m[3]) el = { type: 'text', text: m[3], style: { italic: true } };
    else if (m[4]) el = { type: 'text', text: m[4], style: { bold: true } };
    else if (m[5]) el = { type: 'text', text: m[5], style: { italic: true } };
    else if (m[6]) el = { type: 'text', text: m[6], style: { strike: true } };
    else if (m[7]) el = { type: 'text', text: m[7], style: { code: true } };
    if (el) {
      tokens.push({ start: m.index, end: m.index + m[1].length, element: el });
    }
  }
  return tokens;
}

function collectEmojiCellTokens(t) {
  const tokens = [];
  const re = new RegExp(EMOJI_TOKEN_RE.source, 'g');
  let m;
  while ((m = re.exec(t)) !== null) {
    tokens.push({
      start: m.index,
      end: m.index + m[0].length,
      element: { type: 'emoji', name: m[1] },
    });
  }
  return tokens;
}

function emitCellElements(t, tokens) {
  tokens.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  let lastEnd = 0;
  for (const tok of tokens) {
    if (tok.start < lastEnd) continue;
    merged.push(tok);
    lastEnd = tok.end;
  }
  const elements = [];
  let cursor = 0;
  for (const tok of merged) {
    if (tok.start > cursor) {
      elements.push({ type: 'text', text: t.slice(cursor, tok.start) });
    }
    elements.push(tok.element);
    cursor = tok.end;
  }
  if (cursor < t.length) {
    elements.push({ type: 'text', text: t.slice(cursor) });
  }
  return elements;
}

/**
 * Convert a markdown-formatted cell string to a Slack table cell.
 * Table cells don't run mrkdwn parsing, so emoji shortcodes must be emitted
 * as `{type:'emoji'}` elements inside rich_text — otherwise they render
 * literally as `:tada:`.
 */
function cellToBlock(text) {
  const t = (text || '').trim() || ' ';
  if (!MD_FORMAT_RE.test(t) && !EMOJI_RE.test(t)) {
    return { type: 'raw_text', text: t };
  }

  const tokens = [...collectMarkdownCellTokens(t), ...collectEmojiCellTokens(t)];
  const elements = emitCellElements(t, tokens);

  if (elements.length === 0) {
    return { type: 'raw_text', text: t };
  }

  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements }],
  };
}

function cellHeaderToBlock(text) {
  const stripped = (stripMarkdown(text) || '').trim() || ' ';
  if (!EMOJI_RE.test(stripped)) {
    return { type: 'raw_text', text: stripped };
  }
  const elements = emitCellElements(stripped, collectEmojiCellTokens(stripped));
  if (elements.length === 0) {
    return { type: 'raw_text', text: stripped };
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

  // Header row: strip markdown emphasis but keep emoji shortcodes rendered.
  const rows = [headerCells.map((c) => cellHeaderToBlock(c))];

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

  return normalizeBlocksMrkdwn(blocks);
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

// --- Public API ---

/**
 * Build send payloads from agent output.
 * Returns Array<{ blocks?: Block[], text: string }>
 *
 * Always returns an array. Each element is one Slack message.
 * If blocks present: send as Block Kit. Otherwise: plain text.
 */
export function buildSendPayloads(text, options = {}) {
  void options;
  if (!text) return [{ text: '(无回复)' }];

  // Agent explicitly output Block Kit JSON
  const explicit = parseBlockKit(text);
  if (explicit) {
    normalizeBlocksMrkdwn(explicit.blocks);
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
  const useBlocks = shouldUseBlocks(converted) || tableBlocks.length > 0;

  if (!useBlocks) {
    return [{ text: converted }];
  }

  const blocks = buildBlocks(converted, tableBlocks);
  if (blocks.length === 0) {
    return [{ text: converted }];
  }

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

export { buildPlanSnapshotRows, buildPlanSnapshotTitle, categorizeTool };

export { sanitizeErrorText } from '../format-utils.js';
import {
  buildPlanSnapshotRows,
  buildPlanSnapshotTitle,
  categorizeTool,
} from '../turn-delivery/task-card-format.js';
