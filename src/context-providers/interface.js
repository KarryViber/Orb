import { createHash } from 'node:crypto';

/**
 * @typedef {Object} ProviderContext
 * @property {string} userText
 * @property {string} threadTs
 * @property {string} userId
 * @property {string} channel
 * @property {string} dataDir
 * @property {string} workspaceDir
 * @property {string} mode
 * @property {Object} channelMeta
 * @property {string} threadHistory
 * @property {Array} priorConversation
 * @property {Array} fragments
 */

/**
 * @typedef {Object} ContextProvider
 * @property {string} name
 * @property {(ctx: ProviderContext) => Promise<Array>} prefetch
 * @property {(ctx: ProviderContext, manifestItems: Array) => Promise<void>} [postUse]
 */

export function sha16(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

export function snippet(value, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function memoryManifestItem(kind, itemId, content) {
  return {
    item_kind: kind,
    item_id: String(itemId || ''),
    content: snippet(content),
    content_hash: sha16(content || itemId),
  };
}
