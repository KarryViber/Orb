import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { info, warn } from './log.js';
import { taskQueue } from './queue.js';

const TAG = 'scheduler';
export const SHUTDOWN_QUEUE_FILE = 'shutdown-queue.json';
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
    const addPersistedTask = (task, threadTs = null) => {
      const persistedTask = sanitizeTaskForPersistence(task);
      if (!persistedTask) return;
      let profileName = 'unknown';
      let dataDir = null;
      try {
        const profile = getProfile(persistedTask.userId);
        profileName = profile.name;
        dataDir = profile.dataDir;
      } catch {}
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

    for (const task of drained || []) addPersistedTask(task);
    for (const [threadTs, queue] of threadQueues) {
      for (const task of queue) addPersistedTask(task, threadTs);
    }
    for (const [threadTs, entry] of activeWorkers) {
      if (entry.task) {
        addPersistedTask(entry.task, threadTs);
      }
      if (entry.pendingInjects && entry.pendingInjects.size > 0) {
        for (const injectTask of entry.pendingInjects.values()) {
          addPersistedTask(injectTask, threadTs);
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
  } catch (e) {
    warn(TAG, `shutdown: queue persistence error: ${e.message}`);
  }
}
