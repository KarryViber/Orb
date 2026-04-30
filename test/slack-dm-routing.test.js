import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  matchDmRule,
  renderDmRoutingMainText,
  renderDmRoutingPrompt,
} from '../src/adapters/slack-dm-routing.js';

const config = JSON.parse(readFileSync(join(process.cwd(), 'config.json'), 'utf8'));
const rules = config.adapters.slack.dmRouting.rules;

test('matchDmRule matches GitHub URL rules and builds context', () => {
  const matched = matchDmRule({
    text: 'please inspect https://github.com/acme/orb',
    files: [],
    user: 'U1',
    ts: '111.222',
  }, rules);

  assert.equal(matched.rule.name, 'github-research');
  assert.equal(matched.ctx.url_matched, 'https://github.com/acme/orb');
  assert.equal(matched.ctx.repo_slug, 'acme/orb');
  assert.equal(matched.ctx.preview, 'https://github.com/acme/orb');
  assert.equal(matched.ctx.original_text, 'please inspect https://github.com/acme/orb');
});

test('matchDmRule matches invoice file rule with inline case-insensitive filename pattern', () => {
  const matched = matchDmRule({
    text: 'please book this',
    files: [{ name: 'April_RECEIPT.PDF', filetype: 'pdf', url_private: 'https://files.slack.com/f' }],
    user: 'U1',
    ts: '111.222',
  }, rules);

  assert.equal(matched.rule.name, 'invoice-bookkeeping');
  assert.equal(matched.ctx.filename, 'April_RECEIPT.PDF');
  assert.equal(matched.ctx.preview, 'April_RECEIPT.PDF');
  assert.equal(matched.ctx.original_text, 'please book this');
});

test('renderDmRoutingPrompt labels payload fragments and avoids raw DM payload in worker text', () => {
  const matched = matchDmRule({
    text: 'please inspect https://github.com/acme/orb',
    files: [],
    user: 'U1',
    ts: '111.222',
  }, rules);

  const { instructionText, payloadFragments } = renderDmRoutingPrompt(matched.rule, matched.ctx, {
    user: 'U1',
    ts: '111.222',
  });

  assert.doesNotMatch(instructionText, /please inspect/);
  assert.doesNotMatch(instructionText, /https:\/\/github.com\/acme\/orb/);
  assert.match(instructionText, /\[routed_dm_payload:original_text\]/);
  assert.match(instructionText, /\[routed_dm_payload:url_matched\]/);
  assert.match(instructionText, /仓库: acme\/orb/);
  assert.deepEqual(payloadFragments.map((fragment) => fragment.metadata.key), [
    'original_text',
    'url_matched',
  ]);
  assert.equal(payloadFragments[0].origin, 'slack:dm:111.222:original_text');
  assert.equal(payloadFragments[1].origin, 'https://github.com/acme/orb');
  assert.equal(payloadFragments[1].trusted, false);
});

test('current dmRouting rules render expected worker prompt skeletons', () => {
  const cases = [
    {
      name: 'x-reply-drafting',
      event: { text: '回他 https://x.com/example/status/12345', files: [], user: 'U1', ts: '111.222' },
      expected: ['[路由: x-reply-drafting]', 'DM 原文: [routed_dm_payload:original_text]', '链接: [routed_dm_payload:url_matched]'],
    },
    {
      name: 'github-research',
      event: { text: 'https://github.com/acme/orb', files: [], user: 'U1', ts: '111.222' },
      expected: ['[路由: github-research]', '仓库: acme/orb', '链接: [routed_dm_payload:url_matched]'],
    },
    {
      name: 'invoice-bookkeeping',
      event: { text: 'book it', files: [{ name: '領収書-0429.pdf', filetype: 'pdf' }], user: 'U1', ts: '111.222' },
      expected: ['[路由: invoice-bookkeeping]', 'PDF 文件: [routed_dm_payload:filename]', 'DM 原文: [routed_dm_payload:original_text]'],
    },
  ];

  for (const item of cases) {
    const matched = matchDmRule(item.event, rules);
    assert.equal(matched.rule.name, item.name);
    matched.ctx.date_mmdd = '04/30';
    const mainText = renderDmRoutingMainText(matched.rule, matched.ctx);
    const { instructionText } = renderDmRoutingPrompt(matched.rule, matched.ctx, item.event);
    assert.ok(mainText.length > 0, `${item.name} main text`);
    for (const expected of item.expected) {
      assert.match(instructionText, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
});
