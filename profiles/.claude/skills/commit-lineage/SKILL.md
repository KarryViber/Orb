---
name: commit-lineage
description: commit message 必带 lineage 锚点——若改动来自 spec / lesson / 决策原文，message 必须引用源路径。Use when 准备 git commit、用户说「提交」「commit」「频繁 commit」、或起草 commit message 时。
provenance: user-authored
---

# Commit Lineage

每次 commit 把代码改动反向锚定到 spec / lesson / 决策原文，长期可审计「为什么这行长这样」。

借鉴 Yansu traceable lineage 原则：每行代码都该能追溯到引发它的需求或决策。

## When to Use

- 准备执行 `git commit` 时
- 起草 commit message 时
- 用户说「提交」「commit」「先 commit 一下」

## 规则

commit message 末尾按需追加 lineage 行，使用以下锚点：

| 锚点 | 何时用 | 例 |
|------|--------|-----|
| `Spec:` | 改动来自 `workspace/specs/*.md` 的实施 | `Spec: specs/dm-routing.md#实施步骤-3` |
| `Lesson:` | 改动是为了规避某条踩坑复盘 | `Lesson: lessons/slack-stream-chunk-semantics.md` |
| `Decision:` | 改动来自架构决策原文（CLAUDE.md / soul / spec 的 Decision Log） | `Decision: CLAUDE.md#Worker-IPC-Protocol` |
| `Issue:` | 改动是为了修复一个 issue / 用户报告的 bug | `Issue: 2026-04-25 Karry 反馈 cron 卡死` |
| `Followup:` | 来自之前 commit 的遗留 TODO | `Followup: 40b358a` |

**没有源头的改动**（探索性 / 临时调试 / 重构）不强制带 lineage，但 message 主体要写清「为什么」。

## 模板

conventional commits + lineage 行：

```
{type}({scope}): {简述}

{可选 body}

Spec: specs/xxx.md[#section]
Lesson: lessons/yyy.md
```

## 例子

**好**：
```
feat(execplan): 加 ## 验收场景 段

借鉴 Yansu scenario-simulation，spec 草稿后增加 Karry 拍板 gate。

Spec: specs/yansu-borrow.md
Decision: CLAUDE.md#Surgical-Changes
```

**好**（无源头但 why 清晰）：
```
fix(worker): typo 导致 inject 失败

变量名 `injectId` 写成 `injetId`。
```

**坏**（有 spec 来源但没引用）：
```
feat: 新增场景段
```

## Gotchas

- **不要**为了凑 lineage 编造来源——没源头的改动主体写清 why 即可
- **不要**把 lineage 行写在 message 第一行（影响 oneline 可读性），只放末尾
- 引用 lessons 时用相对路径 `lessons/xxx.md`，不要绝对路径（commit history 跨机器看也能 grep）
- spec 引用最好带 `#anchor` 锚到具体段，否则 spec 长了找不到
- 多源头时一个锚点一行，不要堆在同一行

## 反模式

- :x: 每个 commit 都硬塞 lineage（没源头就别加）
- :x: `Spec: see above` / `Lesson: 见之前讨论`（不可追溯）
- :x: lineage 写在 message 主标题里
