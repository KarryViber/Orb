# Spec: CLI 权限审批通道（Slack 审批卡片 ↔ Claude CLI Permission Hook）

**创建**：2026-04-20
**Phase 1 调研完成**：2026-04-20（`specs/permission-approval-channel-research.md`）
**驱动**：Skills 治理任务中发现 worker 的 Claude CLI 权限弹框在 Slack 里不可见，写 `_GOVERNANCE.md` 被拦停
**执行方**：外部 Codex / Claude Code session（Orb 运行时不改自身 src/）
**优先级**：P1（长期卡点，任何需要审批的写入都会卡）
**状态**：Phase 1 调研完毕，假设已验证/推翻，可开 Phase 2 实施

---

## 0. 背景 / Why

Orb worker fork 出 `claude` CLI 子进程（`src/worker.js:219`），走 `stream-json` I/O。CLI 遇到需要权限的工具（Write / Bash 非 allow 列表项 / MCP 新工具）时，**默认行为是在终端交互式弹框**。由于 worker 通过 pipe 接管 stdio，这个弹框既不会到 Slack，worker 也不会把请求转发出去——结果就是 CLI 卡死等输入，最终 idle timeout 退出，用户看到「空回复」或「被拦」。

当前 settings.json 有 `Write(*)`、`Bash(*)` 在 allow 里，但 worker 启动 CLI 时**没传 `--permissions-settings` 也没继承用户 settings**（CLI 的 permissions 默认从 cwd 的 `.claude/settings.json` 读，workspace 目录下没这份设置）。

---

## 1. 方案总览：MCP Permission Prompt Tool

Claude Code CLI 原生支持 `--permission-prompt-tool mcp__<server>__<tool>` 参数（**已验证** 2026-04-20 Codex 黑盒探针 + 官方 CLI reference <https://code.claude.com/docs/en/cli-reference>）。参数必须传完整 MCP tool 名 `mcp__server__tool`，裸工具名会失败。注意：`--permission-prompt-tool` 不出现在 `claude --help` 输出里，但官方 CLI reference 中存在。

当 CLI 需要审批时，**不**弹终端框，而是调用指定的 MCP 工具；tool 返回「单一 text block JSON」表达 allow/deny（详见 § 2.1）。

架构：
```
Claude CLI (stream-json)
    │ 需要权限
    ▼
MCP Permission Tool (Orb 自建 MCP server)
    │ tool call
    ▼
Orb Scheduler (via IPC or HTTP loopback)
    │ 建审批卡片
    ▼
Slack adapter.sendApproval()   ← 已有
    │ 用户点 Allow / Deny
    ▼
Slack action callback → Scheduler
    │ 回传决策
    ▼
MCP Tool return 单一 text block: {"behavior":"allow"} 或 {"message":"..."}
    │
    ▼
Claude CLI 继续 / 放弃
```

**复用**：Orb 已有审批卡片基础设施（X/Twitter 发帖走的那套，见 `adapters/slack.js` 的 `sendApproval` + scheduler 的 approval 回调路由）——只需接一个新的审批来源：CLI permission。

---

## 2. 组件清单

### 2.1 新增：`src/mcp-permission-server.js`

Orb 内置的 MCP server，暴露一个工具。**契约已通过 Codex 2026-04-20 黑盒探针验证**（本机 Claude CLI 2.1.114）：

```
tool name: orb_request_permission
  （CLI 实际调用时完整名为 mcp__orb_permission__orb_request_permission）

MCP tools/call 请求（CLI → MCP server）:
  params.name: "orb_request_permission"
  params.arguments:
    tool_name: string        # 要执行的工具名（如 "Write"）
    input: object            # 工具原始参数（如 {file_path, content}）
    tool_use_id: string      # toolu_... 形式的调用 id
  params._meta["claudecode/toolUseId"]: 同 tool_use_id

MCP tools/call 返回（MCP server → CLI）:
  必须是「单一 text block」，不能带 structuredContent。
  content: [{ type: "text", text: <JSON 字符串> }]

  allow 分支（text 字段内容）:
    {"behavior":"allow"}        # 推荐
    （或 {"behavior":"allow","reason":"..."} / "allow" 纯字符串也接受）

  deny 分支（text 字段内容）:
    {"message":"Denied by Slack approval"}  # 推荐
    （{"behavior":"deny"} 会被 CLI 校验拒绝，不要用）
```

实现要点：
- Node.js，用 `@modelcontextprotocol/sdk` 起 MCP server（stdio transport，CLI 作为 client 连）
- **thread/channel/user_id 上下文** 通过 env var 注入（不在 tool arguments 里），MCP server 启动时从 env 读：
  - `ORB_THREAD_TS`、`ORB_CHANNEL`、`ORB_USER_ID`、`ORB_SCHEDULER_SOCKET`
- 工具调用时：
  1. 从 arguments 拿 `tool_name`/`input`/`tool_use_id`，从 env 拿 thread 上下文
  2. 通过 Unix socket 向 scheduler 发 `permission_request`（payload: `{requestId, toolName, toolInput, toolUseId, threadTs, channel, userId}`）
  3. 阻塞等 scheduler 回 `{allow: boolean, reason?: string}`（带超时，默认 300s，超时视为 deny）
  4. 转换为单一 text block JSON 返回给 CLI：allow → `{"behavior":"allow"}`；deny → `{"message": reason || "Denied"}`

### 2.2 修改：`src/worker.js`

CLI 启动参数加（**已验证** `--mcp-config` 同时支持文件路径和 inline JSON，主实现用**临时文件**——易 debug、转义简单、日志清楚）：
```js
streamArgs.push(
  '--permission-prompt-tool', 'mcp__orb_permission__orb_request_permission',
  '--mcp-config', path_to_orb_mcp_config_json,
  '--strict-mcp-config',  // 可选：防止会话带入其他 MCP 配置
);
```

临时文件路径建议：`/tmp/orb-mcp-{workerPid}-{threadTs}.json`，worker 退出时清理。

`orb_mcp_config.json` 内容：
```json
{
  "mcpServers": {
    "orb_permission": {
      "command": "node",
      "args": ["/Users/karry/Orb/src/mcp-permission-server.js"],
      "env": {
        "ORB_SCHEDULER_SOCKET": "/tmp/orb-scheduler-{schedulerPid}.sock",
        "ORB_THREAD_TS": "<threadTs>",
        "ORB_CHANNEL": "<channel>",
        "ORB_USER_ID": "<userId>"
      }
    }
  }
}
```

### 2.3 修改：`src/scheduler.js`

新增 handler：
```js
case 'permission_request':
  // worker 不该直接发这个 — 这是 MCP server 独立进程发的
  // 但 scheduler 需要提供一个 IPC 接收点（socket / HTTP loopback）
  await handlePermissionRequest(msg);
  break;
```

`handlePermissionRequest` 流程：
1. 查 thread_ts 对应的 profile / channel
2. 调 `adapter.sendApproval({ title, fields, allowBtn, denyBtn, onDecision })`
3. 把 decision callback 存 pending map（key = request_id）
4. 用户点按钮 → 已有的 approval action handler → 查 pending → 通过 socket/HTTP 回传给 MCP server
5. 超时兜底：5 min 自动 deny + Slack 贴「超时自动拒绝」

### 2.4 修改：`src/adapters/slack.js`

`sendApproval` 扩展支持 `kind: 'permission'` 类别，卡片模板：
```
🔐 权限请求 — {tool_name}
• 参数：{tool_input 摘要，截断 500 字}
• 来源：thread {thread_ts}
[✅ 允许]  [❌ 拒绝]  [⚙️ 允许并永久加入 allow]
```

第三个按钮可选（Phase 2）：点击后把 `tool_name + pattern` 写入 `settings.json` 的 `allow`，下次不再问。

---

## 3. 数据流时序

```
t0: CLI emit tool_use(Write, {path, content}) — tool_use_id=toolu_xyz
t1: CLI 检测到 Write 不在 allow → MCP tools/call orb_request_permission
      params.arguments = { tool_name: "Write", input: {...}, tool_use_id: "toolu_xyz" }
t2: MCP server 收到 tool call → socket 发 permission_request 给 scheduler
      payload: {requestId, toolName:"Write", toolInput:{...}, toolUseId, threadTs, channel, userId}
t3: scheduler 调 adapter.sendApproval → Slack 贴审批卡片
t4: 用户点 ✅允许
t5: Slack action → scheduler approval handler → 查 pending map →
      socket 回 MCP server: {allow: true, reason: "manual"}
t6: MCP server tool return 单一 text block:
      content: [{type:"text", text:'{"behavior":"allow"}'}]
t7: CLI 解析 behavior=allow → 继续执行，Write 实际生效
```

---

## 4. 边界 / Gotchas

### 4.1 Worker 与 MCP server 生命周期

MCP server 是 CLI 的子进程（CLI 按 `--mcp-config` 自己 spawn）。worker 不 own 这个进程。**风险**：worker idle timeout 退出后 CLI 关闭，MCP server 也跟着死——没问题。但如果权限请求**在** worker 等 CLI exit 期间卡住，可能死锁。**缓解**：MCP server 内置 5min 超时硬兜底。

### 4.2 多并发 worker

scheduler 同时跑多个 worker，每个 CLI 起自己的 MCP server 实例。socket 名要带 worker pid 或 thread_ts 去重。pending map 的 key 用 `{threadTs}:{requestId}` 防撞。

### 4.3 审批延迟期间 worker 的 `inject`

Karry 在等审批的时候又发了新消息给 thread。**策略**：`inject` 正常入 CLI stdin，但 CLI 当前 turn 还卡在权限请求上——新消息会排队到下个 turn。`intermediate_text` / `progress_update` 继续正常走。

### 4.4 超时行为

300s 未决 → MCP tool return 单一 text block `{"message":"timeout: no response from Slack approval in 300s"}` → CLI 视为 deny，放弃这次工具调用。Slack 卡片更新为「⏰ 超时自动拒绝」。worker 不应因此崩溃。

注意：不要返回 `{"behavior":"deny"}`——CLI 2.1.114 校验会拒绝该结构，必须用 `{"message":"..."}` 格式。

### 4.5 settings.json allow 优先级

CLI 先查 `permissions.allow`，命中则不走 permission-prompt-tool。**确认**：workspace 目录下要不要放一份 `.claude/settings.json` 继承全局 allow，避免 `Read(*)`、`Bash(git *)` 这种常规操作也弹审批卡。

---

## 5. 调研结果（Phase 1 已完成 2026-04-20）

详见 `specs/permission-approval-channel-research.md`。核心结论：

1. **`--permission-prompt-tool` 参数格式**：✅ 接完整 MCP tool 名 `mcp__<server>__<tool>`，裸名失败。不在 `claude --help` 输出中但官方 CLI reference 里有。
2. **MCP permission tool IO 契约**：
   - input：`{tool_name, input, tool_use_id}`（不是 `tool_input`）
   - output：**单一 text block JSON**，不能返回 structuredContent
   - allow：`{"behavior":"allow"}` / deny：`{"message":"..."}`（`{"behavior":"deny"}` 被拒）
3. **`--mcp-config` 格式**：✅ 文件路径和 inline JSON 都支持。主实现用临时文件。
4. **SDK-only 方案**：不在本 spec 范围，保留为未来选项。
5. **`stream-json` 原生 permission event**：❌ 不存在。CLI 只在 stdout 输出 `tool_use` + synthetic `tool_result` error + 最终 `result.permission_denials`，不足以做交互闭环。必须走 MCP 方案。
6. **备注 1**：`PermissionRequest` hooks 在 `-p`（print/non-interactive）模式不触发，不能替代方案。
7. **备注 2**：发现官方 Channels Permission Relay（`notifications/claude/channel/permission_request`），产品形态更贴「Slack 审批卡片」，但目前是 **Research Preview** 且要求 Claude.ai auth（Orb 现在是 API key 模式），不作主路径。见 § 10。

---

## 6. 实施路径（Phase 分解）

### Phase 1：调研（已完成 2026-04-20）
- ✅ 读 CLI `--help` + 官方 CLI reference + MCP docs
- ✅ 起 mock MCP server 做黑盒探针（返回「单一 text block」，如 `{"behavior":"allow"}`，不是结构化对象）
- ✅ 产出 `specs/permission-approval-channel-research.md`

### Phase 2：MCP server + worker 接线（1 day）
- 写 `src/mcp-permission-server.js`
- 改 `src/worker.js` 加 `--permission-prompt-tool` + `--mcp-config`
- scheduler 加 `permission_request` handler 桩（先 auto-allow + 打日志，不接 Slack）
- 跑本地测试：触发 Write，观察整条链路日志

### Phase 3：Slack 卡片接线（0.5 day）
- 扩展 `adapters/slack.js` `sendApproval` 支持 `kind: 'permission'`
- scheduler 接 approval action callback → socket 回 MCP
- 端到端测试：在 Slack 收到卡片 → 点按钮 → CLI 继续

### Phase 4：打磨（0.5 day）
- 超时兜底 + 卡片更新文案
- `.claude/settings.json` 放到 workspace 下继承常规 allow，减少无谓审批
- 第三按钮「允许并加入 allow」（可选）
- 在 workspace/CLAUDE.md 加一节「审批通道工作原理」

### Phase 5：回头做 Skills 治理（blocked on Phase 3）
- 本 spec 的起因任务
- 审批通道通后，重跑 Skills 治理三件套

**总工作量**：2.5 工作日（含调研，不含 Skills 治理）

---

## 7. 不做什么

- **不**改 worker IPC 协议核心字段（`turn_start/turn_end/result` 等），只**新增** `permission_request` 通道
- **不**把审批卡片和 X/Twitter 发帖卡片合并代码路径——两类审批业务逻辑差异大（内容对外 vs 工具权限），保持独立
- **不**在 Phase 1-3 做「永久 allow」按钮，留 Phase 4
- **不**引入 HTTP server（scheduler 已经是单进程，用 Unix socket 足够）

---

## 8. 成功标准

1. 在 Slack 里让 Orb 写一个 `workspace/.claude/skills/` 下的新文件 → 收到审批卡片 → 点允许 → 文件成功写入
2. 点拒绝 → Slack 显示「已拒绝，worker 已放弃该操作」，worker 不崩
3. 超时 5min 未决 → 卡片更新为超时，worker 不挂
4. 常规操作（Read / grep / git status）**不**触发审批卡片（allow 列表生效）

---

## 9. 回滚策略

所有改动集中在：
- `src/worker.js`（加 2 个 CLI 参数）
- `src/mcp-permission-server.js`（新文件）
- `src/scheduler.js`（新增 handler）
- `src/adapters/slack.js`（扩展 sendApproval）

回滚：移除 `--permission-prompt-tool` 参数即可退回旧行为（CLI 走默认权限模式，弹框在 worker 的 stdin 黑洞里——等于关审批通道但不崩）。

---

## 10. 备选路径：官方 Channels Permission Relay（不选型，记录存档）

2026-04-20 调研发现官方存在另一条远程审批路径：

- 出站：`notifications/claude/channel/permission_request`
- 入站：`notifications/claude/channel/permission`
- 字段：`request_id`、`tool_name`、`description`、`input_preview`、`behavior`
- 文档：<https://code.claude.com/docs/en/channels-reference>

**为什么不选**：
1. `--channels` 在官方 CLI reference 中仍标为 **Research Preview**，稳定性和字段可能变
2. 需要 Claude.ai authentication（Orb 当前 API key 模式跑，切 auth 是更大的改动）
3. 本地开发还要 `--dangerously-load-development-channels` flag

**未来条件**：若 Channels 转 GA 且 Orb 有理由换 Claude.ai auth（比如集成 Claude.ai 原生功能），可单开 spike 评估迁移。本 spec 主路径不动。
