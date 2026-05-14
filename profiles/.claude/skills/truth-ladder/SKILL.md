---
name: truth-ladder
description: 状态放行三层阶梯（attempted / observed / confirmed）—— 汇报任务、API、命令、消息或外部动作状态时强制分层，避免把"动作已发起"误写成"结果已达成"。Use when 准备写「任务已完成」「API 返回成功」「exit code 0」「用户已收到」「ok:true」类状态汇报；或在 cron 报告 / Slack 回报 / project status / receipt 中表达完成度时。
---

# Truth Ladder — 状态放行阶梯

## When to Use
- 准备写「任务已完成」「API 返回成功」「exit code 0」「用户已收到」「ok:true」「已发出」「已通知」等状态结论
- cron 报告、receipt、project status update、Slack 收尾消息
- 多步外部动作（发消息 / 写文件 / 调 vendor API）执行后的回报

## 三层状态

| 层 | 含义 | 证据要求 |
|----|------|---------|
| **attempted** | 动作已发起 | exit code 0 / 命令跑完 / 函数返回 |
| **observed** | 外部已观察到变化 | API `ok:true` 且拿到 ts/id / 文件落盘 / DB 行写入 |
| **confirmed** | 最终目标方/下游验收达成预期 | 人工确认 / 下游系统验收 / 用户回执 |

## 规则

1. **默认从 attempted 起步**——没有外部可观测证据就不上 observed
2. **observed ≠ 终点**——系统回 success 不代表用户真收到、事情真成
3. **confirmed 必须有第三方确认源**（人 / 下游 / 真实目标方）
4. **写事实而非结论**——记录 `ok:true` / id / path / timestamp，不直接写「已完成」
5. **禁止跳级**——没 observed 证据不写 confirmed；没 attempted 事实不写任何成功状态
6. **源端必须新鲜**——任何状态判断的「证据」必须来自当下读取（grep / cat / API call / log tail），禁止凭 commit message、thread 记忆、上一轮自己说的话推断当前 src 或外部系统状态

## 典型映射

- 命令 exit 0 → **attempted**
- Slack `chat.postMessage` 返回 `ok:true` + ts → **observed**
- 用户在 thread 里 react / 回复确认看到 → **confirmed**
- cron 脚本跑完没报错 → **attempted**（不是「报告已送达」）
- vendor API 200 OK → **observed**（不是「客户已知悉」）

## Gotchas

- ❌ 把「命令跑完了」写成「任务已完成」
- ❌ 把「API 成功了」写成「用户已经收到」
- ❌ 为了显得利索跳过中间状态
- ❌ 摘要里只写结论不写支撑事实（id / ts / path）
- ❌ Slack 投递后只看 ok:true 就报 confirmed——message_not_in_streaming_state 类降级失败也是 ok:true 后发生的
- ❌ **凭 commit message 推断 src 现状**——commit 描述「修了 X」≠ 当前 src 真的修好了；动手前必须 grep 当前文件验证。反例：04/29 funnel 5 笔重构方向全错的共同根因就是凭 thread 记忆 + commit log 推断 dedup 在哪一层做的
- ❌ **凭 thread 记忆判断脚本是否跑过**——「我刚才发了命令」≠「命令真的执行成功」；必须 ps / log tail / 产物文件 stat 三选一验证。反例：04/29 setsid 不存在导致脚本根本没跑，12 分钟后 Karry 探针才暴露
- ❌ **凭 stdout 尾巴判断「都跑完了」**——log 末尾安静≠任务完成，可能是 hang / 中断 / 输出走 stderr。反例：04/30 codex log 尾巴误判

## 「好了吗」探针识别

用户说「好了吗 / 完成了吗 / 好了吧 / 跑完没」时，**默认假定自己上一轮的状态报告是 attempted 但被错说成 confirmed**——回复前必须重新跑一次源端验证（不是回看 thread 历史），把当前真实状态按三层重新分类。

## 与其他纪律的关系

- `execution-discipline` § 状态诚实 / 副作用留据 → Truth Ladder 是落地写法
- `debug-audit-on-second-miss` → 第 2 次 patch 不中走 audit 时，所有「已试假设 / 已排除方向」的事实必须遵循本 skill 的源端新鲜原则
- `operation-receipt` → receipt 内的状态字段直接遵循三层
- `compliance-delivery-checklist` → 对外交付前 7 点审查含「事实」一项，本 skill 是事实分层标准

## One-liner

**attempted ≠ observed ≠ confirmed，三级不可跳；证据必须当下重读，禁止凭记忆。**
