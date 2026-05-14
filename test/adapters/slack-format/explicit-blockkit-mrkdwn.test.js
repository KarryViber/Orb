import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSendPayloads } from '../../../src/adapters/slack-format.js';

test('explicit Block Kit mrkdwn sections normalize markdown headings', () => {
  const payloads = buildSendPayloads(JSON.stringify({
    text: 'fallback',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '# :rotating_light: 一级\n## :droplet: 一句话定性\n### :sparkles: 亮点',
        },
        fields: [
          { type: 'mrkdwn', text: '## :link: 与 Orb 关联' },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '### :memo: 备注' },
          { type: 'plain_text', text: '## leave plain text alone' },
        ],
      },
      {
        type: 'header',
        text: { type: 'plain_text', text: '## header plain text' },
      },
      { type: 'divider' },
    ],
  }));

  assert.equal(payloads.length, 1);
  const blocks = payloads[0].blocks;
  assert.equal(blocks[0].text.text, '【:rotating_light: 一级】\n\n*:droplet: 一句话定性*\n*:sparkles: 亮点*');
  assert.equal(blocks[0].fields[0].text, '*:link: 与 Orb 关联*');
  assert.equal(blocks[1].elements[0].text, '*:memo: 备注*');
  assert.equal(blocks[1].elements[1].text, '## leave plain text alone');
  assert.equal(blocks[2].text.text, '## header plain text');
});

test('markdown buildBlocks path keeps heading conversion behavior', () => {
  const payloads = buildSendPayloads('## :droplet: 一句话定性\n\nbody');

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].blocks[0].text.text, '*:droplet: 一句话定性*');
  assert.equal(payloads[0].blocks[1].text.text, 'body');
});

test('daily notes and git diff summaries do not render context blocks', () => {
  const payloads = buildSendPayloads('done', contextOptions());

  assert.deepEqual(payloads, [{ text: 'done' }]);
});

test('daily notes summary does not render context-only fallback', () => {
  const payloads = buildSendPayloads('', { dailyNotesSummary: { count: 1 } });

  assert.deepEqual(payloads, [{ text: '(无回复)' }]);
});

function contextOptions() {
  return {
    gitDiffSummary: {
      hasChanges: true,
      totals: { filesChanged: 1, insertions: 2, deletions: 0 },
      files: [{ status: 'M', path: 'src/worker.js', linesAdded: 2, linesDeleted: 0 }],
    },
    dailyNotesSummary: {
      count: 2,
      entries: [
        { mode: 'line', time: '12:46', layer: '配置层', snippet: 'daemon 重启 + 验真 落地' },
        { mode: 'narrative', time: '13:10', snippet: 'daily-notes 回执时序修复 A+B 上线' },
      ],
    },
  };
}
