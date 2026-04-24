# spec: status_update Bash 多行命令美化 + 语义化

## 背景

Slack assistant thread 的 status line 当前对 Bash 工具调用显示为：

```
Orb running: ls -la ~/Orb/test/ 2>&1
echo "---"
grep '"test"' ~/Orb/package.json
```

多行 Bash 命令（heredoc / 多命令 / 带换行）会直接把整块命令塞进 status，Slack 渲染成 3 行以上，非常丑。

## 目标

1. 单行显示——即使原命令有换行，status 也只占一行
2. 优先走语义——Bash 工具调用的 `description` 参数（Claude CLI 会填）表达的是意图，比原始命令可读得多

## 改动点

**文件**：`~/Orb/src/worker.js`
**函数**：`buildStatusText(toolName, input)`
**位置**：`toolName === 'Bash'` 分支（当前约 L534-L537）

### 当前代码

```js
if (toolName === 'Bash') {
  const command = truncateText(String(parsedInput?.command ?? parsedInput?.cmd ?? input ?? '').trim(), 80);
  return command ? `running: ${command}` : 'running bash';
}
```

### 目标代码

```js
if (toolName === 'Bash') {
  const description = parsedInput?.description;
  if (description && typeof description === 'string' && description.trim()) {
    return truncateText(description.trim(), 80);
  }
  const rawCommand = String(parsedInput?.command ?? parsedInput?.cmd ?? input ?? '').trim();
  const firstLine = rawCommand.split('\n')[0].trim();
  const command = truncateText(firstLine, 80);
  return command ? `running: ${command}` : 'running bash';
}
```

### 逻辑

- 有 `description`（Claude CLI 为每次 Bash 调用都会填一句人类可读描述）→ 直接用 description，不加 `running:` 前缀（description 本身就是语义句，比如 "Show working tree status"）
- 无 description → fallback 到命令首行 + `running:` 前缀

## 验收

重启 daemon 后，下一次多行 Bash 调用的 Slack status 应该：
- 只占一行
- 如果 CLI 提供了 description，显示成 `"Show working tree status"` 而不是 `"running: git status"`

## 注意

- 不改 `buildToolTitle`（task-card 的标题，已经是单行）
- 不改其他工具分支
- 外科手术式改动，只动 Bash 分支
