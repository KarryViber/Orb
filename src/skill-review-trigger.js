const EXPLICIT_KEYWORDS = /记一下|抽个\s*skill|这个步骤|make a skill|extract a skill|remember this workflow/i;
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
const ERROR_RE = /error|failed|exception|traceback|enoent|eacces|permission denied|timed?\s*out/i;

function toolName(entry) {
  return typeof entry === 'string' ? entry : entry?.name || entry?.tool || '';
}

function toolInputText(entry) {
  const input = typeof entry === 'object' ? entry.input || entry.payload || entry : {};
  try {
    return JSON.stringify(input);
  } catch {
    return String(input || '');
  }
}

function pathTokens(text) {
  return String(text || '').match(/(?:\/[\w.-]+){3,}|[\w.-]+\/[\w./-]{8,}/g) || [];
}

function hasRepeatedSequence(names) {
  if (names.length < 4) return false;
  for (let size = 2; size <= Math.min(4, Math.floor(names.length / 2)); size++) {
    const seen = new Set();
    for (let i = 0; i + size <= names.length; i++) {
      const seq = names.slice(i, i + size).join('>');
      if (seen.has(seq)) return true;
      seen.add(seq);
    }
  }
  return false;
}

function hasSustainedPairing(names) {
  const pairs = new Map();
  for (let i = 0; i + 1 < names.length; i++) {
    const pair = [names[i], names[i + 1]].sort().join('+');
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  return [...pairs.values()].some((count) => count >= 2);
}

function existingSkillCovered({ text = '', existingSkillText = '' }) {
  const keywords = [...new Set(String(text).toLowerCase().match(/[a-z][a-z0-9_-]{3,}|[\u4e00-\u9fff]{2,}/g) || [])];
  const haystack = String(existingSkillText || '').toLowerCase();
  return keywords.filter((kw) => haystack.includes(kw)).length >= 3;
}

export function assessSkillReviewTrigger(toolHistory = [], options = {}) {
  const names = toolHistory.map(toolName).filter(Boolean);
  const text = [
    options.userText || '',
    options.resultText || '',
    ...toolHistory.map(toolInputText),
  ].join('\n');
  const uniqueTools = new Set(names);

  if (names.length <= 2) return { should: false, reason: 'one-off: only 1-2 tool calls', pattern: 'one_off' };
  if (names.length === 1 && READ_ONLY_TOOLS.has(names[0])) {
    return { should: false, reason: 'trivial: read-only single step', pattern: 'trivial' };
  }
  if (names.every((name) => READ_ONLY_TOOLS.has(name)) && uniqueTools.size <= 1) {
    return { should: false, reason: 'trivial: read-only single-tool thread', pattern: 'trivial' };
  }
  if (existingSkillCovered({ text, existingSkillText: options.existingSkillText })) {
    return { should: false, reason: 'existing skill coverage matched 3+ keywords', pattern: 'existing_skill' };
  }
  const paths = pathTokens(text);
  if (paths.length >= Math.max(3, names.length) && uniqueTools.size <= 2) {
    return { should: false, reason: 'highly context-specific project paths dominate', pattern: 'context_specific' };
  }

  if (EXPLICIT_KEYWORDS.test(options.threadText || options.userText || '')) {
    return { should: true, reason: 'user explicitly requested skill capture', pattern: 'explicit_user' };
  }
  if (hasRepeatedSequence(names)) {
    return { should: true, reason: 'same tool sequence repeated in thread', pattern: 'repeated_action' };
  }
  if (ERROR_RE.test(text) && names.some((name) => ['Edit', 'Write', 'Bash'].includes(name))) {
    return { should: true, reason: 'error followed by fix-capable tool sequence', pattern: 'repair_pattern' };
  }
  if (uniqueTools.size >= 3) {
    return { should: true, reason: '3+ distinct tools collaborated', pattern: 'multi_step_workflow' };
  }
  if (hasSustainedPairing(names)) {
    return { should: true, reason: '2+ tools were paired repeatedly', pattern: 'tool_combination' };
  }

  return { should: false, reason: 'no reusable skill pattern detected', pattern: 'none' };
}
