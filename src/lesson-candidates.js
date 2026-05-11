import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function yamlValue(value) {
  if (value == null || value === '') return 'null';
  return JSON.stringify(String(value));
}

function yamlObject(value) {
  if (!value || typeof value !== 'object') return 'null';
  return JSON.stringify(value);
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
  failureKind = '',
  origin = null,
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
    `failure_kind: ${yamlValue(failureKind)}`,
    `origin: ${yamlObject(origin)}`,
    `created_at: ${yamlValue(new Date().toISOString())}`,
    '---',
    '',
    '',
  ].join('\n');
  writeFileSync(file, frontmatter, 'utf-8');
  return file;
}

export function isUserCorrectionText(text) {
  if (!text) return false;
  const patterns = /不对|不是这样|不是我想要|不该这样|这不对|方向错了|搞错了|弄错了|理解错了|你搞错了|应该是|我要的是|按我说的|我说的不是|我说的是|改一下|别这样|错了|重做|重来|重新|再试|not what I|wrong|redo|try again|should be|not like this/i;
  return patterns.test(String(text));
}
