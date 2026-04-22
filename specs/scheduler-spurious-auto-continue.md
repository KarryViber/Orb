# spec: 修复 turn_complete 后的误触发 auto-continue

## 根因

`src/scheduler.js:1130-1151` 的 `result` handler 看到 `!text` 就触发 auto-continue 通知 `⏳ 回合上限已达…`。

但 Orb 的正常流程里，一个 turn 先通过 `turn_complete` 事件交付全部文本 → idle timeout → CLI exit(0) 触发 `result` 事件，此时 `result.text` **本就该是空的**（内容早发完了）。scheduler 把这种"正常收尾"误判为"空结果"，发出误导性通知。

实际触发场景：用户回答已经看到 Orb 的完整回复，等一分钟后 Slack 突然蹦出 `⏳ 回合上限已达（正在: Bash），自动续接中 (1/2)…`，体验上像"Orb 自言自语"。

## 修复

`src/scheduler.js:1139` 前加守卫：

```js
if (msg.type === 'result') {
  let text = msg.text?.trim() || null;
  const silentDeferredResult = deferDeliveryUntilResult && isSilentResultText(text);
  finalResultText = text || '';
  try {
    if (taskCardState.streamId && !taskCardState.failed && !turnDelivered) {
      await stopTaskCardStream(text);
      turnDelivered = true;
    }
+   // 正常流程：turn_complete 已交付内容后，CLI exit 的空 result 是预期的收尾信号
+   // 不是真·失败，不应该触发 auto-continue
+   if (!text && turnDelivered) {
+     this._autoContinueCount.delete(threadTs);
+     return;
+   }
    if (!text) {
      const retries = this._autoContinueCount.get(threadTs) || 0;
      ...
```

`turnDelivered` 在本文件中在以下位置被设为 true：
- L1137 `stopTaskCardStream` 后
- `turn_complete` handler 里文本成功交付时
- `intermediate_text` 已交付且 `turn_complete` 也已处理时

选 `turnDelivered` 作为守卫是因为它精确表达"这个 turn 已经有内容被交付给用户"。如果 turn_complete 没触发（真失败），`turnDelivered` 为 false，auto-continue 路径保持原样。

## 不改

- `turn_complete` 分支（L1?? 周围）逻辑不变
- auto-continue 文案、次数、pending dispatch 逻辑不变
- 仅堵住"已交付后收到空 result 也走 auto-continue"这一条路径

## 验证

1. 修改 scheduler.js
2. `launchctl kickstart -k gui/$(id -u)/com.orb.claude-agent` 重启
3. 在 Slack thread 发一个简短消息（让 Orb 秒回）
4. 等 60+ 秒（idle timeout 触发 CLI exit）
5. 检查 thread — 不应该出现 `⏳ 回合上限已达` 通知
6. 反向验证：触发一个真·max-turns 场景（例如让 Orb 连续跑 30+ 工具调用），确认 auto-continue 通知仍正常出现

## 提交

commit msg: `fix(scheduler): 修复 turn_complete 后 CLI exit 空 result 误触发 auto-continue`
