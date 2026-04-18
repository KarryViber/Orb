# CLAUDE.md 架构声明对齐

**背景：** 2026-04-18 codex 审计（`specs/codex-architecture-audit-20260418.md`）发现 CLAUDE.md 声明的不变量与 `src/` 实际行为已偏离。本 spec 把文档对齐到现实，不改代码。

## 目标
修正 `~/Orb/CLAUDE.md`，使架构声明与 `src/scheduler.js`、`src/worker.js` 的实际实现一致。

## 改动点

### 1. Worker 生命周期（L58、L153-154）

**现状声明：**
> Workers are one-shot forks — execute and exit, never reused

**实际行为：** scheduler 对活动 worker 做 `inject`（`scheduler.js:92-104`），worker 接收后在同一 Claude CLI 会话里续推（`worker.js:164-176, 318-327`）。worker 在 thread 有后续消息时会被复用，直到 idle 超时才退出。

**改为：**
> Workers are short-lived per-thread processes — forked on first message, reused for follow-up messages in the same thread via `inject` IPC, exit on idle timeout. Never reused across threads.

同步改 `Immutable Constraints` 段的对应条目。

### 2. IPC 协议（L138-149）

**现状声明只列：** task / approval_result（入）；result / error / update / file / approval（出）

**实际还有：**
- Scheduler → Worker：`inject`（中途注入新消息）
- Worker → Scheduler：`turn_complete`（一轮结束信号）
- `task` 载荷字段补全：`imagePaths`、`model`、`effort`、`mode`、`priorConversation`

**改为完整协议表，并在注释指明**「新增消息类型要同步更新 `worker.js` 头注释、`scheduler.js` handler 和本段」。

### 3. Profile 隔离（L118-122）

**现状声明：**
> Each profile owns independent `soul/`, `skills/`, `scripts/`, `workspace/`, `data/` directories
> `default` profile is the fallback for unmapped users

**问题：**
- `config.js:49-57` 和 `scheduler.js:147-152` 没有 `default` fallback 分支，未映射的 userId 会直接出错
- `worker.js:67-74`、`config.js:63-79`、`context.js:137-180` 的 profile 根目录校验只覆盖 `workspace/` 和 `data/`，没校验 `soul/` 和 `scripts/`

**二选一：**
- (A) 删除 `default fallback` 声明，明确「未映射 userId 不处理」
- (B) 保留声明，但在本 spec 的 follow-up 里补代码实现

**推荐 A**，因为 default fallback 在多 profile 场景下可能把数据错误路由到 default，安全性差。

## 不在本 spec 范围
- 统一 runtime key（`profile:platform:threadTs`）— 涉及 src 改动，单独立 spec
- DocStore slug 推断去重 — 单独立 spec
- scheduler 拆分 — 大改造，单独评估

## 验收
- 外部会话按本 spec 修改 `~/Orb/CLAUDE.md`
- diff 仅涉及文档段落，不改 `src/`
- 修改后再跑一次 codex 快速审计，确认"不变量失真"类问题清零
