# spec: config.json 默认 model/effort 可配置化

## 背景

`src/scheduler.js:545` 目前硬编码 `if (!effectiveEffort) effectiveEffort = 'low';`，`effectiveModel` 无硬编码默认（落到 CLI 自身默认）。Karry 想在 `config.json` 声明式控制默认 model/effort，不再改源码。

## 目标

- `config.json` 新增 `defaults.model` / `defaults.effort` 字段（可选）
- Scheduler fallback 链：消息前缀 `[opus]` `[effort:high]` > 关键词升级 > **config.defaults** > 内置兜底
- 内置兜底保留当前行为（effort=low，model 不传）以兼容 config 未设的情况
- 不动 IPC 协议、不动 worker.js、不动 cron 字段语义

## 修改

### 1. `config.json`

顶层加：
```json
"defaults": {
  "model": "opus",
  "effort": "medium"
}
```

Karry 初始值设 `opus` / `medium`。

### 2. `src/config.js`

暴露 `getDefaults()`：
```js
export function getDefaults() {
  const config = loadConfig();
  return {
    model: config.defaults?.model || null,
    effort: config.defaults?.effort || 'low',  // 保留内置兜底
  };
}
```

### 3. `src/scheduler.js`

- import `getDefaults`
- 改 L524-545 fallback 链：

```js
const defaults = getDefaults();
let effectiveModel = null;
let effectiveEffort = null;
// ... 前缀解析不变（L527-536）
// ... 关键词升级不变（L538-542）

// 新 fallback 顺序：前缀 > 关键词 > config.defaults > 内置
if (!effectiveModel) effectiveModel = defaults.model;
if (!effectiveEffort) effectiveEffort = defaults.effort;
```

`defaults.effort` 在 `getDefaults()` 已保证非空（兜底 `'low'`），所以不再需要 L545 的二次兜底。

### 4. `CLAUDE.md`（~/Orb/CLAUDE.md § Config）

加一段：
> `defaults.model` / `defaults.effort` — Slack 人工触发 worker 的默认模型/推理深度。优先级：消息前缀 `[model]`/`[effort:X]` > 关键词自动升级 > `defaults.*` > 内置兜底（effort=low，model 不传）。SIGHUP 不刷新（仅重启 daemon 生效）。

## 不影响

- Cron 任务：`cron-jobs.json` 里每个 job 显式写 `model/effort`，worker 直接用，不经 scheduler fallback 链
- Worker IPC：payload 字段不变，scheduler 填好 effectiveModel/effectiveEffort 传给 worker
- 关键词自动升 xhigh 逻辑（L539-542）保持在 defaults 之前，不被覆盖

## 验证

1. `config.json` 加 `"defaults": { "model": "opus", "effort": "medium" }`
2. `launchctl kickstart -k gui/$(id -u)/com.orb.claude-agent` 重启 daemon
3. Slack DM 发 "hello"（无前缀、无关键词）→ 检查 `logs/stdout.log` 确认 `--model opus --effort medium` 被传给 CLI
4. Slack DM 发 "[haiku] [effort:low] hello" → 确认前缀生效、覆盖 config 默认
5. Cron 任务到点触发 → 确认仍按 job 字段执行，不受 config defaults 影响

## 不做

- 不为 profile 级别的 defaults 留口子（youAGBI 再说）
- 不改 cron-jobs.json schema
- 不加 CLI 命令管理 defaults（直接改 config.json 即可）
