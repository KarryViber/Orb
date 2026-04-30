import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { info } from './log.js';
import { purgeTransient, lintMemory } from './memory.js';

const TAG = 'scheduler';
export const MEMORY_SYNC_THRESHOLD = 20;
export const MEMORY_SYNC_INTERVAL = 6 * 60 * 60 * 1000;

export function checkMemorySync({
  profileName,
  toolCount,
  task,
  memorySyncCounts,
  lastMemorySync,
  getProfile,
}) {
  if (!toolCount) return null;

  const prev = memorySyncCounts.get(profileName) || 0;
  const next = prev + toolCount;
  memorySyncCounts.set(profileName, next);

  if (next < MEMORY_SYNC_THRESHOLD) return null;

  memorySyncCounts.set(profileName, 0);

  const lastSync = lastMemorySync.get(profileName) || 0;
  if (Date.now() - lastSync < MEMORY_SYNC_INTERVAL) return null;
  lastMemorySync.set(profileName, Date.now());
  info(TAG, `memory sync threshold reached: profile=${profileName} tools=${next}`);
  return runMemoryMaintenance({ task, getProfile });
}

// Memory housekeeping: purge transient facts, lint memory.db, GC image cache.
// MEMORY.md / USER.md distillation is retired — CLI-native auto-memory
// (~/.claude/projects/{cwd}/memory/) handles persistent preference tracking.
export async function runMemoryMaintenance({ task, getProfile }) {
  const { userId } = task;
  const profile = getProfile(userId);
  const dbPath = join(profile.dataDir, 'memory.db');

  const transientReport = await purgeTransient(dbPath, { maxAgeDays: 7 }).catch(() => ({ purged: 0 }));
  if (transientReport.purged > 0) {
    info(TAG, `purged ${transientReport.purged} transient fact(s)`);
  }

  const lintReport = await lintMemory(dbPath, { fix: true }).catch(() => ({}));
  if (lintReport.actions_taken?.length > 0) {
    info(TAG, `memory lint: ${lintReport.actions_taken.length} actions — ${lintReport.actions_taken.join(', ')}`);
  }

  cleanupImages(profile.workspaceDir);
}

export function cleanupImages(workspaceDir) {
  const imgDir = join(workspaceDir, '.images');
  try {
    const files = readdirSync(imgDir);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of files) {
      const fp = join(imgDir, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp);
      } catch {}
    }
  } catch {}
}
