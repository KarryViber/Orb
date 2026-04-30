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

function truncateText(text, max = 256) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

function truncateTaskField(text) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= 256) return normalized;
  return `${normalized.slice(0, 255)}...`;
}

function mapTodoStatus(status) {
  if (status === 'completed') return 'complete';
  if (status === 'in_progress') return 'in_progress';
  return 'pending';
}

export function categorizeTool(toolName) {
  if (/^(Bash|Read|Edit|Write|Grep|Glob|NotebookEdit|WebFetch|WebSearch)$/.test(toolName)) return 'Probe';
  if (/^(Task|Agent|Skill|mcp__)/.test(toolName)) return 'Delegate';
  if (toolName === 'summary') return 'Distill';
  return null;
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
  return truncateText(summary ? `${name}: ${summary}` : name);
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

export function buildPlanSnapshotRows(todos) {
  if (!Array.isArray(todos)) return [];
  return todos.map((todo, index) => ({
    task_id: `todowrite-todo-${index}`,
    title: truncateTaskField(todo?.content || `Todo ${index + 1}`),
    status: mapTodoStatus(todo?.status),
  }));
}

export function buildPlanSnapshotTitle(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const total = list.length;
  const completed = list.filter((todo) => todo?.status === 'completed').length;
  const activeTodo = list.find((todo) => todo?.status === 'in_progress');

  if (activeTodo) {
    return `进度 ${completed}/${total}｜${truncateText(activeTodo.content || '进行中', 40)}`;
  }
  if (total > 0 && completed === total) {
    return `进度 ${total}/${total}｜完成`;
  }
  return `进度 ${completed}/${total}`;
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
