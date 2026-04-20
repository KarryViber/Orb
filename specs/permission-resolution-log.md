# Permission Resolution Logging

## 背景

`src/scheduler.js` 当前只在权限请求到达时打印日志：

```
[scheduler] permission approval requested: thread=… tool=… request=…
```

resolution（allow/deny/timeout）没有对称日志，审计时看不出请求最终如何结束。

## 改动

在 `src/scheduler.js` 的 `_handlePermissionRequest` / Slack 回调 / 超时处理三条路径中，resolve 前追加一行：

```js
info(TAG, `permission resolved: thread=${threadTs} request=${requestId} action=${action} latency=${latencyMs}ms`);
```

字段：
- `action`: `allow` | `deny` | `timeout`
- `latency`: 从 `permission approval requested` 到 resolution 的毫秒数（用 `Date.now()` 捕获起始时间戳存到 pending map）

## 验收

1. `~/.claude/settings.json` 临时去掉 `Write(*)` → 发消息触发 → 点 Allow → 日志出 `action=allow`
2. 同样触发 → 点 Deny → 日志出 `action=deny`
3. 同样触发 → 不点等 300s → 日志出 `action=timeout`

## 范围

单文件改动（`src/scheduler.js`），估 15 行增量。不改对外接口。
