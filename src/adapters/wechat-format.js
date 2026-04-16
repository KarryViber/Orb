/**
 * WeChat message formatting utilities.
 *
 * WeChat personal chat doesn't render Markdown natively.
 * Convert Markdown → readable plain text for chat bubbles.
 */

import { splitText } from '../format-utils.js';

const MAX_LENGTH = 4000;

// --- Markdown → WeChat plain text ---

const FENCE_RE = /^```(\w*)\s*$/;

/**
 * Convert Markdown to WeChat-friendly plain text.
 * - # Headers → 【Title】
 * - **bold** → kept (WeChat partially supports)
 * - [text](url) → text (url)
 * - Tables → key-value list
 * - Code fences → preserved as-is
 */
export function markdownToWechat(text) {
  if (!text) return '';

  const lines = text.split('\n');
  const result = [];
  let i = 0;
  let inCodeBlock = false;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code fence toggle
    if (FENCE_RE.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }

    // Table detection: current line has |, next line is separator
    if (
      i + 1 < lines.length &&
      line.includes('|') &&
      /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[i + 1])
    ) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      result.push(rewriteTable(tableLines));
      continue;
    }

    // Headers → 【Title】
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+?)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();
      result.push(level === 1 ? `【${title}】` : `**${title}**`);
      i++;
      continue;
    }

    // Links: [text](url) → text (url)
    let processed = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)');
    processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    // Horizontal rules
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      result.push('———');
      i++;
      continue;
    }

    result.push(processed);
    i++;
  }

  // Collapse 3+ consecutive blank lines to 2
  let output = result.join('\n');
  output = output.replace(/\n{3,}/g, '\n\n');
  return output.trim();
}

/**
 * Rewrite a markdown table to key-value list format.
 */
function rewriteTable(tableLines) {
  if (tableLines.length < 2) return tableLines.join('\n');

  const parseRow = (line) =>
    line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  const headers = parseRow(tableLines[0]);
  const rows = [];

  for (let i = 2; i < tableLines.length; i++) {
    const cells = parseRow(tableLines[i]);
    const pairs = [];
    for (let j = 0; j < headers.length && j < cells.length; j++) {
      const value = cells[j].trim();
      if (value) pairs.push(`${headers[j]}: ${value}`);
    }
    if (pairs.length <= 2) {
      rows.push(pairs.map((p) => `- ${p}`).join('\n'));
    } else {
      rows.push(`- ${pairs.join(' | ')}`);
    }
  }

  return rows.join('\n');
}

/**
 * Build send payloads from agent output.
 * Returns Array<{ text: string }> — WeChat only supports plain text bubbles.
 */
export function buildSendPayloads(text) {
  if (!text) return [{ text: '(无回复)' }];

  const converted = markdownToWechat(text);
  const chunks = splitText(converted, MAX_LENGTH);

  if (chunks.length > 1) {
    return chunks.map((c, i) => ({
      text: `${c}\n（${i + 1}/${chunks.length}）`,
    }));
  }

  return chunks.map((c) => ({ text: c }));
}
