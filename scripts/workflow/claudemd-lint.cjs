#!/usr/bin/env node
// CLAUDE.md structure lint — mechanical checks, no LLM.
// Hooks into daily 01:15 reflection Step 1.
// Writes JSON to /tmp/claudemd_lint.json for reflect-send-slack merge.
// Always exits 0 on warnings (cron continues); non-zero only on self error.

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE || '~/Orb/profiles/<your-profile>/workspace';
const CLAUDE_MD = path.join(WORKSPACE, 'CLAUDE.md');
const ORB_ROOT = path.resolve(WORKSPACE, '../../..');
const ORB_CLAUDE_MD = path.join(ORB_ROOT, 'CLAUDE.md');
const ORB_SRC_DIR = path.join(ORB_ROOT, 'src');
const ORB_IPC_SCHEMA_JS = path.join(ORB_SRC_DIR, 'ipc-schema.js');
const LINE_WARN_THRESHOLD = 250;

const REQUIRED_SECTIONS = [
  '## 人格',
  '## 说话风格',
  '## 协作边界',
  '## 底线',
  '## Karry 协作偏好',
  '## 严禁操作',
  '## 输出约束',
  '## 上下文先行',
];

const warnings = [];

if (!fs.existsSync(CLAUDE_MD)) {
  console.error(JSON.stringify({ fatal: 'CLAUDE.md not found: ' + CLAUDE_MD }));
  process.exit(2);
}

const text = fs.readFileSync(CLAUDE_MD, 'utf-8');
const lines = text.split('\n');

if (lines.length > LINE_WARN_THRESHOLD) {
  warnings.push('lines ' + lines.length + ' exceeds threshold ' + LINE_WARN_THRESHOLD);
}

for (const sec of REQUIRED_SECTIONS) {
  if (!text.includes(sec)) warnings.push('missing section: ' + sec);
}

const refRe = /[`(]((?:\.claude\/skills|specs|data\/lessons|playbooks|scripts)\/[\w\-./]+?)[`)]/g;
const seen = new Set();
let m;
while ((m = refRe.exec(text)) !== null) {
  const rel = m[1];
  if (seen.has(rel)) continue;
  seen.add(rel);
  const p1 = path.join(WORKSPACE, rel);
  const p2 = path.join(WORKSPACE, '..', rel);
  if (!fs.existsSync(p1) && !fs.existsSync(p2)) {
    warnings.push('broken ref: ' + rel);
  }
}

const skillRefRe = /CLI skill `([\w-]+)`/g;
const skillDirs = [
  path.join(WORKSPACE, '.claude/skills'),
  path.join(ORB_ROOT, '.claude/skills'),
];
const existingSkills = [];
for (const skillDir of skillDirs) {
  if (!fs.existsSync(skillDir)) continue;
  for (const d of fs.readdirSync(skillDir)) {
    if (fs.existsSync(path.join(skillDir, d, 'SKILL.md'))) existingSkills.push(d);
  }
}
while ((m = skillRefRe.exec(text)) !== null) {
  const name = m[1];
  if (!existingSkills.includes(name)) warnings.push('referenced CLI skill missing: ' + name);
}

// === ~/Orb/CLAUDE.md cross-checks (developer guide) ===
if (fs.existsSync(ORB_CLAUDE_MD)) {
  const orbText = fs.readFileSync(ORB_CLAUDE_MD, 'utf-8');

  // Check 1: src/ file list in Architecture section vs real src/*.js (incl. adapters/)
  if (fs.existsSync(ORB_SRC_DIR)) {
    const realSrcFiles = new Set();
    const walk = function (dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile() && ent.name.endsWith('.js')) realSrcFiles.add(ent.name);
      }
    };
    walk(ORB_SRC_DIR);
    const docSrcFiles = new Set();
    const srcLineRe = /^\s{2,}([\w-]+\.js)\s+—/gm;
    let sm;
    while ((sm = srcLineRe.exec(orbText)) !== null) docSrcFiles.add(sm[1]);
    for (const f of realSrcFiles) {
      if (!docSrcFiles.has(f)) warnings.push('orb-claudemd: src/ list missing file: ' + f);
    }
    for (const f of docSrcFiles) {
      if (!realSrcFiles.has(f)) warnings.push('orb-claudemd: src/ list has stale file: ' + f);
    }
  }

  // Check 2: IPC payload fields — ipc-schema.js is source of truth
  if (fs.existsSync(ORB_IPC_SCHEMA_JS)) {
    const schemaText = fs.readFileSync(ORB_IPC_SCHEMA_JS, 'utf-8');
    const realTypes = {};
    const factoryRe = /export function make\w+\([^)]*\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)\n  \};/g;
    let fm;
    while ((fm = factoryRe.exec(schemaText)) !== null) {
      const body = fm[1];
      const typeMatch = body.match(/type:\s*IPC_TYPES\.(\w+)/);
      if (!typeMatch) continue;
      const typeKey = typeMatch[1];
      const typeConstRe = new RegExp(typeKey + ":\\s*'(\\w+)'");
      const typeNameMatch = schemaText.match(typeConstRe);
      if (!typeNameMatch) continue;
      const typeName = typeNameMatch[1];
      const fields = new Set();
      const fieldRe = /^\s{4}(\w+):/gm;
      let xm;
      while ((xm = fieldRe.exec(body)) !== null) {
        if (xm[1] !== 'type') fields.add(xm[1]);
      }
      realTypes[typeName] = fields;
    }
    const docTypes = {};
    const docTypeRe = /\{\s*type:\s*'(\w+)'\s*(?:,\s*([\s\S]*?))?\s*\}\s*(?:`|\|)/g;
    let dm;
    while ((dm = docTypeRe.exec(orbText)) !== null) {
      const t = dm[1];
      let body = (dm[2] || '').replace(/\{[^{}]*\}/g, '');
      const fields = new Set();
      for (const part of body.split(',')) {
        const name = part.trim().replace(/[?:].*$/, '').trim();
        if (/^\w+$/.test(name)) fields.add(name);
      }
      docTypes[t] = fields;
    }
    for (const t of Object.keys(realTypes)) {
      if (!docTypes[t]) {
        warnings.push('orb-claudemd: IPC type missing in doc: ' + t);
        continue;
      }
      const rf = realTypes[t];
      const df = docTypes[t];
      for (const f of rf) {
        if (!df.has(f)) warnings.push('orb-claudemd: IPC ' + t + ' doc missing field: ' + f);
      }
      for (const f of df) {
        if (!rf.has(f)) warnings.push('orb-claudemd: IPC ' + t + ' doc has stale field: ' + f);
      }
    }
  }
}

// === Lesson similarity nudge (daily) ===
try {
  const { spawnSync } = require('child_process');
  const scanScript = '~/Orb/profiles/<your-profile>/scripts/lesson-similarity-scan.py';
  if (fs.existsSync(scanScript)) {
    const out = spawnSync('python3', [scanScript], { encoding: 'utf-8', timeout: 30000 });
    if (out.status === 0 && out.stdout) {
      const scan = JSON.parse(out.stdout.trim().split('\n').pop());
      const HIGH_PAIRS_THRESHOLD = 10;
      if (scan.high_pairs_85 >= HIGH_PAIRS_THRESHOLD) {
        warnings.push(
          'lesson-similarity: ' + scan.high_pairs_85 + ' pairs >= 0.85 (' +
          scan.total_lessons + ' total lessons) — consider running lesson-cluster.py'
        );
      }
    }
  }
} catch (e) {
  // nudge is best-effort; never fail the lint
}

const result = {
  file: CLAUDE_MD,
  lines: lines.length,
  warnings: warnings,
  checked_at: new Date().toISOString(),
};

fs.writeFileSync('/tmp/claudemd_lint.json', JSON.stringify(result, null, 2));

if (warnings.length > 0) {
  console.error('[claudemd-lint] ' + warnings.length + ' warnings -> /tmp/claudemd_lint.json');
  for (const w of warnings) console.error('  - ' + w);
} else {
  console.error('[claudemd-lint] OK (' + lines.length + ' lines, no warnings)');
}

process.exit(0);
