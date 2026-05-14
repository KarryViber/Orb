/**
 * Runtime cron delivery contract.
 *
 * lineage: specs/cron-delivery-contract-2026-05-03.md
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const VALID_MODES = new Set(['direct', 'evolution_state', 'dm_only', 'silent']);
const VALID_STATUSES = new Set(['ok', 'fail', 'failed', 'skip', 'silent']);

function hasCronDeliveryOverride(adapter) {
  return typeof adapter?.deliverCronOutput === 'function';
}

export function resolveDeliveryMode(job, fallbackDm = null) {
  const deliver = job?.deliver || {};
  const mode = deliver.mode || 'silent';
  if (!VALID_MODES.has(mode)) {
    throw new Error(`invalid deliver.mode for cron ${job?.id || 'unknown'}: ${mode}`);
  }
  return {
    mode,
    platform: deliver.platform || 'slack',
    channel: deliver.channel || fallbackDm,
    threadTs: deliver.threadTs || null,
    format: deliver.format || null,
    category: deliver.category || null,
    onFailDM: deliver.onFailDM || fallbackDm,
  };
}

export function parseCronOutput({ text, cronId, tmpDir = '/tmp' }) {
  const rawText = typeof text === 'string' ? text : '';
  const lastLine = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || '';
  if (lastLine.startsWith('{')) {
    return normalizePayload(parseJson(lastLine, 'turn_complete.text'), 'turn_complete.text');
  }

  const outputPath = join(tmpDir, `cron-output-${cronId}.json`);
  if (existsSync(outputPath)) {
    const fileText = readFileSync(outputPath, 'utf-8');
    return normalizePayload(parseJson(fileText, outputPath), outputPath);
  }

  return { protocol: 'silent', status: 'skip' };
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error(`cron delivery protocol parse failed (${source}): ${err.message}`);
    e.code = 'ORB_CRON_DELIVERY_PARSE_FAILED';
    throw e;
  }
}

function normalizePayload(payload, protocol) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`cron delivery protocol must be a JSON object (${protocol})`);
  }
  const status = String(payload.status || 'ok').toLowerCase();
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`cron delivery protocol invalid status (${protocol}): ${status}`);
  }
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : null;
  validateBlockShapes(blocks, protocol);
  return {
    protocol,
    status: status === 'failed' ? 'fail' : status,
    main: stringOrNull(payload.main ?? payload.title ?? payload.text),
    blocks,
    thread_md: stringOrNull(payload.thread_md ?? payload.markdown ?? payload.thread),
    error: stringOrNull(payload.error ?? payload.reason),
  };
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function validateBlockShapes(blocks, protocol) {
  if (!blocks) return;
  blocks.forEach((item, index) => {
    if (isNativeBlock(item) || isAttachmentShapeBlock(item)) return;
    const keys = item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item).slice(0, 5).join(',') || '(none)'
      : typeof item;
    throw new Error(
      `cron delivery protocol invalid blocks shape (${protocol}): item[${index}] missing 'type' and not attachment-shape; keys=${keys}`,
    );
  });
}

function isNativeBlock(item) {
  return item && typeof item === 'object' && !Array.isArray(item) && typeof item.type === 'string';
}

function isAttachmentShapeBlock(item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    && ('header' in item || 'body' in item || 'color' in item);
}

export function renderCronBlocks(rawBlocks) {
  if (!Array.isArray(rawBlocks)) return { blocks: null, attachments: null };
  const blocks = [];
  const attachments = [];
  let renderedNoColorAttachmentShape = false;
  for (const item of rawBlocks) {
    if (isNativeBlock(item)) {
      blocks.push(item);
      continue;
    }
    if (!isAttachmentShapeBlock(item)) continue;
    const itemBlocks = [];
    if (stringOrNull(item.header)) {
      itemBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${item.header.trim().replace(/^#+\s*/, '')}*` },
      });
    }
    if (stringOrNull(item.body)) {
      itemBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: item.body },
      });
    }
    if (stringOrNull(item.color)) {
      const attachment = { color: item.color };
      if (itemBlocks.length) attachment.blocks = itemBlocks;
      attachments.push(attachment);
      continue;
    }
    if (!itemBlocks.length) continue;
    if (renderedNoColorAttachmentShape) blocks.push({ type: 'divider' });
    blocks.push(...itemBlocks);
    renderedNoColorAttachmentShape = true;
  }
  return {
    blocks: blocks.length ? blocks : null,
    attachments: attachments.length ? attachments : null,
  };
}

export async function dispatchCronDelivery({ job, paths, delivery, output, adapter = null, dryRun = false }) {
  if (delivery.mode === 'silent') {
    return { delivered: false, skipped: true, reason: 'silent-mode' };
  }

  try {
    if (output?.status === 'fail') {
      throw new Error(output.error || output.main || 'cron output status=fail');
    }
    if (output?.status === 'skip' || output?.status === 'silent') {
      if (delivery.mode !== 'evolution_state') {
        return { delivered: false, skipped: true, reason: `output-${output.status}` };
      }
    }

    if (delivery.mode === 'direct') return postDirect({ delivery, output, adapter, dryRun });
    if (delivery.mode === 'dm_only') return postDmOnly({ delivery, output, adapter, dryRun });
    if (delivery.mode === 'evolution_state') return postEvolutionState({ job, paths, delivery, output, dryRun });
    throw new Error(`unsupported delivery mode: ${delivery.mode}`);
  } catch (err) {
    await postFailDM({ delivery, job, error: err, adapter, dryRun });
    throw err;
  }
}

async function postDirect({ delivery, output, adapter, dryRun }) {
  const text = output?.main || '[cron delivery]';
  const rendered = renderCronBlocks(output?.blocks);
  const threadMd = output?.thread_md || null;
  if (dryRun) {
    return {
      delivered: true,
      mode: 'direct',
      channel: delivery.channel,
      text,
      blocks: Boolean(rendered.blocks),
      attachments: Boolean(rendered.attachments),
      threadMd: Boolean(threadMd),
    };
  }
  if (hasCronDeliveryOverride(adapter)) {
    const resp = await adapter.deliverCronOutput({
      channel: delivery.channel,
      threadTs: delivery.threadTs,
      output,
      deliveryConfig: delivery,
    });
    return {
      delivered: true,
      mode: 'direct',
      channel: delivery.channel,
      ts: resp?.ts || null,
      deliveredCount: resp?.deliveredCount,
    };
  }
  const main = await postViaAdapter(adapter, delivery.channel, delivery.threadTs || undefined, text);
  const threadTs = delivery.threadTs || main.ts || undefined;
  if (threadMd) {
    await postViaAdapter(adapter, delivery.channel, threadTs, threadMd);
  }
  if (rendered.blocks || rendered.attachments) {
    const extra = {};
    if (rendered.blocks) extra.blocks = rendered.blocks;
    if (rendered.attachments) extra.attachments = rendered.attachments;
    await postViaAdapter(adapter, delivery.channel, threadTs, ' ', extra);
  }
  return { delivered: true, mode: 'direct', channel: delivery.channel, ts: main.ts || null };
}

async function postDmOnly({ delivery, output, adapter, dryRun }) {
  const channel = delivery.onFailDM || delivery.channel;
  const text = output?.main || output?.thread_md || '[cron delivery]';
  const rendered = renderCronBlocks(output?.blocks);
  if (dryRun) {
    return {
      delivered: true,
      mode: 'dm_only',
      channel,
      text,
      blocks: Boolean(rendered.blocks),
      attachments: Boolean(rendered.attachments),
    };
  }
  const extra = {};
  if (rendered.blocks) extra.blocks = rendered.blocks;
  if (rendered.attachments) extra.attachments = rendered.attachments;
  const resp = await postViaAdapter(adapter, channel, undefined, text, extra);
  return { delivered: true, mode: 'dm_only', channel, ts: resp.ts || null };
}

async function postEvolutionState({ job, paths, delivery, output, dryRun }) {
  const args = [
    join(paths.scriptsDir, 'evolution_state.py'),
    '--cron-id', job.id,
    '--cron-name', job.name || job.id,
    '--title', output?.main || job.name || job.id,
  ];
  if (delivery.category) args.push('--category', delivery.category);
  if (job?.schedule?.display) args.push('--schedule-label', job.schedule.display);
  if (dryRun) {
    if (output?.blocks) return { delivered: true, mode: 'evolution_state', args: args.slice(1), content: 'blocks' };
    if (output?.thread_md) return { delivered: true, mode: 'evolution_state', args: args.slice(1), content: 'markdown' };
    if (output?.main) return { delivered: true, mode: 'evolution_state', args: args.slice(1), content: 'main_fallback' };
    return { delivered: true, mode: 'evolution_state', args: [...args.slice(1), '--silent'], content: 'silent' };
  }

  let tempFile = null;
  let markdownTempFile = null;
  if (output?.blocks) {
    tempFile = join('/tmp', `cron-delivery-${job.id}-${process.pid}-blocks.json`);
    writeFileSync(tempFile, JSON.stringify(output.blocks), 'utf-8');
    args.push('--blocks-file', tempFile);
    if (output?.thread_md) {
      markdownTempFile = join('/tmp', `cron-delivery-${job.id}-${process.pid}.md`);
      writeFileSync(markdownTempFile, output.thread_md, 'utf-8');
      args.push('--markdown-file', markdownTempFile);
    }
  } else if (output?.thread_md) {
    tempFile = join('/tmp', `cron-delivery-${job.id}-${process.pid}.md`);
    writeFileSync(tempFile, output.thread_md, 'utf-8');
    args.push('--markdown-file', tempFile);
  } else if (output?.main) {
    tempFile = join('/tmp', `cron-delivery-${job.id}-${process.pid}.md`);
    writeFileSync(tempFile, output.main, 'utf-8');
    args.push('--markdown-file', tempFile);
  } else {
    args.push('--silent');
  }

  try {
    const { stdout } = await execFileAsync('python3', args, { timeout: 30_000 });
    return { delivered: true, mode: 'evolution_state', path: stdout.trim() || null };
  } finally {
    if (tempFile) {
      try { unlinkSync(tempFile); } catch {}
    }
    if (markdownTempFile) {
      try { unlinkSync(markdownTempFile); } catch {}
    }
  }
}

export async function postFailDM({ delivery, job, error, adapter = null, dryRun = false }) {
  const channel = delivery?.onFailDM;
  if (!channel) return { delivered: false, skipped: true, reason: 'onFailDM-missing' };
  const text = [
    `⚠️ Cron delivery failed: ${job?.name || job?.id || 'unknown'}`,
    `id: ${job?.id || 'unknown'}`,
    `mode: ${delivery?.mode || 'unknown'}`,
    `reason: ${String(error?.message || error).slice(0, 300)}`,
  ].join('\n');
  if (dryRun) return { delivered: true, mode: 'fail_dm', channel, text };
  const resp = await postViaAdapter(adapter, channel, undefined, text);
  return { delivered: true, mode: 'fail_dm', channel, ts: resp.ts || null };
}

async function postViaAdapter(adapter, channel, threadTs, text, extra = {}) {
  if (typeof adapter?.sendReply !== 'function') {
    throw new Error('cron delivery adapter unavailable: sendReply missing');
  }
  const resp = await adapter.sendReply(channel, threadTs, text, extra);
  if (resp?.ok === false) {
    throw new Error(`platform sendReply failed: ${resp.error || 'unknown'}`);
  }
  return resp || {};
}
