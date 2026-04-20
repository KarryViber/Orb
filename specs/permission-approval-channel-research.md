## 假设验证结果

- 假设：`claude config --help` 还能提供独立的 config CLI 帮助
  - 验证方法：在 2026-04-20 运行 `claude --help`、`claude config --help`；再对照官方 changelog 与 configuration/CLI reference 文档。
  - 结论：推翻。当前本机 `claude` 为 `2.1.114`。`claude config --help` 不存在独立子命令，实际回落到顶层 help；官方 changelog 也写明 `claude config commands` 已废弃，改为编辑 `settings.json`。
  - 对 spec 的影响：§ 5 第 1 条不要再把 `claude config --help` 当成可靠信息源；CLI 行为应以官方 CLI reference 为准。
  - 证据：
    - 本地命令：`claude config --help`
    - 官方 changelog：<https://code.claude.com/docs/en/changelog>
    - 官方 CLI reference：<https://code.claude.com/docs/en/cli-reference>

- 假设：`--permission-prompt-tool` 可能接配置路径，或者接裸 tool 名
  - 验证方法：查官方 CLI reference；再在 `/private/tmp/codex-probe-20260420` 下起最小 MCP server，分别用 `approve` 与 `mcp__permprobe__approve` 做黑盒探针。
  - 结论：部分推翻。它接的是 MCP tool 名，不是配置路径；而且当前 CLI 需要的是完整工具名 `mcp__<server>__<tool>`。裸名字会失败，并报 `Available MCP tools: mcp__permprobe__approve`。
  - 对 spec 的影响：§ 2.2 的参数必须写成 `mcp__orb_permission__orb_request_permission`，不能写裸 `orb_request_permission`，更不能传配置路径。
  - 证据：
    - 官方 CLI reference：<https://code.claude.com/docs/en/cli-reference>
    - 本地错误：`MCP tool approve (passed via --permission-prompt-tool) not found. Available MCP tools: mcp__permprobe__approve`

- 假设：`--mcp-config` 只支持文件路径
  - 验证方法：查 `claude --help` 与官方 CLI reference；再分别用文件路径和 inline JSON 启动同一个 probe MCP server。
  - 结论：推翻。`--mcp-config` 同时接受 JSON 文件路径和 inline JSON 字符串；本机两种都成功，`system/init` 都显示 server 已加载。server `env` 也被正确传入子进程。官方文档还写了可传多个 config。
  - 对 spec 的影响：§ 2.2 里“临时文件 vs inline JSON”两条都可行。工程上仍建议临时文件：更好 debug、转义更简单、日志更清楚。
  - 证据：
    - 本地 `claude --help`：`--mcp-config <configs...> Load MCP servers from JSON files or strings`
    - 官方 CLI reference：<https://code.claude.com/docs/en/cli-reference>
    - 官方 MCP/SDK docs：<https://code.claude.com/docs/en/agent-sdk/mcp>

- 假设：permission prompt MCP tool 的 input/output 契约大致是 spec 里写的 `tool_input` / `{ allow: boolean, reason?: string }`
  - 验证方法：起最小 stdio MCP server，记录 Claude 发来的 `tools/call` 原始 JSON；再测试不同返回格式。
  - 结论：部分推翻。
  - 实际 input：
    - Claude 发给 permission tool 的 MCP `tools/call` 为：
    - `params.name`: 工具名本身，例如 `approve`
    - `params.arguments.tool_name`: 例如 `Write`
    - `params.arguments.input`: 工具原始参数，例如 `{ "file_path": "...", "content": "..." }`
    - `params.arguments.tool_use_id`: 例如 `toolu_...`
    - `params._meta["claudecode/toolUseId"]`: 同一个 tool use id
  - 实际 output：
    - 必须返回一个“单一 text block”的 MCP tool result。
    - 带 `structuredContent` 的返回会被判定为无效，即使 `content[0].type === "text"` 也不行。
    - 允许分支，以下几种都被本机 `2.1.114` 接受：
    - 文本 `allow`
    - 文本 JSON `{"allow":true,"reason":"..."}`
    - 文本 JSON `{"behavior":"allow","reason":"..."}`
    - 拒绝分支，确认可用的是：
    - 文本 JSON `{"message":"probe denied"}`
    - 文本 JSON `{"behavior":"deny"}` 被拒绝，CLI 返回校验错误；错误里显示它期望的 union 之一是 `{"behavior":"allow", ...}`，另一支至少要求 `{"message": string}`。
  - 对 spec 的影响：§ 2.1 的 IO 契约必须重写。
    - 输入字段应从 `tool_input` 改成 `input`，并补上 `tool_use_id`
    - 输出不要再写 `{ allow, reason }` 这种“直接返回对象”
    - 推荐输出改为“单一 text block”
    - allow：`{"behavior":"allow"}`
    - deny：`{"message":"Denied by Slack approval"}`
    - 不要返回 `structuredContent`
  - 证据：
    - 本地黑盒日志（2026-04-20）记录到的原始 `tools/call`
    - 相关官方 hook 文档可交叉印证 `tool_name` / `tool_input` 这类命名背景，但 `permission-prompt-tool` 本身的精确契约官方文档未写透：<https://code.claude.com/docs/en/hooks>

- 假设：`stream-json` 会直接输出原生 `permission_request` 事件，因此可以不做 MCP server
  - 验证方法：在 workspace 外目录 `/private/tmp/codex-probe-20260420`，强制 `Write` 走 `ask`（`--settings '{"permissions":{"ask":["Write"],"allow":[],"deny":[]}}'`），运行 `claude -p --output-format stream-json --verbose`，让它尝试写文件并观察 stdout。
  - 结论：推翻。没有看到独立的 `permission_request` 事件。
  - 实际 stream-json 表现：
    - 先输出 assistant 的 `Write` `tool_use`
    - 然后输出一个 synthetic `tool_result` error：`Claude requested permissions to use Write, but you haven't granted it yet.`
    - 最终 `result.permission_denials` 里有这次被拦的工具调用
  - 对 spec 的影响：§ 5 第 5 条的“直接拦 stdout 事件然后回 stdin”这条路在当前 CLI 上不可用；不能省掉单独的审批通道组件。

- 假设：官方没有更直接的“远程审批 relay”路径
  - 验证方法：读官方 channels reference 与 CLI reference。
  - 结论：推翻。官方其实有专门的 permission relay：
    - 出站：`notifications/claude/channel/permission_request`
    - 入站：`notifications/claude/channel/permission`
    - 字段：`request_id`、`tool_name`、`description`、`input_preview`、`behavior`
  - 对 spec 的影响：这是一条真实存在的第三路径，比“自定义 permission MCP tool”更贴近“Slack 审批卡片”问题本身；但它目前有两个限制：
    - `--channels` 在官方 CLI reference 中仍标为 Research preview
    - 需要 Claude.ai authentication；本地开发 channel 还要走 `--dangerously-load-development-channels`
  - 备注：这条路值得单独立一个 spike，但不改变你这份 spec 的 Phase 1 结论。
  - 证据：
    - channels reference：<https://code.claude.com/docs/en/channels-reference>
    - CLI reference：<https://code.claude.com/docs/en/cli-reference>

- 假设：可以用 `PermissionRequest` hooks 代替 `permission-prompt-tool`
  - 验证方法：查官方 hooks guide。
  - 结论：推翻。官方明确写了：`PermissionRequest` hooks 在非交互 `-p` 模式不会触发；若做自动策略，应改用 `PreToolUse` hooks。
  - 对 spec 的影响：不要把 hooks 作为 Orb 当前 `stream-json` worker 的远程审批主方案。
  - 证据：<https://code.claude.com/docs/en/hooks-guide>

## 推荐实施路径

- 在你当前 spec 的二选一前提下，推荐走 MCP permission tool 路径，不走 stream-json 事件拦截。原因很简单：本机 `2.1.114` 的 `stream-json` 没有原生 `permission_request` 事件，stdout 上只有“工具调用失败 + permission_denials”，不足以完成交互式审批闭环。

- 具体建议：
  - `worker.js` 传 `--permission-prompt-tool mcp__orb_permission__orb_request_permission`
  - `worker.js` 传 `--mcp-config <temp-file.json>`，不建议 inline JSON 当主实现
  - 可选再加 `--strict-mcp-config`，避免会话把别的 MCP 配置带进来
  - permission MCP tool 按以下契约实现：
  - 入参：`tool_name`、`input`、`tool_use_id`
  - allow 返回：单一 text block，内容推荐 `{"behavior":"allow"}`
  - deny 返回：单一 text block，内容推荐 `{"message":"Denied by Slack approval"}`
  - 不要返回 `structuredContent`

- 额外建议：把官方 channels permission relay 记为一个单独备选 spike，而不是直接塞进这份 spec。
  - 它从产品形态上更接近“Slack 审批卡片”
  - 但当前是 Research preview，且要求 Claude.ai auth，不适合在这份 spec 里直接替换主路径

## 需要修改 spec 的地方

- § 1「方案总览：MCP Permission Prompt Tool」
  - 把“需要外部 session 验证确切格式”改为已确认结论：`--permission-prompt-tool` 接完整 MCP tool 名 `mcp__server__tool`
  - 增加一行说明：`claude --help` 不会列出所有 flag，`--permission-prompt-tool` 虽然不在 help 里，但在官方 CLI reference 中存在

- § 2.1「新增：src/mcp-permission-server.js」
  - 输入契约改成：
  - `tool_name: string`
  - `input: object`
  - `tool_use_id: string`
  - 输出契约改成：
  - 单一 text block JSON
  - allow：`{"behavior":"allow"}`
  - deny：`{"message":"Denied by Slack approval"}`
  - 删除当前 spec 里的 `{ allow: boolean, reason?: string }`

- § 2.2「修改：src/worker.js」
  - 命令参数固定写成：
  - `--permission-prompt-tool mcp__orb_permission__orb_request_permission`
  - `--mcp-config <temp-file>`
  - 把“需 Codex 验证 CLI 支持格式”改成：已确认 `--mcp-config` 同时支持文件路径和 inline JSON，但主实现仍建议 temp file

- § 3「数据流时序」
  - `t2` 的 MCP tool call payload 要改成真实字段：
  - `tool_name`
  - `input`
  - `tool_use_id`
  - `t6` 的返回也要改：
  - 不再是 `{allow: true}`
  - 而是 tool 返回文本 JSON，经 Claude 解析后放行

- § 4.4「超时行为」
  - 当前写的是 `return {allow: false, reason: "timeout"}`
  - 应改为 deny 文本 JSON，例如 `{"message":"timeout"}`；如果想让 Claude 明确知道是超时拒绝，message 里写清楚即可

- § 5「调研任务」
  - 给第 1 条补结果：`--permission-prompt-tool` 是完整 MCP tool 名，不是配置路径
  - 给第 2 条补结果：input 是 `tool_name` + `input` + `tool_use_id`；返回必须是单一 text block
  - 给第 3 条补结果：`--mcp-config` 文件路径与 inline JSON 都支持
  - 给第 5 条补结果：`stream-json` 没有原生 `permission_request` 事件
  - 另加一条备注：`PermissionRequest` hooks 在 `-p` 下不触发，不是替代方案

- § 6 Phase 1
  - “试一个极简 MCP server 手动验证通路（echo { allow: true } 的 mock）” 这句要改
  - 正确说法应是：mock server 返回“单一 text block”，例如 `{"behavior":"allow"}`，不能只回结构化对象

- 可选新增一段附注
  - 标题可叫「备选：官方 Channels Permission Relay」
  - 只记录其存在、限制与为何暂不选型，避免后续重复调研
