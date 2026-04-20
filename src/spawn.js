/**
 * Shared worker fork utility.
 * Used by scheduler (interactive tasks) and cron (scheduled tasks).
 */
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { info, error as logError } from './log.js';
import { sanitizeErrorText } from './format-utils.js';

const TAG = 'spawn';
const WORKER_PATH = join(import.meta.dirname, 'worker.js');

/**
 * Fork a worker process and wire up stdout/stderr logging.
 * Returns { worker, kill } where kill() cleans up the timeout.
 *
 * @param {Object} opts
 * @param {Object} opts.task        — IPC task payload to send
 * @param {number} opts.timeout     — kill timeout in ms (default 600_000)
 * @param {string} opts.label       — log label (e.g. 'cron:jobName' or 'task:threadTs')
 * @param {function} opts.onMessage — handler for worker IPC messages
 * @param {function} opts.onExit    — handler for worker exit(code, signal)
 */
export function spawnWorker({ task, timeout = 600_000, label, onMessage, onExit }) {
  const worker = fork(WORKER_PATH, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ORB_WORKER: '1', ENABLE_PROMPT_CACHING_1H: '1' },
  });

  // stdout/stderr → log (sanitize to avoid leaking tokens)
  worker.stdout?.on('data', (d) => info(TAG, `[${label}] ${sanitizeErrorText(d.toString().trimEnd())}`));
  worker.stderr?.on('data', (d) => logError(TAG, `[${label}] ${sanitizeErrorText(d.toString().trimEnd())}`));

  // kill timeout
  const timer = setTimeout(() => {
    logError(TAG, `[${label}] timeout after ${timeout}ms, killing`);
    worker.kill('SIGTERM');
    const killTimer = setTimeout(() => { try { worker.kill('SIGKILL'); } catch {} }, 5_000);
    killTimer.unref(); // #23: don't block process exit
  }, timeout);

  worker.on('message', (msg) => onMessage(msg));

  worker.on('exit', (code, signal) => {
    clearTimeout(timer);
    onExit(code, signal);
  });

  // Send task — kill worker if IPC send fails (#16)
  worker.send(task, (err) => {
    if (err) {
      logError(TAG, `[${label}] failed to send task: ${err.message}`);
      clearTimeout(timer);
      worker.kill('SIGTERM');
    }
  });

  return {
    worker,
    kill: () => { clearTimeout(timer); worker.kill('SIGTERM'); },
  };
}
