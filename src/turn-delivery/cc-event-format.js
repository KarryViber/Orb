import {
  buildPlanSnapshotRows,
  buildPlanSnapshotTitle,
  categorizeTool,
  truncateText,
} from './task-card-format.js';

const QI_INITIAL_CHUNKS = [
  { type: 'plan_update', title: 'Orbiting...' },
  { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress', details: '' },
  { type: 'task_update', id: 'qi-other', title: 'Delegate', status: 'in_progress', details: '' },
  { type: 'task_update', id: 'qi-summary', title: 'Distill', status: 'in_progress', details: '' },
];

const QI_TASK_IDS = {
  Probe: 'qi-exec',
  Delegate: 'qi-other',
  Distill: 'qi-summary',
};

export function buildInterruptedTitle(stopReason) {
  const reason = String(stopReason || 'unknown').trim() || 'unknown';
  return `⚠️ 已中断（${reason}）· 发「继续」续接`;
}

export function summarizeQiInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const keys = ['description', 'command', 'query', 'pattern', 'file_path', 'url', 'skill_name', 'subagent_type'];
  for (const key of keys) {
    if (input[key] != null && String(input[key]).trim()) return String(input[key]);
  }
  const first = Object.entries(input).find(([, value]) => (
    value != null && ['string', 'number', 'boolean'].includes(typeof value)
  ));
  return first ? `${first[0]}: ${first[1]}` : '';
}

export function buildQiToolLine(payload) {
  const name = payload?.name || 'Tool';
  const summary = summarizeQiInput(payload?.input);
  // 254 = 256 - 2 (\n wrapper in buildQiToolChunks).
  return truncateText(summary ? `${name}: ${summary}` : name, 254);
}

export function buildStatusText(payload) {
  return truncateText(buildQiToolLine(payload), 80);
}

export function formatElapsedTime(startedAt, now = Date.now()) {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ${elapsedSeconds % 60}s`;
  return `${Math.floor(elapsedMinutes / 60)}h ${elapsedMinutes % 60}m`;
}

export function chunksText(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => {
      if (!chunk || typeof chunk !== 'object') return '';
      return [chunk.text, chunk.markdown_text, chunk.details, chunk.output, chunk.title]
        .filter((value) => typeof value === 'string' && value)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

export function qiInitialChunks() {
  return QI_INITIAL_CHUNKS.map((chunk) => ({ ...chunk }));
}

export function buildQiToolChunks(payload, state) {
  const category = categorizeTool(payload?.name);
  const taskId = QI_TASK_IDS[category];
  if (!taskId) return [];
  state.toolCount += 1;
  return [
    { type: 'task_update', id: taskId, title: category, details: `\n${buildQiToolLine(payload)}\n` },
  ];
}

export function buildQiSettledChunks(toolCount = 0, reason = '') {
  const count = Number.isFinite(Number(toolCount)) ? Number(toolCount) : 0;
  const details = reason ? `Settled: ${reason}` : `Distilled from ${count} probes`;
  return [
    { type: 'plan_update', title: 'Settled' },
    { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'complete' },
    { type: 'task_update', id: 'qi-other', title: 'Delegate', status: 'complete' },
    { type: 'task_update', id: 'qi-summary', title: 'Distill', status: 'complete', details },
  ];
}

export function buildQiInterruptedChunks(toolCount = 0, stopReason = '') {
  const count = Number.isFinite(Number(toolCount)) ? Number(toolCount) : 0;
  const reason = String(stopReason || 'unknown').trim() || 'unknown';
  return [
    { type: 'plan_update', title: buildInterruptedTitle(reason) },
    { type: 'task_update', id: 'qi-summary', title: 'Distill', status: 'error', details: `Interrupted after ${count} probes: ${reason}` },
  ];
}

export function buildPlanInterruptedChunks(stopReason = '') {
  return [{ type: 'plan_update', title: buildInterruptedTitle(stopReason) }];
}

export function buildPlanSnapshotChunks(todos) {
  const rows = buildPlanSnapshotRows(todos);
  if (rows.length === 0) return [];
  return [
    { type: 'plan_update', title: buildPlanSnapshotTitle(todos) },
    ...rows.map((row) => ({
      type: 'task_update',
      id: row.task_id,
      title: row.title,
      status: row.status,
    })),
  ];
}

export { buildPlanSnapshotRows, buildPlanSnapshotTitle, categorizeTool };
