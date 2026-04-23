# Delivery Hardening P3 — `markTaskCardFailed()` 封装

> 外部 session 执行工单。Delivery Hardening P2（3c51d10 / 0baf42a）+ EGF-2（`scheduler.js:729/862/1117` 的 `egress.reset()`）打完后的一次收尾 polish。把「`taskCardState.failed = true` + `egress.reset()`」这对必须成对的动作封装成一个方法，补齐唯一遗漏点（L959 deferred degrade），防止未来加降级路径时漏 reset 复现 final-text 丢失类 bug。

**scope 严格**：只改 `src/scheduler.js`，~15 行净变化。**不动** `egress.js` / `worker.js` / adapters / IPC。

## 背景

EGF-2 修的是「task card stream 失败后 egress fingerprint 污染」。三处 reset 点：

- `failTaskCardStream` 内部（L728-729）— 由 keepalive / startStream / appendTaskCardPlan 失败汇聚
- `stopTaskCardStream` 降级分支（L861-862）— stopStream 抛 ownership 错误
- `intermediate_text` handler 内联分支（L1116-1117）— appendStream 抛 ownership 错误

审计时发现还有一处 `turn.taskCardState.failed = true` **没配套 reset**：

- `deliverDeferredFinalResult` degrade 分支（L959）— deferred task_card 投递降级到 plain message

**当前语义下**该处是 no-op（deferred 模式全程不 admit，egress 集合为空），但：
1. 失去与前三处的对称性，读者会怀疑是遗漏
2. 如果未来 deferred 引入 intermediate admit，会复现 EGF-2 修的那类 bug

## 原则

1. **surgical**：只加一个内部闭包 + 替换三处直写；新增一处（L959）
2. **不碰** `failTaskCardStream`（L721-761）：它的清理范围远大于两行模式，内联替换会把 2 行塞进它的 15+ 行流中，心智不简化
3. **不引新语义**：函数行为 = 现有两行的精确等价

## 改动

### [P3MF-1] 新增 `markTaskCardFailed()` 闭包

**位置**：`src/scheduler.js`，建议放在 `resetTaskCardState`（~L708）和 `failTaskCardStream`（~L721）之间，保持 taskCard 相关闭包聚集。

```js
const markTaskCardFailed = () => {
  turn.taskCardState.failed = true;
  turn.egress.reset();
};
```

### [P3MF-2] 替换 L861-862 两行

**文件**：`src/scheduler.js`，`stopTaskCardStream` catch ownership 分支（L859-862 附近）

**现状**：
```js
if (failure.code === 'message_not_in_streaming_state' || failure.code === 'message_not_owned_by_app') {
  warn(TAG, `stopStream degraded to plain message: ${err.message}`);
  turn.taskCardState.failed = true;
  turn.egress.reset(); // [EGF-2] stopStream 降级前 reset，让 finalText 的 ssfe-edit / fallback admit 不被前轮 fingerprint 拦截
  const editableTs = turn.taskCardState.streamTs;
  ...
}
```

**改为**：
```js
if (failure.code === 'message_not_in_streaming_state' || failure.code === 'message_not_owned_by_app') {
  warn(TAG, `stopStream degraded to plain message: ${err.message}`);
  markTaskCardFailed(); // reset 确保 ssfe-edit / fallback admit 不被前轮 fingerprint 拦截
  const editableTs = turn.taskCardState.streamTs;
  ...
}
```

### [P3MF-3] 替换 L1116-1117 两行

**文件**：`src/scheduler.js`，`intermediate_text` handler 内联失败分支（L1114-1117 附近）

**现状**：
```js
if (code === 'message_not_in_streaming_state' || code === 'message_not_owned_by_app') {
  warn(TAG, `stream ownership lost, degrading to sendReply: ${code}`);
  turn.taskCardState.failed = true;
  turn.egress.reset(); // [EGF-2] stream 失败后清空 fingerprints，避免污染 fallback 路径的 final/后续 intermediate
}
```

**改为**：
```js
if (code === 'message_not_in_streaming_state' || code === 'message_not_owned_by_app') {
  warn(TAG, `stream ownership lost, degrading to sendReply: ${code}`);
  markTaskCardFailed(); // reset 避免污染 fallback 路径的 final/后续 intermediate
}
```

### [P3MF-4] 新增调用点 L959（deferred degrade）

**文件**：`src/scheduler.js`，`deliverDeferredFinalResult` catch warn 分支（L957-960 附近）

**现状**：
```js
if (failure.level === 'warn') {
  warn(TAG, `deferred task_card delivery degraded to plain message: ${err.message}`);
  turn.taskCardState.failed = true;
  try {
    const fallbackPayloads = buildFinalTextPayloads(text);
    ...
```

**改为**：
```js
if (failure.level === 'warn') {
  warn(TAG, `deferred task_card delivery degraded to plain message: ${err.message}`);
  markTaskCardFailed(); // defensive; deferred path doesn't admit today but keep parity with other degrade sites
  try {
    const fallbackPayloads = buildFinalTextPayloads(text);
    ...
```

### [P3MF-5] 不改 `failTaskCardStream`（L728）

`failTaskCardStream` 内部已有完整 cleanup（streamId/streamTs null / clearKeepalive / chunkType / fallback 渲染 / taskCards 清空 / status 恢复）。把其中两行抽出替换会把 `markTaskCardFailed()` 调用混进它自身的清理序列，**不简化心智**。保持现状，仅保留现有 L729 的 `egress.reset()` 内联调用。

---

## 验证

### 静态

```bash
node --check src/scheduler.js
```

### 逻辑校验（V1/V2/V3）

**V1**：三处替换点（L861 / L1116 / L959）行为与替换前**逐行等价**：
- L861 / L1116：原来就是 `failed = true; egress.reset();`，封装后等价
- L959：原来只有 `failed = true`（无 reset），封装后新增一次 reset；由于此刻 egress 集合在 deferred 路径下必为空（intermediate 早 return / turn_complete deferred 走 `deliverDeferredFinalResult`），`_seen.clear()` 作用于空 Set 是 no-op

**V2（正常 turn）**：`markTaskCardFailed` 永不被调用（`failed` 始终 false），行为不变。

**V3（EGF-2 原 bug 场景）**：长 turn + stream 中途失败 → L1116 改走 `markTaskCardFailed()` → `failed=true` + `egress.reset()` 同步执行，和 EGF-2 语义完全一致。

### 动态（可选）

无需重启验证，纯 refactor + 1 行新增 no-op。如要跑：

```bash
nohup bash -c 'sleep 3; launchctl kickstart -k gui/501/app.orb.daemon' > /dev/null 2>&1 & disown
```

然后 DM 发一条长任务，确认 task card + final text 正常。

---

## 完成标准

- [ ] `scheduler.js` 新增 `markTaskCardFailed()` 闭包
- [ ] L861 替换为 `markTaskCardFailed()`
- [ ] L1116 替换为 `markTaskCardFailed()`
- [ ] L959 新增 `markTaskCardFailed()` 调用 + defensive 注释
- [ ] `failTaskCardStream`（L728）内部保持原状
- [ ] `node --check` 通过
- [ ] `git diff --stat` 净变化 ≤ 15 行

## 不做的事

- **不**封装 `failTaskCardStream` 两行（见 P3MF-5）
- **不**改 `egress.js`
- **不**加 smoke test cron（roadmap 级，不进本 spec）
- **不**做 DeliveryFSM 重构（观察期）
- **不**改 IPC 协议 / worker.js / adapters

## Commit 策略

单 commit：
```
refactor(scheduler): encapsulate taskCard fail + egress reset as markTaskCardFailed

- Extract `failed=true; egress.reset()` pair into markTaskCardFailed() closure
- Apply at 3 existing sites (stopStream degrade / intermediate ownership error / deferred degrade)
- Adds defensive reset at deferred degrade site (L959) — currently no-op but keeps parity
```

## 重启（仅在需要验证时）

```bash
nohup bash -c 'sleep 3; launchctl kickstart -k gui/501/app.orb.daemon' > /dev/null 2>&1 & disown
```

---

**Owner notes**：本 spec 是 EGF-2 的 polish，不是新 bug fix。如果执行时发现 L861 / L1116 的实际代码与本 spec 描述不符（例如 EGF-2 注释已被其它改动覆盖），以代码为准 + 保留原有注释语义。
