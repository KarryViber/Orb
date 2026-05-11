import { parseToolInput } from './worker/tool-event-state.js';

const DAILY_NOTES_SNIPPET_MAX_CHARS = 40;

function splitShellWords(command) {
  const words = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const ch of String(command || '')) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaped) current += '\\';
  if (current) words.push(current);
  return words;
}

function optionValue(words, name) {
  const prefix = `${name}=`;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === name) return words[i + 1] || '';
    if (word.startsWith(prefix)) return word.slice(prefix.length);
  }
  return '';
}

function truncateSnippet(text, maxChars = DAILY_NOTES_SNIPPET_MAX_CHARS) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  let end = maxChars;
  const prev = normalized[end - 1] || '';
  const next = normalized[end] || '';
  if (/[A-Za-z0-9_]/.test(prev) && /[A-Za-z0-9_]/.test(next)) {
    const boundary = normalized.lastIndexOf(' ', end - 1);
    if (boundary >= Math.floor(maxChars * 0.6)) end = boundary;
  }
  return `${normalized.slice(0, end).trimEnd()}...`;
}

export function parseDailyNotesAppendToolUse(toolUse) {
  if (toolUse?.name !== 'Bash') return null;
  const input = parseToolInput(toolUse?.input);
  const command = typeof input?.command === 'string' ? input.command : '';
  if (!command.includes('daily-notes-append.py')) return null;

  const words = splitShellWords(command);
  const mode = optionValue(words, '--mode') || 'line';
  const time = optionValue(words, '--time') || '';
  const layer = optionValue(words, '--layer') || '';
  const title = optionValue(words, '--title') || '';
  const body = optionValue(words, '--body') || '';
  const snippet = truncateSnippet(title || body);

  return {
    mode,
    time,
    ...(layer ? { layer } : {}),
    ...(title ? { title } : {}),
    ...(snippet ? { snippet } : {}),
  };
}
