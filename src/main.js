import 'dotenv/config';
import { SlackAdapter } from './adapters/slack.js';
import { WeChatAdapter } from './adapters/wechat.js';
import { Scheduler } from './scheduler.js';
import { CronScheduler } from './cron.js';
import { loadConfig, resolveProfile, resolveProfilePaths } from './config.js';
import { invalidateSoulCache } from './context.js';
import { cleanupSessions } from './session.js';
import { info, error as logError } from './log.js';
import { spawnWorker } from './spawn.js';

const TAG = 'main';

process.on('uncaughtException', (err) => {  if (err?.code === 'EPIPE') return;
  logError(TAG, `uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logError(TAG, `unhandledRejection: ${reason?.stack || reason}`);
});

async function start() {
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

  const allAdapters = scheduler.adapters; // Map<platform, adapter>

  const cronScheduler = new CronScheduler({
    getProfilePaths: (profileName) => {
      const profileDef = config.profiles[profileName];
      if (!profileDef) throw new Error(`unknown profile: ${profileName}`);
      return resolveProfilePaths(profileDef);
    },

    spawnCronWorker: (job, profilePaths) => {
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

        try {
          spawnWorker({
            task: {
              type: 'task',
              userText: job.prompt,
              threadTs: `cron:${job.id}`,
              channel: null,
              userId: null,
              platform: 'cron',
              model: job.model || null,
              effort: job.effort || null,
              profile: {
                name: job.profileName,
                soulDir: profilePaths.soulDir,
                workspaceDir: profilePaths.workspaceDir,
                dataDir: profilePaths.dataDir,
                scriptsDir: profilePaths.scriptsDir,
              },
            },
            timeout: 600_000,
            label: `cron:${job.id}`,
            onMessage: (msg) => {
              if (msg?.type === 'result') settle(resolve, msg.text || '');
              else if (msg?.type === 'error') settle(reject, new Error(msg.error || 'worker error'));
            },
            onExit: (code, signal) => {
              if (code !== 0 || signal) {
                settle(reject, new Error(signal ? `cron worker killed: ${signal}` : `worker exited with code ${code}`));
              }
            },
          });
        } catch (err) {
          settle(reject, new Error(`fork failed: ${err.message}`));
        }
      });
    },

    deliverResult: async (job, text) => {
      if (!job.deliver) return;
      const { platform, channel, threadTs } = job.deliver;
      const adapter = allAdapters.get(platform);
      if (!adapter) throw new Error(`no adapter for platform: ${platform}`);
      const payloads = adapter.buildPayloads(text);
      for (const payload of payloads) {
        await adapter.sendReply(channel, threadTs || null, payload.text, payload.blocks ? { blocks: payload.blocks } : {});
      }
    },
  });

  cronScheduler.setProfileNames(Object.keys(config.profiles));
  cronScheduler.start();

  process.on('SIGTERM', () => { cronScheduler.stop(); scheduler.shutdown('SIGTERM'); });
  process.on('SIGINT', () => { cronScheduler.stop(); scheduler.shutdown('SIGINT'); });

  process.on('SIGHUP', () => {
    info(TAG, 'SIGHUP received, reloading config + soul cache...');
    try {
      const reloaded = loadConfig(true);
      invalidateSoulCache();
      cronScheduler.setProfileNames(Object.keys(reloaded.profiles));
      info(TAG, 'config + soul cache reloaded');
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
