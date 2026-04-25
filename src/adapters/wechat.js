/**
 * WeChat adapter for Orb.
 *
 * Connects to personal WeChat accounts via Tencent's iLink Bot API.
 * Based on Hermes Agent's weixin.py implementation.
 *
 * Architecture:
 * - Long-poll getupdates for inbound messages (no public endpoint needed)
 * - POST sendmessage for outbound with context_token echo
 * - QR code login via separate setup script (scripts/wechat-setup.js)
 * - Credentials persisted to ~/.orb/wechat/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { info, error as logError, warn } from '../log.js';
import { buildSendPayloads } from './wechat-format.js';
import { PlatformAdapter } from './interface.js';

const TAG = 'wechat';

// --- iLink API constants ---

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_APP_ID = 'bot';
const CHANNEL_VERSION = '2.2.0';
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);

const EP_GET_UPDATES = 'ilink/bot/getupdates';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';
const EP_SEND_TYPING = 'ilink/bot/sendtyping';
const EP_GET_CONFIG = 'ilink/bot/getconfig';

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const SESSION_EXPIRED_ERRCODE = -14;

const ITEM_TEXT = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

function formatApprovalPrompt(prompt) {
  if (prompt && typeof prompt === 'object') {
    if (prompt.kind === 'permission') {
      const lines = [
        `工具: ${prompt.toolName || 'unknown'}`,
      ];
      if (prompt.requestId) lines.push(`请求: ${prompt.requestId}`);
      if (prompt.toolUseId) lines.push(`调用: ${prompt.toolUseId}`);
      if (prompt.toolInput !== undefined) {
        try {
          lines.push(`参数: ${JSON.stringify(prompt.toolInput, null, 2)}`);
        } catch {
          lines.push(`参数: ${String(prompt.toolInput)}`);
        }
      }
      return lines.join('\n');
    }
    try {
      return JSON.stringify(prompt, null, 2);
    } catch {
      return String(prompt);
    }
  }
  return String(prompt || '');
}

// --- Credential storage ---

function credentialDir() {
  const dir = join(homedir(), '.orb', 'wechat');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadCredentials(accountId) {
  const path = join(credentialDir(), `${accountId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// --- Context token store (disk-backed) ---

class ContextTokenStore {
  constructor(accountId) {
    this._accountId = accountId;
    this._cache = new Map();
    this._path = join(credentialDir(), `${accountId}.context-tokens.json`);
    this._restore();
  }

  _restore() {
    if (!existsSync(this._path)) return;
    try {
      const data = JSON.parse(readFileSync(this._path, 'utf-8'));
      for (const [userId, token] of Object.entries(data)) {
        if (token) this._cache.set(userId, token);
      }
      info(TAG, `restored ${this._cache.size} context token(s)`);
    } catch (err) {
      warn(TAG, `failed to restore context tokens: ${err.message}`);
    }
  }

  get(userId) {
    return this._cache.get(userId) || null;
  }

  set(userId, token) {
    this._cache.set(userId, token);
    this._persist();
  }

  delete(userId) {
    if (this._cache.delete(userId)) this._persist();
  }

  _persist() {
    try {
      const obj = Object.fromEntries(this._cache);
      writeFileSync(this._path, JSON.stringify(obj, null, 2));
    } catch (err) {
      warn(TAG, `failed to persist context tokens: ${err.message}`);
    }
  }
}

// --- Typing ticket cache ---

class TypingTicketCache {
  constructor(ttlMs = 600_000) {
    this._ttl = ttlMs;
    this._cache = new Map();
  }

  get(userId) {
    const entry = this._cache.get(userId);
    if (!entry) return null;
    if (Date.now() - entry.ts >= this._ttl) {
      this._cache.delete(userId);
      return null;
    }
    return entry.ticket;
  }

  set(userId, ticket) {
    this._cache.set(userId, { ticket, ts: Date.now() });
  }
}

// --- Sync buffer persistence ---

function syncBufPath(accountId) {
  return join(credentialDir(), `${accountId}.sync.json`);
}

function loadSyncBuf(accountId) {
  const path = syncBufPath(accountId);
  if (!existsSync(path)) return '';
  try {
    return JSON.parse(readFileSync(path, 'utf-8')).get_updates_buf || '';
  } catch {
    return '';
  }
}

function saveSyncBuf(accountId, buf) {
  try {
    writeFileSync(syncBufPath(accountId), JSON.stringify({ get_updates_buf: buf }));
  } catch (err) {
    warn(TAG, `failed to save sync buf: ${err.message}`);
  }
}

// --- HTTP helpers ---

function randomWechatUin() {
  const buf = randomBytes(4);
  const value = buf.readUInt32BE(0);
  return Buffer.from(String(value)).toString('base64');
}

function buildHeaders(token, bodyStr) {
  const headers = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function apiPost(baseUrl, endpoint, payload, token, timeoutMs) {
  const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
  const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token, body),
      body,
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`iLink POST ${endpoint} HTTP ${resp.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// --- Message deduplication ---

class MessageDedup {
  constructor(ttlMs = 300_000) {
    this._ttl = ttlMs;
    this._seen = new Map();
  }

  isDuplicate(msgId) {
    const now = Date.now();
    // Cleanup
    if (this._seen.size > 2000) {
      for (const [id, ts] of this._seen) {
        if (now - ts > this._ttl) this._seen.delete(id);
      }
    }
    if (this._seen.has(msgId)) return true;
    this._seen.set(msgId, now);
    return false;
  }
}

// --- Extract text from item_list ---

function extractText(itemList) {
  for (const item of itemList) {
    if (item.type === ITEM_TEXT) {
      const text = item.text_item?.text || '';
      const ref = item.ref_msg || {};
      const refItem = ref.message_item || {};
      if (refItem.type && refItem.type !== ITEM_TEXT) {
        const title = ref.title || '';
        const prefix = title ? `[引用媒体: ${title}]\n` : '[引用媒体]\n';
        return `${prefix}${text}`.trim();
      }
      if (refItem.type === ITEM_TEXT) {
        const refText = refItem.text_item?.text || '';
        const title = ref.title || '';
        const parts = [title, refText].filter(Boolean);
        if (parts.length) return `[引用: ${parts.join(' | ')}]\n${text}`.trim();
      }
      return text;
    }
  }
  // Voice with text transcription
  for (const item of itemList) {
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return '';
}

// --- WeChat Adapter ---

export class WeChatAdapter extends PlatformAdapter {
  constructor({
    accountId,
    token,
    baseUrl,
    dmPolicy,
    allowedUsers,
    sendChunkDelayMs,
  }) {
    super();
    this._accountId = accountId || '';
    this._token = token || '';
    this._baseUrl = (baseUrl || ILINK_BASE_URL).replace(/\/$/, '');
    this._dmPolicy = dmPolicy || 'allowlist';
    this._allowedUsers = new Set(allowedUsers || []);
    this._sendChunkDelayMs = sendChunkDelayMs ?? 350;

    // Try loading credentials from disk if token not provided
    if (this._accountId && !this._token) {
      const creds = loadCredentials(this._accountId);
      if (creds) {
        this._token = creds.token || '';
        if (creds.base_url) this._baseUrl = creds.base_url.replace(/\/$/, '');
        info(TAG, `loaded credentials from disk for account=${this._accountId.slice(0, 8)}`);
      }
    }

    this._tokenStore = null; // initialized in start()
    this._typingCache = new TypingTicketCache();
    this._typingFetchInFlight = new Map();
    this._dedup = new MessageDedup();
    this._running = false;
    this._pollTimer = null;

    // Callbacks
    this.onMessage = null;

    // Thread tracking (WeChat has no threads — each user is a "thread")
    this._trackedUsers = new Map();
  }

  get botUserId() {
    return this._accountId;
  }

  get platform() {
    return 'wechat';
  }

  get supportsInteractiveApproval() {
    return false;
  }

  // --- PlatformAdapter interface ---

  async start(onMessage) {
    this.onMessage = onMessage;

    if (!this._token || !this._accountId) {
      logError(TAG, 'missing accountId or token — run wechat-setup first');
      throw new Error('WeChat: missing credentials');
    }

    this._tokenStore = new ContextTokenStore(this._accountId);
    this._running = true;

    info(TAG, `starting poll loop, account=${this._accountId.slice(0, 8)}, baseUrl=${this._baseUrl}`);
    this._pollLoop(); // fire-and-forget, self-scheduling

    // Periodic cleanup every 30 min
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, ts] of this._trackedUsers) {
        if (now - ts > 24 * 60 * 60 * 1000) this._trackedUsers.delete(id);
      }
    }, 30 * 60 * 1000);
  }

  async disconnect() {
    this._running = false;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
    info(TAG, 'disconnected');
  }

  async sendReply(channel, threadTs, text, extra = {}) {
    // channel = wechat userId (peer), threadTs = same or null
    const targetUser = channel;
    let contextToken = this._tokenStore?.get(targetUser) || null;
    const clientId = `orb-wx-${randomUUID().replace(/-/g, '')}`;

    const buildMessage = (token) => {
      const message = {
        from_user_id: '',
        to_user_id: targetUser,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: ITEM_TEXT, text_item: { text } }],
      };
      if (token) message.context_token = token;
      return message;
    };

    // iLink returns ret/errcode=-14 when the per-chat session expires
    // (common after long idle, esp. for cron pushes). Retry once without
    // context_token -- iLink accepts tokenless sends as a degraded fallback.
    // Ported from Hermes weixin.py e105b7a.
    let resp = await apiPost(this._baseUrl, EP_SEND_MESSAGE, { msg: buildMessage(contextToken) }, this._token, API_TIMEOUT_MS);
    const ret = resp?.ret ?? 0;
    const errcode = resp?.errcode ?? 0;
    if ((ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) && contextToken) {
      warn(TAG, `session expired for ${targetUser.slice(0, 8)}...; retrying without context_token`);
      this._tokenStore?.delete?.(targetUser);
      contextToken = null;
      resp = await apiPost(this._baseUrl, EP_SEND_MESSAGE, { msg: buildMessage(null) }, this._token, API_TIMEOUT_MS);
    }
    const finalRet = resp?.ret ?? 0;
    const finalErr = resp?.errcode ?? 0;
    if (finalRet !== 0 || finalErr !== 0) {
      throw new Error(`iLink sendmessage ret=${finalRet} errcode=${finalErr} errmsg=${resp?.errmsg || ''}`);
    }
  }

  async editMessage() {
    // WeChat doesn't support message editing
  }

  async uploadFile() {
    // TODO: implement media upload via CDN protocol
    warn(TAG, 'file upload not yet implemented for WeChat');
  }

  async setTyping(channel, threadTs, status) {
    if (!status) return;
    const userId = channel;
    let ticket = this._typingCache.get(userId);
    if (!ticket) {
      const contextToken = this._tokenStore?.get(userId) || null;
      let timeoutId = null;
      try {
        ticket = await Promise.race([
          this._fetchTypingTicket(userId, contextToken),
          new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve(''), 500);
            if (typeof timeoutId.unref === 'function') timeoutId.unref();
          }),
        ]);
      } catch {
        ticket = '';
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    if (!ticket) return;
    try {
      await apiPost(this._baseUrl, EP_SEND_TYPING, {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: 1, // TYPING_START
      }, this._token, CONFIG_TIMEOUT_MS);
    } catch (_) {}
  }

  async setThreadStatus(channel, threadTs, status, _loadingMessages) {
    const enable = !!(status && String(status).trim());
    await this.setTyping(channel, threadTs, enable);
  }

  async sendApproval(channel, threadTs, prompt) {
    const mode = process.env.ORB_PERMISSION_APPROVAL_MODE || 'auto-allow';
    const renderedPrompt = formatApprovalPrompt(prompt);
    if (mode === 'auto-allow') {
      await this.sendReply(channel, threadTs, `[需要审批] ${renderedPrompt}\n（当前配置为 auto-allow，自动批准一次）`);
      return { approved: true, scope: 'once', userId: channel };
    }

    const reason = 'WeChat 不支持交互式审批；请设置 ORB_PERMISSION_APPROVAL_MODE=auto-allow，或在 Slack 上批准该权限请求。';
    await this.sendReply(channel, threadTs, `[需要审批] ${renderedPrompt}\n${reason}`);
    return { approved: false, scope: 'once', userId: channel, reason };
  }

  buildPayloads(text) {
    return buildSendPayloads(text);
  }

  async cleanupIndicator(channel, threadTs, typingSet, errorMsg) {
    try {
      await this.sendReply(channel, threadTs, `⚠️ ${errorMsg}`);
    } catch (err) {
      logError(TAG, `failed to send error msg: ${err.message}`);
    }
  }

  async fetchThreadHistory(threadTs, channel) {
    // WeChat has no thread concept — no history to fetch
    return null;
  }

  // --- Long-poll loop ---

  async _pollLoop() {
    let syncBuf = loadSyncBuf(this._accountId);
    let timeoutMs = LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;

    while (this._running) {
      try {
        let response;
        try {
          response = await apiPost(
            this._baseUrl, EP_GET_UPDATES,
            { get_updates_buf: syncBuf },
            this._token, timeoutMs + 5000, // extra margin over server timeout
          );
        } catch (err) {
          if (err.name === 'AbortError') {
            // Normal timeout — server had nothing to send
            continue;
          }
          throw err;
        }

        // Update suggested timeout
        const suggested = response.longpolling_timeout_ms;
        if (typeof suggested === 'number' && suggested > 0) {
          timeoutMs = suggested;
        }

        const ret = response.ret ?? 0;
        const errcode = response.errcode ?? 0;

        if (ret !== 0 || errcode !== 0) {
          if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
            logError(TAG, 'session expired — pausing 10 minutes (need to re-scan QR)');
            await this._sleep(600_000);
            consecutiveFailures = 0;
            continue;
          }
          consecutiveFailures++;
          warn(TAG, `getUpdates failed ret=${ret} errcode=${errcode} errmsg=${response.errmsg || ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
          await this._sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
          continue;
        }

        consecutiveFailures = 0;
        const newSyncBuf = response.get_updates_buf || '';
        if (newSyncBuf) {
          syncBuf = newSyncBuf;
          saveSyncBuf(this._accountId, syncBuf);
        }

        for (const message of (response.msgs || [])) {
          this._processMessageSafe(message);
        }
      } catch (err) {
        consecutiveFailures++;
        logError(TAG, `poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
        await this._sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._pollTimer = setTimeout(resolve, ms);
    });
  }

  async _processMessageSafe(message) {
    try {
      await this._processMessage(message);
    } catch (err) {
      logError(TAG, `inbound error from=${(message.from_user_id || '').slice(0, 8)}: ${err.message}`);
    }
  }

  async _processMessage(message) {
    const senderId = String(message.from_user_id || '').trim();
    if (!senderId || senderId === this._accountId) return;

    const messageId = String(message.message_id ?? '').trim();
    if (messageId && this._dedup.isDuplicate(messageId)) return;

    // DM policy check
    if (this._dmPolicy === 'disabled') return;
    if (this._dmPolicy === 'allowlist' && !this._allowedUsers.has(senderId)) {
      info(TAG, `blocked message from unlisted user: ${senderId.slice(0, 8)}`);
      return;
    }

    // Store context token
    const contextToken = String(message.context_token ?? '').trim();
    if (contextToken) {
      this._tokenStore.set(senderId, contextToken);
    }

    // Pre-fetch typing ticket in background
    this._fetchTypingTicket(senderId, contextToken || null).catch(() => {});

    // Extract text
    const itemList = message.item_list || [];
    const userText = extractText(itemList);
    if (!userText) return;

    // In WeChat, each user is essentially a "thread"
    // Use senderId as both channel and threadTs
    const channel = senderId;
    const threadTs = senderId;

    info(TAG, `msg: from=${senderId.slice(0, 8)} text="${userText.slice(0, 80)}"`);

    this._trackedUsers.set(senderId, Date.now());

    const task = {
      userText,
      fileContent: '',
      imagePaths: [],
      threadTs,
      channel,
      userId: senderId,
      platform: 'wechat',
      threadHistory: null,
    };

    if (this.onMessage) {
      this.onMessage(task);
    }
  }

  async _fetchTypingTicket(userId, contextToken) {
    const cached = this._typingCache.get(userId);
    if (cached) return cached;
    if (this._typingFetchInFlight.has(userId)) {
      return this._typingFetchInFlight.get(userId);
    }

    const promise = (async () => {
      try {
        const payload = { ilink_user_id: userId };
        if (contextToken) payload.context_token = contextToken;
        const response = await apiPost(
          this._baseUrl, EP_GET_CONFIG, payload, this._token, CONFIG_TIMEOUT_MS,
        );
        const ticket = response.typing_ticket || '';
        if (ticket) this._typingCache.set(userId, ticket);
        return ticket;
      } catch (err) {
        warn(TAG, `fetch typing ticket failed for ${userId.slice(0, 8)}: ${err.message}`);
        return '';
      } finally {
        this._typingFetchInFlight.delete(userId);
      }
    })();
    this._typingFetchInFlight.set(userId, promise);
    return promise;
  }
}
