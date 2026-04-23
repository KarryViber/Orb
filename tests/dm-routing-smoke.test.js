#!/usr/bin/env node
// Smoke tests for DM routing v2.1 (src/adapters/slack.js)
//
// v2.1 changes vs v2:
//   - No visible threadBootstrap. Only the main card is posted to Slack.
//   - task.userText = interpolated workerPrompt (worker-facing only).
//   - mainTemplate supports {date_mmdd} {preview} {filename} {repo_slug}.
//   - workerPrompt supports {original_text} {url_matched} {filename} etc.
//
// Run:
//   node profiles/karry/workspace/work/tests/dm-routing-smoke.test.js

import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackAdapter } from '../../../../../src/adapters/slack.js';

const RULES = [
  {
    name: 'x-reply-drafting',
    match: { urlPattern: 'https?://(x\\.com|twitter\\.com)/[^/\\s]+/status/\\d+' },
    target: {
      channel: 'C10',
      mainTemplate: '🐦 X 拟稿 {date_mmdd}｜待判别｜{preview}',
      cardSpec: 'x-reply-drafting',
      workerPrompt: '[路由: x-reply-drafting]\nDM 原文: {original_text}\n链接: {url_matched}',
    },
  },
  {
    name: 'github-research',
    match: { urlPattern: 'https?://(github\\.com|gist\\.github\\.com)/[^\\s]+' },
    target: {
      channel: 'C08',
      mainTemplate: '🧬 GitHub {date_mmdd}｜{repo_slug}｜待调研',
      cardSpec: 'github-research',
      workerPrompt: '[路由: github-research]\nDM 原文: {original_text}\n链接: {url_matched}\n仓库: {repo_slug}',
    },
  },
  {
    name: 'invoice-bookkeeping',
    match: {
      hasFile: true,
      filetype: 'pdf',
      filenamePattern: '(?i)invoice|receipt|領収書|請求書|インボイス',
    },
    target: {
      channel: 'C04',
      mainTemplate: '💰 记账 {date_mmdd}｜{filename}｜待处理',
      cardSpec: 'invoice-bookkeeping',
      workerPrompt: '[路由: invoice-bookkeeping]\nPDF 文件: {filename}\nDM 原文: {original_text}',
    },
  },
];

const results = [];
async function testCase(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    results.push({ name, pass: true });
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.stack || err.message}`);
    results.push({ name, pass: false, err });
  }
}

function makeAdapter({ dmRouting, tmpWorkspace }) {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    dmRouting: dmRouting || { enabled: true, dmFallback: 'worker', rules: RULES },
    getProfilePaths: () => ({
      workspaceDir: tmpWorkspace,
      dataDir: tmpWorkspace,
      soulDir: tmpWorkspace,
      scriptsDir: tmpWorkspace,
      name: 'test',
    }),
  });
  adapter._botUserId = 'UBOT';
  adapter._botId = 'BBOT';

  const calls = [];
  const emitted = [];
  adapter._slack = {
    chat: {
      postMessage: async (args) => {
        calls.push({ ...args });
        return { ok: true, ts: `tgt-${calls.length}.0000` };
      },
    },
    apiCall: async () => ({}),
  };
  adapter.onMessage = (task) => emitted.push(task);
  return { adapter, calls, emitted };
}

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'orb-dm-'));
}

// --- Tests ---

await testCase('T1: DM X link → only main card posted, no bootstrap', async () => {
  const { adapter, calls, emitted } = makeAdapter({ tmpWorkspace: mkTmp() });
  const event = {
    channel_type: 'im',
    channel: 'Dkarry',
    user: 'U0AN7112XD2',
    text: 'https://x.com/foo/status/123',
    ts: '1700000001.0001',
  };
  const r = await adapter._routeDMMessage(event);
  assert.equal(r.routed, true);
  assert.equal(calls.length, 1, 'v2.1: only main postMessage, no bootstrap');
  assert.equal(calls[0].channel, 'C10');
  assert.match(calls[0].text, /🐦 X 拟稿 \d{2}\/\d{2}｜待判别｜https:\/\/x\.com/);
  assert.equal(calls[0].unfurl_links, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].channel, 'C10');
  assert.equal(emitted[0].threadTs, 'tgt-1.0000');
  assert.equal(emitted[0].platform, 'slack');
  assert.equal(emitted[0].userId, 'U0AN7112XD2');
});

await testCase('T2: DM X link + Karry comment preserved in workerPrompt', async () => {
  const { adapter, calls, emitted } = makeAdapter({ tmpWorkspace: mkTmp() });
  const event = {
    channel_type: 'im',
    channel: 'Dkarry',
    user: 'U0AN7112XD2',
    text: '这个值得转 https://twitter.com/foo/status/999',
    ts: '1700000002.0001',
  };
  await adapter._routeDMMessage(event);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].text.includes('这个值得转'), 'main card must not leak DM original');
  assert.ok(emitted[0].userText.includes('这个值得转'), 'workerPrompt should carry DM original');
  assert.ok(emitted[0].userText.includes('status/999'));
});

await testCase('T3: DM GitHub link → evolution channel with repo_slug', async () => {
  const { adapter, calls, emitted } = makeAdapter({ tmpWorkspace: mkTmp() });
  const event = {
    channel_type: 'im',
    channel: 'Dkarry',
    user: 'U0AN7112XD2',
    text: 'https://github.com/anthropics/anthropic-cookbook',
    ts: '1700000003.0001',
  };
  const r = await adapter._routeDMMessage(event);
  assert.equal(r.routed, true);
  assert.equal(calls[0].channel, 'C08');
  assert.match(calls[0].text, /🧬 GitHub \d{2}\/\d{2}｜anthropics\/anthropic-cookbook｜待调研/);
  assert.equal(emitted[0].channel, 'C08');
  assert.ok(emitted[0].userText.includes('anthropics/anthropic-cookbook'));
});

await testCase('T4: DM invoice PDF → finance, 1 msg only, file downloaded', async () => {
  const tmp = mkTmp();
  const origFetch = globalThis.fetch;
  let fetchedUrl = null;
  globalThis.fetch = async (url) => {
    fetchedUrl = url;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('%PDF-stub').buffer,
      headers: { get: () => null },
    };
  };
  try {
    const { adapter, calls, emitted } = makeAdapter({ tmpWorkspace: tmp });
    const event = {
      channel_type: 'im',
      channel: 'Dkarry',
      user: 'U0AN7112XD2',
      text: 'see attached',
      ts: '1700000004.0001',
      files: [{
        name: 'invoice_2026.pdf',
        filetype: 'pdf',
        url_private: 'https://files.slack.com/xyz/invoice_2026.pdf',
      }],
    };
    const r = await adapter._routeDMMessage(event);
    assert.equal(r.routed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, 'C04');
    assert.match(calls[0].text, /💰 记账 \d{2}\/\d{2}｜invoice_2026\.pdf｜待处理/);
    assert.ok(emitted[0].userText.includes('invoice_2026.pdf'));
    assert.ok(emitted[0].userText.includes('附件已下载到'));
    assert.ok(fetchedUrl?.includes('invoice_2026.pdf'), 'fetch should hit slack file URL');
    const inbox = join(tmp, 'work', 'inbox');
    assert.ok(existsSync(inbox), 'inbox dir should exist after download');
    assert.equal(emitted[0].channel, 'C04');
  } finally {
    globalThis.fetch = origFetch;
  }
});

await testCase('T5: DM contract.pdf (not invoice) → no match, fallback worker', async () => {
  const { adapter, calls, emitted } = makeAdapter({ tmpWorkspace: mkTmp() });
  const event = {
    channel_type: 'im',
    channel: 'Dkarry',
    user: 'U0AN7112XD2',
    text: '',
    ts: '1700000005.0001',
    files: [{ name: 'contract_2026.pdf', filetype: 'pdf', url_private: 'https://files.slack.com/...' }],
  };
  const r = await adapter._routeDMMessage(event);
  assert.equal(r.routed, false);
  assert.equal(r.fallback, 'worker');
  assert.equal(calls.length, 0);
  assert.equal(emitted.length, 0);
});

await testCase('T6: DM pure text → no match, fallback worker', async () => {
  const { adapter, calls } = makeAdapter({ tmpWorkspace: mkTmp() });
  const event = {
    channel_type: 'im',
    channel: 'Dkarry',
    user: 'U0AN7112XD2',
    text: '今天怎么样',
    ts: '1700000006.0001',
  };
  const r = await adapter._routeDMMessage(event);
  assert.equal(r.routed, false);
  assert.equal(r.fallback, 'worker');
  assert.equal(calls.length, 0);
});

await testCase('T8: Slack postMessage failure → not routed, caller falls back', async () => {
  const { adapter } = makeAdapter({ tmpWorkspace: mkTmp() });
  adapter._slack.chat.postMessage = async () => { throw new Error('simulated 500'); };
  const event = {
    channel_type: 'im',
    channel: 'Dkarry',
    user: 'U0AN7112XD2',
    text: 'https://x.com/foo/status/42',
    ts: '1700000008.0001',
  };
  const r = await adapter._routeDMMessage(event);
  assert.equal(r.routed, false);
  assert.equal(r.fallback, 'worker');
});

await testCase('Disabled routing → immediate pass-through', async () => {
  const { adapter, calls } = makeAdapter({
    tmpWorkspace: mkTmp(),
    dmRouting: { enabled: false, rules: RULES },
  });
  const r = await adapter._routeDMMessage({
    channel_type: 'im', user: 'u', text: 'https://x.com/a/status/1', ts: '1',
  });
  assert.equal(r.routed, false);
  assert.equal(calls.length, 0);
});

await testCase('Silent fallback blocks worker handoff', async () => {
  const { adapter } = makeAdapter({
    tmpWorkspace: mkTmp(),
    dmRouting: { enabled: true, dmFallback: 'silent', rules: RULES },
  });
  const r = await adapter._routeDMMessage({
    channel_type: 'im', user: 'u', text: '你好', ts: '1',
  });
  assert.equal(r.routed, false);
  assert.equal(r.fallback, 'silent');
});

await testCase('Rule order: X rule wins over GitHub rule on ambiguous text', async () => {
  const { adapter, calls } = makeAdapter({ tmpWorkspace: mkTmp() });
  const event = {
    channel_type: 'im', user: 'U0AN7112XD2',
    text: '看这个 https://x.com/a/status/1 顺便 https://github.com/b/c',
    ts: '1700000009.0001',
  };
  await adapter._routeDMMessage(event);
  assert.equal(calls[0].channel, 'C10', 'x-ops should win because rules ordered first');
});

// --- v2.1 additions ---

await testCase('T9: routeDMMessage posts only 1 main message (no bootstrap)', async () => {
  const { adapter, calls } = makeAdapter({ tmpWorkspace: mkTmp() });
  await adapter._routeDMMessage({
    channel_type: 'im', user: 'U0AN7112XD2',
    text: 'https://x.com/foo/status/777',
    ts: '1700000011.0001',
  });
  assert.equal(calls.length, 1, 'v2.1: exactly one postMessage to Slack');
  assert.equal(calls[0].thread_ts, undefined, 'main message must not have thread_ts');
});

await testCase('T10: task.userText equals interpolated workerPrompt with DM original', async () => {
  const { adapter, emitted } = makeAdapter({ tmpWorkspace: mkTmp() });
  const dmText = '回他：这思路稍微过度简化 https://x.com/bar/status/888';
  await adapter._routeDMMessage({
    channel_type: 'im', user: 'U0AN7112XD2', text: dmText, ts: '1700000012.0001',
  });
  assert.equal(emitted.length, 1);
  const ut = emitted[0].userText;
  assert.ok(ut.startsWith('[路由: x-reply-drafting]'), 'workerPrompt header intact');
  assert.ok(ut.includes(`DM 原文: ${dmText}`), 'DM original text preserved verbatim');
  assert.ok(ut.includes('链接: https://x.com/bar/status/888'));
});

await testCase('T11: DM original text not leaked to any Slack-visible message', async () => {
  const { adapter, calls } = makeAdapter({ tmpWorkspace: mkTmp() });
  const secret = '机密草稿：请转发给 Z';
  const dmText = `${secret} https://x.com/secret/status/42`;
  await adapter._routeDMMessage({
    channel_type: 'im', user: 'U0AN7112XD2', text: dmText, ts: '1700000013.0001',
  });
  for (const c of calls) {
    const serialized = JSON.stringify(c);
    assert.ok(!serialized.includes(secret),
      `secret should not appear in postMessage args: ${serialized}`);
  }
});

await testCase('T12: workerPrompt has no unresolved {placeholder} residue', async () => {
  const { adapter, emitted } = makeAdapter({ tmpWorkspace: mkTmp() });
  // Cover all 3 rules
  const cases = [
    { text: 'https://x.com/a/status/1', ts: '1700000020.0001' },
    { text: 'https://github.com/owner/name', ts: '1700000020.0002' },
  ];
  for (const { text, ts } of cases) {
    await adapter._routeDMMessage({
      channel_type: 'im', user: 'U0AN7112XD2', text, ts,
    });
  }
  // Invoice case with file
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
    headers: { get: () => null },
  });
  try {
    await adapter._routeDMMessage({
      channel_type: 'im', user: 'U0AN7112XD2', text: '',
      ts: '1700000020.0003',
      files: [{ name: 'receipt_oct.pdf', filetype: 'pdf', url_private: 'https://files.slack.com/r' }],
    });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(emitted.length, 3);
  for (const task of emitted) {
    const residue = task.userText.match(/\{[a-z_]+\}/i);
    assert.equal(residue, null,
      `unresolved placeholder in userText: ${residue?.[0]}\n---\n${task.userText}`);
  }
});

// --- Summary ---

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const r of failed) console.error(`  - ${r.name}: ${r.err?.message}`);
  process.exit(1);
}
