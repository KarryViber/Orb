import { info, error as logError, warn } from '../../log.js';
import { markdownToMrkdwn } from '../slack-format.js';
import {
  formatDmRoutingDate,
  interpolateDmRoutingTemplate,
  matchDmRule,
  renderDmRoutingMainText,
  renderDmRoutingPrompt,
} from '../slack-dm-routing.js';
import { extractSlackThreadUrls } from './thread-context.js';

const TAG = 'slack';

export function createMessageRouter({
  webClient,
  allowBots,
  ignoredChannels,
  dmRouting,
  resolveLedger,
  threadContext,
  approvalController,
  getBotUserId,
  getBotId,
  getTeamId = () => null,
  getOnMessage,
  getOnReaction,
}) {
  let botMessageTs = new Set();
  let botReplyTs = new Set();
  const reactionDedupCache = new Map();
  const MAX_BOT_TS = 5000;
  const MAX_BOT_REPLY_TS = 5000;
  const REACTION_DEDUP_TTL = 30 * 1000;

  // Quick-reply emoji → text map (Slack reaction names, no colons)
  // 详见 ~/Orb/profiles/.claude/skills/reaction-action-protocol/SKILL.md
  const QUICK_REPLY_MAP = {
    'white_check_mark': '收工',
    'point_right': '继续',
    'rocket': '派吧，干',
    'arrows_counterclockwise': '换条思路',
    'hand': '先停一下',
    'eyes': '展开看看',
  };

  const router = {
    _trackBotMessage(ts) {
      botMessageTs.add(ts);
    },

    _trackBotReply(ts) {
      botReplyTs.add(ts);
    },

    _isBotThread(threadTs) {
      return botMessageTs.has(threadTs);
    },

    _cleanupMessageRouter() {
      if (botMessageTs.size > MAX_BOT_TS) {
        const arr = [...botMessageTs];
        arr.splice(0, Math.floor(arr.length / 2));
        botMessageTs = new Set(arr);
      }
      if (botReplyTs.size > MAX_BOT_REPLY_TS) {
        const arr = [...botReplyTs];
        arr.splice(0, Math.floor(arr.length / 2));
        botReplyTs = new Set(arr);
      }
      const now = Date.now();
      for (const [key, t] of reactionDedupCache) {
        if (now - t > REACTION_DEDUP_TTL) reactionDedupCache.delete(key);
      }
    },

    _handleMessageChanged(event) {
      approvalController._handleMessageChanged(event);
    },

    async _routeDMMessage(event) {
      const cfg = dmRouting;
      if (!cfg?.enabled) return { routed: false };

      const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
      const matched = matchDmRule(event, rules);
      if (!matched) return { routed: false, fallback: cfg.dmFallback || 'worker' };

      const { rule, ctx } = matched;
      if (ctx.file) {
        try {
          ctx.localPath = await threadContext._downloadDMFile(ctx.file, event, event.user);
          info(TAG, `DM file downloaded: ${ctx.localPath}`);
        } catch (err) {
          warn(TAG, `DM file download failed for rule=${rule.name}: ${err.message}`);
          ctx.localPath = null;
        }
      }
      ctx.date_mmdd = formatDmRoutingDate();

      try {
        const mainText = markdownToMrkdwn(renderDmRoutingMainText(rule, ctx));
        const mainMsg = await webClient.chat.postMessage({
          channel: rule.target.channel,
          text: mainText,
          unfurl_links: false,
        });
        const ledger = resolveLedger({ userId: event.user, event });
        try {
          ledger?.recordAdapterEvent({
            source: 'slack.dm_routing',
            eventType: 'adapter.dm_routing.target_card',
            channel: rule.target.channel,
            ts: mainMsg.ts,
            platform: 'slack',
            meta: { ruleName: rule.name, sourceTs: event.ts },
          });
        } catch (recordErr) {
          warn(TAG, `ledger record failed: ${recordErr.message}`);
        }
        if (!mainMsg.ts) throw new Error('postMessage returned no ts');
        router._trackBotMessage(mainMsg.ts);
        threadContext._trackThread(mainMsg.ts);

        const { instructionText, payloadFragments } = renderDmRoutingPrompt(rule, ctx, event);
        const onMessage = getOnMessage();
        if (onMessage) {
          const channelMeta = await threadContext.fetchChannelMeta(rule.target.channel);
          onMessage({
            userText: instructionText,
            fileContent: '',
            imagePaths: [],
            threadTs: mainMsg.ts,
            channel: rule.target.channel,
            userId: event.user,
            platform: 'slack',
            teamId: event.team || event.team_id || getTeamId(),
            channelSemantics: 'silent',
            threadHistory: null,
            channelMeta,
            fragments: payloadFragments,
            origin: { kind: 'user', name: 'first-touch', parentAttemptId: null },
          });
        }

        info(TAG, `DM routed: rule=${rule.name} source_dm=${event.ts} → ${rule.target.channel}/${mainMsg.ts}`);
        return { routed: true };
      } catch (err) {
        logError(TAG, `DM routing failed (rule=${rule.name}): ${err.message}`);
        try {
          const pendingText = markdownToMrkdwn([
            interpolateDmRoutingTemplate(rule.target.mainTemplate || '待补', ctx),
            '',
            '待补：DM 路由已命中，但自动建卡/启动 worker 时遇到 Slack API 故障；请稍后补处理。',
          ].filter((line) => line !== null && line !== undefined).join('\n'));
          const pendingMsg = await webClient.chat.postMessage({
            channel: rule.target.channel,
            text: pendingText,
            unfurl_links: false,
          });
          const ledger = resolveLedger({ userId: event.user, event });
          try {
            ledger?.recordAdapterEvent({
              source: 'slack.dm_routing',
              eventType: 'adapter.dm_routing.fallback_card',
              channel: rule.target.channel,
              ts: pendingMsg.ts,
              platform: 'slack',
              meta: { ruleName: rule.name, sourceTs: event.ts },
            });
          } catch (recordErr) {
            warn(TAG, `ledger record failed: ${recordErr.message}`);
          }
          if (pendingMsg.ts) {
            router._trackBotMessage(pendingMsg.ts);
            threadContext._trackThread(pendingMsg.ts);
          }
        } catch (pendingErr) {
          logError(TAG, `DM routing degraded card failed (rule=${rule.name}): ${pendingErr.message}`);
        }
        return { routed: true, degraded: true };
      }
    },

    async _handleMessage({ event, ack }) {
      try { await ack(); } catch (err) {
        logError(TAG, `ack failed: ${err.message}`);
        return;
      }

      if (event.subtype === 'message_changed') {
        router._handleMessageChanged(event);
        return;
      }

      const botId = getBotId();
      const botUserId = getBotUserId();
      if (event.bot_id) {
        if (event.bot_id === botId) return;
        if (allowBots === 'none') return;
        if (allowBots === 'mentions' && !event.text?.includes(`<@${botUserId}>`)) return;
      }
      if (event.subtype && event.subtype !== 'file_share') return;

      const eventTs = event.event_ts || event.ts;
      if (threadContext._isDuplicate(eventTs)) {
        info(TAG, `dedup: skipping already-seen event ${eventTs}`);
        return;
      }

      const channelType = event.channel_type || (event.channel?.startsWith('D') ? 'im' : '');
      const isDM = channelType === 'im' || channelType === 'mpim';
      const isMention = event.text?.includes(`<@${botUserId}>`);
      const threadTs = event.thread_ts || event.ts;
      const isBotThread = event.thread_ts && router._isBotThread(event.thread_ts);
      let isAssistantThread = false;
      if (isDM && channelType === 'im' && event.thread_ts && !event.bot_id && !isBotThread) {
        const assistantThreadRoot = event.assistant_thread
          ? true
          : await threadContext._isAssistantThreadRoot(event.channel, event.thread_ts);
        isAssistantThread = assistantThreadRoot || Boolean(event.user);
      }

      if (isDM && channelType === 'im' && (!event.thread_ts || isAssistantThread) && dmRouting?.enabled) {
        const outcome = await router._routeDMMessage(event);
        if (outcome.routed) return;
        if (outcome.fallback === 'silent') {
          info(TAG, `DM unmatched, silent fallback: user=${event.user} ts=${event.ts}`);
          return;
        }
      }

      if (ignoredChannels.has(event.channel)) return;
      if (isMention || isDM) threadContext._trackThread(threadTs);

      const userText = (event.text || '').replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
      if (!userText && (!event.files || event.files.length === 0)) return;

      const channel = event.channel;
      const userId = event.user;
      const channelMeta = await threadContext.fetchChannelMeta(channel);

      let fileContent = '';
      let imagePaths = [];
      const fragments = [];
      if (event.files && event.files.length > 0) {
        const result = await threadContext._processIncomingFiles(event.files);
        fileContent = result.text;
        imagePaths = result.imagePaths;
        fragments.push(...(result.fragments || []));
        info(TAG, `processed ${event.files.length} incoming file(s), ${imagePaths.length} image(s)`);
      }

      const linkedUrls = extractSlackThreadUrls(userText);
      if (linkedUrls.length > 0) {
        const seen = new Set();
        for (const { channel: linkCh, threadTs: linkTs } of linkedUrls) {
          const key = `${linkCh}:${linkTs}`;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const history = await threadContext.fetchThreadHistory(linkTs, linkCh);
            if (history) {
              fragments.push({
                source_type: 'linked_thread',
                trusted: false,
                origin: `slack:${linkCh}/${linkTs}`,
                content: history,
                retrieved_at: new Date().toISOString(),
                platform: 'slack',
                channel: linkCh,
                thread_ts: linkTs,
              });
              info(TAG, `fetched linked thread: ${linkCh}/${linkTs}`);
            }
          } catch (err) {
            logError(TAG, `failed to fetch linked thread ${linkCh}/${linkTs}: ${err.message}`);
          }
        }
      }

      info(TAG, `msg: ch=${channel} thread=${threadTs} user=${userId} text="${(userText || '[files only]').slice(0, 80)}"`);
      const task = {
        userText,
        fileContent,
        imagePaths,
        threadTs,
        channel,
        userId,
        platform: 'slack',
        teamId: event.team || event.team_id || getTeamId(),
        threadHistory: null,
        channelMeta,
        fragments,
        origin: { kind: 'user', name: 'first-touch', parentAttemptId: null },
      };

      if (event.thread_ts) {
        try {
          task.threadHistory = await threadContext.fetchThreadHistory(threadTs, channel);
        } catch (err) {
          logError(TAG, `failed to fetch thread history: ${err.message}`);
        }
      }

      const onMessage = getOnMessage();
      if (onMessage) onMessage(task);
    },

    async _handleReaction({ event, ack }) {
      try { await ack(); } catch (_) {}
      if (!event) return;
      if (event.item?.type !== 'message') return;

      const reactionName = event.reaction;
      const isFire = reactionName === 'fire';
      const quickReplyText = QUICK_REPLY_MAP[reactionName];
      if (!isFire && !quickReplyText) return;

      const { channel, ts: targetTs } = event.item;
      if (!channel || !targetTs) return;
      if (!botReplyTs.has(targetTs)) {
        info(TAG, `ignored ${reactionName} reaction on non-bot message: ${targetTs}`);
        return;
      }

      const dedupKey = `${targetTs}:${reactionName}`;
      const now = Date.now();
      const last = reactionDedupCache.get(dedupKey);
      if (last && now - last < REACTION_DEDUP_TTL) {
        info(TAG, `reaction dedupe: ${dedupKey} (last=${now - last}ms ago)`);
        return;
      }
      reactionDedupCache.set(dedupKey, now);

      let thread = await router._fetchThreadForReaction(channel, targetTs);
      if (!thread && quickReplyText) {
        // quick-reply doesn't need a preceding user message; resolve thread_ts only
        try {
          const resp = await webClient.conversations.replies({ channel, ts: targetTs, limit: 1, inclusive: true });
          const msg = resp.messages?.[0];
          if (msg) thread = { threadTs: msg.thread_ts || targetTs, userText: '', userId: event.user || null };
        } catch (err) {
          logError(TAG, `quick-reply thread resolve failed: ${err.message}`);
        }
      }
      if (!thread) {
        warn(TAG, `no thread context for reaction on ${targetTs}`);
        return;
      }
      const { threadTs, userText: prevUserText, userId: prevUserId } = thread;
      const reactingUserId = event.user || prevUserId;

      const onReaction = getOnReaction();
      if (!onReaction) return;

      if (isFire) {
        info(TAG, `fire reaction → rerun: thread=${threadTs} target=${targetTs} user=${reactingUserId}`);
        onReaction({
          platform: 'slack',
          channel,
          threadTs,
          targetMessageTs: targetTs,
          userText: `[effort:xhigh] ${prevUserText}`,
          userId: reactingUserId,
          teamId: event.team || event.team_id || getTeamId(),
          threadHistory: null,
          rerun: true,
          origin: { kind: 'user', name: 'rerun', parentAttemptId: null },
        });
        return;
      }

      // quick-reply: inject mapped text into active worker (or fork if none)
      info(TAG, `quick-reply :${reactionName}: → "${quickReplyText}" thread=${threadTs} user=${reactingUserId}`);
      onReaction({
        platform: 'slack',
        channel,
        threadTs,
        targetMessageTs: targetTs,
        userText: quickReplyText,
        userId: reactingUserId,
        teamId: event.team || event.team_id || getTeamId(),
        threadHistory: null,
        origin: { kind: 'user', name: `reaction:${reactionName}`, parentAttemptId: null },
      });
    },

    async _fetchThreadForReaction(channel, botMessageTsValue) {
      try {
        const msgResp = await webClient.conversations.replies({
          channel,
          ts: botMessageTsValue,
          limit: 1,
          inclusive: true,
        });
        const botMsg = msgResp.messages?.[0];
        if (!botMsg) return null;
        const threadTs = botMsg.thread_ts || botMessageTsValue;

        const threadResp = await webClient.conversations.replies({
          channel,
          ts: threadTs,
          limit: 100,
          inclusive: true,
        });
        const messages = threadResp.messages || [];
        const idx = messages.findIndex((m) => m.ts === botMessageTsValue);
        if (idx < 0) return null;

        for (let i = idx - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.user && m.user !== getBotUserId() && !m.bot_id) {
            return { threadTs, userText: m.text || '', userId: m.user };
          }
        }
        return null;
      } catch (err) {
        logError(TAG, `_fetchThreadForReaction: ${err.message}`);
        return null;
      }
    },

    _hasBotReply(ts) {
      return botReplyTs.has(ts);
    },
  };

  return router;
}
