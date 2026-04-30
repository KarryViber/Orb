// Compile a regex from config. Returns null on invalid input rather than
// throwing, so a bad rule disables just that rule instead of crashing routing.
// Accepts leading `(?i)` / `(?im)` inline flag prefix (PCRE-style, common in
// human-authored configs) and rewrites it to JS RegExp flags.
export function safeDmRoutingRegex(pattern, flags = '') {
  if (pattern == null) return null;
  try {
    let p = String(pattern);
    let f = String(flags || '');
    const m = p.match(/^\(\?([a-z]+)\)/);
    if (m) {
      const inline = m[1].toLowerCase();
      for (const ch of inline) if (!f.includes(ch) && 'gimsuy'.includes(ch)) f += ch;
      p = p.slice(m[0].length);
    }
    return new RegExp(p, f);
  } catch {
    return null;
  }
}

export function extractDmRoutingRepoSlug(url) {
  if (!url) return '';
  const m = String(url).match(/github\.com\/([^/\s]+)\/([^/\s?#]+)/);
  if (!m) return '';
  const owner = m[1];
  const name = m[2].replace(/\.git$/, '');
  return `${owner}/${name}`;
}

export function formatDmRoutingDate(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}`;
}

export function makeDmRoutingPreview(s, max = 40) {
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

export function interpolateDmRoutingTemplate(template, ctx) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
    const v = ctx[key];
    return v == null ? '' : String(v);
  });
}

export function matchDmRule(event, rules) {
  const text = event?.text || '';
  const files = event?.files || [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const ctx = matchSingleRule(rule, text, files);
    if (ctx) return { rule, ctx };
  }
  return null;
}

function matchSingleRule(rule, text, files) {
  const m = rule?.match || {};

  if (m.hasFile) {
    if (!files || files.length === 0) return null;
    const fileRe = m.filenamePattern ? safeDmRoutingRegex(m.filenamePattern) : null;
    const wantType = m.filetype ? String(m.filetype).toLowerCase() : null;
    for (const f of files) {
      const name = f.name || '';
      const ext = (name.split('.').pop() || '').toLowerCase();
      const ftype = (f.filetype || '').toLowerCase();
      if (wantType && ext !== wantType && ftype !== wantType) continue;
      if (fileRe && !fileRe.test(name)) continue;
      return {
        file: f,
        filename: name,
        preview: name,
        original_text: text || '',
      };
    }
    return null;
  }

  if (m.urlPattern) {
    const re = safeDmRoutingRegex(m.urlPattern);
    if (!re) return null;
    const found = text ? text.match(re) : null;
    if (!found) return null;
    const url = found[0];
    return {
      urlMatched: url,
      url_matched: url,
      preview: makeDmRoutingPreview(url),
      repo_slug: extractDmRoutingRepoSlug(url),
      original_text: text || '',
    };
  }

  return null;
}

export function renderDmRoutingMainText(rule, ctx) {
  return interpolateDmRoutingTemplate(rule?.target?.mainTemplate, ctx);
}

export function renderDmRoutingPrompt(rule, ctx, event = {}) {
  const payloadKeys = new Set(['original_text', 'url_matched', 'urlMatched', 'filename']);
  const keyAlias = { urlMatched: 'url_matched' };
  const payloadFragments = [];
  const seen = new Set();
  const retrievedAt = new Date().toISOString();
  const addPayload = (rawKey) => {
    const key = keyAlias[rawKey] || rawKey;
    if (seen.has(key)) return;
    const value = ctx[rawKey] ?? ctx[key];
    if (value == null || value === '') return;
    seen.add(key);
    payloadFragments.push({
      source_type: 'routed_dm_payload',
      trusted: false,
      origin: key === 'url_matched'
        ? String(value)
        : `slack:dm:${event.ts || 'unknown'}:${key}`,
      content: String(value),
      retrieved_at: retrievedAt,
      platform: 'slack',
      author_id: event.user || null,
      metadata: {
        key,
        repo_slug: key === 'url_matched' ? (ctx.repo_slug || '') : undefined,
      },
    });
  };

  const tpl = rule?.target?.workerPrompt || rule?.target?.threadBootstrap || '';
  let instructionText = String(tpl || '').replace(/\{(\w+)\}/g, (_, key) => {
    if (payloadKeys.has(key)) {
      addPayload(key);
      return `[routed_dm_payload:${keyAlias[key] || key}]`;
    }
    const v = ctx[key];
    return v == null ? '' : String(v);
  });

  for (const key of payloadKeys) addPayload(key);

  if (ctx.file) {
    instructionText += ctx.localPath
      ? `\n\n[附件已下载到: ${ctx.localPath}]`
      : '\n\n[附件下载失败，请手动从 Slack 获取。]';
  }
  return { instructionText, payloadFragments };
}
