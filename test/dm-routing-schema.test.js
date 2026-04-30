import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateDmRoutingConfig,
  validateDmRoutingRules,
} from '../src/dm-routing-schema.js';

const config = JSON.parse(readFileSync(join(process.cwd(), 'config.json'), 'utf8'));

function validRule(overrides = {}) {
  return {
    name: 'github-research',
    match: { urlPattern: 'https?://github\\.com/[^\\s]+' },
    target: {
      channel: 'CXXXXXXXXXX',
      mainTemplate: 'GitHub {repo_slug}',
      workerPrompt: 'worker {url_matched}',
    },
    ...overrides,
  };
}

test('current config dmRouting rules validate', () => {
  assert.deepEqual(validateDmRoutingConfig(config), []);
});

test('dmRouting rule requires exactly one urlPattern or filenamePattern', () => {
  assert.match(
    validateDmRoutingRules([validRule({ match: {} })]).join('\n'),
    /exactly one of urlPattern or filenamePattern/,
  );
  assert.match(
    validateDmRoutingRules([validRule({
      match: {
        urlPattern: 'https://example\\.com',
        hasFile: true,
        filenamePattern: 'invoice',
      },
    })]).join('\n'),
    /exactly one of urlPattern or filenamePattern/,
  );
});

test('dmRouting rule validates regex length and file match shape', () => {
  assert.match(
    validateDmRoutingRules([validRule({
      match: { urlPattern: 'x'.repeat(201) },
    })]).join('\n'),
    /at most 200 characters/,
  );
  assert.match(
    validateDmRoutingRules([validRule({
      match: { filenamePattern: 'invoice' },
    })]).join('\n'),
    /hasFile: must be true/,
  );
});

test('dmRouting rule validates target channel and required templates', () => {
  const errors = validateDmRoutingRules([validRule({
    target: {
      channel: 'not-a-channel',
      mainTemplate: '',
      workerPrompt: '',
    },
  })]).join('\n');

  assert.match(errors, /target.channel: must be a Slack channel id/);
  assert.match(errors, /target.mainTemplate: must be a non-empty string/);
  assert.match(errors, /target.workerPrompt: must be a non-empty string/);
});

test('dmRouting schema rejects unknown fields that would expand prompt surface', () => {
  const errors = validateDmRoutingRules([validRule({
    extraRuleField: true,
    match: { urlPattern: 'https://example\\.com', promptFragment: '{raw}' },
    target: {
      channel: 'CXXXXXXXXXX',
      mainTemplate: 'main',
      workerPrompt: 'worker',
      extraPrompt: '{raw}',
    },
  })]).join('\n');

  assert.match(errors, /extraRuleField: unknown field/);
  assert.match(errors, /match.promptFragment: unknown field/);
  assert.match(errors, /target.extraPrompt: unknown field/);
});
