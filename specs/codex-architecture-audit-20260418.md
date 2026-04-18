# 架构审计报告

## 1. 架构一致性

- `default` fallback 只写在声明里，代码没有：`CLAUDE.md:120`；`src/config.js:49-57`；`src/scheduler.js:147-152`。
- profile 隔离只校验了 `workspace/data`，没校验 `soul/scripts`：`CLAUDE.md:118-122`；`src/worker.js:67-74`；`src/config.js:63-79`；`src/context.js:137-180`。
- “worker one-shot” 已失真：`scheduler` 对活动 worker 做 `inject`，`worker` 复用同一 CLI 会话：`CLAUDE.md:59,154`；`src/scheduler.js:92-104`；`src/worker.js:34-45,164-176,318-327`。
- IPC 声明过期：文档未包含 `inject`、`turn_complete`、`imagePaths/model/effort/mode/priorConversation`：`CLAUDE.md:138-149`；`src/worker.js:12-28`；`src/scheduler.js:210-229,240-255`。

## 2. 耦合与抽象

- 调度层身份模型和会话层不一致。session 用 `platform:threadTs`（`src/worker.js:83-84`），`scheduler/queue` 只用 `threadTs`（`src/scheduler.js:56-57,75,92,122-139`；`src/queue.js:24-25`）。
- context 边界被拆散。接口说 adapter 负责线程历史（`src/adapters/interface.js:12-17`），但 Slack adapter 还解析 URL、抓取被引用线程并塞进 `fileContent`（`src/adapters/slack.js:620-648`）；`context.js` 又做 memory/docs/thread 组装（`src/context.js:188-245`）。
- DocStore 规则重复实现。`src/context.js:18-19` 明写“镜像 `docquery.py`”；实际 alias/slug 推断在 JS 和 Python 各维护一份（`src/context.js:21-88`；`lib/docstore/docquery.py:55-135`）。
- `scheduler` 过胖：既管编排，又管 skill review、memory sync、lint、图片 GC，还驱动改写 `USER.md/MEMORY.md`（`src/scheduler.js:383-677`）。

## 3. 风险点

- 热路径子进程过多：fork worker（`src/spawn.js:24-27`）→ Claude CLI（`src/worker.js:164-175`）→ 两个 Python bridge（`src/context.js:188-196`；`src/memory.js:34-39,74-79`）。
- 热更新边界不完整：`SIGHUP` 只清 cache，不重建 adapter / scheduler 参数（`src/main.js:44-49,177-186`）；resumed session 还会跳过新 `system-prompt`（`src/worker.js:114-120,156-160`）。
- 文件态并发策略不一致：`sessions.json` 有锁（`src/session.js:30-44`），`cron-jobs.json` 无锁读改写（`src/cron.js:172-195,297-304`），而架构又允许 agent 直接改它（`CLAUDE.md:97`）；`MEMORY.md/USER.md` 也由后台 worker 直接写（`src/scheduler.js:592-637`）。
- 审批抽象带着不同安全语义。Slack 是真实审批（`src/adapters/slack.js:415-487`），WeChat 是自动批准一次（`src/adapters/wechat.js:375-378`）。

## 4. 改进建议

1. `高 / 中`：改 `src/scheduler.js`、`src/queue.js`，统一用 `profile:platform:threadTs` 作为运行时 key。
2. `高 / 中`：改 `src/config.js`、`src/worker.js`，把 `soul/scripts/workspace/data` 全部纳入 profile 根目录校验；同时恢复 `default` fallback，或删除该声明。
3. `高 / 高`：改 `src/context.js`、`src/adapters/slack.js`、`lib/docstore/docquery.py`，把 slug 推断、linked-thread 抓取、thread history 收拢为单一 context service。
4. `中 / 中`：改 `src/scheduler.js`、`src/worker.js`、`CLAUDE.md`，二选一：删除 `inject` 保持真 one-shot，或承认这是“短会话 worker”并重写不变量。
