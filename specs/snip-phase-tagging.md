# Snip / Phase Tagging — Thread 历史分阶段折叠

## 背景

目前 `adapters/slack.js:fetchThreadHistory` 截取 Thread 最后 30 条消息 / 8000 字符全量回灌。长 thread（日常工作容易到 50+ 消息）会触发硬截断，老上下文整体丢失；同时当前阶段也被老阶段的冗余话挤占。

参考 Claude Design 系统提示里的 snip 机制（每条消息带 `[id:mNNNN]`，阶段完成后注册 snip，pressure 大时折叠），在 Orb 里做一个轻量版：**按阶段折叠，当前阶段保留全文，历史阶段只留一句摘要**。

## 核心思路

1. **Agent 自标阶段**：每次 Orb 回复开头（或末尾）加一个阶段标签：`[phase:research]` / `[phase:plan]` / `[phase:exec]` / `[phase:review]`。由 SOUL.md 或 workspace CLAUDE.md 写入行为约束。
2. **Fold 规则**：拼 thread 历史时，以阶段切换点分段。最新阶段保留全文，之前每个阶段只保留第一条 Orb 消息 + 最后一条（入口 + 结论），中间折叠成 `… (折叠 N 条 · phase:xxx) …`。
3. **向后兼容**：没有 `[phase:xxx]` 标签的老消息，全部视为 `phase:legacy`，走老的截断规则。

## 改动范围

### 改动 1：workspace CLAUDE.md — 行为约束

在「Slack 频道输出格式」之后加一节：

```md
## 阶段标签（Phase Tagging）

每次 Thread 内回复开头加一个阶段标签，便于后续 context 折叠：

- `[phase:research]` — 调研 / 查资料 / 读代码
- `[phase:plan]` — 给方案 / 列选项 / 排 ROI
- `[phase:exec]` — 实施 / 改文件 / 跑命令
- `[phase:review]` — 复盘 / 验证 / 回报结果

**只在 Thread 内部回复加，主消息（频道首条）不加。**
单轮对话（DM 一次性问答）可省略。

示例：
> `[phase:plan]` 挑三个真能落地的，按 ROI 排序...
```

### 改动 2：`adapters/slack.js:fetchThreadHistory` — 折叠逻辑

在 `lines` 组装后（当前 `src/adapters/slack.js:321` 之前），加折叠：

```js
// Phase-based folding: group Orb messages by [phase:xxx] tag, fold old phases
const PHASE_RE = /\[phase:([a-z-]+)\]/i;
const segments = []; // { phase, msgs: [line] }
let current = { phase: 'legacy', msgs: [] };
for (const line of lines) {
  if (line.startsWith('Orb: ')) {
    const m = line.match(PHASE_RE);
    if (m) {
      if (current.msgs.length > 0) segments.push(current);
      current = { phase: m[1].toLowerCase(), msgs: [line] };
      continue;
    }
  }
  current.msgs.push(line);
}
if (current.msgs.length > 0) segments.push(current);

// Keep last segment full; fold all earlier segments
const folded = [];
for (let i = 0; i < segments.length; i++) {
  const seg = segments[i];
  const isLast = i === segments.length - 1;
  if (isLast || seg.phase === 'legacy' || seg.msgs.length <= 2) {
    folded.push(...seg.msgs);
  } else {
    const first = seg.msgs[0];
    const last = seg.msgs[seg.msgs.length - 1];
    const middle = seg.msgs.length - 2;
    folded.push(first);
    if (middle > 0) folded.push(`… (折叠 ${middle} 条 · phase:${seg.phase}) …`);
    folded.push(last);
  }
}

const content = folded.length > 0 ? folded.join('\n') : null;
```

替换原 `const content = lines.length > 0 ? lines.join('\n') : null;`。

### 改动 3（可选）：显式 `snip` 工具

暂不做。Claude CLI 没有 agent-defined tool 机制，加 IPC 消息类型成本超过收益。Fold 完全由 adapter 自动做。

## 验收

1. 人工在 Slack Thread 里连续跑 3 个阶段的对话（含 `[phase:research]` / `[phase:plan]` / `[phase:exec]` 标签）
2. 触发 worker 第 4 轮对话，检查 thread history 注入内容：前两个阶段应该被折叠成「首条 + 折叠 N 条 + 末条」
3. 无 phase 标签的老 thread 行为与原来一致（直接截断到 8000 字符）

## 不做

- 不改 MAX_HISTORY_CHARS / MAX_HISTORY_MESSAGES（fold 本身就减压）
- 不做跨 thread 的 snip（没必要）
- 不做 phase 自动推断（交给 agent 自标，人肉标签更准）

## 工作量

- workspace CLAUDE.md：5 min
- slack.js 折叠逻辑：1-2h（含测试）
- 单元测试建议加在 `tests/adapters/slack.test.js`（若存在），覆盖：有标签 / 无标签 / 混合 / 只有一个阶段四种情况
