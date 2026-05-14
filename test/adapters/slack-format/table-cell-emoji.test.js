import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSendPayloads } from '../../../src/adapters/slack-format.js';

function extractTableBlock(payloads) {
  for (const p of payloads) {
    if (!p.blocks) continue;
    for (const b of p.blocks) {
      if (b.type === 'table') return b;
    }
  }
  return null;
}

function extractCellElements(cell) {
  if (cell.type === 'rich_text') return cell.elements[0].elements;
  return null;
}

test('emoji-only cell becomes rich_text with {type:emoji,name}', () => {
  const md = [
    '| 项目 | 状态 |',
    '|------|------|',
    '| :hotel: 酒店 | OK |',
    '',
  ].join('\n');
  const table = extractTableBlock(buildSendPayloads(md));
  assert.ok(table, 'table block not produced');
  const dataRow = table.rows[1];
  const elements = extractCellElements(dataRow[0]);
  assert.ok(elements, ':hotel: cell should be rich_text');
  assert.deepEqual(elements[0], { type: 'emoji', name: 'hotel' });
  assert.equal(elements[1].type, 'text');
  assert.match(elements[1].text, /酒店/);
});

test('mixed markdown bold + emoji renders both in one cell', () => {
  const md = [
    '| 项目 | 状态 |',
    '|------|------|',
    '| :warning: 注意 | **重要** |',
    '',
  ].join('\n');
  const table = extractTableBlock(buildSendPayloads(md));
  assert.ok(table);
  const row = table.rows[1];

  const left = extractCellElements(row[0]);
  assert.ok(left);
  assert.deepEqual(left[0], { type: 'emoji', name: 'warning' });

  const right = extractCellElements(row[1]);
  assert.ok(right, 'bold cell should still be rich_text');
  const bold = right.find((el) => el.style && el.style.bold);
  assert.ok(bold, 'bold element missing');
  assert.equal(bold.text, '重要');
});

test('plain ascii cell remains raw_text (no regression)', () => {
  const md = [
    '| A | B |',
    '|---|---|',
    '| plain | OK |',
    '',
  ].join('\n');
  const table = extractTableBlock(buildSendPayloads(md));
  assert.ok(table);
  assert.equal(table.rows[1][0].type, 'raw_text');
  assert.equal(table.rows[1][0].text, 'plain');
});

test('header cell with emoji renders rich_text emoji element', () => {
  const md = [
    '| :sparkles: 项目 | 状态 |',
    '|------|------|',
    '| row | OK |',
    '',
  ].join('\n');
  const table = extractTableBlock(buildSendPayloads(md));
  assert.ok(table);
  const headerCell = table.rows[0][0];
  assert.equal(headerCell.type, 'rich_text');
  const els = headerCell.elements[0].elements;
  assert.deepEqual(els[0], { type: 'emoji', name: 'sparkles' });
  assert.match(els[1].text, /项目/);
});

test('header cell without emoji stays raw_text and strips bold markers', () => {
  const md = [
    '| **项目** | 状态 |',
    '|------|------|',
    '| row | OK |',
    '',
  ].join('\n');
  const table = extractTableBlock(buildSendPayloads(md));
  assert.ok(table);
  const headerCell = table.rows[0][0];
  assert.equal(headerCell.type, 'raw_text');
  assert.equal(headerCell.text, '项目');
});

test('cell with check_mark and bold cell next to each other', () => {
  const md = [
    '| 项目 | 状态 |',
    '|------|------|',
    '| :white_check_mark: 完成 | OK |',
    '| :warning: 注意 | **重要** |',
    '| :hotel: 酒店 | ¥100k |',
    '',
  ].join('\n');
  const table = extractTableBlock(buildSendPayloads(md));
  assert.ok(table);
  const names = table.rows.slice(1).map((row) => {
    const els = extractCellElements(row[0]);
    return els && els[0].type === 'emoji' ? els[0].name : null;
  });
  assert.deepEqual(names, ['white_check_mark', 'warning', 'hotel']);
});
