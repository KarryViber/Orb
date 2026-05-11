import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function todayJST() {
  const d = new Date(Date.now() + 9 * 3600_000);
  return d.toISOString().slice(0, 10);
}

function profilePathFrom({ profilePath, dataDir }) {
  return profilePath || dirname(dataDir);
}

export function writeHeartbeatReceipt({ profilePath, dataDir, job, status, error, deliveryMode, startedAt, finishedAt }) {
  const dir = join(profilePathFrom({ profilePath, dataDir }), 'data', 'cron-receipts', todayJST());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${job.id}.json`);
  const payload = {
    cron_id: job.id,
    cron_name: job.name || null,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    delivery_mode: deliveryMode?.mode || null,
    error: error || null,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
}
