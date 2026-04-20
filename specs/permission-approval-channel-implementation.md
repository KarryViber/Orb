# Permission Approval Channel — 实施记录

日期：2026-04-20

## 本次改动

- 新增 [src/mcp-permission-server.js](/Users/karry/Orb/src/mcp-permission-server.js)
  - 实现 Orb 自建 MCP permission tool：`orb_request_permission`
  - 通过 Unix socket 向 scheduler 发送 `permission_request`
  - 返回单一 text block，不使用 `structuredContent`
  - 兼容 Claude 当前使用的 NDJSON JSON-RPC stdio 帧格式

- 修改 [src/worker.js](/Users/karry/Orb/src/worker.js)
  - Claude CLI 启动时追加：
    - `--permission-prompt-tool mcp__orb_permission__orb_request_permission`
    - `--mcp-config <temp-json>`
    - `--strict-mcp-config`
  - 临时 `mcp-config` 路径包含 worker pid + threadTs
  - 通过 `process.ppid` 推导 scheduler Unix socket：`/tmp/orb-permission-scheduler-{schedulerPid}.sock`
  - workspace 缺失 `.claude/settings.json` 时自动补一份常规 allow，减少噪声
  - worker 退出时清理临时 `mcp-config`

- 修改 [src/scheduler.js](/Users/karry/Orb/src/scheduler.js)
  - 启动 Unix socket server 接收 `permission_request`
  - 默认模式为 `auto-allow` 桩并打日志；设置 `ORB_PERMISSION_APPROVAL_MODE=slack` 时走 Slack 审批
  - pending map key 按 `{threadTs}:{requestId}`
  - 为活跃 worker 记录 `platform/channel/userId`，供权限审批回查

- 修改 [src/adapters/slack.js](/Users/karry/Orb/src/adapters/slack.js)
  - `sendApproval()` 支持 `kind: 'permission'`
  - 新增 permission 卡片模板、超时自动拒绝文案更新
  - 保持现有审批卡片行为兼容

- 新增 [scripts/test-permission-auto-allow.js](/Users/karry/Orb/scripts/test-permission-auto-allow.js)
  - 本地 mock scheduler socket
  - fork `worker.js`
  - 强制 `Write` 走 ask
  - 验证 `Write` 真正生效

- 新增 [/.claude/settings.json](/Users/karry/Orb/.claude/settings.json)
  - 放置 repo workspace 常规 allow 基线

## 本地踩坑

- Claude 当前 MCP stdio 不是 `Content-Length` framing，而是 NDJSON JSON-RPC。
  - 通过原始 stdin 录包确认：
    - `{"method":"initialize",...}\n`
  - 初版 server 只按 header framing 解析，导致 CLI 一直显示 `Available MCP tools: none`

- 本机 `Claude Code 2.1.114` 的 permission allow 返回，实际需要 `updatedInput`。
  - 直接返回 `{"behavior":"allow"}` 时，CLI 会把它判成 invalid union，`Write` 不会执行
  - 当前实现改为：
    - `{"behavior":"allow","updatedInput":<原始 input>}`
  - deny 仍保持：
    - `{"message":"..."}`
  - 这点和原 spec 的 Phase 1 结论有出入；结论来自本机 2026-04-20 实测 stream-json/print 双路径

- Orb worker 会保持 Claude 会话存活直到 idle timeout。
  - 测试脚本把 `WORKER_IDLE_TIMEOUT_MS` 降到 15s，避免本地测试多等 90s

## 本地已跑测试

- 语法检查
  - `node --check src/mcp-permission-server.js`
  - `node --check src/worker.js`
  - `node --check src/scheduler.js`
  - `node --check src/adapters/slack.js`
  - `node --check scripts/test-permission-auto-allow.js`

- 端到端本地测试
  - `node scripts/test-permission-auto-allow.js`
  - 已验证链路：
    - Claude `Write` tool_use
    - MCP permission tool call
    - mock scheduler socket auto-allow
    - Claude `Write` 实际写入文件
    - worker 收到 `DONE`

## 测试脚本用法

```bash
node scripts/test-permission-auto-allow.js
```

成功输出会包含：

```text
permission auto-allow E2E passed
toolName=Write
result=DONE
```

## 需要 Karry 手动验证

- `ORB_PERMISSION_APPROVAL_MODE=slack` 下的真实 daemon 路径
  - launchd daemon 中 worker 发起权限请求
  - scheduler 在真实 Slack thread 发 permission 卡片
  - 点击 Allow / Deny 后，Unix socket 正确回传到 MCP server

- Slack 卡片超时文案
  - 300s 后卡片是否更新为“⏰ 超时自动拒绝”
  - Claude 是否收到 deny message 并停止本次工具调用

- 多 worker 并发
  - 同时存在多个权限请求时，`{threadTs}:{requestId}` 是否稳定避免串话
