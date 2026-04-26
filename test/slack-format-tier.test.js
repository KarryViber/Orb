import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSendPayloads, markdownToMrkdwn } from '../src/adapters/slack-format.js';

test('markdown heading tiers stay visually distinct', () => {
  const out = markdownToMrkdwn([
    '# A',
    'intro **E** text',
    '## B',
    '### C',
    '#### D',
    '##### F',
    '###### G',
  ].join('\n'));

  assert.equal(out, [
    '【A】',
    '',
    'intro *E* text',
    '',
    '*B*',
    '*C*',
    '_D_',
    '_F_',
    '_G_',
  ].join('\n'));
  assert.match(out, /^【A】$/m);
  assert.match(out, /^\*B\*$/m);
  assert.match(out, /^\*C\*$/m);
  assert.match(out, /^_D_$/m);
  assert.match(out, /^intro \*E\* text$/m);
  assert.doesNotMatch(out, /^\*E\*$/m);
});

test('CJK boundaries are only inserted for inline emphasis', () => {
  const headingOut = markdownToMrkdwn('前文\n## 段标题\n中文段落');
  assert.equal(headingOut, '前文\n\n*段标题*\n中文段落');
  assert.equal(headingOut.includes('*段标题*\n\u200b中文'), false);

  const inlineOut = markdownToMrkdwn('这里**重点**词');
  assert.equal(inlineOut, '这里\u200b*重点*\u200b词');
});

test('standalone Slack mrkdwn bold remains idempotent', () => {
  assert.equal(markdownToMrkdwn('*xxx*'), '*xxx*');
  assert.equal(markdownToMrkdwn('before\n*xxx*\nafter'), 'before\n*xxx*\nafter');
});

test('mixed headings, inline emphasis, code, and list bold convert correctly', () => {
  assert.equal(
    markdownToMrkdwn('## 标题\n正文 **重点** 见 `code`'),
    '*标题*\n正文 *重点* 见 `code`',
  );
  assert.equal(
    markdownToMrkdwn('- **项目** 描述'),
    '- *项目* 描述',
  );
});

test('protected code regions are not structurally converted', () => {
  assert.equal(
    markdownToMrkdwn('```js\n## fake\nconst x = "**fake**";\n```'),
    '```js\n## fake\nconst x = "**fake**";\n```',
  );
  assert.equal(
    markdownToMrkdwn('inline `**fake**` and `## fake`'),
    'inline `**fake**` and `## fake`',
  );
});

test('thread reply sample keeps tiered visual snapshot and block headings', () => {
  const input = [
    '# 调研结论',
    '## :mag: 范围',
    '正文 **重点** 见 `code`。',
    '### 下一步',
    '- **项目** 描述',
    '#### 备注',
    '保留 `ID-1`。',
  ].join('\n');

  const converted = markdownToMrkdwn(input);
  assert.equal(converted, [
    '【调研结论】',
    '',
    '*:mag: 范围*',
    '正文 *重点* 见 `code`。',
    '*下一步*',
    '- *项目* 描述',
    '_备注_',
    '保留 `ID-1`。',
  ].join('\n'));

  const [payload] = buildSendPayloads(input);
  assert.ok(payload.blocks);
  assert.deepEqual(
    payload.blocks.map((block) => block.text?.text),
    [
      '*调研结论*',
      '*:mag: 范围*\n正文 *重点* 见 `code`。\n*下一步*\n- *项目* 描述\n_备注_\n保留 `ID-1`。',
    ],
  );
});
