import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { info, warn } from './log.js';
import { taskQueue } from './queue.js';

const TAG = 'scheduler';
export const SHUTDOWN_QUEUE_FILE = 'shutdown-queue.json';
export const INTERRUPTED_RUNS_FILE = 'interrupted-runs.json';
export const SHUTDOWN_QUEUE_VERSION = 2;

const PERSISTED_TASK_FIELDS = [
  'userText',
  'fileContent',
  'imagePaths',
  'threadTs',
  'channel',
  'userId',
  'platform',
  'teamId',
  'profile',
  'model',
  'effort',
  'maxTurns',
  'deliveryThreadTs',
  'rerun',
  'targetMessageTs',
  'forceNewWorker',
  'mode',
  'priorConversation',
  'deferDeliveryUntilResult',
  'enableTaskCard',
  'channelSemantics',
  'attemptId',
  'fragments',
  'origin',
];

export function sanitizeTaskForPersistence(task) {
  if (!task || typeof task !== 'object') return null;
  const persisted = {};
  for (const field of PERSISTED_TASK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(task, field)) {
      persisted[field] = task[field];
    }
  }
  return persisted;
}

function isCronTask(task) {
  if (!task || typeof task !== 'object') return false;
  if (task.origin?.kind === 'cron') return true;
  return String(task.threadTs || '').startsWith('cron:');
}

function taskDedupKey(task, fallbackThreadTs = null) {
  const attemptId = task?.attemptId;
  if (!attemptId) return null;
  const threadTs = task?.threadTs || fallbackThreadTs;
  if (!threadTs) return null;
  return `${threadTs}:${attemptId}`;
}

export function normalizeShutdownQueue(raw, queuePath) {
  if (Array.isArray(raw)) {
    warn(TAG, `startup replay: legacy shutdown queue schema detected at ${queuePath}; only global queue will be restored`);
    return { globalQueue: raw, threadQueues: {} };
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('shutdown queue payload must be an array or object');
  }

  const globalQueue = Array.isArray(raw.globalQueue)
    ? raw.globalQueue
    : Array.isArray(raw.taskQueue)
      ? raw.taskQueue
      : [];
  const threadQueues = raw.threadQueues && typeof raw.threadQueues === 'object'
    ? raw.threadQueues
    : {};
  const seen = new Set();
  const dedupQueue = (queue, fallbackThreadTs = null) => {
    const out = [];
    for (const task of Array.isArray(queue) ? queue : []) {
      if (!task) continue;
      const key = taskDedupKey(task, fallbackThreadTs);
      if (key && seen.has(key)) {
        warn(TAG, `startup replay deduped task attempt=${task.attemptId} thread=${task.threadTs || fallbackThreadTs || 'unknown'} from ${queuePath}`);
        continue;
      }
      if (key) seen.add(key);
      out.push(task);
    }
    return out;
  };
  const dedupedGlobalQueue = dedupQueue(globalQueue);
  const dedupedThreadQueues = {};
  for (const [threadTs, queue] of Object.entries(threadQueues)) {
    const deduped = dedupQueue(queue, threadTs);
    if (deduped.length > 0) dedupedThreadQueues[threadTs] = deduped;
  }
  return { globalQueue: dedupedGlobalQueue, threadQueues: dedupedThreadQueues };
}

export function restoreShutdownQueues({ threadQueues }) {
  const profilesDir = join(import.meta.dirname, '..', 'profiles');
  if (!existsSync(profilesDir)) return;

  try {
    const profiles = readdirSync(profilesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const entry of profiles) {
      const queuePath = join(profilesDir, entry.name, 'data', SHUTDOWN_QUEUE_FILE);
      if (!existsSync(queuePath)) continue;

      try {
        const raw = JSON.parse(readFileSync(queuePath, 'utf8'));
        const restored = normalizeShutdownQueue(raw, queuePath);
        let restoredCount = 0;

        for (const task of restored.globalQueue) {
          if (taskQueue.enqueue(task)) restoredCount++;
          else warn(TAG, `startup replay dropped global queued task for thread=${task?.threadTs || 'unknown'}: taskQueue full`);
        }

        for (const [threadTs, queue] of Object.entries(restored.threadQueues)) {
          const validQueue = Array.isArray(queue) ? queue.filter(Boolean) : [];
          if (validQueue.length === 0) continue;
          threadQueues.set(threadTs, validQueue);
          restoredCount += validQueue.length;
        }

        unlinkSync(queuePath);
        info(TAG, `startup replay restored ${restoredCount} queued task(s) from ${queuePath}`);
      } catch (err) {
        warn(TAG, `startup replay failed for ${queuePath}: ${err.message}`);
      }
    }
  } catch (err) {
    warn(TAG, `startup replay scan failed: ${err.message}`);
  }
}

export function persistShutdownQueues({ threadQueues, activeWorkers, getProfile }) {
  try {
    const pending = taskQueue.drain ? taskQueue.drain() : [];
    let drained = pending;
    if ((!drained || drained.length === 0) && typeof taskQueue.dequeue === 'function') {
      drained = [];
      let t;
      while ((t = taskQueue.dequeue())) drained.push(t);
    }
    const byProfile = new Map();
    const interruptedByProfile = new Map();
    const resolveProfileForTask = (persistedTask) => {
      let profileName = 'unknown';
      let dataDir = null;
      if (persistedTask?.profile?.dataDir) {
        profileName = persistedTask.profile.name || profileName;
        dataDir = persistedTask.profile.dataDir;
        return { profileName, dataDir };
      }
      try {
        const profile = getProfile(persistedTask.userId);
        profileName = profile.name;
        dataDir = profile.dataDir;
      } catch {}
      return { profileName, dataDir };
    };
    const addPersistedTask = (task, threadTs = null) => {
      if (isCronTask(task)) return;
      const persistedTask = sanitizeTaskForPersistence(task);
      if (!persistedTask) return;
      const { profileName, dataDir } = resolveProfileForTask(persistedTask);
      if (!dataDir) return;
      if (!byProfile.has(profileName)) {
        byProfile.set(profileName, { dataDir, globalQueue: [], threadQueues: {} });
      }
      const entry = byProfile.get(profileName);
      if (threadTs) {
        if (!entry.threadQueues[threadTs]) entry.threadQueues[threadTs] = [];
        entry.threadQueues[threadTs].push(persistedTask);
      } else {
        entry.globalQueue.push(persistedTask);
      }
    };
    const addInterrupted = (task, role) => {
      if (isCronTask(task)) return;
      const persistedTask = sanitizeTaskForPersistence(task);
      if (!persistedTask) return;
      const { profileName, dataDir } = resolveProfileForTask(persistedTask);
      if (!dataDir) return;
      if (!interruptedByProfile.has(profileName)) {
        interruptedByProfile.set(profileName, { dataDir, runs: [] });
      }
      interruptedByProfile.get(profileName).runs.push({
        role,
        task: persistedTask,
        interruptedAt: new Date().toISOString(),
        attemptId: persistedTask.attemptId || null,
        threadTs: persistedTask.threadTs || null,
        origin: persistedTask.origin || null,
      });
    };

    for (const task of drained || []) addPersistedTask(task);
    for (const [threadTs, queue] of threadQueues) {
      for (const task of queue) addPersistedTask(task, threadTs);
    }
    for (const entry of activeWorkers.values()) {
      if (entry.task) addInterrupted(entry.task, 'active-task');
      if (entry.pendingInjects && entry.pendingInjects.size > 0) {
        for (const injectTask of entry.pendingInjects.values()) {
          addInterrupted(injectTask, 'pending-inject');
        }
      }
    }

    if (byProfile.size > 0) {
      let totalPersisted = 0;
      for (const [name, payload] of byProfile) {
        try {
          mkdirSync(payload.dataDir, { recursive: true });
          const outPath = join(payload.dataDir, SHUTDOWN_QUEUE_FILE);
          writeFileSync(outPath, `${JSON.stringify({
            version: SHUTDOWN_QUEUE_VERSION,
            globalQueue: payload.globalQueue,
            threadQueues: payload.threadQueues,
          }, null, 2)}\n`);
          const profileCount = payload.globalQueue.length
            + Object.values(payload.threadQueues).reduce((sum, queue) => sum + queue.length, 0);
          totalPersisted += profileCount;
          info(TAG, `shutdown: persisted ${profileCount} task(s) for profile=${name} → ${outPath}`);
        } catch (e) {
          warn(TAG, `shutdown: failed to persist queue for profile=${name}: ${e.message}`);
        }
      }
      warn(TAG, `shutdown: persisted ${totalPersisted} queued task(s) to ${SHUTDOWN_QUEUE_FILE}`);
    }
    for (const [name, payload] of interruptedByProfile) {
      try {
        mkdirSync(payload.dataDir, { recursive: true });
        const outPath = join(payload.dataDir, INTERRUPTED_RUNS_FILE);
        let existing = [];
        if (existsSync(outPath)) {
          try { existing = JSON.parse(readFileSync(outPath, 'utf8')) || []; } catch {}
          if (!Array.isArray(existing)) existing = [];
        }
        const merged = [...existing, ...payload.runs];
        writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
        warn(TAG, `shutdown: marked ${payload.runs.length} run(s) interrupted for profile=${name} → ${outPath}`);
      } catch (e) {
        warn(TAG, `shutdown: failed to mark interrupted for profile=${name}: ${e.message}`);
      }
    }
  } catch (e) {
    warn(TAG, `shutdown: queue persistence error: ${e.message}`);
  }
}
