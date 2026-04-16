# Orb — Multi-profile AI Agent Framework

通过 Slack（未来支持 Discord/WeChat）接收消息，fork Claude Code CLI 执行任务。

## Architecture

```
src/
  main.js              — 入口，adapter 初始化，信号处理
  scheduler.js         — worker 生命周期，任务队列，调度
  config.js            — config.json 加载，profile 路由
  worker.js            — fork 子进程，调用 Claude CLI
  cron.js              — Cron 定時任務（60s tick、job 持久化、schedule 解析）
  context.js           — prompt 分層組装（soul → user → directives → memory → thread → message）
  session.js           — thread↔session 持久化（per-profile 隔離）
  memory.js            — Holographic 記憶検索 + 対話存儲（Python bridge 経由）
  format-utils.js      — 平台无关文本工具（sanitize、split）
  log.js               — console + file 双写，50MB 自動轮转
  queue.js             — 全局任务 FIFO 队列
  adapters/
    interface.js       — PlatformAdapter 抽象基类
    slack.js           — Slack Socket Mode 实現
    slack-format.js    — Markdown→mrkdwn，Block Kit 构建
```

## Key Paths

- `profiles/{name}/soul/`      — 人格/协作边界/用户档案（per-profile，运行时只读）
- `profiles/{name}/skills/`    — Skill 文件（CC 原生 agent 格式，context.js 扫描注入索引）
- `profiles/{name}/scripts/`   — 用户工具脚本（x-twitter, plaud, finance, lark 等）
- `profiles/{name}/workspace/` — Claude CLI 工作目录
- `profiles/{name}/data/`      — sessions.json + memory.db + doc-index.db + cron-jobs.json + MEMORY.md（gitignored）
- `lib/holographic/`           — Holographic 記憶エンジン（Python、Hermes 由来）
- `lib/docstore/`              — DocStore 文件索引（FTS5、Python、Hermes 由来）
- `config.json`                — profile 路由 + adapter 配置

## Prompt Architecture

Worker 调用 Claude CLI 时分两路注入：
- `--system-prompt`: Soul + User + MEMORY.md + Skills + Framework Directives（稳定内容，利于 prompt cache）
- `-p` (stdin): Holographic Recall + Docs + Thread History + Message（動態内容）

Soul 文件: SOUL.md（人格 + 协作边界）+ USER.md（用户档案）。workspace/CLAUDE.md 由 CLI 从 cwd 自动读取（运行时约束 + 执行纪律）。USER.md 由 scheduler 自动从 holographic preference facts 同步更新。MEMORY.md 在 data/ 下，agent 主动写入 + scheduler 定期从高 trust facts 合并。Framework directives（记忆策略等）硬编码在 context.js 中，条件注入。

## Config

`config.json` 支持 `${ENV_VAR}` 插值。SIGHUP 信号触发热加载。

## Dev

```bash
npm run dev          # --watch 模式
npm start            # 生産启动（launchd 管理）
```

## Conventions

- ESM (type: module), Node >= 18, 纯 JS
- worker 是一次性 fork，执行完 exit
- 不要修改运行中 Orb 的核心文件（main/scheduler/worker/adapters）— 通过 spec 文件让外部 session 执行

## Cron

Jobs 存储在 `profiles/{name}/data/cron-jobs.json`。CronScheduler 每 60s tick 一次，检查 due jobs 并 fork worker 执行。

Job 格式：
```json
{
  "id": "abc123",
  "name": "Daily Report",
  "prompt": "生成日报...",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *" },
  "deliver": { "platform": "slack", "channel": "C01234", "threadTs": null },
  "profileName": "{your-profile}",
  "enabled": true,
  "repeat": { "times": null, "completed": 0 },
  "nextRunAt": "2026-04-15T09:00:00+09:00",
  "lastRunAt": null, "lastStatus": null, "lastError": null
}
```

Schedule 类型：`"0 9 * * *"` (cron)、`"every 30m"` (interval)、`"2h"` / ISO (one-shot)。
Agent 通过直接读写 cron-jobs.json 管理任务（Claude CLI 原生文件操作）。

---

## Architecture Constraints（架构硬约束）

以下规则是架构演进中确立的不变量，任何修改源码的 session 必须遵守。

### 文件职责分层

| 文件 | 读取者 | 职责 | 维护频率 |
|------|--------|------|---------|
| `~/Orb/CLAUDE.md`（本文件） | 外部 Claude Code session（改源码时） | 开发者指南 + 架构约束 | 架构变更时 |
| `profiles/{name}/workspace/CLAUDE.md` | Orb worker（Claude CLI 的 cwd） | Agent 运行时约束 + 执行纪律 | 基本不动 |
| `profiles/{name}/soul/SOUL.md` | Orb worker（context.js 读取） | 人格 + 协作边界 | 日常维护 |
| `profiles/{name}/soul/USER.md` | Orb worker（context.js 读取） | 用户档案 | 自动同步 |

两层职责分离 + 框架内置 directives：soul = 身份 + 决策原则，workspace CLAUDE.md = 操作约束，framework directives = context.js 硬编码的运维机制（条件注入）。

### Profile 隔离

- 每个 profile 拥有独立的 `soul/`、`skills/`、`scripts/`、`workspace/`、`data/` 目录
- `config.json` 中 `userIds` 映射决定用户归属哪个 profile
- `default` profile 是兜底，未映射用户走这里
- session 数据按 `{platform}:{threadTs}` 键隔离，存储在各自 `data/sessions.json`
- 新增用户 = 新建 profile 目录 + config.json 加映射，不改源码

### 平台抽象

- `adapters/interface.js` 定义 `PlatformAdapter` 抽象基类
- 每个平台一个 adapter（slack.js），实现 `start/disconnect/sendReply/editMessage/uploadFile/setTyping/sendApproval/buildPayloads/fetchThreadHistory`
- 平台专用格式化放 `adapters/{platform}-format.js`，通用工具放 `format-utils.js`
- `scheduler.js` 只通过 adapter 接口操作平台，不直接 import 平台 SDK
- 新增平台 = 新建 adapter + format 文件 + config.json 加配置，不改 scheduler/worker/context

### Worker IPC 协议

Scheduler ↔ Worker 通信通过 Node IPC（process.send/on('message')）：

```
Scheduler → Worker:
  { type: 'task', userText, fileContent, threadTs, channel, userId, platform, threadHistory, profile }
  { type: 'approval_result', approved, scope, userId }

Worker → Scheduler:
  { type: 'result', text }
  { type: 'error', error }
  { type: 'update', text, messageTs }
  { type: 'file', filePath, filename }
  { type: 'approval', prompt }
```

新增消息类型需同步更新 worker.js 顶部注释和 scheduler.js handler。

### 不可变约束

- **Claude Code CLI 是唯一的 agent runtime**，不接入其他 LLM SDK
- **worker 是一次性进程**，执行完 exit，不复用
- **Orb 运行时不能修改自己的源码**，通过 spec 文件让外部 session 执行
- **config.json 是唯一的路由配置源**，不在代码中硬编码 userId/profile 映射
