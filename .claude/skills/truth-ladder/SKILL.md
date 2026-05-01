---
name: truth-ladder
description: 状态放行三层阶梯（attempted / observed / confirmed）—— 汇报任务、API、命令、消息或外部动作状态时强制分层，避免把"动作已发起"误写成"结果已达成"。Use when 准备写「任务已完成」「API 返回成功」「exit code 0」「用户已收到」「ok:true」类状态汇报；或在 cron 报告 / Slack 回报 / project status / receipt 中表达完成度时。
provenance: user-authored
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

## 与其他纪律的关系

- `execution-discipline` § 状态诚实 / 副作用留据 → Truth Ladder 是落地写法
- `operation-receipt` → receipt 内的状态字段直接遵循三层
- `compliance-delivery-checklist` → 对外交付前 7 点审查含「事实」一项，本 skill 是事实分层标准

## One-liner

**attempted ≠ observed ≠ confirmed，三级不可跳。**
