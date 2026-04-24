# Slack 集成整固 Sprint（2026-04-24 审计驱动）

## 背景

过去 3 天 Slack 集成 100+ commits 密集改动（task card 叙事化、Qi 卡引入、EgressGate、TurnState、stream rotate/keepalive、DM routing、inject_failed fail-forward 等），存在反复 revert/重做信号（`6305551 revert → 4b14ae6 B1 修正版`）。2026-04-24 代码审计（`pr-review-toolkit:code-reviewer`）识别 4 条 P0 + 4 条 P1 真实隐患。本 spec 一次性整固，再堆新功能前先补债。

**健康评估**：2.5/5，技术债已到必须停下加测试/整固的水位。

**核心债务**：
- Qi 卡异常路径兜底完全缺失（与 taskCard 对称度差）
- `turn` 闭包串轮风险（`let turn` 被多处 setTimeout/promise 捕获 binding）
- DM routing fallback 违反明文铁律
- scheduler.js 2309 行零集成测试

## 系统特性约束（改动前必读）

- **Claude Code CLI 是唯一 runtime**，不引入其他 LLM SDK
- **Worker 生命周期**：per-thread 短寿，首消息 fork，同 thread 通过 `inject` IPC 复用，idle 超时退出，不跨 thread 复用
- **Orb 运行时不能改自己源码**：外部 session 执行本 spec；daemon 由 launchd 管理
- **IPC 协议**：worker↔scheduler 消息类型固定，改动须同步 `worker.js` 头注释、`scheduler.js` handler、`~/Orb/CLAUDE.md` § Worker IPC Protocol
- **Slack stream API**：4 分钟软限制、`message_not_in_streaming_state` / `message_not_owned_by_app` 异常路径、per-turn per-message，不跨 inject 复用

## 工作项

### P0-1: DM routing fallback 纠正（违反静默铁律）

**文件**：`src/adapters/slack.js:1692-1805` `_routeDMMessage`

**问题**：rule 命中但 postMessage 失败时返回 `fallback: 'worker'`，上层 `_handleMessage` 把 rule 命中后 API 故障的情况走普通 DM worker 路径——会在 DM 里 fork worker 回答，违反 `workspace/CLAUDE.md` § DM 入站路由 铁律「API 失败 → 依然先建目标频道卡片，thread 里说明「待补」，不回退到 DM 反问」。

**修复**：
1. rule 命中 + API 失败：降级建"待补"卡片到目标频道（不回 DM），返回 `{ routed: true, degraded: true }`
2. rule 未命中：保留 `fallback: 'worker'` 走常规 DM 回答路径
3. 两条路径返回值分开，不共用 `fallback` 字段语义

**验收**：
- 手动断网或 mock `chat.postMessage` 抛错，DM 发 X 链接，Orb 在 DM **不出任何回复**，目标频道（`#10-x-ops`）出现"待补"卡片
- rule 未命中的普通 DM 消息仍走 worker 回答

---

### P0-2: Qi 卡异常路径兜底（对齐 taskCard 对称度）

**文件**：`src/scheduler.js:1264-1283, 1486-1556, 1937-1950` + `src/worker.js:89-120, 751-791`

**问题**（3 条子项）：

**(a) `qi_finalize` catch 只 warn，不 stopStream 兜底** — `scheduler.js:1537-1556`
```js
try {
  await adapter.appendStream(streamId, [...]);
  await adapter.stopStream(streamId);
} catch (err) {
  warn(TAG, `[qi_finalize] failed: ${err.message}`);  // ← stopStream 被跳过
}
```
`appendStream` 抛错 → `stopStream` 永不执行 → Slack 端 Qi 永远卡在「Orbiting…」直到 4 分钟自动关闭。

**(b) worker 异常退出不清 Qi stream** — `scheduler.js:1264-1283` `finalizeTaskCardsOnAbnormalExit`
只处理 `turn.taskCardState.streamId`，完全不动 `turn.qiStreamId`。长任务 timeout/OOM kill 时 Qi 卡永不收尾。

**(c) `qi_start` 失败无降级** — `scheduler.js:1508` 附近
startStream 失败只 warn，`qiStreamId` 保持 null，后续 `qi_append` 静默 return，工具已跑但用户看不到 Qi 进度。

**修复**：
1. 提取 `closeQiStream(turn, { reason, emitFinalize? })` helper，封装 stopStream try/catch + editMessage 兜底为静态终态（`Settled`）
2. `qi_finalize` 走该 helper；appendStream 抛错仍尝试 stopStream
3. `finalizeTaskCardsOnAbnormalExit` 改名为 `finalizeStreamsOnAbnormalExit`，覆盖 taskCard + Qi 两条 stream
4. `qi_start` 失败标记 `turn.qiStreamFailed = true`；`qi_append` handler 检查此标志，失败时降级走 `progress_update` 等价路径（或静默但 warn）

**验收**：
- mock `adapter.appendStream` 抛错触发 `qi_finalize`，Slack 端 Qi 卡在 1s 内变成「Settled」静态卡（不再转圈）
- kill worker（SIGKILL）强制 abnormal exit，Slack 端 Qi 和 taskCard 都在 scheduler onExit 后收尾
- mock `startStream` 抛错，后续 3 个工具调用不把 scheduler 卡死；warn 日志清晰

---

### P0-3: `turn` 闭包串轮防护 — 引入 `abandonTurn(prevTurn)`

**文件**：`src/scheduler.js:1652-1667` `turn_start` handler + 全局 `let turn` 捕获点

**问题**：顶层 `let turn` 被 setTimeout（rotate/keepalive）、qi_finalize finally `if (turn.qiStreamId === streamId)`、status_refresh 等**多处 closure 捕获 binding**（不是 snapshot）。`turn_start` rebuild（或 inject_failed 重建）时：
- 前一轮 setTimeout 未触发的 rotate/keepalive 还持有新 `turn` 引用
- 前一轮 async handler 如 `qi_finalize` 的 finally 检查新 `turn`（实际想检查的是旧）
- 旧 streamId 引用如果没及时 stopStream，会泄漏

目前 `clearKeepalive()` 只清 timer 不关 stream，`clearStatusRefresh()` 同理。

**修复**：
1. 新增 `abandonTurn(prevTurn)` helper：
   - 兜底 stopStream 所有持有的 streamId（taskCard、Qi）
   - 清 EgressGate / pendingPermission 对应条目
   - 清所有 setTimeout handle（rotate / keepalive / status_refresh）
2. `turn_start` 先 `await abandonTurn(turn)`，再 `turn = makeTurnState(...)`
3. `inject_failed` 重建路径同样调用
4. 所有 setTimeout callback 内先检查 `if (turn !== capturedTurn) return;`（或改为在 `abandonTurn` 里置 `prevTurn.abandoned = true` 供 callback 短路）

**验收**：
- 单元测试：mock 连续 2 轮 `turn_start` 间隔 < 100ms，前轮 rotate setTimeout 在 200ms 后触发，不应影响新 turn 的 streamId
- 集成测试：用户 fast follow-up（<1s 内 2 条消息），Slack 端前一轮 Qi/taskCard 都有明确终态，不留孤儿

---

### P0-4: `inject` 写入失败兜底

**文件**：`src/worker.js:807` `child.stdin.write(msg + '\n')`

**问题**：write 不在 try 里。CLI close stdin 后再 write 会抛 `ERR_STREAM_DESTROYED` / `EPIPE`，worker 进程未捕获异常 → uncaughtException → crash → scheduler 走 abnormal exit 路径，那一轮输出全丢。

触发场景：scheduler 发第一个 inject → worker 发 `inject_failed` → worker 在 close CLI（`_activeCli.close()`）到 process exit 之间收到第二个 inject → stdin 已关但 process 还活着 → write 抛。

**修复**：
```js
function inject(msg) {
  try {
    if (!child?.stdin?.writable) return false;
    child.stdin.write(msg + '\n');
    return true;
  } catch (err) {
    ipcSend({ type: 'inject_failed', ...pendingInject });
    return false;
  }
}
```

**验收**：mock CLI stdin 提前 close，连发 2 条 inject，worker 不 crash，第二条走 `inject_failed` → scheduler fail-forward 到新 worker。

---

### P1-1: `intermediate_text` 与 `result` 的去重用 `subtractDeliveredText`

**文件**：`src/scheduler.js:1866`

**问题**：
```js
} else if (turn.intermediateDeliveredThisTurn && text) {
  info(TAG, `result text already delivered via intermediate stream, skip sendReply`);
  turnDelivered = true;
}
```
把 `intermediateDeliveredThisTurn=true` 当作"全文已发"，不对比内容。若 Claude 分两段 text block 输出，第一段 intermediate 发了，第二段未触发 intermediate（debounce + result 紧随），final `text` 被整段吞。

**修复**：走 `subtractDeliveredText(text, turn.egress)`（或等价 dedupe），只 skip 已交付部分，剩余部分 sendReply。

**验收**：mock Claude 发两段 text block（段 1 触发 intermediate，段 2 紧跟 result 无 debounce），Slack 端两段都送达。

---

### P1-2: `rotateStream` 成功后 reset EgressGate

**文件**：`src/scheduler.js:918, 929`（rotate 路径）

**问题**：rotate 起新 streamId，前 stream 已 stopStream；但 `turn.egress` 的 fingerprint 仍持有前 stream 已 admit 内容。下一轮新 stream 首条 append 相似内容会被 dedup 吞。

**修复**：rotate 成功分支末尾加 `turn.egress.reset()`。

**验收**：mock 4min rotate，rotate 后 intermediate_text 内容与 rotate 前相似（如"继续分析..."），新 stream 能 admit。

---

### P1-3: `_autoContinueCount` 入口清零

**文件**：`src/scheduler.js` submit / task 入口

**问题**：inject 新 task 入口不清 `_autoContinueCount.get(threadTs)`。tool-only turn 连续时（result 空文本且 turnDelivered=false 分支），前轮计数残留会消耗新轮续接 quota。

**修复**：scheduler 接到新 `submit(threadTs, ...)`（非 inject 延续）时 `_autoContinueCount.delete(threadTs)`。

---

### P1-4: TodoWrite `plan_snapshot` 覆盖 displayMode

**文件**：`src/scheduler.js:1586-1591`

**问题**：
```js
if (!turn.taskCardState.displayMode && typeof msg.display_mode === 'string') {
  turn.taskCardState.displayMode = msg.display_mode;
}
```
先有 `tool_call`（非 TodoWrite）设了 displayMode，随后 TodoWrite plan_snapshot 不再覆盖。B1 改造遗留的顺序依赖。

**修复**：TodoWrite `plan_snapshot`（`isTodoWriteSnapshot`）take precedence 覆盖 displayMode='plan'、chunk_type='task'；worker 侧可增加一个 `override_display_mode: true` 标志显式表达。

---

### P2-1: scheduler 集成测试骨架

**文件**：新建 `test/scheduler-ipc-statemachine.test.js`

**目标**：覆盖 scheduler 最脆弱的 IPC 状态机路径，为后续改动建安全网。

**最小覆盖**：
1. **Stream 生命周期**：mock adapter，驱动 `task → turn_start → tool_call → plan_snapshot → turn_complete → result`，断言 startStream/appendStream/stopStream 调用序列
2. **Rotate**：4min+ 长 turn，断言 rotate 后 EgressGate reset
3. **Qi 生命周期**：`qi_start → qi_append × 3 → qi_finalize`，以及 `qi_start → qi_append → [abnormal exit]`，断言 finalizeStreamsOnAbnormalExit 覆盖
4. **inject_failed 回放**：mock worker 发 inject_failed，断言 scheduler unshift 到 threadQueue 并 fork 新 worker
5. **Turn abandon**：连续 2 轮 turn_start 间隔 < 100ms，断言 `abandonTurn(prevTurn)` 被调用且旧 streamId 被 stopStream

**验收**：4-5 条测试全绿，CI（npm test）运行 < 10s。

---

## 执行顺序与分阶段

**Phase A**（违反铁律 / 信息丢失，优先）：
1. P0-1 DM routing fallback
2. P0-2 Qi 异常兜底（(a)(b)(c) 一起）

**Phase B**（竞态 / 状态泄漏）：
3. P0-3 abandonTurn
4. P0-4 inject write 兜底

**Phase C**（次级正确性）：
5. P1-1 ~ P1-4 四条

**Phase D**（测试）：
6. P2-1 集成测试骨架

每个 Phase 独立 commit，Phase 之间可停下让 Karry 验证 Slack 实际行为（用真实 DM/频道消息触发）。

## 非目标（本 spec 不做）

- 不重构 scheduler.js 拆分（先补测试再拆）
- 不引入新 IPC message type
- 不改 Qi 卡 UX 呈现（只修生命周期）
- 不改 Claude CLI 调用方式
- 不调整 `defaults.model/effort` / `ORB_WORKER_TIMEOUT_MS` 等配置

## 相关上下文

- 审计报告：本 spec 上方 thread 审计结论
- 系统约束：`~/Orb/CLAUDE.md` § Worker IPC Protocol / Task Card Routing / Task Card Lifecycle / Immutable Constraints
- Agent 约束：`~/Orb/profiles/karry/workspace/CLAUDE.md` § Agent 运行时约束 / DM 入站路由 / 执行纪律
- 相关历史 specs：`dm-routing-assistant-thread-fix.md`, `delivery-hardening-p3-mark-failed.md`, `scheduler-spurious-auto-continue.md`, `task-card-v3.*-REPORT.md`

## 完工标准

- [ ] 4 条 P0 + 4 条 P1 修复全部合入，每条有对应 commit
- [ ] `test/scheduler-ipc-statemachine.test.js` 骨架测试 ≥5 条全绿
- [ ] 手动 Slack 验证：DM routing 断网场景 + Qi 异常 + fast follow-up（< 1s 两条消息）+ 长任务 rotate
- [ ] `~/Orb/CLAUDE.md` Worker IPC Protocol 表按需更新（如新增 `override_display_mode` 字段）
- [ ] 本 spec 归档到 `specs/.archive/`
