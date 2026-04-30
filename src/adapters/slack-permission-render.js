function parsePermissionToolInput(toolInput) {
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

function stringifyPermissionValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeSlackCodeText(text) {
  return String(text || '').replace(/```/g, '` ` `');
}

function truncatePermissionText(value, maxChars) {
  const normalized = sanitizeSlackCodeText(stringifyPermissionValue(value));
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function formatSlackInlineCode(value) {
  return `\`${String(value ?? 'unknown').replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;
}

function formatPermissionPreviewMeta(text, maxChars) {
  const totalChars = String(text || '').length;
  if (!totalChars) return '(共 0 字符)';
  const previewChars = Math.min(totalChars, maxChars);
  if (previewChars >= totalChars) return `(共 ${totalChars} 字符)`;
  return `(前 ${previewChars} 字符 / 共 ${totalChars} 字符)`;
}

function tokenizeShellCommand(command) {
  return String(command || '')
    .match(/'[^']*'|"[^"]*"|\S+/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

function extractShellTargets(tokens) {
  return tokens.slice(1).filter((token) => token && token !== '--' && !token.startsWith('-'));
}

function pickPrimitiveParams(input, limit = 4) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      parts.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}: [${value.slice(0, 3).map((item) => String(item)).join(', ')}${value.length > 3 ? ', ...' : ''}]`);
    }
    if (parts.length >= limit) break;
  }
  return parts.join('\n');
}

function renderBashSemantics(command) {
  const commandText = String(command || '');
  const commandPreview = truncatePermissionText(commandText, 200);
  const tokens = tokenizeShellCommand(commandText);
  const verb = tokens[0]?.toLowerCase();
  const targets = extractShellTargets(tokens);
  const primaryTarget = targets.join(' ') || '未识别目标';
  const method = tokens.find((token, index) => {
    if (index === 0) return false;
    const upper = token.toUpperCase();
    return upper === 'POST' || upper === 'DELETE';
  })?.toUpperCase();

  if (['rm', 'unlink', 'rmdir', 'trash'].includes(verb)) {
    return {
      emoji: '🗑',
      action: '删除',
      targetLabel: '目标',
      targetValue: primaryTarget,
      previewTitle: '命令',
      previewBody: `\`\`\`${commandPreview}\`\`\``,
    };
  }

  if (verb === 'git' && (tokens[1] === 'push' || (tokens[1] === 'reset' && tokens.includes('--hard')))) {
    return {
      emoji: '⚠️',
      action: 'Git 高危操作',
      targetLabel: '命令',
      targetValue: commandPreview,
      previewTitle: '完整命令',
      previewBody: `\`\`\`${commandPreview}\`\`\``,
    };
  }

  if (verb === 'curl' || verb === 'wget') {
    const url = tokens.find((token) => /^https?:\/\//i.test(token)) || '未识别目标';
    return {
      emoji: '🌐',
      action: method ? `网络调用 (${method})` : '网络调用',
      targetLabel: '目标',
      targetValue: url,
      previewTitle: '命令',
      previewBody: `\`\`\`${commandPreview}\`\`\``,
    };
  }

  return {
    emoji: '⚡',
    action: '执行命令',
    targetLabel: '命令',
    targetValue: commandPreview,
    previewTitle: '命令',
    previewBody: `\`\`\`${commandPreview}\`\`\``,
  };
}

export function renderPermissionSemantics(toolName, toolInput) {
  const normalizedToolName = String(toolName || 'unknown');
  const parsedInput = parsePermissionToolInput(toolInput);
  const rawInput = truncatePermissionText(toolInput, 500);

  if (normalizedToolName === 'Write') {
    const content = stringifyPermissionValue(parsedInput?.content ?? '');
    return {
      emoji: '📝',
      action: '写入文件',
      targetLabel: '文件',
      targetValue: parsedInput?.file_path ?? 'unknown',
      previewTitle: '内容预览',
      previewBody: `\`\`\`${truncatePermissionText(content, 500)}\`\`\``,
      previewMeta: formatPermissionPreviewMeta(content, 500),
      rawInput,
    };
  }

  if (normalizedToolName === 'Edit') {
    const oldString = stringifyPermissionValue(parsedInput?.old_string ?? '');
    const newString = stringifyPermissionValue(parsedInput?.new_string ?? '');
    return {
      emoji: '✏️',
      action: '编辑文件',
      targetLabel: '文件',
      targetValue: parsedInput?.file_path ?? 'unknown',
      previewTitle: '变更预览',
      previewBody: [
        '*旧内容*',
        `\`\`\`${truncatePermissionText(oldString, 300)}\`\`\``,
        formatPermissionPreviewMeta(oldString, 300),
        '*新内容*',
        `\`\`\`${truncatePermissionText(newString, 300)}\`\`\``,
        formatPermissionPreviewMeta(newString, 300),
      ].join('\n'),
      rawInput,
    };
  }

  if (normalizedToolName === 'Read') {
    return {
      emoji: '👁',
      action: '读取文件',
      targetLabel: '文件',
      targetValue: parsedInput?.file_path ?? 'unknown',
      rawInput,
    };
  }

  if (normalizedToolName === 'Bash') {
    return {
      ...renderBashSemantics(parsedInput?.command ?? toolInput),
      rawInput,
    };
  }

  if (normalizedToolName === 'Glob' || normalizedToolName === 'Grep') {
    return {
      emoji: '🔍',
      action: '搜索',
      targetLabel: '范围',
      targetValue: parsedInput?.path ?? parsedInput?.glob ?? 'unknown',
      previewTitle: 'Pattern',
      previewBody: `\`\`\`${truncatePermissionText(parsedInput?.pattern ?? parsedInput?.query ?? '', 300)}\`\`\``,
      rawInput,
    };
  }

  if (normalizedToolName.startsWith('mcp__')) {
    const keyParams = pickPrimitiveParams(parsedInput, 4);
    return {
      emoji: '🔌',
      action: '调用外部工具',
      targetLabel: '工具',
      targetValue: normalizedToolName,
      previewTitle: keyParams ? '关键参数' : null,
      previewBody: keyParams ? `\`\`\`${truncatePermissionText(keyParams, 300)}\`\`\`` : null,
      rawInput,
    };
  }

  return {
    emoji: '🛠',
    action: '工具调用',
    targetLabel: '工具',
    targetValue: normalizedToolName,
    previewTitle: '参数',
    previewBody: `\`\`\`${rawInput}\`\`\``,
    rawInput,
    fallback: true,
  };
}
