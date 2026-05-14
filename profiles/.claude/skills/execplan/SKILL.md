---
name: execplan
description: 任务开工前用这个 skill 评估是否需要先写 spec。触发：涉及 ≥3 模块、>30 文件改动、>10 步骤、架构级决策、或用户说「先出方案 / 先写 spec」。生成的 spec 放 workspace/specs/
provenance: user-authored
---

复杂任务（>10 步骤、>30 文件、跨会话恢复、需要 Karry 审阅后 agent 独立推进）前写一份 ExecPlan，让**不知道任何上下文的新会话**也能接着干完。

基于 OpenAI Codex Exec Plans + Yansu scenario-simulation 改造。

## 双层触发（与 skill-factory 对称）

### 即时层：任务开工前的 Gate

每次 worker 收到任务，**开工前**先评估复杂度（不向用户输出评估过程，只在命中时开口）：

**命中门槛（满足任一就必须提议）**：
- 任务涉及 ≥ 3 个模块 / 文件目录
- 预估 > 30 个文件改动 或 > 10 个有序步骤
- 架构级决策（新增存储 / 改 IPC / 增 cron / 改 schema）
- Karry 明说「先出方案」「先写 spec」「先想清楚」
- 预估单次 worker 无法完成（需要跨会话推进）

**命中时的提议格式**（任务回复的开头，而不是夹在中间）：
```
:clipboard: 这个任务建议先写 ExecPlan
*理由*：{触发的具体门槛}
*spec 路径*：`workspace/specs/{kebab-name}.md`
*选项*：
  - `写 spec` — 我先出 ExecPlan 供你审阅再开工
  - `直接干` — 跳过 spec，立即执行
  - `我来写` — 你自己写 spec
```

用户回复「直接干」或已显式给出简单指令 → 不再追问，正常执行。
用户回复「写 spec」→ 按骨架写完 ExecPlan 并 commit，**等 Karry 在 `## 验收场景` 段对场景拍板后**再进实施 turn。

### 被动层：现有 spec 的活文档维护

进入 `workspace/specs/{name}.md` 相关任务时：
- 每个停顿点必须更新 Progress（勾选 / 拆分 / 时间戳）
- 发现意外 → Surprises & Discoveries 追加
- 改方向 → Decision Log 追加
- milestone 完成 → Outcomes & Retrospective 追加
- 每次 commit 带对应 spec 引用（`spec(xxx): ...`）

### 聚合层：spec 健康度按需巡检

用户说「巡检一下 spec / 看看 spec 状态」时执行：
- 扫 `workspace/specs/*.md`，按 Progress 未勾选比例、最后更新时间排序
- 发现 Progress 停滞 > 7 天且未标完结 → 报告
- 发现 Outcomes 未填但最后 Progress 显示 100% → 提醒补 retrospective
- 不自动修改 spec 文件，只做诊断

**不设 cron**（2026-04-18 决定，遵循简洁原则）。

## 核心铁律

1. **自包含**：单个文件看完就能干活，不依赖「你之前说过」「见上一版」
2. **活文档**：边做边改 Progress / Decision Log，不是写完就扔
3. **可验证结果**：每个 milestone 描述可观测的行为（跑什么命令、看到什么输出），不是「加了个 struct」
4. **绝对路径 + 具体命令**：文件路径从 repo root 写全，命令写清 cwd
5. **嵌入知识**：需要的背景直接写进来，不要「参见某博客」
6. **场景先于代码**（2026-04-25 起）：spec 草稿必带 `## 验收场景` 段（≥3 条），Karry 拍板才进实施。借鉴 Yansu，挡前置理解错位

## Orb 工作流约定

- **位置**：`~/Orb/profiles/<your-profile>/workspace/specs/{task-name}.md`
- **命名**：kebab-case，见名知意（`dm-routing.md` / `worker-zombie-cleanup.md`）
- **提交时机**：ExecPlan 本身就是一个 commit，后续每个 milestone 完成也要 commit
- **不要**在 ExecPlan 里再嵌套 ``` 代码块（用缩进块替代）；顶层也不必用 ``` 包裹整份文档
- **必带「执行」段**：spec 末尾必须有 `## 执行` 段，注明总 turn 预算；大改拆「调研 turn ≤ X」+「实施 turn ≤ Y」两段
- **必带「验收场景」段**（2026-04-25 起）：≥3 条 happy/edge/fail 场景，写完发 Slack 等 Karry 拍板后再开工

## 骨架（必须包含这些段）

```
# {动作短语标题}

## Purpose / 大图景
做完这个 Karry 能做什么之前做不了的？用户可见行为是什么？

## Progress
- [x] (2026-04-18 11:30 JST) 已完成项
- [ ] 待办项

## Surprises & Discoveries
- 观察: ...
  证据: {日志/测试输出}

## Decision Log
- 决策: 用 A 不用 B
  理由: ...
  日期: 2026-04-18

## Outcomes & Retrospective
（收尾写）

## Context / 当前状态
假设读者零上下文。关键文件写全路径，定义每个术语。

## Plan of Work
散文描述：改哪些文件（全路径）、加什么、为什么。

## 验收场景  ← Karry 拍板 gate
列 ≥3 条具体场景，每条写「输入 → 期望可观测行为」。覆盖至少：
- **Happy path**：典型成功用例
- **Edge case**：边界 / 罕见输入 / 并发 / 部分失败
- **Failure mode**：明确的失败行为（报错文案 / 降级路径 / 不该发生什么）

写完发 Slack 等 Karry 确认。Karry 改场景 = spec 调整；Karry 点头 = 进实施。

## Concrete Steps
具体命令 + cwd + 预期输出片段。

## Validation / Acceptance
跑什么、看到什么——对应「验收场景」每条要可执行验证。

## Idempotence / Recovery
能不能重跑？失败如何回滚？

## Interfaces / Dependencies
涉及的模块、函数签名、IPC 协议。写全限定路径。

## 执行
总预算 ≤ N turn；若是大改，拆「调研 turn ≤ X」+「实施 turn ≤ Y」两次 codex session。
```

## Milestone 原则

每个 milestone 独立可验证、增量交付。写 milestone 时讲故事：**目标 → 工作 → 结果 → 证据**。

## 什么时候更新 ExecPlan

- 每个停顿点：更新 Progress（必要时拆分「已做 X / 剩余 Y」）
- 发现意外行为：写入 Surprises，附证据
- 改变方向：写入 Decision Log，说明 why
- Milestone 完成：写 Outcomes 片段
- 大改完方向：文档底部加一条 revision note

## 反模式

- :x: 方案写一半，Progress 永远停留在 Day 1
- :x: 步骤抽象到「合理处理 X」「按架构调整」——新会话看不懂
- :x: 引用「上次那个 spec」但没 checked in
- :x: 验收写成「代码通过 lint」而不是「用户可看到的行为」
- :x: 每次停顿都不 commit，丢状态
- :x: **跳过验收场景评审直接进实施**（场景先于代码是硬约束）
- :x: 验收场景写成「能跑 / work / 不报错」——必须是具体可观测行为

## 与 Orb 其他 skill 的分工

| 工具 | 用途 | 触发层次 |
|------|------|---------|
| `execplan` (本文件) | 把**一次性复杂任务**拆成可独立执行的 spec | 即时 gate + 周扫 |
| `skill-factory` | 把**重复工作流**沉淀为可复用 skill | 即时提议 + 周聚合 |
| `state-assumptions-before-acting` | 开工前显式化假设 | 任务进入实施前 |
| `commit-lineage` | commit message 锚定 spec/lesson | 每次 commit |
