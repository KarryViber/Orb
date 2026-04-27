import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function yamlValue(value) {
  if (value == null || value === '') return 'null';
  return JSON.stringify(String(value));
}

function safePart(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'unknown';
}

function truncate(value, max = 500) {
  const text = String(value || '').replace(/\s+$/g, '');
  return text.length <= max ? text : text.slice(0, max);
}

export function writeLessonCandidate(dataDir, {
  source,
  stopReason = '',
  errorContext = '',
  threadId = '',
  cronName = '',
  kind = '',
} = {}) {
  if (!dataDir || !source) return null;
  const dir = join(dataDir, 'lesson-candidates');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${ts}-${safePart(source)}-${safePart(kind || cronName || threadId)}.md`);
  const frontmatter = [
    '---',
    'status: pending_review',
    `source: ${yamlValue(source)}`,
    `stopReason: ${yamlValue(stopReason)}`,
    `errorContext: ${yamlValue(truncate(errorContext))}`,
    `thread_id: ${yamlValue(threadId)}`,
    `cron_name: ${yamlValue(cronName)}`,
    `created_at: ${yamlValue(new Date().toISOString())}`,
    '---',
    '',
    '',
  ].join('\n');
  writeFileSync(file, frontmatter, 'utf-8');
  return file;
}

export function isUserCorrectionText(text) {
  return /不对|错了|应该是|重做|别这样|不是这样|你搞错了|wrong|redo|should be|not like this/i.test(String(text || ''));
}
