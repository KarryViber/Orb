import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { info, error as logError, warn } from '../log.js';
import { isSafeUrl } from '../format-utils.js';
import {
  buildSendPayloads,
  extractSuggestedPrompts,
  markdownToMrkdwn,
} from './slack-format.js';
import { PlatformAdapter } from './interface.js';
import { downloadAndCacheImage, cleanImageCache, IMAGE_EXTENSIONS } from './image-cache.js';
import {
  dispatchBlockActionHandler,
  handleBlockActionMessageChanged,
  releaseBlockActionMessage,
  updateBlockActionCard,
} from './slack-block-actions.js';
import {
  formatDmRoutingDate,
  interpolateDmRoutingTemplate,
  matchDmRule,
  renderDmRoutingMainText,
  renderDmRoutingPrompt,
} from './slack-dm-routing.js';
import { formatSlackInlineCode, renderPermissionSemantics } from './slack-permission-render.js';
import {
  STREAM_TASK_FIELD_LIMIT,
  StreamAPIError,
  assertStreamTaskField,
  buildStreamAPIError,
  getSlackStreamErrorCode,
  isStreamingStateError,
  preserveStreamTaskField,
} from './slack-stream-error.js';
import {
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TEXT_FINAL,
  CONTROL_PLANE_MESSAGE,
  CONTROL_PLANE_UPDATE,
  METADATA_STATUS,
  METADATA_TITLE,
  TASK_PROGRESS_APPEND,
  TASK_PROGRESS_START,
  TASK_PROGRESS_STOP,
} from '../turn-delivery/intents.js';
import { IMAGE_CACHE_DIR, ORB_STREAM_TRACE } from '../runtime-env.js';

const TAG = 'slack';
const MAX_USERNAME_CACHE = 500;
const __dirname = dirname(fileURLToPath(import.meta.url));
const streamTrace = () => ORB_STREAM_TRACE;

// --- Slack thread URL parsing ---

/**
 * Extract channel ID and thread timestamp from Slack message URLs.
 * Formats:
 *   https://{workspace}.slack.com/archives/{channelId}/p{ts_no_dot}
 *   https://{workspace}.slack.com/archives/{channelId}/p{ts_no_dot}?thread_ts={ts}&cid={channelId}
 * Returns array of { channel, threadTs } objects.
 */
const SLACK_URL_RE = /https?:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?([^\s>)]*))?/g;

function extractSlackThreadUrls(text) {
  if (!text) return [];
  const results = [];
  let m;
  while ((m = SLACK_URL_RE.exec(text)) !== null) {
    const channel = m[1];
    const messageTs = `${m[2]}.${m[3]}`;
    const query = m[4] || '';

    // Prefer thread_ts from query (points to thread parent) over p-timestamp (might be a reply)
    let threadTs = messageTs;
    const threadMatch = query.replace(/&amp;/g, '&').match(/thread_ts=(\d+\.\d+)/);
    if (threadMatch) {
      threadTs = threadMatch[1];
    }

    results.push({ channel, threadTs, messageTs });
  }
  SLACK_URL_RE.lastIndex = 0;
  return results;
}

// --- Block Kit text extraction ---

/**
 * Extract readable text from a Block Kit `blocks` array.
 *
 * Orb's cron outputs (夜间反思 / 盘前快检 / 日报 etc.) are all Block Kit —
 * `msg.text` is just a short header, the real content lives in section/header/
 * context blocks. Without this, fetchThreadHistory only sees the header and
 * the worker loses all context when the user replies in the thread.
 */
function extractBlockKitText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'header' && block.text?.text) {
      parts.push(block.text.text);
    } else if (block.type === 'section') {
      if (block.text?.text) parts.push(block.text.text);
      if (Array.isArray(block.fields)) {
        for (const f of block.fields) {
          if (f?.text) parts.push(f.text);
        }
      }
    } else if (block.type === 'context' && Array.isArray(block.elements)) {
      for (const el of block.elements) {
        if (el?.text) parts.push(el.text);
      }
    }
    // divider / image / actions ignored
  }
  return parts.join('\n');
}

function isIgnorableAssistantThreadError(err) {
  const code = String(err?.data?.error || err?.code || '').trim();
  return code === 'no_permission' || code === 'channel_not_found';
}

// --- Incoming file processing ---
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'tsv', 'log', 'py', 'js', 'ts', 'jsx', 'tsx',
  'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'bash', 'sql',
  'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'cfg',
]);
const MAX_FILE_SIZE = 100 * 1024; // 100KB

export class SlackAdapter extends PlatformAdapter {
  constructor({ botToken, appToken, allowBots, replyBroadcast, freeResponseChannels, freeResponseUsers, dmRouting, getProfilePaths, ledger }) {
    super();
    this._botToken = botToken;
    this._slack = new WebClient(botToken);
    this._socket = new SocketModeClient({ appToken });
    this._allowBots = allowBots || 'none';
    this._replyBroadcast = replyBroadcast || false;
    this._freeResponseChannels = freeResponseChannels || new Set();
    this._freeResponseUsers = freeResponseUsers || new Set();
    this._dmRouting = dmRouting || null;
    this._getProfilePaths = getProfilePaths || null;
    this._ledger = ledger || null;
    this._botUserId = null;
    this._botId = null;

    this._imageCacheDir = IMAGE_CACHE_DIR;

    // Dedup
    this._seenMessages = new Map();
    this._DEDUP_TTL = 5 * 60 * 1000;

    // Thread tracking (mentioned threads + bot-participated threads)
    this._trackedThreads = new Map();
    this._THREAD_TTL = 24 * 60 * 60 * 1000;
    this._MAX_TRACKED = 5000;

    // Bot's own message timestamps (for auto-participation in reply threads)
    this._botMessageTs = new Set();
    this._MAX_BOT_TS = 5000;

    // Bot's own individual reply timestamps (for reaction rerun validation)
    this._botReplyTs = new Set();
    this._MAX_BOT_REPLY_TS = 5000;

    // Thread context cache (60s TTL, avoids hammering Slack API)
    this._threadCtxCache = new Map();
    this._assistantThreadRootCache = new Map();
    this._THREAD_CTX_TTL = 60 * 1000;
    this._channelMetaCache = new Map();
    this._CHANNEL_META_TTL = 5 * 60 * 1000;
    this._cleanupInterval = null;

    // Pending approvals
    this._pendingApprovals = new Map();
    this._blockActionInFlight = new Set();
    this._streams = new Map();
    this._teamId = null;
    this._statusSubscriber = null;

    // Reaction dedupe (30s per ts+reaction, avoids add/remove/add loops)
    this._reactionDedupCache = new Map();
    this._REACTION_DEDUP_TTL = 30 * 1000;

    // Callbacks (set in start())
    this.onMessage = null;
    this.onInteractive = null;
    this.onReaction = null;
  }

  get botUserId() {
    return this._botUserId;
  }

  get platform() {
    return 'slack';
  }

  get supportsInteractiveApproval() {
    return true;
  }

  get capabilities() {
    return {
      stream: true,
      edit: true,
      metadata: true,
    };
  }

  _resolveAdapterEventLedger(hint = {}) {
    if (typeof this._ledger !== 'function') return this._ledger || null;
    try {
      return this._ledger(hint) || null;
    } catch (err) {
      warn(TAG, `ledger resolve failed: ${err.message}`);
      return null;
    }
  }

  setAdapterEventLedgerResolver(ledger) {
    this._ledger = ledger || null;
  }

  // --- Dedup ---

  _isDuplicate(eventTs) {
    const now = Date.now();
    if (this._seenMessages.size > 2000) {
      // Step 1: drop anything past TTL
      for (const [ts, t] of this._seenMessages) {
        if (now - t > this._DEDUP_TTL) this._seenMessages.delete(ts);
      }
      // Step 2: still over? force-evict the 500 oldest. Otherwise under a
      // sustained high-QPS burst (whole map inside TTL window) the Map grows
      // unbounded.
      if (this._seenMessages.size > 2000) {
        const sorted = [...this._seenMessages.entries()].sort((a, b) => a[1] - b[1]);
        for (const [ts] of sorted.slice(0, 500)) {
          this._seenMessages.delete(ts);
        }
      }
    }
    if (this._seenMessages.has(eventTs)) return true;
    this._seenMessages.set(eventTs, now);
    return false;
  }

  // --- Thread tracking ---

  _trackThread(threadTs) {
    this._trackedThreads.set(threadTs, Date.now());
  }

  _isTrackedThread(threadTs) {
    return this._trackedThreads.has(threadTs);
  }

  _cleanupTrackedThreads() {
    const cutoff = Date.now() - this._THREAD_TTL;
    for (const [ts, t] of this._trackedThreads) {
      if (t < cutoff) this._trackedThreads.delete(ts);
    }
    // LRU eviction if over limit
    if (this._trackedThreads.size > this._MAX_TRACKED) {
      const sorted = [...this._trackedThreads.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, Math.floor(sorted.length / 2));
      for (const [ts] of toRemove) this._trackedThreads.delete(ts);
    }
    // Evict bot message timestamps
    if (this._botMessageTs.size > this._MAX_BOT_TS) {
      const arr = [...this._botMessageTs];
      arr.splice(0, Math.floor(arr.length / 2));
      this._botMessageTs = new Set(arr);
    }
    // Evict bot reply timestamps (reaction rerun validation)
    if (this._botReplyTs.size > this._MAX_BOT_REPLY_TS) {
      const arr = [...this._botReplyTs];
      arr.splice(0, Math.floor(arr.length / 2));
      this._botReplyTs = new Set(arr);
    }
    // Evict expired thread context cache
    const now = Date.now();
    for (const [key, entry] of this._threadCtxCache) {
      if (now - entry.fetchedAt > this._THREAD_CTX_TTL) this._threadCtxCache.delete(key);
    }
    for (const [key, entry] of this._assistantThreadRootCache) {
      if (now - entry.fetchedAt > this._THREAD_CTX_TTL) this._assistantThreadRootCache.delete(key);
    }
    // Evict expired reaction dedupe entries
    for (const [key, t] of this._reactionDedupCache) {
      if (now - t > this._REACTION_DEDUP_TTL) this._reactionDedupCache.delete(key);
    }
  }

  // --- Bot message tracking (for auto-participation) ---

  _trackBotMessage(ts) {
    this._botMessageTs.add(ts);
  }

  _isBotThread(threadTs) {
    return this._botMessageTs.has(threadTs);
  }

  async _isAssistantThreadRoot(channel, threadTs) {
    if (!channel || !threadTs) return false;
    const cacheKey = `${channel}:${threadTs}`;
    const cached = this._assistantThreadRootCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt < this._THREAD_CTX_TTL)) {
      return cached.value;
    }

    let value = false;
    try {
      const resp = await this._slack.conversations.replies({
        channel,
        ts: threadTs,
        limit: 1,
        inclusive: true,
      });
      const root = resp.messages?.[0];
      const rootText = [root?.text || '', extractBlockKitText(root?.blocks)]
        .filter(Boolean)
        .join('\n');
      value = Boolean(root?.bot_id === this._botId && /assistant thread/i.test(rootText));
    } catch (err) {
      warn(TAG, `assistant thread root lookup failed for ${cacheKey}: ${err.message}`);
    }

    this._assistantThreadRootCache.set(cacheKey, { value, fetchedAt: Date.now() });
    return value;
  }

  // --- Thread history ---

  _userNameCache = new Map();

  async _resolveUserName(userId) {
    if (!userId) return 'User';
    if (this._userNameCache.has(userId)) return this._userNameCache.get(userId);

    try {
      const result = await this._slack.users.info({ user: userId });
      const profile = result.user?.profile;
      const name = profile?.display_name || profile?.real_name || userId;
      if (this._userNameCache.size >= MAX_USERNAME_CACHE) {
        // FIFO eviction — Map preserves insertion order
        const firstKey = this._userNameCache.keys().next().value;
        this._userNameCache.delete(firstKey);
      }
      this._userNameCache.set(userId, name);
      return name;
    } catch (_) {
      return userId;
    }
  }

  async fetchThreadHistory(threadTs, channel, { bypassCache = false } = {}) {
    const MAX_HISTORY_MESSAGES = 30;
    const MAX_HISTORY_CHARS = 8000;

    if (!channel) return null;

    // Check cache (60s TTL)
    const cacheKey = `${channel}:${threadTs}`;
    if (!bypassCache) {
      const cached = this._threadCtxCache.get(cacheKey);
      if (cached && (Date.now() - cached.fetchedAt < this._THREAD_CTX_TTL)) {
        return cached.content;
      }
    }

    // Fetch with retry on rate-limit (429)
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await this._slack.conversations.replies({
          channel,
          ts: threadTs,
          limit: MAX_HISTORY_MESSAGES + 5,
          inclusive: true,
        });
        break;
      } catch (err) {
        if (err.data?.error === 'ratelimited' && attempt < 2) {
          const delay = (attempt + 1) * 1000;
          warn(TAG, `rate-limited fetching thread ${cacheKey}, retry in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    if (!result?.messages || result.messages.length <= 1) {
      this._threadCtxCache.set(cacheKey, { content: null, fetchedAt: Date.now() });
      return null;
    }

    const messages = result.messages.slice(0, -1);

    const lines = [];
    let totalChars = 0;

    for (const msg of messages) {
      let role;
      if (msg.bot_id) {
        role = 'Orb';
      } else {
        role = await this._resolveUserName(msg.user);
      }

      // Always-try + take-max: if msg has blocks, extract text from them and
      // use whichever is longer (msg.text vs block-kit text). Avoids a length
      // threshold which is fragile with mixed CJK/emoji cron headers.
      let text = msg.text || '';
      if (Array.isArray(msg.blocks) && msg.blocks.length > 0) {
        const blockText = extractBlockKitText(msg.blocks);
        if (blockText.length > text.length) text = blockText;
      }

      if (msg.bot_id) {
        const stripped = text.replace(/:[a-z0-9_+-]+:/gi, '').trim();
        if (!stripped) continue;
      }

      text = text.slice(0, 2000);
      const line = `${role}: ${text}`;

      if (totalChars + line.length > MAX_HISTORY_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }

    const PHASE_RE = /\[phase:([a-z-]+)\]/i;
    const segments = [];
    let current = { phase: 'legacy', msgs: [] };

    for (const line of lines) {
      if (line.startsWith('Orb: ')) {
        const m = line.match(PHASE_RE);
        if (m) {
          if (current.msgs.length > 0) segments.push(current);
          current = { phase: m[1].toLowerCase(), msgs: [line] };
          continue;
        }
      }
      current.msgs.push(line);
    }
    if (current.msgs.length > 0) segments.push(current);

    const folded = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      if (isLast || seg.phase === 'legacy' || seg.msgs.length <= 2) {
        folded.push(...seg.msgs);
      } else {
        const first = seg.msgs[0];
        const last = seg.msgs[seg.msgs.length - 1];
        const middle = seg.msgs.length - 2;
        folded.push(first);
        if (middle > 0) folded.push(`… (折叠 ${middle} 条 · phase:${seg.phase}) …`);
        folded.push(last);
      }
    }

    const content = folded.length > 0 ? folded.join('\n') : null;
    this._threadCtxCache.set(cacheKey, { content, fetchedAt: Date.now() });
    return content;
  }

  async fetchChannelMeta(channelId) {
    if (!channelId) return { topic: '', purpose: '' };

    const hit = this._channelMetaCache.get(channelId);
    if (hit && Date.now() - hit.fetchedAt < this._CHANNEL_META_TTL) {
      return { topic: hit.topic, purpose: hit.purpose };
    }

    try {
      const result = await this._slack.conversations.info({ channel: channelId });
      const topic = result.channel?.topic?.value || '';
      const purpose = result.channel?.purpose?.value || '';
      this._channelMetaCache.set(channelId, { topic, purpose, fetchedAt: Date.now() });
      return { topic, purpose };
    } catch (err) {
      warn(TAG, `fetchChannelMeta failed channel=${channelId}: ${err.message}`);
      return { topic: '', purpose: '' };
    }
  }

  // --- Incoming file processing ---

  async _processIncomingFiles(files) {
    if (!files || files.length === 0) return { text: '', imagePaths: [], fragments: [] };

    const parts = [];
    const imagePaths = [];
    const fragments = [];
    const retrievedAt = new Date().toISOString();
    for (const file of files) {
      const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';
      const isText = TEXT_EXTENSIONS.has(ext) || file.mimetype?.startsWith('text/');
      const fileOrigin = `slack:file:${file.id || file.name || 'unknown'}`;

      if (!isText) {
        const mimeIsImage = file.mimetype?.startsWith('image/');
        const extIsImage = IMAGE_EXTENSIONS.has(ext);
        if (mimeIsImage || extIsImage) {
          if (!isSafeUrl(file.url_private)) {
            parts.push(`[附件: ${file.name} — URL 安全检查失败]`);
            continue;
          }
          try {
            const imgPath = await downloadAndCacheImage(
              file.url_private, this._botToken, this._imageCacheDir
            );
            imagePaths.push(imgPath);
            fragments.push({
              source_type: 'image_attachment',
              trusted: 'semi',
              origin: fileOrigin,
              source_path: imgPath,
              content: `[图片: ${file.name || file.id || 'unknown'}]`,
              retrieved_at: retrievedAt,
              mime_type: file.mimetype || null,
              platform: 'slack',
              metadata: { file_id: file.id || null, name: file.name || null, size: file.size || null },
            });
            parts.push(`[图片: ${file.name} — 已传递给模型]`);
            info(TAG, `cached image: ${file.name} → ${imgPath}`);
          } catch (err) {
            parts.push(`[附件: ${file.name} — 图片处理失败: ${err.message}]`);
          }
        } else {
          parts.push(`[附件: ${file.name} (${file.mimetype}, ${file.size} bytes)]`);
        }
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        parts.push(`[附件: ${file.name} — 超出大小限制 (${file.size} bytes, 上限 100KB)]`);
        continue;
      }
      if (!isSafeUrl(file.url_private)) {
        parts.push(`[附件: ${file.name} — URL 安全检查失败]`);
        continue;
      }
      try {
        const resp = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this._botToken}` },
          redirect: 'manual',
        });
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get('location');
          if (!loc || !isSafeUrl(loc)) {
            parts.push(`[附件: ${file.name} — 重定向目标不安全]`);
            continue;
          }
          const resp2 = await fetch(loc);
          if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
          const text = await resp2.text();
          parts.push(`--- 文件: ${file.name} ---\n${text}\n--- EOF ---`);
          fragments.push({
            source_type: 'attachment',
            trusted: 'semi',
            origin: fileOrigin,
            content: text,
            retrieved_at: retrievedAt,
            mime_type: file.mimetype || null,
            platform: 'slack',
            metadata: { file_id: file.id || null, name: file.name || null, size: file.size || null },
          });
          info(TAG, `ingested file: ${file.name} (${text.length} chars)`);
          continue;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        parts.push(`--- 文件: ${file.name} ---\n${text}\n--- EOF ---`);
        fragments.push({
          source_type: 'attachment',
          trusted: 'semi',
          origin: fileOrigin,
          content: text,
          retrieved_at: retrievedAt,
          mime_type: file.mimetype || null,
          platform: 'slack',
          metadata: { file_id: file.id || null, name: file.name || null, size: file.size || null },
        });
        info(TAG, `ingested file: ${file.name} (${text.length} chars)`);
      } catch (err) {
        parts.push(`[附件: ${file.name} — 下载失败: ${err.message}]`);
      }
    }
    return { text: parts.join('\n\n'), imagePaths, fragments };
  }

  // --- Approval buttons ---

  _buildApprovalBlocks(prompt, approvalId) {
    if (prompt && typeof prompt === 'object' && prompt.kind === 'permission') {
      return this._buildPermissionApprovalBlocks(prompt, approvalId);
    }
    return [
      { type: 'section', text: { type: 'mrkdwn', text: markdownToMrkdwn(String(prompt || '')) } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Allow Once', emoji: true },
          style: 'primary', action_id: 'orb_approve_once', value: approvalId },
        { type: 'button', text: { type: 'plain_text', text: 'Allow Session', emoji: true },
          action_id: 'orb_approve_session', value: approvalId },
        { type: 'button', text: { type: 'plain_text', text: 'Always Allow', emoji: true },
          action_id: 'orb_approve_always', value: approvalId },
        { type: 'button', text: { type: 'plain_text', text: 'Deny', emoji: true },
          style: 'danger', action_id: 'orb_deny', value: approvalId },
      ]},
    ];
  }

  _buildPermissionApprovalBlocks(prompt, approvalId) {
    const timeoutSeconds = Math.round((prompt.timeoutMs || 300_000) / 1000);
    const timeoutLabel = timeoutSeconds % 60 === 0
      ? `${Math.max(1, Math.round(timeoutSeconds / 60))} 分钟内处理`
      : `${timeoutSeconds}s 内处理`;
    const semantics = renderPermissionSemantics(prompt.toolName, prompt.toolInput);
    const debugSummary = [
      `tool=\`${prompt.toolName || 'unknown'}\``,
      `request=\`${prompt.requestId || 'unknown'}\``,
      `thread=\`${prompt.threadTs || 'unknown'}\``,
    ].join(' · ');
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*🔐 权限请求*' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${semantics.emoji} ${semantics.action}*\n${formatSlackInlineCode(semantics.targetValue)}`,
        },
      },
    ];

    if (semantics.previewTitle && semantics.previewBody) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${semantics.previewTitle}*\n${semantics.previewBody}${semantics.previewMeta ? `\n${semantics.previewMeta}` : ''}`,
        },
      });
    }

    blocks.push(
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `⏰ ${timeoutLabel}，超时自动拒绝` },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `调试: ${debugSummary}` },
          { type: 'mrkdwn', text: `raw: ${formatSlackInlineCode(this._truncateForSlackCodeBlock(semantics.rawInput || prompt.toolInput, 180))}` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '允许', emoji: true },
            style: 'primary',
            action_id: 'orb_approve_once',
            value: approvalId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '拒绝', emoji: true },
            style: 'danger',
            action_id: 'orb_deny',
            value: approvalId,
          },
        ],
      },
    );
    return blocks;
  }

  _truncateForSlackCodeBlock(value, maxChars) {
    let text;
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
    const normalized = (text || '').replace(/```/g, '` ` `');
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars - 3)}...`;
  }

  _approvalFallbackText(prompt) {
    if (prompt && typeof prompt === 'object' && prompt.kind === 'permission') {
      return `权限请求: ${prompt.toolName || 'unknown'}`;
    }
    return markdownToMrkdwn(`承認リクエスト: ${String(prompt || '').slice(0, 100)}`);
  }

  _approvalTimeoutReason(prompt) {
    if (prompt && typeof prompt === 'object' && prompt.kind === 'permission') {
      const seconds = Math.round((prompt.timeoutMs || 300_000) / 1000);
      return `timeout: no response from Slack approval in ${seconds}s`;
    }
    return 'timeout';
  }

  _buildApprovalStatusBlocks(pending, label, extraText) {
    const toolName = pending?.prompt?.toolName || '';
    const semantics = toolName ? ` · \`${toolName}\`` : '';
    const trailing = extraText ? ` · ${extraText}` : '';
    return [{
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${label}${semantics}${trailing}` },
      ],
    }];
  }

  async sendApproval(channel, threadTs, prompt) {
    const effectivePrompt = (prompt && typeof prompt === 'object')
      ? { ...prompt, threadTs, channel }
      : prompt;
    const approvalId = `${threadTs}_${Date.now()}`;
    const blocks = this._buildApprovalBlocks(effectivePrompt, approvalId);
    const timeoutMs = (effectivePrompt && typeof effectivePrompt === 'object' && effectivePrompt.timeoutMs) ? effectivePrompt.timeoutMs : 10 * 60 * 1000;

    const msg = await this._slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      blocks,
      text: this._approvalFallbackText(effectivePrompt),
    });
    const ledger = this._resolveAdapterEventLedger(effectivePrompt);
    try {
      ledger?.recordAdapterEvent({
        source: 'slack.sendApproval',
        eventType: 'adapter.approval.created',
        channel,
        ts: msg.ts,
        platform: 'slack',
        meta: { approvalId, kind: effectivePrompt?.kind },
      });
    } catch (err) {
      warn(TAG, `ledger record failed: ${err.message}`);
    }
    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        if (this._pendingApprovals.has(approvalId)) {
          const pending = this._pendingApprovals.get(approvalId);
          this._pendingApprovals.delete(approvalId);
          const reason = this._approvalTimeoutReason(effectivePrompt);
          const label = effectivePrompt?.kind === 'permission' ? '⏰ 超时自动拒绝' : '⏰ Timed Out';
          this._slack.chat.update({
            channel,
            ts: msg.ts,
            blocks: this._buildApprovalStatusBlocks(pending, label, reason),
            text: label,
          }).then((updated) => {
            try {
              pending.ledger?.recordAdapterEvent({
                source: 'slack.sendApproval.timeout',
                eventType: 'adapter.approval.timeout',
                channel,
                ts: updated?.ts || msg.ts,
                platform: 'slack',
                meta: { approvalId, kind: effectivePrompt?.kind, reason },
              });
            } catch (err) {
              warn(TAG, `ledger record failed: ${err.message}`);
            }
          }).catch((err) => {
            logError(TAG, `failed to update timed out approval: ${err.message}`);
          });
          resolve({ approved: false, reason, scope: 'once' });
        }
      }, timeoutMs);

      this._pendingApprovals.set(approvalId, {
        resolve,
        channel,
        threadTs,
        messageTs: msg.ts,
        timeoutHandle,
        prompt: effectivePrompt,
        blocks,
        ledger,
      });
    });
  }

  async _handleInteractive({ body, ack }) {
    try { await ack(); } catch (_) {}

    if (body.type !== 'block_actions' || !body.actions?.length) return;

    const action = body.actions[0];
    const approvalId = action.value;
    const actionId = action.id || action.action_id;
    const userId = body.user?.id;

    if (approvalId && this._pendingApprovals.has(approvalId)) {
      const pending = this._pendingApprovals.get(approvalId);
      this._pendingApprovals.delete(approvalId);
      clearTimeout(pending.timeoutHandle); // #22: cancel timeout if user acted early

      const approvalMap = {
        orb_approve_once: { approved: true, scope: 'once', label: '✅ Allowed Once' },
        orb_approve_session: { approved: true, scope: 'session', label: '✅ Allowed (Session)' },
        orb_approve_always: { approved: true, scope: 'always', label: '✅ Always Allowed' },
        orb_deny: { approved: false, scope: 'once', label: '❌ Denied' },
      };
      const decision = approvalMap[actionId] || { approved: false, scope: 'once', label: '❌ Denied' };
      const { approved, scope, label } = decision;

      try {
        const updatedBlocks = this._buildApprovalStatusBlocks(pending, label, `by <@${userId}>`);

        await this._slack.chat.update({
          channel: pending.channel,
          ts: pending.messageTs,
          blocks: updatedBlocks,
          text: label,
        });
        try {
          pending.ledger?.recordAdapterEvent({
            source: 'slack.block_action',
            eventType: 'adapter.approval.resolved',
            channel: pending.channel,
            ts: pending.messageTs,
            platform: 'slack',
            meta: { approvalId, approved, scope, userId },
          });
        } catch (err) {
          warn(TAG, `ledger record failed: ${err.message}`);
        }
      } catch (err) {
        logError(TAG, `failed to update approval message: ${err.message}`);
      }

      pending.resolve({ approved, scope, userId });
      return;
    }

    await dispatchBlockActionHandler({
      body,
      action,
      actionId,
      slack: this._slack,
      getProfilePaths: this._getProfilePaths,
      resolveLedger: (ledgerHint) => this._resolveAdapterEventLedger(ledgerHint),
      inFlight: this._blockActionInFlight,
    });
  }

  _releaseBlockActionMessage(messageTs) {
    releaseBlockActionMessage(this._blockActionInFlight, messageTs);
  }

  _handleMessageChanged(event) {
    handleBlockActionMessageChanged(event, this._blockActionInFlight);
  }

  async _updateBlockActionCard(channel, messageTs, text, originalBlocks = null, ledgerHint = {}) {
    return updateBlockActionCard({
      slack: this._slack,
      resolveLedger: (hint) => this._resolveAdapterEventLedger(hint),
      channel,
      messageTs,
      text,
      originalBlocks,
      ledgerHint,
    });
  }

  // --- Reply / Edit helpers ---

  async _postReply(channel, threadTs, text, extra = {}) {
    const params = { channel, thread_ts: threadTs, text, ...extra };
    if (this._replyBroadcast) params.reply_broadcast = true;
    const result = await this._slack.chat.postMessage(params);
    // Track bot's own messages for auto-participation
    if (result.ts) {
      this._trackBotMessage(threadTs);
      this._botReplyTs.add(result.ts);
    }
    return result;
  }

  async _editMessage(channel, ts, text, extra = {}) {
    const params = { channel, ts, text, ...extra };
    return this._slack.chat.update(params);
  }

  async sendReply(channel, threadTs, text, extra = {}) {
    return this._postReply(channel, threadTs, text, extra);
  }

  async editMessage(channel, ts, text, extra = {}) {
    return this._editMessage(channel, ts, text, extra);
  }

  async deliver(intent, { channel: deliveryChannel, turnState } = {}) {
    const slackChannel = intent.channel || turnState?.channel;
    const threadTs = intent.threadTs || turnState?.threadTs;
    const text = String(intent.text || '');
    const meta = intent.meta || {};

    if (deliveryChannel === 'stream') {
      if (intent.intent === TASK_PROGRESS_START) {
        return this.startStream(slackChannel, threadTs, {
          task_display_mode: meta.task_display_mode || 'plan',
          initial_chunks: meta.chunks || [],
          team_id: meta.teamId || null,
        });
      }
      if (intent.intent === TASK_PROGRESS_APPEND) {
        await this.appendStream(turnState.streamId, meta.chunks || [{ type: 'markdown_text', text }]);
        return { streamId: turnState.streamId, ts: turnState.streamMessageTs || null };
      }
      if (intent.intent === TASK_PROGRESS_STOP) {
        await this.stopStream(turnState.streamId, { chunks: meta.chunks || [] });
        return { streamId: turnState.streamId, ts: turnState.streamMessageTs || null };
      }
      if (intent.intent === ASSISTANT_TEXT_DELTA) {
        await this.appendStream(turnState.streamId, [{ type: 'markdown_text', text }]);
        return { streamId: turnState.streamId, ts: turnState.streamMessageTs || null };
      }
      if (intent.intent === ASSISTANT_TEXT_FINAL) {
        let finalBlocks = null;
        if (meta.gitDiffSummary?.hasChanges) {
          finalBlocks = this.buildPayloads('', { gitDiffSummary: meta.gitDiffSummary })
            .flatMap((payload) => payload.blocks || []);
        }
        await this.stopStream(turnState.streamId, {
          markdown_text: turnState.assistantStreamTextLen > 0 ? '' : text,
          final_blocks: finalBlocks,
        });
        return { streamId: turnState.streamId, ts: turnState.streamMessageTs || null };
      }
    }

    if (deliveryChannel === 'postMessage') {
      if (Array.isArray(meta.blocks) && meta.blocks.length > 0) {
        const result = await this.sendReply(slackChannel, threadTs, text, { blocks: meta.blocks });
        return { ts: result?.ts || null };
      }
      const payloads = this.buildPayloads(text, { gitDiffSummary: meta.gitDiffSummary || null });
      let lastTs = null;
      for (const payload of payloads) {
        const extra = payload.blocks ? { blocks: payload.blocks } : {};
        const result = await this.sendReply(slackChannel, threadTs, payload.text, extra);
        lastTs = result?.ts || lastTs;
      }
      return { ts: lastTs };
    }

    if (deliveryChannel === 'edit') {
      if (!meta.ts) return { ts: null };
      const result = await this.editMessage(slackChannel, meta.ts, text, meta.blocks ? { blocks: meta.blocks } : {});
      return { ts: result?.ts || meta.ts };
    }

    if (deliveryChannel === 'metadata') {
      if (intent.intent === METADATA_STATUS) {
        await this.setThreadStatus(slackChannel, threadTs, text, meta.loadingMessages || null);
      } else if (intent.intent === METADATA_TITLE) {
        const title = text.split('\n')[0].trim().slice(0, 60);
        if (title) await this.setThreadTitle(slackChannel, threadTs, title);
        const prompts = extractSuggestedPrompts(text);
        if (prompts.length > 0) await this.setSuggestedPrompts(slackChannel, threadTs, prompts);
      }
      return { ts: null };
    }

    if (deliveryChannel === 'silent') return { ts: null };
    throw new Error(`unknown delivery channel: ${deliveryChannel}`);
  }

  clearStatusByContext({ channel, threadTs } = {}) {
    this.__orbTurnDeliveryCcEventSubscriber?.clearByContext?.({ channel, threadTs });
  }

  // --- Streaming helpers ---

  normalizeTaskDisplayMode(mode) {
    return mode === 'aggregated' || mode === 'plan' ? 'plan' : 'timeline';
  }

  normalizeStreamChunks(chunks) {
    const normalized = [];
    const blocks = [];
    const pushTaskUpdate = (taskLike) => {
      if (!taskLike || typeof taskLike !== 'object') return;
      const id = String(taskLike.id || taskLike.task_id || '').trim();
      const title = assertStreamTaskField('title', taskLike.title || taskLike.text || '');
      if (!id || !title) return;

      const chunk = {
        type: 'task_update',
        id,
        title,
        status: taskLike.status === 'completed' ? 'complete' : taskLike.status,
      };

      if (!['pending', 'in_progress', 'complete', 'error'].includes(chunk.status)) {
        chunk.status = 'in_progress';
      }

      const details = typeof taskLike.details === 'string' ? preserveStreamTaskField('details', taskLike.details) : '';
      const output = typeof taskLike.output === 'string' ? assertStreamTaskField('output', taskLike.output) : '';
      if (details) chunk.details = details;
      if (output) chunk.output = output;
      if (Array.isArray(taskLike.sources) && taskLike.sources.length > 0) {
        chunk.sources = taskLike.sources;
      }
      normalized.push(chunk);
    };

    for (const chunk of Array.isArray(chunks) ? chunks : []) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'markdown_text') {
        const raw = String(chunk.text || chunk.markdown_text || '').trim();
        const text = raw ? markdownToMrkdwn(raw) : '';
        if (text) normalized.push({ type: 'markdown_text', text });
        continue;
      }
      if (chunk.type === 'task_update') {
        pushTaskUpdate(chunk.task && typeof chunk.task === 'object' ? chunk.task : chunk);
        continue;
      }
      if (chunk.type === 'task') {
        pushTaskUpdate(chunk);
        continue;
      }
      if (chunk.type === 'plan_update') {
        const title = String(chunk.title || '').trim();
        if (title) normalized.push({ type: 'plan_update', title: title.slice(0, STREAM_TASK_FIELD_LIMIT) });
        continue;
      }
      if (chunk.type === 'blocks') {
        if (Array.isArray(chunk.blocks) && chunk.blocks.length > 0) normalized.push(chunk);
        continue;
      }
      if (chunk.type === 'text') {
        const raw = String(chunk.text || '').trim();
        normalized.push({ type: 'markdown_text', text: raw ? markdownToMrkdwn(raw) : ' ' });
        continue;
      }
      blocks.push(chunk);
    }

    if (blocks.length > 0) normalized.push({ type: 'blocks', blocks });
    return normalized;
  }

  _getStreamHandle(streamId) {
    const stream = this._streams.get(streamId);
    if (!stream) throw new StreamAPIError(`unknown stream id: ${streamId}`);
    return stream;
  }

  async _resolveStreamRecipient(channel, threadTs, teamId = null) {
    if (!channel || !threadTs || String(channel).startsWith('D')) return {};
    const resolvedTeamId = this._teamId || teamId || null;
    if (!resolvedTeamId) throw new StreamAPIError('missing Slack team_id for streaming API');

    try {
      const result = await this._slack.conversations.replies({
        channel,
        ts: threadTs,
        limit: 1,
        inclusive: true,
      });
      const recipientUserId = result?.messages?.[0]?.user;
      if (!recipientUserId) {
        throw new StreamAPIError(`failed to resolve recipient_user_id for thread ${threadTs}`);
      }
      return {
        recipient_user_id: recipientUserId,
        recipient_team_id: resolvedTeamId,
      };
    } catch (err) {
      if (err instanceof StreamAPIError) throw err;
      throw new StreamAPIError(`failed to resolve stream recipient: ${err.message}`, err);
    }
  }

  async startStream(channel, threadTs, { task_display_mode = 'timeline', initial_chunks = [], team_id = null } = {}) {
    if (!threadTs) throw new StreamAPIError('chat.startStream requires thread_ts');

    const normalizedTaskDisplayMode = this.normalizeTaskDisplayMode(task_display_mode);
    const initialChunks = this.normalizeStreamChunks(initial_chunks);

    const params = {
      channel,
      thread_ts: threadTs,
      task_display_mode: normalizedTaskDisplayMode,
      // Keep all initial text inside chunks so Slack never sees both
      // top-level markdown_text and markdown_text chunks in one request.
      chunks: initialChunks.length > 0 ? initialChunks : [{ type: 'markdown_text', text: ' ' }],
      ...(await this._resolveStreamRecipient(channel, threadTs, team_id)),
    };

    let result;
    try {
      result = await this._slack.apiCall('chat.startStream', params);
    } catch (err) {
      throw buildStreamAPIError('startStream', err.data?.error || err.message, err);
    }
    if (!result?.ok || !result?.ts) {
      throw buildStreamAPIError('startStream', result?.error || 'missing_ts');
    }

    const streamId = `${channel}:${result.ts}`;
    const initialLen = initialChunks.reduce((s, c) => s + (c?.text?.length || 0), 0);
    info(TAG, `[slack:startStream] stream_id=${streamId} display_mode=${normalizedTaskDisplayMode} initial_chunks=${initialChunks.length} initial_len=${initialLen}`);
    this._streams.set(streamId, {
      channel,
      ts: result.ts,
      startedAt: Date.now(),
      appendCount: 0,
      totalAppendLen: 0,
      lastAppendAt: null,
    });
    return { stream_id: streamId, ts: result.ts };
  }

  async appendStream(streamId, chunks) {
    const stream = this._getStreamHandle(streamId);
    const normalizedChunks = this.normalizeStreamChunks(chunks);
    if (normalizedChunks.length === 0) return;
    const appendLen = normalizedChunks.reduce((s, c) => s + (c?.text?.length || 0), 0);

    let result;
    try {
      result = await this._slack.apiCall('chat.appendStream', {
        channel: stream.channel,
        ts: stream.ts,
        chunks: normalizedChunks,
      });
    } catch (err) {
      if (isStreamingStateError(err) || getSlackStreamErrorCode(err) === 'message_not_owned_by_app') {
        this._streams.delete(streamId);
      }
      info(TAG, `[slack:appendStream:error] stream_id=${streamId} error=${err.data?.error || err.message} chunks=${normalizedChunks.length} len=${appendLen} n=${stream.appendCount || 0} total_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('appendStream', err.data?.error || err.message, err);
    }
    if (!result?.ok) {
      if (isStreamingStateError(result) || getSlackStreamErrorCode(result) === 'message_not_owned_by_app') {
        this._streams.delete(streamId);
      }
      info(TAG, `[slack:appendStream:error] stream_id=${streamId} error=${result?.error || 'unknown_error'} chunks=${normalizedChunks.length} len=${appendLen} n=${stream.appendCount || 0} total_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('appendStream', result?.error || 'unknown_error');
    }
    const now = Date.now();
    const sinceLast = stream.lastAppendAt ? now - stream.lastAppendAt : null;
    stream.appendCount = (stream.appendCount || 0) + 1;
    stream.totalAppendLen = (stream.totalAppendLen || 0) + appendLen;
    stream.lastAppendAt = now;
    const lifeMs = stream.startedAt ? now - stream.startedAt : null;
    if (streamTrace()) {
      info(TAG, `[slack:appendStream] stream_id=${streamId} chunks=${normalizedChunks.length} len=${appendLen} since_last_ms=${sinceLast ?? 'null'} n=${stream.appendCount} total_len=${stream.totalAppendLen} life_ms=${lifeMs}`);
    }
  }

  async stopStream(streamId, { markdown_text, blocks, chunks, final_blocks } = {}) {
    const stream = this._getStreamHandle(streamId);
    const normalizedChunks = this.normalizeStreamChunks(chunks);
    const finalBlocks = Array.isArray(blocks) && blocks.length > 0
      ? blocks
      : Array.isArray(final_blocks) && final_blocks.length > 0
        ? final_blocks
        : null;
    const finalText = typeof markdown_text === 'string' ? markdownToMrkdwn(markdown_text.trim()) : '';
    if (finalText && streamTrace()) {
      info(TAG, `[slack:stopStream] emitting markdown_text as implicit post (len=${finalText.length}, channel=${stream.channel}, ts=${stream.ts})`);
    }

    // Slack rejects markdown_text + chunks in the same call; fold final text
    // into chunks to match startStream behavior.
    if (finalText && normalizedChunks.length > 0) {
      normalizedChunks.push({ type: 'markdown_text', text: finalText });
    }
    const sendMarkdownTop = Boolean(finalText) && normalizedChunks.length === 0;

    let result;
    try {
      const lifeMs = stream.startedAt ? Date.now() - stream.startedAt : null;
      info(TAG, `[slack:stopStream] summary stream_id=${streamId} life_ms=${lifeMs} total_appends=${stream.appendCount || 0} total_append_len=${stream.totalAppendLen || 0} final_len=${finalText.length} final_blocks=${finalBlocks ? finalBlocks.length : 0}`);
      result = await this._slack.apiCall('chat.stopStream', {
        channel: stream.channel,
        ts: stream.ts,
        ...(normalizedChunks.length > 0 ? { chunks: normalizedChunks } : {}),
        ...(sendMarkdownTop ? { markdown_text: finalText } : {}),
        ...(finalBlocks ? { blocks: finalBlocks } : {}),
      });
    } catch (err) {
      info(TAG, `[slack:stopStream:error] stream_id=${streamId} error=${err.data?.error || err.message} total_appends=${stream.appendCount || 0} total_append_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('stopStream', err.data?.error || err.message, err);
    } finally {
      this._streams.delete(streamId);
    }
    if (!result?.ok) {
      info(TAG, `[slack:stopStream:error] stream_id=${streamId} error=${result?.error || 'unknown_error'} total_appends=${stream.appendCount || 0} total_append_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('stopStream', result?.error || 'unknown_error');
    }
  }

  // --- PlatformAdapter interface ---

  async uploadFile(channel, threadTs, filePath, filename) {
    try {
      await this._slack.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: createReadStream(filePath),
        filename: filename || filePath.split('/').pop(),
      });
      info(TAG, `uploaded file: ${filename || filePath}`);
    } catch (err) {
      logError(TAG, `file upload failed: ${err.message}`);
      await this._postReply(channel, threadTs, markdownToMrkdwn(`:warning: 文件上传失败: ${filename || filePath}`));
    }
  }

  async setThreadStatus(channel, threadTs, status, loadingMessages) {
    if (!channel || !threadTs) return;
    try {
      const payload = {
        channel_id: channel,
        thread_ts: threadTs,
        status: String(status || ''),
      };
      if (Array.isArray(loadingMessages) && loadingMessages.length > 0) {
        payload.loading_messages = loadingMessages.slice(0, 10).map(String);
      }
      await this._slack.apiCall('assistant.threads.setStatus', payload);
    } catch (err) {
      if (isIgnorableAssistantThreadError(err)) return;
      warn(TAG, `setThreadStatus failed: ${err.message}`);
    }
  }

  async setThreadTitle(channel, threadTs, title) {
    if (!channel || !threadTs || !title) return;
    try {
      await this._slack.apiCall('assistant.threads.setTitle', {
        channel_id: channel,
        thread_ts: threadTs,
        title: String(title).trim().slice(0, 60),
      });
    } catch (err) {
      if (isIgnorableAssistantThreadError(err)) return;
      warn(TAG, `setThreadTitle failed: ${err.message}`);
    }
  }

  async setSuggestedPrompts(channel, threadTs, prompts) {
    if (!channel || !threadTs || !Array.isArray(prompts) || prompts.length === 0) return;
    const normalizedPrompts = prompts
      .filter((prompt) => prompt?.title && prompt?.message)
      .slice(0, 4)
      .map((prompt) => ({
        title: String(prompt.title).trim().slice(0, 60),
        message: String(prompt.message).trim().slice(0, 200),
      }));
    if (normalizedPrompts.length === 0) return;
    try {
      await this._slack.apiCall('assistant.threads.setSuggestedPrompts', {
        channel_id: channel,
        thread_ts: threadTs,
        prompts: normalizedPrompts,
      });
    } catch (err) {
      if (isIgnorableAssistantThreadError(err)) return;
      warn(TAG, `setSuggestedPrompts failed: ${err.message}`);
    }
  }

  async setTyping(channel, threadTs, status) {
    await this.setThreadStatus(channel, threadTs, status);
  }

  buildPayloads(text, options = {}) {
    return buildSendPayloads(text, options);
  }

  async cleanupIndicator(channel, threadTs, typingSet, errorMsg) {
    if (typingSet) await this.setThreadStatus(channel, threadTs, '').catch(() => {});
    try {
      await this._postReply(channel, threadTs, markdownToMrkdwn(`:warning: ${errorMsg}`));
    } catch (err) {
      logError(TAG, `failed to send error msg: ${err.message}`);
    }
  }

  async disconnect() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._socket.disconnect();
  }

  // --- DM content-based routing (v2.1) ---
  //
  // Routes 1:1 DM messages to target channels based on rules in
  // config.adapters.slack.dmRouting. On match:
  //   1. Posts main card (short header) to target channel — only visible message
  //   2. Synthesizes a task whose userText is the interpolated workerPrompt
  //      (NOT posted to Slack — passed straight to worker)
  //   3. Worker produces the 3-section Block Kit approval card as its first output
  //   4. DM stays silent (iron rule from v1 spec)
  // Returns true if routed (caller should skip normal worker dispatch).

  async _downloadDMFile(file, event, userId) {
    if (!file?.url_private) throw new Error('no url_private');
    if (!isSafeUrl(file.url_private)) throw new Error('unsafe URL');

    let inboxDir;
    if (this._getProfilePaths && userId) {
      const paths = this._getProfilePaths(userId);
      inboxDir = join(paths.workspaceDir, 'work', 'inbox');
    } else {
      inboxDir = join(homedir(), '.orb', 'dm-inbox');
    }
    mkdirSync(inboxDir, { recursive: true });

    const safeName = (file.name || 'file.bin').replace(/[\/\\]/g, '_');
    const ts = event.ts || String(Date.now());
    const dest = join(inboxDir, `${ts}_${safeName}`);

    const resp = await fetch(file.url_private, {
      headers: { Authorization: `Bearer ${this._botToken}` },
      redirect: 'manual',
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc || !isSafeUrl(loc)) throw new Error('unsafe redirect');
      const resp2 = await fetch(loc);
      if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
      writeFileSync(dest, Buffer.from(await resp2.arrayBuffer()));
      return dest;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
    return dest;
  }

  async _routeDMMessage(event) {
    const cfg = this._dmRouting;
    if (!cfg?.enabled) return { routed: false };

    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    const matched = matchDmRule(event, rules);

    if (!matched) {
      return { routed: false, fallback: cfg.dmFallback || 'worker' };
    }

    const { rule, ctx } = matched;

    if (ctx.file) {
      try {
        ctx.localPath = await this._downloadDMFile(ctx.file, event, event.user);
        info(TAG, `DM file downloaded: ${ctx.localPath}`);
      } catch (err) {
        warn(TAG, `DM file download failed for rule=${rule.name}: ${err.message}`);
        ctx.localPath = null;
      }
    }
    ctx.date_mmdd = formatDmRoutingDate();

    try {
      const mainText = markdownToMrkdwn(renderDmRoutingMainText(rule, ctx));
      const mainMsg = await this._slack.chat.postMessage({
        channel: rule.target.channel,
        text: mainText,
        unfurl_links: false,
      });
      const ledger = this._resolveAdapterEventLedger({ userId: event.user, event });
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
      this._trackBotMessage(mainMsg.ts);
      this._trackThread(mainMsg.ts);

      const { instructionText, payloadFragments } = renderDmRoutingPrompt(rule, ctx, event);

      if (this.onMessage) {
        const channelMeta = await this.fetchChannelMeta(rule.target.channel);
        const task = {
          userText: instructionText,
          fileContent: '',
          imagePaths: [],
          threadTs: mainMsg.ts,
          channel: rule.target.channel,
          userId: event.user,
          platform: 'slack',
          teamId: event.team || event.team_id || null,
          channelSemantics: 'silent',
          threadHistory: null,
          channelMeta,
          fragments: payloadFragments,
          origin: { kind: 'user', name: 'first-touch', parentAttemptId: null },
        };
        this.onMessage(task);
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
        const pendingMsg = await this._slack.chat.postMessage({
          channel: rule.target.channel,
          text: pendingText,
          unfurl_links: false,
        });
        const ledger = this._resolveAdapterEventLedger({ userId: event.user, event });
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
          this._trackBotMessage(pendingMsg.ts);
          this._trackThread(pendingMsg.ts);
        }
      } catch (pendingErr) {
        logError(TAG, `DM routing degraded card failed (rule=${rule.name}): ${pendingErr.message}`);
      }
      return { routed: true, degraded: true };
    }
  }

  // --- Message handler ---

  async _handleMessage({ event, ack }) {
    try { await ack(); } catch (err) {
      logError(TAG, `ack failed: ${err.message}`);
      return;
    }

    if (event.subtype === 'message_changed') {
      this._handleMessageChanged(event);
      return;
    }

    // Bot message filtering
    if (event.bot_id) {
      if (event.bot_id === this._botId) return;
      if (this._allowBots === 'none') return;
      if (this._allowBots === 'mentions' && !event.text?.includes(`<@${this._botUserId}>`)) return;
    }
    if (event.subtype && event.subtype !== 'file_share') return;

    const eventTs = event.event_ts || event.ts;
    if (this._isDuplicate(eventTs)) {
      info(TAG, `dedup: skipping already-seen event ${eventTs}`);
      return;
    }

    // Detect DM: both 1:1 (im) and group DM (mpim)
    const channelType = event.channel_type || (event.channel?.startsWith('D') ? 'im' : '');
    const isDM = channelType === 'im' || channelType === 'mpim';
    const isMention = event.text?.includes(`<@${this._botUserId}>`);
    const threadTs = event.thread_ts || event.ts;
    const tracked = this._isTrackedThread(threadTs);
    const isBotThread = event.thread_ts && this._isBotThread(event.thread_ts);
    let isAssistantThread = false;
    if (isDM && channelType === 'im' && event.thread_ts && !event.bot_id && !isBotThread) {
      const assistantThreadRoot = event.assistant_thread
        ? true
        : await this._isAssistantThreadRoot(event.channel, event.thread_ts);
      // Slack AI Assistant roots are server-created, so Orb never tracks them
      // via chat.postMessage; fall back to the human DM thread heuristic.
      isAssistantThread = assistantThreadRoot || Boolean(event.user);
    }

    // DM content-based routing (v2) — allow Slack AI Assistant threads through,
    // but keep Orb-created worker threads on the normal worker path.
    if (isDM && channelType === 'im' && (!event.thread_ts || isAssistantThread) && this._dmRouting?.enabled) {
      const outcome = await this._routeDMMessage(event);
      if (outcome.routed) return;
      if (outcome.fallback === 'silent') {
        info(TAG, `DM unmatched, silent fallback: user=${event.user} ts=${event.ts}`);
        return;
      }
      // fallback === 'worker' → fall through to normal handling
    }

    const isFreeResponse = this._freeResponseChannels.has(event.channel) && this._freeResponseUsers.has(event.user);
    if (!isDM && !isMention && !tracked && !isBotThread && !isFreeResponse) return;
    if (isMention || isDM || isFreeResponse) this._trackThread(threadTs);

    const userText = (event.text || '')
      .replace(new RegExp(`<@${this._botUserId}>`, 'g'), '')
      .trim();

    if (!userText && (!event.files || event.files.length === 0)) return;

    const channel = event.channel;
    const userId = event.user;
    const channelMeta = await this.fetchChannelMeta(channel);

    // Process incoming file attachments
    let fileContent = '';
    let imagePaths = [];
    const fragments = [];
    if (event.files && event.files.length > 0) {
      const result = await this._processIncomingFiles(event.files);
      fileContent = result.text;
      imagePaths = result.imagePaths;
      fragments.push(...(result.fragments || []));
      info(TAG, `processed ${event.files.length} incoming file(s), ${imagePaths.length} image(s)`);
    }

    // Resolve Slack thread URLs → fetch referenced conversation context
    const linkedUrls = extractSlackThreadUrls(userText);
    if (linkedUrls.length > 0) {
      const seen = new Set();
      for (const { channel: linkCh, threadTs: linkTs } of linkedUrls) {
        const key = `${linkCh}:${linkTs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const history = await this.fetchThreadHistory(linkTs, linkCh);
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
      teamId: event.team || event.team_id || null,
      threadHistory: null,
      channelMeta,
      fragments,
      origin: { kind: 'user', name: 'first-touch', parentAttemptId: null },
    };

    // Fetch thread history (only for thread replies, not new conversations)
    if (event.thread_ts) {
      try {
        task.threadHistory = await this.fetchThreadHistory(threadTs, channel);
      } catch (err) {
        logError(TAG, `failed to fetch thread history: ${err.message}`);
      }
    }

    if (this.onMessage) {
      this.onMessage(task);
    }
  }

  // --- Reaction handler (🔥 → rerun at xhigh) ---

  async _handleReaction({ event, ack }) {
    try { await ack(); } catch (_) {}

    if (!event) return;
    if (event.reaction !== 'fire') return;
    if (event.item?.type !== 'message') return;

    const { channel, ts: targetTs } = event.item;
    if (!channel || !targetTs) return;

    // Only bot's own replies are eligible
    if (!this._botReplyTs.has(targetTs)) {
      info(TAG, `ignored fire reaction on non-bot message: ${targetTs}`);
      return;
    }

    // Dedupe: same ts+reaction within 30s ignored (handles rapid add/remove/add)
    const dedupKey = `${targetTs}:${event.reaction}`;
    const now = Date.now();
    const last = this._reactionDedupCache.get(dedupKey);
    if (last && now - last < this._REACTION_DEDUP_TTL) {
      info(TAG, `reaction dedupe: ${dedupKey} (last=${now - last}ms ago)`);
      return;
    }
    this._reactionDedupCache.set(dedupKey, now);

    const thread = await this._fetchThreadForReaction(channel, targetTs);
    if (!thread) {
      warn(TAG, `no preceding user message for reaction on ${targetTs}`);
      return;
    }
    const { threadTs, userText, userId } = thread;

    info(TAG, `fire reaction → rerun: thread=${threadTs} target=${targetTs} user=${userId}`);

    if (this.onReaction) {
      this.onReaction({
        platform: 'slack',
        channel,
        threadTs,
        targetMessageTs: targetTs,
        userText: `[effort:xhigh] ${userText}`,
        userId,
        teamId: event.team || event.team_id || null,
        threadHistory: null,
        rerun: true,
        origin: { kind: 'user', name: 'rerun', parentAttemptId: null },
      });
    }
  }

  async _fetchThreadForReaction(channel, botMessageTs) {
    try {
      // Step 1: fetch the reacted message to discover thread_ts
      const msgResp = await this._slack.conversations.replies({
        channel,
        ts: botMessageTs,
        limit: 1,
        inclusive: true,
      });
      const botMsg = msgResp.messages?.[0];
      if (!botMsg) return null;
      const threadTs = botMsg.thread_ts || botMessageTs;

      // Step 2: fetch full thread, walk backwards from bot msg to nearest user msg
      const threadResp = await this._slack.conversations.replies({
        channel,
        ts: threadTs,
        limit: 100,
        inclusive: true,
      });
      const messages = threadResp.messages || [];

      const idx = messages.findIndex((m) => m.ts === botMessageTs);
      if (idx < 0) return null;

      for (let i = idx - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.user && m.user !== this._botUserId && !m.bot_id) {
          return {
            threadTs,
            userText: m.text || '',
            userId: m.user,
          };
        }
      }
      return null;
    } catch (err) {
      logError(TAG, `_fetchThreadForReaction: ${err.message}`);
      return null;
    }
  }

  // --- Start ---

  async start(onMessage, onInteractive) {
    this.onMessage = onMessage;
    this.onInteractive = onInteractive;

    const auth = await this._slack.auth.test();
    this._botUserId = auth.user_id;
    this._botId = auth.bot_id;
    this._teamId = auth.team_id || null;
    info(TAG, `booted as @${auth.user} (${this._botUserId}, bot=${this._botId})`);

    this._socket.on('message', (evt) => this._handleMessage(evt));
    this._socket.on('interactive', (evt) => this._handleInteractive(evt));
    this._socket.on('reaction_added', (evt) => this._handleReaction(evt));

    this._socket.on('disconnect', (err) => {
      warn(TAG, `socket disconnected: ${err || 'unknown'}`);
    });
    this._socket.on('error', (err) => {
      logError(TAG, `socket error: ${err?.message || err}`);
    });
    this._socket.on('reconnecting', () => {
      info(TAG, 'socket reconnecting...');
    });

    await this._socket.start();
    info(TAG, `socket connected, reply_broadcast=${this._replyBroadcast}`);

    // Periodic cleanup every 30 min
    this._cleanupInterval = setInterval(() => {
      this._cleanupTrackedThreads();
      cleanImageCache(this._imageCacheDir).catch(() => {});
      info(TAG, `cleanup: trackedThreads=${this._trackedThreads.size} seenMessages=${this._seenMessages.size}`);
    }, 30 * 60 * 1000);
  }
}
