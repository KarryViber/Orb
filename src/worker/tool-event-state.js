const TASK_CARD_TOOLS = new Set([
  'TodoWrite', 'Task', 'Agent', 'Skill',
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'NotebookEdit',
]);

function truncateText(text, maxChars) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function truncate256(text) {
  const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= 256) return normalized;
  return `${normalized.slice(0, 255)}…`;
}

export function shouldEmitTaskCardForTool(toolName, input, toolUseId = null) {
  const isTodoWriteSnapshot = toolName === 'TodoWrite' && Array.isArray(input?.todos);
  return isTodoWriteSnapshot
    ? TASK_CARD_TOOLS.has(toolName)
    : TASK_CARD_TOOLS.has(toolName) && Boolean(toolUseId);
}

function tokenizeShellCommand(command) {
  return String(command || '')
    .match(/'[^']*'|"[^"]*"|\S+/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

export function parseToolInput(toolInput) {
  if (toolInput && typeof toolInput === 'object') return toolInput;
  if (typeof toolInput !== 'string') return null;
  const trimmed = toolInput.trim();
  if (!trimmed) return null;
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function stringifyToolValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizePrimitiveParams(input, limit = 4) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}: [${value.slice(0, 3).map((item) => String(item)).join(', ')}${value.length > 3 ? ', ...' : ''}]`);
    }
    if (parts.length >= limit) break;
  }
  return parts.join('\n');
}

function firstNonFlagToken(command) {
  const tokens = tokenizeShellCommand(command);
  return tokens.find((token) => token && token !== '--' && !token.startsWith('-')) || tokens[0] || 'sh';
}

function summarizeWriteDetails(parsedInput) {
  const filePath = parsedInput?.file_path ? `path: ${parsedInput.file_path}` : '';
  const content = parsedInput?.content != null
    ? `content: ${truncateText(stringifyToolValue(parsedInput.content), 120)}`
    : '';
  return [filePath, content].filter(Boolean).join('\n');
}

function summarizeEditDetails(parsedInput) {
  const filePath = parsedInput?.file_path ? `path: ${parsedInput.file_path}` : '';
  const oldString = parsedInput?.old_string != null
    ? `old: ${truncateText(stringifyToolValue(parsedInput.old_string), 80)}`
    : '';
  const newString = parsedInput?.new_string != null
    ? `new: ${truncateText(stringifyToolValue(parsedInput.new_string), 80)}`
    : '';
  return [filePath, oldString, newString].filter(Boolean).join('\n');
}

function summarizeTodos(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return 'No todos';
  return todos.map((todo) => {
    const icon = todo.status === 'completed' ? 'complete' : todo.status === 'in_progress' ? 'in progress' : 'pending';
    return `- [${icon}] ${todo.content || '(untitled)'}`;
  }).join('\n');
}

export function buildToolTitle(toolName, input) {
  const parsedInput = parseToolInput(input);
  const title = (value) => truncate256(value);
  const basename = (filePath) => {
    const rawPath = filePath || 'unknown';
    return String(rawPath).split('/').filter(Boolean).pop() || String(rawPath);
  };

  if (toolName === 'TodoWrite') return title('Plan update');
  if (toolName === 'Bash') {
    const description = parsedInput?.description;
    if (description && typeof description === 'string' && description.trim()) {
      return title(`Bash: ${description.trim()}`);
    }
    const command = parsedInput?.command ?? parsedInput?.cmd ?? input;
    return title(`Bash: ${firstNonFlagToken(command)}`);
  }
  if (toolName === 'Read') return title(`Read: ${basename(parsedInput?.file_path)}`);
  if (toolName === 'Edit') return title(`Edit: ${basename(parsedInput?.file_path)}`);
  if (toolName === 'Write') return title(`Write: ${basename(parsedInput?.file_path)}`);
  if (toolName === 'Grep') return title(`Grep: ${parsedInput?.pattern || 'unknown'}`);
  if (toolName === 'Glob') return title(`Glob: ${parsedInput?.pattern || 'unknown'}`);
  if (toolName === 'WebSearch') return title(`WebSearch: ${parsedInput?.query || 'unknown'}`);
  if (toolName === 'NotebookEdit') return title(`NotebookEdit: ${basename(parsedInput?.notebook_path)}`);
  if (toolName === 'Skill') {
    const description = parsedInput?.description || parsedInput?.skill_description;
    const skillName = parsedInput?.skill_name || parsedInput?.name || parsedInput?.skill || 'unknown';
    return title(`Skill: ${description || skillName}`);
  }
  if (toolName === 'Task' || toolName === 'Agent') {
    const desc = parsedInput?.description || parsedInput?.subagent_type || 'sub-agent';
    return title(`Agent: ${desc}`);
  }
  if (toolName === 'WebFetch') {
    const url = parsedInput?.url || '';
    try {
      return title(`WebFetch: ${new URL(url).hostname || url}`);
    } catch {
      return title(`WebFetch: ${truncateText(url, 80) || 'unknown'}`);
    }
  }

  const summary = summarizePrimitiveParams(parsedInput);
  return title(summary ? `${toolName}: ${summary}` : `${toolName || 'unknown'}:`);
}

export function createToolEventState() {
  let totalToolCount = 0;
  let turnToolCount = 0;
  let lastTool = null;
  let totalToolInputs = [];
  let turnToolInputs = [];
  let todoSnapshot = [];
  const pendingTools = new Map();
  const completedTools = new Map();

  return {
    resetTurn() {
      turnToolCount = 0;
      turnToolInputs = [];
      todoSnapshot = [];
      pendingTools.clear();
      completedTools.clear();
    },
    recordToolUse(block = {}) {
      totalToolCount += 1;
      turnToolCount += 1;
      totalToolInputs.push(block.input || {});
      turnToolInputs.push(block.input || {});
      lastTool = block.name || null;
      if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
        todoSnapshot = block.input.todos.map((todo) => ({ ...todo }));
      }
      if (block.id) {
        pendingTools.set(block.id, {
          id: block.id,
          name: block.name || null,
          input: block.input || {},
        });
      }
    },
    recordToolResult(block = {}) {
      if (!block.tool_use_id) return;
      const pending = pendingTools.get(block.tool_use_id) || null;
      pendingTools.delete(block.tool_use_id);
      completedTools.set(block.tool_use_id, {
        ...pending,
        result: block,
        isError: block.is_error === true,
      });
    },
    snapshotForCcEvent() {
      return {
        totalToolCount,
        turnToolCount,
        lastTool,
        totalToolInputs: [...totalToolInputs],
        turnToolInputs: [...turnToolInputs],
        todos: todoSnapshot.map((todo) => ({ ...todo })),
        pendingTools: [...pendingTools.values()],
        completedTools: [...completedTools.values()],
      };
    },
  };
}
