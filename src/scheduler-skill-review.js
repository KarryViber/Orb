import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { info } from './log.js';
import { spawnWorker } from './spawn.js';
import { assessSkillReviewTrigger } from './skill-review-trigger.js';

const TAG = 'scheduler';
export const SKILL_REVIEW_THRESHOLD = 10;

export function scanExistingSkills(agentsDir) {
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => {
        try {
          const content = readFileSync(join(agentsDir, entry.name, 'SKILL.md'), 'utf8');
          const summary = content.split('\n').slice(0, 5).join('\n');
          return { file: `${entry.name}/SKILL.md`, summary };
        } catch { return { file: `${entry.name}/SKILL.md`, summary: '(read error)' }; }
      });
  } catch { return []; }
}

export function checkSkillReview({
  profileName,
  toolCount,
  task,
  resultText,
  toolHistory = [],
  toolResults = [],
  skillToolCounts,
  getProfile,
  backgroundWorkers,
  maxBackgroundWorkers,
}) {
  if (!toolCount || toolCount === 0) return;

  const prev = skillToolCounts.get(profileName) || 0;
  const next = prev + toolCount;
  skillToolCounts.set(profileName, next);

  const profile = task?.profile || getProfile(task?.userId);
  const agentsDir = join(profile.workspaceDir, '.claude', 'skills');
  const existingSkillText = scanExistingSkills(agentsDir)
    .map((skill) => `${skill.file}\n${skill.summary}`)
    .join('\n');
  const assessment = assessSkillReviewTrigger(toolHistory, {
    userText: task?.userText || '',
    resultText: resultText || '',
    threadText: [task?.threadHistory || '', task?.userText || '', resultText || ''].join('\n'),
    existingSkillText,
    toolResults,
  });

  if (assessment.should || next >= SKILL_REVIEW_THRESHOLD) {
    info(TAG, `skill review triggered: profile=${profileName} tools=${next} pattern=${assessment.pattern} reason=${assessment.reason}`);
    skillToolCounts.set(profileName, 0);
    const priorMessages = [];
    if (task?.userText) priorMessages.push({ role: 'user', content: String(task.userText) });
    if (resultText) priorMessages.push({ role: 'assistant', content: String(resultText) });
    if (toolHistory.length > 0) {
      priorMessages.push({ role: 'assistant', content: `Skill trigger: ${assessment.pattern} — ${assessment.reason}\nTools: ${toolHistory.map((item) => item.name).filter(Boolean).join(' -> ')}` });
    }
    spawnSkillReview({
      task,
      priorMessages,
      getProfile,
      backgroundWorkers,
      maxBackgroundWorkers,
    });
  }
}

export function spawnSkillReview({
  task,
  priorMessages = [],
  getProfile,
  backgroundWorkers,
  maxBackgroundWorkers,
}) {
  const { userId } = task;
  const profile = getProfile(userId);
  const agentsDir = join(profile.workspaceDir, '.claude', 'skills');
  const draftsDir = join(agentsDir, '_drafts');

  const existing = scanExistingSkills(agentsDir);
  const existingSection = existing.length > 0
    ? [
        '',
        '## Existing Skills',
        'These skills already exist. If the conversation improved or extended one, UPDATE it instead of creating a duplicate.',
        '',
        ...existing.map(s => `### ${s.file}\n${s.summary}\n`),
      ].join('\n')
    : '\n## Existing Skills\nNone yet.\n';

  const reviewPrompt = [
    'You are a skill extraction agent. Review the conversation that just completed.',
    '',
    '## Decision Flow',
    '1. Was a non-trivial, multi-step, reusable approach demonstrated?',
    '   - If NO → respond "No skill extracted." and exit',
    '   - If YES → continue',
    '2. Does it match an existing skill below?',
    '   - If YES → read that file, merge new learnings, write updated version back',
    '   - If NO → create a new skill file',
    '',
    '## Extraction Criteria',
    '- Multi-step approach requiring domain knowledge or trial-and-error',
    '- Reusable across different contexts (not one-off)',
    '- Worth documenting (saves future time)',
    '',
    existingSection,
    '',
    `## Output Location: ${draftsDir}/{kebab-case-name}/SKILL.md`,
    '',
    '## Skill File Format (Claude Code agent .md):',
    '```',
    '---',
    'name: skill-name',
    'description: One-line description of when/why to use this',
    'stage: draft',
    `created_at: ${new Date().toISOString()}`,
    `source_thread_id: ${task.threadTs || 'unknown'}`,
    '---',
    '# Skill Title',
    '',
    '## When to Use',
    'Trigger conditions...',
    '',
    '## Steps',
    '1. ...',
    '2. ...',
    '',
    '## Notes',
    'Gotchas, edge cases, lessons learned...',
    '```',
    '',
    'When UPDATING: preserve existing content that\'s still valid, add new learnings, bump any version notes.',
    'Be concise. One skill per directory. Directory name = kebab-case skill name; file name must be SKILL.md.',
  ].join('\n');

  if (backgroundWorkers.size >= maxBackgroundWorkers) {
    info(TAG, 'background worker limit reached, skipping skill review');
    return;
  }

  let worker;
  ({ worker } = spawnWorker({
    task: {
      type: 'task',
      userText: reviewPrompt,
      fileContent: '',
      threadTs: `skill-review-${Date.now()}`,
      channel: null,
      userId: null,
      platform: 'system',
      threadHistory: null,
      model: 'haiku',
      effort: 'low',
      maxTurns: null,
      disablePermissionPrompt: true,
      mode: 'skill-review',
      priorConversation: priorMessages,
      fragments: [],
      profile: {
        name: profile.name,
        scriptsDir: profile.scriptsDir,
        workspaceDir: profile.workspaceDir,
        dataDir: profile.dataDir,
      },
    },
    timeout: 120_000,
    label: `skill-review:${profile.name}`,
    onMessage: () => {},
    onExit: (code) => {
      backgroundWorkers.delete(worker);
      info(TAG, `skill review worker exited: code=${code} profile=${profile.name}`);
    },
  }));
  backgroundWorkers.add(worker);
  info(TAG, `skill review dispatched: profile=${profile.name} priorMessages=${priorMessages.length}`);
}
