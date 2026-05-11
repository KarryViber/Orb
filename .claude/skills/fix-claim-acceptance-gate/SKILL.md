---
name: fix-claim-acceptance-gate
description: Use when about to claim a bug is "已修复 / 已改正 / fixed / resolved / 修好了" — requires producing a diff anchor (file:line showing the actual change) AND a receipt (failing repro that now passes, or log showing the original symptom is gone). 仅声明「我改了」「应该好了」「逻辑上对」不构成验收。补充 verification-before-completion 的修复场景专项门槛。
---

# Fix-Claim Acceptance Gate

## When to Use

声明任何一条 bug / 问题 / 异常「已修复 / 已改正 / fixed / resolved / 修好了 / 应该好了 / 这次对了」之前。

不论场景：代码 bug / 配置错误 / cron 失败 / Slack 投递异常 / 数据脏了 / 文档错了——只要要说「修好了」，就过本 gate。

## The Two-Receipt Rule

修复声明必须同时出示：

**① Diff 锚点**（你改了什么）
- 具体 `file:line`（不是「我改了 worker.js」，而是 `src/worker.js:243-251`）
- before / after 片段，能让读者一眼看到改动本身
- 来源：`git diff` / Edit tool 的 old_string→new_string / 文件 Read 验证落盘

**② Receipt 证据**（改动让原症状消失）
- 原 bug 的最小复现，现在跑通（test pass / 命令 exit 0 / 日志干净）
- 或：原症状的负向证据（grep 找不到错误关键字 / 监控指标恢复 / 接口返回正确值）
- 来源：fresh 跑出来的命令输出，不是「之前跑过应该还行」

**只有 ① 没有 ②** = "我改了代码"，不是"修好了"
**只有 ② 没有 ①** = "现在能跑了"，但不知是不是你的功劳
**两个都没有** = 在猜

## Common Failures

| 反例声明 | 缺什么 | 正确做法 |
|---------|--------|---------|
| "我把那个 bug 修了" | diff + receipt 都缺 | 贴 file:line + 跑一次复现命令 |
| "应该好了你试试" | receipt 缺 | 自己先跑通再报，不外包验证 |
| "改了 worker.js 加了 null 检查" | diff 不够具体 + receipt 缺 | 给 file:line 范围 + 触发原 bug 路径看是否还炸 |
| "tests 都过了" | diff 没绑定到 bug | 说明哪个 test 对应原 symptom，证明它之前会 fail |
| "日志看起来正常" | receipt 太弱 | 说出原 error 关键字，证明现在 grep 不到 |
| "逻辑上应该没问题" | 全靠脑补 | 跑一次再说 |

## Red Flags — 立刻停手

声明里出现以下任一，**先回到 gate 补证据再发**：

- "应该 / 大概 / probably / should be"
- "我改了 X" 但没说改了什么、在哪、改了哪几行
- "你试试看" / "再跑一下看看"
- "linter 过了" 当作 bug fix 证据
- "agent 说做完了" 当作 receipt
- 修复 + 立即声明完成，中间没有 verify 步
- reflection / cron / 自动化窗口内的"修复完成"声明（最容易跳过 gate 的场景）

## Why This Exists

**Session 8 反思（2026-05-06）**：reflection 窗口内的修复声明绕过了 verification-before-completion，因为通用 skill 的 trigger 是"complete/passing"，"已修复"语义被忽略；且没要求"diff + receipt"双证据。

generic verification skill 是 framework，本 skill 是 fix-specific instance：修复声明=改动+症状消失双 lock，缺一不立。

## Interaction with Other Skills

- **verification-before-completion**：通用门槛（任何完成声明都要 evidence）。本 skill 是它在「修复」语义上的特化。
- **debug-audit-on-second-miss**：第 2 次假设没命中根因强制 audit。本 skill 是第 1 次声明修复时的入口检查；audit 触发后再进 audit skill。
- **truth-ladder**：判断声明强度。本 skill 给修复声明设定「diff + receipt = 强声明」「只有 diff = 中声明」「都没 = 不允许声明」三档。
- **claim-vs-reality-margin**：修复声明 vs 实际状态的 gap 监控。本 skill 是它的 fix 子集 enforcement。

## Bottom Line

**No "fixed" claim without diff + receipt.**

改动 + 症状消失 = 修复
只有改动 = "我动了代码"
只有症状消失 = 巧合，不是你的功劳
两个都没 = 在 hallucinate

不可妥协。reflection / cron / 自动化窗口同样适用。
