/**
 * Platform-agnostic text utilities.
 * Adapter-specific format modules import from here.
 */

export function sanitizeErrorText(text) {
  if (!text) return text;
  return text
    .replace(/xox[bpars]-[0-9A-Za-z-]+/g, '[SLACK_TOKEN]')
    .replace(/xapp-[0-9A-Za-z-]+/g, '[SLACK_APP_TOKEN]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[API_KEY]')
    .replace(/Bearer [A-Za-z0-9._\-\/+=]{20,}/g, 'Bearer [TOKEN]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[JWT]')
    .replace(/ghp_[A-Za-z0-9]{36,}/g, '[GITHUB_TOKEN]')
    .replace(/gho_[A-Za-z0-9]{36,}/g, '[GITHUB_OAUTH]');
}

export function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!['https:', 'http:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host.endsWith('.internal') || host.endsWith('.local')) return false;
    // IPv6 ULA (fc00::/7) and link-local (fe80::/10) — strip brackets first
    const bare = host.replace(/^\[|\]$/g, '');
    if (/^f[cd][0-9a-f]{2}:/i.test(bare) || /^fe[89ab][0-9a-f]:/i.test(bare)) return false;
    return true;
  } catch {
    return false;
  }
}

export function splitText(text, maxLen = 3000) {
  if (!text || text.length <= maxLen) return [text || ''];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
