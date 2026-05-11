import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHandlerLog,
  resolveHandlerScript,
  runBlockActionScript,
} from '../../../src/adapters/slack-block-action-script.js';
import {
  buildBlockActionContext,
  resolveHandlerActionId as resolveBlockActionHandlerActionId,
} from '../../../src/adapters/slack-block-actions.js';

function tempProfile() {
  const root = mkdtempSync(join(tmpdir(), 'orb-block-action-'));
  const scriptsDir = join(root, 'scripts');
  const handlersDir = join(scriptsDir, 'handlers');
  const logDir = join(root, 'logs');
  mkdirSync(handlersDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  return { root, scriptsDir, handlersDir, logDir, pidLog: join(logDir, 'pids.log') };
}

function context(actionId = 'do_thing') {
  return {
    action_id: actionId,
    value: null,
    user_id: 'U1',
    channel: 'C1',
    message_ts: '123.456',
    thread_ts: '123.456',
  };
}

test('resolveHandlerScript returns null when handler does not exist', () => {
  const profile = tempProfile();
  assert.equal(resolveHandlerScript({ scriptsDir: profile.scriptsDir }, 'missing'), null);
});

test('AskUserQuestion dynamic action ids route to stable handler scripts', () => {
  assert.equal(resolveBlockActionHandlerActionId('orb_auq_pick_0_1'), 'orb_auq_pick');
  assert.equal(resolveBlockActionHandlerActionId('orb_auq_pick_0_other'), 'orb_auq_other_open');
  assert.equal(resolveBlockActionHandlerActionId('orb_auq_select_2'), 'orb_auq_stash');
  assert.equal(resolveBlockActionHandlerActionId('orb_auq_select_2', {
    selected_option: {
      text: { type: 'plain_text', text: 'Other...' },
      value: JSON.stringify({ requestId: 'req-1', qIdx: 2, optIdx: 'other' }),
    },
  }), 'orb_auq_other_open');
  assert.equal(resolveBlockActionHandlerActionId('orb_auq_submit'), 'orb_auq_submit');
  assert.equal(resolveBlockActionHandlerActionId('regular_action'), 'regular_action');
});

test('AskUserQuestion block action context resolves prompt data from message blocks', () => {
  const previousSocket = process.env.ORB_SCHEDULER_SOCKET;
  process.env.ORB_SCHEDULER_SOCKET = '/tmp/orb-scheduler.sock';
  try {
    const originalBlocks = [{
      type: 'section',
      block_id: 'orb_auq_req-1_question_0',
      text: { type: 'mrkdwn', text: '*Format choice*\nWhich format should the answer use?' },
      fields: [{ type: 'plain_text', text: 'Format choice' }],
    }];
    const ctx = buildBlockActionContext({
      body: {
        user: { id: 'U1' },
        response_url: 'https://slack.test/response',
      },
      action: {
        block_id: 'orb_auq_req-1_actions_0',
        action_id: 'orb_auq_pick_0_1',
        value: JSON.stringify({ requestId: 'req-1', qIdx: 0, optIdx: 1 }),
        text: { type: 'plain_text', text: 'Table' },
      },
      rawActionId: 'orb_auq_pick_0_1',
      userId: 'U1',
      channel: 'C1',
      messageTs: '123.456',
      threadTs: '123.456',
      profilePaths: { name: 'karry' },
      originalBlocks,
    });

    assert.equal(ctx.requestId, 'req-1');
    assert.equal(ctx.question_idx, 0);
    assert.equal(ctx.option_idx, 1);
    assert.equal(ctx.option_label, 'Table');
    assert.equal(ctx.question, 'Which format should the answer use?');
    assert.equal(ctx.header, 'Format choice');
    assert.equal(ctx.socket_path, '/tmp/orb-scheduler.sock');
  } finally {
    if (previousSocket === undefined) delete process.env.ORB_SCHEDULER_SOCKET;
    else process.env.ORB_SCHEDULER_SOCKET = previousSocket;
  }
});

test('runBlockActionScript resolves normal exits and captures stdout', async () => {
  const profile = tempProfile();
  const handlerPath = join(profile.handlersDir, 'ok.js');
  writeFileSync(handlerPath, "process.stdin.resume(); process.stdin.on('end', () => console.log('done'));\n");
  const logPath = createHandlerLog({
    logDir: profile.logDir,
    actionId: 'ok',
    messageTs: '123.456',
    profileName: 'karry',
    userId: 'U1',
    context: context('ok'),
  });

  const { completion } = runBlockActionScript({
    handlerPath,
    profilePaths: { scriptsDir: profile.scriptsDir },
    context: context('ok'),
    timeoutMs: 1000,
    logPath,
    pidLog: profile.pidLog,
    profileName: 'karry',
    actionId: 'ok',
    messageTs: '123.456',
  });
  const result = await completion;

  assert.equal(result.code, 0);
  assert.match(result.stdout, /done/);
  assert.match(readFileSync(logPath, 'utf8'), /done/);
});

test('runBlockActionScript reports non-zero exit and captures stderr', async () => {
  const profile = tempProfile();
  const handlerPath = join(profile.handlersDir, 'fail.js');
  writeFileSync(handlerPath, "console.error('bad exit'); process.exit(7);\n");

  const { completion } = runBlockActionScript({
    handlerPath,
    profilePaths: { scriptsDir: profile.scriptsDir },
    context: context('fail'),
    timeoutMs: 1000,
    pidLog: profile.pidLog,
  });
  const result = await completion;

  assert.equal(result.code, 7);
  assert.match(result.stderr, /bad exit/);
});

test('runBlockActionScript marks timed out handlers', async () => {
  const profile = tempProfile();
  const handlerPath = join(profile.handlersDir, 'slow.js');
  writeFileSync(handlerPath, "setInterval(() => {}, 1000);\n");

  const { completion } = runBlockActionScript({
    handlerPath,
    profilePaths: { scriptsDir: profile.scriptsDir },
    context: context('slow'),
    timeoutMs: 30,
    pidLog: profile.pidLog,
  });
  const result = await completion;

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
});
