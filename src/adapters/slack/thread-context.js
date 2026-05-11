import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { info, warn } from '../../log.js';
import { isSafeUrl } from '../../format-utils.js';
import { downloadAndCacheImage, IMAGE_EXTENSIONS } from '../image-cache.js';

const TAG = 'slack';
const MAX_USERNAME_CACHE = 500;

const SLACK_URL_RE = /https?:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?([^\s>)]*))?/g;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'tsv', 'log', 'py', 'js', 'ts', 'jsx', 'tsx',
  'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'bash', 'sql',
  'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'cfg',
]);
const MAX_FILE_SIZE = 100 * 1024;
export const RECEIPT_CONTEXT_PREFIXES = [
  '📓',
  '🪞',
  '📝 改动',
  '📝 _改动',
];
const DAILY_NOTES_RECEIPT_RE = /^[📓🪞]\s+(?:\d{2}:\d{2}|--:--)｜/u;

function isReceiptContextText(text) {
  const normalized = String(text || '').trimStart().replace(/^>\s*_?/, '');
  return DAILY_NOTES_RECEIPT_RE.test(normalized)
    || RECEIPT_CONTEXT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function extractSlackThreadUrls(text) {
  if (!text) return [];
  const results = [];
  let m;
  while ((m = SLACK_URL_RE.exec(text)) !== null) {
    const channel = m[1];
    const messageTs = `${m[2]}.${m[3]}`;
    const query = m[4] || '';
    let threadTs = messageTs;
    const threadMatch = query.replace(/&amp;/g, '&').match(/thread_ts=(\d+\.\d+)/);
    if (threadMatch) threadTs = threadMatch[1];
    results.push({ channel, threadTs, messageTs });
  }
  SLACK_URL_RE.lastIndex = 0;
  return results;
}

export function extractBlockKitText(blocks) {
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
        if (!el?.text) continue;
        const lines = String(el.text).split('\n');
        if (lines.some((line) => isReceiptContextText(line) && line.includes('📝 改动'))) continue;
        const kept = lines
          .filter((line) => !isReceiptContextText(line))
          .join('\n')
          .trim();
        if (kept) parts.push(kept);
      }
    }
  }
  return parts.join('\n');
}

export function createThreadContextHelper({
  webClient,
  botToken,
  imageCacheDir,
  getProfilePaths,
  getBotId = () => null,
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
}) {
  const seenMessages = new Map();
  const trackedThreads = new Map();
  const threadCtxCache = new Map();
  const assistantThreadRootCache = new Map();
  const channelMetaCache = new Map();
  const userNameCache = new Map();
  const DEDUP_TTL = 5 * 60 * 1000;
  const THREAD_TTL = 24 * 60 * 60 * 1000;
  const MAX_TRACKED = 5000;
  const THREAD_CTX_TTL = 60 * 1000;
  const CHANNEL_META_TTL = 5 * 60 * 1000;

  const helper = {
    _isDuplicate(eventTs) {
      const t = now();
      if (seenMessages.size > 2000) {
        for (const [ts, seenAt] of seenMessages) {
          if (t - seenAt > DEDUP_TTL) seenMessages.delete(ts);
        }
        if (seenMessages.size > 2000) {
          const sorted = [...seenMessages.entries()].sort((a, b) => a[1] - b[1]);
          for (const [ts] of sorted.slice(0, 500)) seenMessages.delete(ts);
        }
      }
      if (seenMessages.has(eventTs)) return true;
      seenMessages.set(eventTs, t);
      return false;
    },

    _trackThread(threadTs) {
      trackedThreads.set(threadTs, now());
    },

    _isTrackedThread(threadTs) {
      return trackedThreads.has(threadTs);
    },

    _cleanupTrackedThreads() {
      const cutoff = now() - THREAD_TTL;
      for (const [ts, t] of trackedThreads) {
        if (t < cutoff) trackedThreads.delete(ts);
      }
      if (trackedThreads.size > MAX_TRACKED) {
        const sorted = [...trackedThreads.entries()].sort((a, b) => a[1] - b[1]);
        for (const [ts] of sorted.slice(0, Math.floor(sorted.length / 2))) trackedThreads.delete(ts);
      }
      const t = now();
      for (const [key, entry] of threadCtxCache) {
        if (t - entry.fetchedAt > THREAD_CTX_TTL) threadCtxCache.delete(key);
      }
      for (const [key, entry] of assistantThreadRootCache) {
        if (t - entry.fetchedAt > THREAD_CTX_TTL) assistantThreadRootCache.delete(key);
      }
    },

    async _isAssistantThreadRoot(channel, threadTs) {
      if (!channel || !threadTs) return false;
      const cacheKey = `${channel}:${threadTs}`;
      const cached = assistantThreadRootCache.get(cacheKey);
      if (cached && (now() - cached.fetchedAt < THREAD_CTX_TTL)) return cached.value;

      let value = false;
      try {
        const resp = await webClient.conversations.replies({
          channel,
          ts: threadTs,
          limit: 1,
          inclusive: true,
        });
        const root = resp.messages?.[0];
        const rootText = [root?.text || '', extractBlockKitText(root?.blocks)].filter(Boolean).join('\n');
        value = Boolean(root?.bot_id === getBotId() && /assistant thread/i.test(rootText));
      } catch (err) {
        warn(TAG, `assistant thread root lookup failed for ${cacheKey}: ${err.message}`);
      }

      assistantThreadRootCache.set(cacheKey, { value, fetchedAt: now() });
      return value;
    },

    async _resolveUserName(userId) {
      if (!userId) return 'User';
      if (userNameCache.has(userId)) return userNameCache.get(userId);
      try {
        const result = await webClient.users.info({ user: userId });
        const profile = result.user?.profile;
        const name = profile?.display_name || profile?.real_name || userId;
        if (userNameCache.size >= MAX_USERNAME_CACHE) {
          userNameCache.delete(userNameCache.keys().next().value);
        }
        userNameCache.set(userId, name);
        return name;
      } catch (_) {
        return userId;
      }
    },

    async fetchThreadHistory(threadTs, channel, { bypassCache = false } = {}) {
      const MAX_HISTORY_MESSAGES = 30;
      const MAX_HISTORY_CHARS = 8000;
      if (!channel) return null;

      const cacheKey = `${channel}:${threadTs}`;
      if (!bypassCache) {
        const cached = threadCtxCache.get(cacheKey);
        if (cached && (now() - cached.fetchedAt < THREAD_CTX_TTL)) return cached.content;
      }

      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await webClient.conversations.replies({
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
        threadCtxCache.set(cacheKey, { content: null, fetchedAt: now() });
        return null;
      }

      const lines = [];
      let totalChars = 0;
      for (const msg of result.messages.slice(0, -1)) {
        const role = msg.bot_id ? 'Orb' : await helper._resolveUserName(msg.user);
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
      threadCtxCache.set(cacheKey, { content, fetchedAt: now() });
      return content;
    },

    async fetchChannelMeta(channelId) {
      if (!channelId) return { topic: '', purpose: '' };
      const hit = channelMetaCache.get(channelId);
      if (hit && now() - hit.fetchedAt < CHANNEL_META_TTL) return { topic: hit.topic, purpose: hit.purpose };

      try {
        const result = await webClient.conversations.info({ channel: channelId });
        const topic = result.channel?.topic?.value || '';
        const purpose = result.channel?.purpose?.value || '';
        channelMetaCache.set(channelId, { topic, purpose, fetchedAt: now() });
        return { topic, purpose };
      } catch (err) {
        warn(TAG, `fetchChannelMeta failed channel=${channelId}: ${err.message}`);
        return { topic: '', purpose: '' };
      }
    },

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
              const imgPath = await downloadAndCacheImage(file.url_private, botToken, imageCacheDir);
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
          const resp = await fetchImpl(file.url_private, {
            headers: { Authorization: `Bearer ${botToken}` },
            redirect: 'manual',
          });
          if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get('location');
            if (!loc || !isSafeUrl(loc)) {
              parts.push(`[附件: ${file.name} — 重定向目标不安全]`);
              continue;
            }
            const resp2 = await fetchImpl(loc);
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
    },

    async _downloadDMFile(file, event, userId) {
      if (!file?.url_private) throw new Error('no url_private');
      if (!isSafeUrl(file.url_private)) throw new Error('unsafe URL');

      let inboxDir;
      if (getProfilePaths && userId) {
        const paths = getProfilePaths(userId);
        inboxDir = join(paths.workspaceDir, 'work', 'inbox');
      } else {
        inboxDir = join(homedir(), '.orb', 'dm-inbox');
      }
      mkdirSync(inboxDir, { recursive: true });

      const safeName = (file.name || 'file.bin').replace(/[\/\\]/g, '_');
      const ts = event.ts || String(now());
      const dest = join(inboxDir, `${ts}_${safeName}`);

      const resp = await fetchImpl(file.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
        redirect: 'manual',
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc || !isSafeUrl(loc)) throw new Error('unsafe redirect');
        const resp2 = await fetchImpl(loc);
        if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
        writeFileSync(dest, Buffer.from(await resp2.arrayBuffer()));
        return dest;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
      return dest;
    },

    stats() {
      return {
        trackedThreads: trackedThreads.size,
        seenMessages: seenMessages.size,
      };
    },
  };

  return helper;
}
