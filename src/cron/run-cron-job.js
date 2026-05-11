import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dispatchCronDelivery, parseCronOutput, postFailDM } from '../cron-delivery.js';
import { classifyStopReason, isSuccessfulStopReason } from '../stop-reason.js';
import { error as logError, info, warn } from '../log.js';
import { ORB_WORKER_TIMEOUT_MS } from '../runtime-env.js';
import { writeHeartbeatReceipt } from './heartbeat-receipt.js';

const TAG = 'cron';

export function truncateErrorContext(value, limit = 500) {
  return String(value || '').replace(/\s+$/g, '').slice(0, limit);
}

export function failureReasonFromResult(responseText, stopReason, errorSummary = '') {
  const text = String(responseText || '').trim();
  if (text.toLowerCase().startsWith('failed:')) return text.slice('failed:'.length).trim() || 'failed';
  if (!isSuccessfulStopReason(stopReason)) {
    const summary = truncateErrorContext(errorSummary, 160);
    return summary ? `${stopReason}: ${summary}` : `stopReason=${stopReason}`;
  }
  return null;
}

function receiptStatusForSuccess(parsedOutput) {
  if (!parsedOutput || parsedOutput.status === 'silent' || parsedOutput.status === 'skip') return 'silent';
  return 'ok';
}

function writeCronReceipt({ paths, job, status, error, deliveryMode, startedAt }) {
  writeHeartbeatReceipt({
    profilePath: paths?.profilePath,
    dataDir: paths?.dataDir,
    job,
    status,
    error,
    deliveryMode,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

async function runScriptJob({ job, paths }) {
  const command = String(job?.command || '').trim();
  if (!command) {
    const err = new Error(`cron ${job?.id || 'unknown'} runMode=script missing command`);
    err.code = 'ORB_CRON_SCRIPT_COMMAND_MISSING';
    throw err;
  }

  info(TAG, `script job ${job.id} spawned: command=${command}`);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let sigkillTimer = null;
    const startedAt = Date.now();
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: paths.workspaceDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stderr += `\nscript timed out after ${ORB_WORKER_TIMEOUT_MS}ms`;
      try { child.kill('SIGTERM'); } catch {}
      sigkillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 5_000);
    }, ORB_WORKER_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      const exitCode = Number.isInteger(code) ? code : -1;
      const ok = exitCode === 0 && !timedOut;
      const elapsedMs = Date.now() - startedAt;
      info(TAG, `script job ${job.id} exited: code=${exitCode} signal=${signal || 'none'} elapsedMs=${elapsedMs}`);
      resolve({
        text: stdout,
        stopReason: ok ? 'end_turn' : 'cli_error',
        errorSummary: ok ? null : truncateErrorContext(stderr || `exitCode=${exitCode} signal=${signal || 'none'}`),
        exitCode,
        signal: signal || null,
        timedOut,
      });
    });
  });
}

export async function runCronJob({
  job,
  scheduler,
  paths,
  now,
  delivery,
  deliveryMode,
  deliveryAdapter = null,
  origin,
  recordFailureLesson = () => {},
}) {
  const runMode = job.runMode === 'script' ? 'script' : 'agent';
  if (runMode === 'agent' && typeof scheduler?.executeTask !== 'function') {
    throw new Error('scheduler executeTask unavailable for cron job');
  }

  const startedAt = now.toISOString();
  const jobRunId = `${job.id}:${now.getTime()}:${randomUUID()}`;
  let parsedOutput = null;
  let deliveryError = null;
  const result = runMode === 'script'
    ? await runScriptJob({ job, paths })
    : await scheduler.executeTask({
      userText: job.prompt,
      fileContent: '',
      imagePaths: [],
      threadTs: `cron:${job.profileName}:${job.id}`,
      deliveryThreadTs: delivery.threadTs || null,
      channel: delivery.channel,
      userId: null,
      platform: delivery.platform,
      channelSemantics: 'silent',
      threadHistory: null,
      model: job.model || null,
      effort: job.effort || null,
      maxTurns: job.maxTurns || null,
      enableTaskCard: false,
      forceNewWorker: true,
      jobRunId,
      cronName: job.name || job.id,
      origin,
      profile: {
        name: job.profileName,
        workspaceDir: paths.workspaceDir,
        dataDir: paths.dataDir,
        scriptsDir: paths.scriptsDir,
      },
    });

  const responseText = result?.text || '';
  const stopReason = result?.stopReason || null;
  const stopReasonClass = classifyStopReason(stopReason);
  const failureReason = failureReasonFromResult(responseText, stopReason, result?.errorSummary || '');

  if (!failureReason && stopReasonClass !== 'truncated') {
    try {
      parsedOutput = parseCronOutput({ text: responseText, cronId: job.id });
      await dispatchCronDelivery({
        job,
        paths,
        delivery: deliveryMode,
        output: parsedOutput,
        adapter: deliveryAdapter,
      });
    } catch (err) {
      deliveryError = truncateErrorContext(err.message);
      recordFailureLesson(`delivery: ${deliveryError}`, responseText || stopReason || '', { failureKind: 'delivery' });
      logError(TAG, `job ${job.id} delivery failed: ${err.message}`);
    }
  }

  const outputFailReason = parsedOutput?.status === 'fail'
    ? `cron-output: ${parsedOutput.error || 'fail'}`
    : null;
  const effectiveFailureReason = failureReason || outputFailReason;

  if (effectiveFailureReason && stopReasonClass === 'failed') {
    recordFailureLesson(effectiveFailureReason, responseText || stopReason || '');
    writeCronReceipt({
      paths,
      job,
      status: 'failed',
      error: truncateErrorContext(effectiveFailureReason),
      deliveryMode,
      startedAt,
    });
    return {
      lastRunAt: now.toISOString(),
      lastStatus: 'failed',
      lastError: truncateErrorContext(effectiveFailureReason),
      lastDeliveryError: null,
      applyCompletionRules: true,
    };
  }
  if (stopReasonClass === 'truncated') {
    const error = `${stopReason}: 触达 turn 上限，任务未完成（非失败）`;
    writeCronReceipt({
      paths,
      job,
      status: 'truncated',
      error,
      deliveryMode,
      startedAt,
    });
    return {
      lastRunAt: now.toISOString(),
      lastStatus: 'truncated',
      lastError: error,
      lastDeliveryError: null,
      applyCompletionRules: true,
    };
  }
  if (effectiveFailureReason) {
    recordFailureLesson(effectiveFailureReason, responseText || stopReason || '');
    writeCronReceipt({
      paths,
      job,
      status: 'failed',
      error: truncateErrorContext(effectiveFailureReason),
      deliveryMode,
      startedAt,
    });
    return {
      lastRunAt: now.toISOString(),
      lastStatus: 'failed',
      lastError: truncateErrorContext(effectiveFailureReason),
      lastDeliveryError: null,
      applyCompletionRules: true,
    };
  }
  if (deliveryError) {
    writeCronReceipt({
      paths,
      job,
      status: 'failed',
      error: deliveryError,
      deliveryMode,
      startedAt,
    });
    return {
      lastRunAt: now.toISOString(),
      lastStatus: 'failed',
      lastError: deliveryError,
      lastDeliveryError: deliveryError,
      applyCompletionRules: true,
    };
  }
  writeCronReceipt({
    paths,
    job,
    status: receiptStatusForSuccess(parsedOutput),
    error: null,
    deliveryMode,
    startedAt,
  });
  return {
    lastRunAt: now.toISOString(),
    lastStatus: 'ok',
    lastError: null,
    lastDeliveryError: deliveryError,
    applyCompletionRules: true,
  };
}

export async function runCronJobFailureHandler({ err, job, now, paths, deliveryMode, deliveryAdapter = null, recordFailureLesson }) {
  const startedAt = now.toISOString();
  logError(TAG, `job ${job.id} failed: ${err.message}`);
  recordFailureLesson(err.message || 'worker_error', err.stack || err.message);
  try {
    postFailDM({
      delivery: deliveryMode,
      job,
      error: err,
      adapter: deliveryAdapter,
    }).catch((dmErr) => {
      warn(TAG, `job ${job.id} failure DM failed: ${dmErr.message}`);
    });
  } catch (dmErr) {
    warn(TAG, `job ${job.id} failure DM failed: ${dmErr.message}`);
  }

  writeCronReceipt({
    paths,
    job,
    status: 'failed',
    error: truncateErrorContext(err.message),
    deliveryMode,
    startedAt,
  });
  return {
    lastRunAt: now.toISOString(),
    lastStatus: 'failed',
    lastError: truncateErrorContext(err.message),
    lastDeliveryError: null,
    applyCompletionRules: err?.code !== 'ORB_CRON_NOTIFY_DM_MISSING',
    disableJob: err?.code === 'ORB_CRON_NOTIFY_DM_MISSING',
  };
}
