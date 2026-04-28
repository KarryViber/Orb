import 'dotenv/config';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SlackAdapter } from './adapters/slack.js';
import { WeChatAdapter } from './adapters/wechat.js';
import { Scheduler } from './scheduler.js';
import { CronScheduler } from './cron.js';
import { loadConfig, resolveProfile, resolveProfilePaths } from './config.js';
import { cleanupSessions } from './session.js';
import { info, error as logError } from './log.js';

const TAG = 'main';
const DAEMON_LOCK_PATH = join(homedir(), 'Orb', '.daemon.lock');

process.on('uncaughtException', (err) => {  if (err?.code === 'EPIPE') return;
  logError(TAG, `uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logError(TAG, `unhandledRejection: ${reason?.stack || reason}`);
});

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readDaemonLockPid() {
  try {
    const parsed = JSON.parse(readFileSync(DAEMON_LOCK_PATH, 'utf-8'));
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function acquireDaemonLock() {
  mkdirSync(join(DAEMON_LOCK_PATH, '..'), { recursive: true });
  let fd = null;
  try {
    fd = openSync(DAEMON_LOCK_PATH, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', 'utf-8');
    return () => {
      try { closeSync(fd); } catch {}
      try {
        if (readDaemonLockPid() === process.pid) unlinkSync(DAEMON_LOCK_PATH);
      } catch {}
    };
  } catch (err) {
    if (fd != null) {
      try { closeSync(fd); } catch {}
    }
    if (err?.code !== 'EEXIST') throw err;
    const pid = readDaemonLockPid();
    if (isPidAlive(pid)) {
      info(TAG, `daemon already running (pid=${pid}), exiting`);
      process.exit(0);
    }
    try { unlinkSync(DAEMON_LOCK_PATH); } catch {}
    return acquireDaemonLock();
  }
}

async function start() {
  const releaseDaemonLock = acquireDaemonLock();
  process.once('exit', releaseDaemonLock);

  const config = loadConfig();

  const profiles = config.profiles;
  if (!profiles || Object.keys(profiles).length === 0) {
    logError(TAG, 'no profiles defined in config.json');
    process.exit(1);
  }
  info(TAG, `profiles: ${Object.keys(profiles).join(', ')}`);

  // Validate: at least one adapter enabled
  const enabledAdapters = Object.entries(config.adapters || {}).filter(([, v]) => v.enabled);
  if (enabledAdapters.length === 0) {
    logError(TAG, 'no adapters enabled in config.json');
    process.exit(1);
  }

  // Profile resolver function — passed to scheduler
  const getProfile = (userId) => {
    const profile = resolveProfile(userId);
    return resolveProfilePaths(profile);
  };

  const schedulerConfig = config.scheduler || {};
  const scheduler = new Scheduler({
    maxWorkers: schedulerConfig.maxWorkers || 3,
    timeoutMs: schedulerConfig.timeoutMs || 900_000,
    getProfile,
  });

  // Start all enabled adapters
  for (const [name, adapterConfig] of enabledAdapters) {
    if (name === 'slack') {
      // Validate required Slack config
      if (!adapterConfig.botToken || !adapterConfig.appToken) {
        logError(TAG, 'slack adapter: missing botToken or appToken');
        process.exit(1);
      }

      const adapter = new SlackAdapter({
        botToken: adapterConfig.botToken,
        appToken: adapterConfig.appToken,
        allowBots: adapterConfig.allowBots || 'none',
        replyBroadcast: adapterConfig.replyBroadcast || false,
        freeResponseChannels: new Set(adapterConfig.freeResponseChannels || []),
        freeResponseUsers: new Set(adapterConfig.freeResponseUsers || []),
        dmRouting: adapterConfig.dmRouting || null,
        getProfilePaths: getProfile,
      });

      scheduler.addAdapter(name, adapter);

      adapter.onReaction = (task) => scheduler.submit(task);

      await adapter.start(
        (task) => scheduler.submit(task),
        null,
      );

      info(TAG, `adapter started: ${name}`);
    }
    else if (name === 'wechat') {
      if (!adapterConfig.accountId) {
        logError(TAG, 'wechat adapter: missing accountId — run `node scripts/wechat-setup.js` first');
        continue;
      }

      const adapter = new WeChatAdapter({
        accountId: adapterConfig.accountId,
        token: adapterConfig.token || '',
        baseUrl: adapterConfig.baseUrl || undefined,
        dmPolicy: adapterConfig.dmPolicy || 'allowlist',
        allowedUsers: adapterConfig.allowedUsers || [],
        sendChunkDelayMs: adapterConfig.sendChunkDelayMs ?? 350,
      });

      scheduler.addAdapter(name, adapter);

      await adapter.start(
        (task) => scheduler.submit(task),
      );

      info(TAG, `adapter started: ${name}`);
    }
    // Future: else if (name === 'discord') { ... }
  }

  // ── Cron scheduler ──

  const cronScheduler = new CronScheduler({
    getProfilePaths: (profileName) => {
      const profileDef = config.profiles[profileName];
      if (!profileDef) throw new Error(`unknown profile: ${profileName}`);
      return resolveProfilePaths(profileDef);
    },
    scheduler,
  });

  cronScheduler.setProfileNames(Object.keys(config.profiles));
  cronScheduler.start();

  process.on('SIGTERM', () => { cronScheduler.stop(); scheduler.shutdown('SIGTERM'); });
  process.on('SIGINT', () => { cronScheduler.stop(); scheduler.shutdown('SIGINT'); });

  process.on('SIGHUP', () => {
    info(TAG, 'SIGHUP received, reloading config...');
    try {
      const reloaded = loadConfig(true);
      cronScheduler.setProfileNames(Object.keys(reloaded.profiles));
      info(TAG, 'config reloaded');
    } catch (err) {
      logError(TAG, `SIGHUP reload failed, keeping current config: ${err.message}`);
    }
  });

  info(TAG, `Orb started with ${enabledAdapters.length} adapter(s), ${Object.keys(config.profiles).length} profile(s)`);

  // Heartbeat — periodic health log + session cleanup
  const HEARTBEAT_INTERVAL = 30 * 60 * 1000; // 30 minutes
  setInterval(async () => {
    const workers = scheduler.activeWorkers.size;
    const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
    info(TAG, `heartbeat: workers=${workers} mem=${mem}MB uptime=${Math.round(process.uptime())}s`);

    // Prune stale sessions (> 7 days inactive) — use latest cached config (#20)
    const currentConfig = loadConfig();
    for (const [, profileDef] of Object.entries(currentConfig.profiles)) {
      try {
        const paths = resolveProfilePaths(profileDef);
        await cleanupSessions(paths.dataDir);
      } catch {}
    }
  }, HEARTBEAT_INTERVAL).unref();
}

start().catch((err) => {
  logError(TAG, `start failed: ${err.stack || err.message}`);
  process.exit(1);
});
