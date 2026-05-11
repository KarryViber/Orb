import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { info, warn } from './log.js';
import { taskQueue } from './queue.js';

const TAG = 'scheduler';
export const SHUTDOWN_QUEUE_FILE = 'shutdown-queue.json';
const SHUTDOWN_QUEUE_VERSION = 2;

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

export function normalizeThreadQueueForPersistence(queue) {
  return (Array.isArray(queue) ? queue : [])
    .filter((task) => task && !isCronTask(task))
    .map((task) => sanitizeTaskForPersistence(task))
    .filter(Boolean);
}

export function serializeShutdownState(snapshot, normalizedQueue) {
  return {
    version: SHUTDOWN_QUEUE_VERSION,
    globalQueue: normalizeThreadQueueForPersistence(normalizedQueue?.globalQueue),
    threadQueues: Object.fromEntries(
      Object.entries(normalizedQueue?.threadQueues || {})
        .map(([threadTs, queue]) => [threadTs, normalizeThreadQueueForPersistence(queue)])
        .filter(([, queue]) => queue.length > 0),
    ),
  };
}

function drainGlobalQueue() {
  const pending = taskQueue.drain ? taskQueue.drain() : [];
  if (pending?.length || typeof taskQueue.dequeue !== 'function') return pending || [];
  const drained = [];
  let task;
  while ((task = taskQueue.dequeue())) drained.push(task);
  return drained;
}

function groupShutdownStateByProfile({ drained, threadQueues, getProfile }) {
  const byProfile = new Map();
  const resolveProfileForTask = (persistedTask) => {
    let profileName = 'unknown';
    let dataDir = null;
    if (persistedTask?.profile?.dataDir) {
      return {
        profileName: persistedTask.profile.name || profileName,
        dataDir: persistedTask.profile.dataDir,
      };
    }
    try {
      const profile = getProfile(persistedTask.userId);
      profileName = profile.name;
      dataDir = profile.dataDir;
    } catch {}
    return { profileName, dataDir };
  };
  const ensureQueuePayload = (profileName, dataDir) => {
    if (!byProfile.has(profileName)) byProfile.set(profileName, { dataDir, globalQueue: [], threadQueues: {} });
    return byProfile.get(profileName);
  };
  const addPersistedTask = (persistedTask, threadTs = null) => {
    const { profileName, dataDir } = resolveProfileForTask(persistedTask);
    if (!dataDir) return;
    const entry = ensureQueuePayload(profileName, dataDir);
    if (!threadTs) entry.globalQueue.push(persistedTask);
    else {
      if (!entry.threadQueues[threadTs]) entry.threadQueues[threadTs] = [];
      entry.threadQueues[threadTs].push(persistedTask);
    }
  };

  for (const task of normalizeThreadQueueForPersistence(drained)) addPersistedTask(task);
  for (const [threadTs, queue] of threadQueues) {
    for (const task of normalizeThreadQueueForPersistence(queue)) addPersistedTask(task, threadTs);
  }
  return { byProfile };
}

function writeShutdownQueuePayloads(byProfile) {
  if (byProfile.size === 0) return;
  let totalPersisted = 0;
  for (const [name, payload] of byProfile) {
    try {
      mkdirSync(payload.dataDir, { recursive: true });
      const outPath = join(payload.dataDir, SHUTDOWN_QUEUE_FILE);
      const serialized = serializeShutdownState([], {
        globalQueue: payload.globalQueue,
        threadQueues: payload.threadQueues,
      });
      writeFileSync(outPath, `${JSON.stringify(serialized, null, 2)}\n`);
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

export function persistShutdownQueues({ threadQueues, getProfile }) {
  try {
    const drained = drainGlobalQueue();
    const { byProfile } = groupShutdownStateByProfile({
      drained,
      threadQueues,
      getProfile,
    });
    writeShutdownQueuePayloads(byProfile);
  } catch (e) {
    warn(TAG, `shutdown: queue persistence error: ${e.message}`);
  }
}
