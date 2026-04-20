# Permission Card 语义化改造

## 背景

当前权限审批卡片（`src/adapters/slack.js` 的 `_buildPermissionApprovalBlocks`）展示：

- `*🔐 权限请求* \`toolName\``
- `*来源* thread xxx` / `*Request ID* xxx`
- `*参数* {raw JSON}`

Karry 反馈：**来源/Request ID/raw 参数 都看不懂也不想看**。需要的是语义层信息：

1. 这个请求**要做什么事**？（写入 / 编辑 / 删除 / 运行命令）
2. **影响哪个文件/目标**？
3. 如果是写入/编辑，**具体内容预览**

## 目标卡片样式

```
🔐 权限请求

📝 写入文件
/Users/karry/Orb/profiles/karry/workspace/specs/foo.md

内容预览：
┌──────────────────────────────┐
│ # Foo Spec                   │
│                              │
│ ## Background ...            │
└──────────────────────────────┘
(前 500 字符 / 共 XXX 字符)

⏰ 5 分钟内处理，超时自动拒绝
[允许]  [拒绝]
```

## 语义化渲染规则

按 `toolName` 分派，从 `toolInput` 提取语义字段：

| toolName | 动作 | 展示字段 |
|----------|------|----------|
| `Write` | 📝 写入文件 | `file_path` + 内容前 500 字 + 总字数 |
| `Edit` | ✏️ 编辑文件 | `file_path` + `old_string` → `new_string` 前 300 字 |
| `Read` | 👁 读取文件 | `file_path` |
| `Bash` | ⚡ 执行命令 | `command`（智能识别：rm/unlink → 🗑 删除；git/curl → 根据子命令） |
| `Glob` / `Grep` | 🔍 搜索 | pattern + path |
| `mcp__*` | 🔌 调用外部工具 | tool name + 关键参数 |
| 其他 | 🛠 工具调用 | toolName + raw input（fallback，保留原行为） |

### Bash 子命令识别

```
rm / unlink / rmdir / trash → 🗑 删除 + 目标路径
git push / git reset --hard → ⚠️ Git 高危操作 + 完整命令
curl / wget (带 POST/DELETE) → 🌐 网络调用（高危）
其他 → ⚡ 执行 + 命令
```

### 内容截断

- Write content preview: 前 500 字符，末尾带 `(共 XXXX 字符)` 说明
- Edit old/new: 各前 300 字符
- Bash command: 前 200 字符

## 实现位置

单函数改造：`src/adapters/slack.js` `_buildPermissionApprovalBlocks()`

新增 helper 函数：

```js
function renderPermissionSemantics(toolName, toolInput) {
  // 返回 { emoji, action, targetLabel, targetValue, contentPreview?, meta? }
  // 由调用方组装成 Block Kit blocks
}
```

保留原字段作为**调试 section**（可折叠 / context 小字）——不删，只降级。

## 验收

1. Write 文件请求 → 卡片显示 "📝 写入文件 /path/to/x" + 前 500 字内容
2. Edit 请求 → 卡片显示 "✏️ 编辑文件 X" + diff
3. Bash `rm -rf /tmp/foo` → 卡片显示 "🗑 删除 /tmp/foo"
4. Bash `curl https://api.x.com` → "🌐 网络调用"
5. 未知工具 → fallback 到原样式

## 不要做

- 不删除 `requestId`（scheduler 回调要用）——只从主显示区移除，放到 context 小字
- 不改 action_id / approvalId 逻辑
- 不改 resolution 链路
- 不改 timeout 逻辑

## 范围

单文件单函数改造，估 80-120 行增量。纯展示层。
