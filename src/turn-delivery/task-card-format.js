export function truncateText(text, max = 256) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3))}...`;
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

export function buildPlanSnapshotRows(todos) {
  if (!Array.isArray(todos)) return [];
  return todos.map((todo, index) => ({
    task_id: `todowrite-todo-${index}`,
    title: truncateTaskField(todo?.content || `Todo ${index + 1}`),
    status: mapTodoStatus(todo?.status),
  }));
}

export function planSnapshotLineForRow(row) {
  const title = String(row?.title || '').trim();
  if (!title) return '';
  if (row.status === 'complete') return `✓ ${title}`;
  if (row.status === 'in_progress') return `🔵 ${title} ← 中断点`;
  if (row.status === 'error') return `✗ ${title}`;
  return `○ ${title}`;
}

export function buildInterruptedPlanSnapshotText({
  attemptId = '',
  stopReason = '',
  rows = [],
} = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const reason = String(stopReason || 'unknown').trim() || 'unknown';
  const turn = String(attemptId || '').trim() || 'unknown';
  const planText = normalizedRows
    .map(planSnapshotLineForRow)
    .filter(Boolean)
    .join('\n') || '○ 暂无 TodoWrite plan snapshot';

  return [
    `🛑 *任务中断快照* — turn ${turn} · stopReason=${reason}`,
    '',
    '【当前 plan 状态】（最后已知）',
    planText,
    '',
    '发「继续」让新 worker 从此处续做。',
  ].join('\n');
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

export function categorizeTool(toolName) {
  if (/^(Bash|Read|Edit|Write|Grep|Glob|NotebookEdit|WebFetch|WebSearch|LSP)$/.test(toolName)) return 'Probe';
  if (/^(Task|Agent|Skill|mcp__)/.test(toolName)) return 'Delegate';
  if (toolName === 'summary') return 'Distill';
  return null;
}
