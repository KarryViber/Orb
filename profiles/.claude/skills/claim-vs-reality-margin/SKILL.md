---
name: claim-vs-reality-margin
description: 声明≠现实——任何「X 已配置 / 已声明 / 已建立」必须配 margin 量化 + detection 机制，否则把声明当现实。Use when 设计依赖外部能力的方案（vendor partnership / TTL refresh / cron schedule / health check / 配额申请 / SLA 承诺）；或评审「我们已经 X」「客户说会 X」「config 配好了」类陈述；或排查「明明配了为什么没生效」类问题。
provenance: user-authored
---

# Claim ≠ Reality — Margin 显式化

## When to Use

- 设计依赖外部能力的方案：vendor partnership、TTL/refresh、cron schedule、health check、配额、SLA
- 评审陈述：「我们已经 X」「客户说会 X」「config 配好了」「partnership 已签」
- 排查「明明配了为什么没生效」「按理应该 work 啊」类问题
- 写对外承诺前（提案 / SOW / Solution Doc）

## 核心定律

**「声明 X = 实现 X」是默认错觉。**

每次说「X 已 OK」都必须强制问两件事：

1. **margin 在哪？**——从声明到失败之间的安全余量是多少？
2. **detection 在哪？**——失败时谁先发现？多久发现？

没有这两个 → 声明只是声明，不是现实。

## 三个典型映射

| 声明 | margin 应在哪 | detection 应在哪 | Source fact |
|------|---------------|------------------|-------------|
| **Vendor partnership ≠ infra capability** | capability gap 表（partnership 提供什么 vs 实际所需） | 集成阶段先做 capability matrix POC 验证，不是上线后才发现缺 | fact_50 |
| **Refresh interval ≈ TTL ≠ 永远不过期** | interval ≤ TTL / 2（至少留一次重试余量） | refresh 失败 alert + token 过期前 X 分钟主动探活 | fact_39 |
| **Cron 已配置 ≠ 在跑** | last-run 时间戳监控 + 漏跑阈值 | 主动 health check（不是等用户发现没收到报告） | fact_52 |

## Workflow（声明前自检）

```
对每个「我们已经 X / 已配 X / X 会发生」的陈述：
1. X 失败的具体形态是什么？（timeout / quota exceeded / token expired / cron skipped）
2. 失败到被察觉之间有多久？（margin）
3. 谁第一个看到失败？（detection 主体）
4. 1-3 任一答不上来 → 这条声明不能落地
```

## Gotchas

- ❌ 「partnership 已签」当作「能力具备」——签是商务，能力是工程，两件事
- ❌ TTL 1h / refresh 50min ≈ "够了" → race condition 概率 = (refresh 抖动)/(TTL margin)，不留 50% margin 必爆
- ❌ Cron schedule 写对了 ≠ 它在跑——launchd unload / daemon crash / disable flag 都让它静默死
- ❌ 「客户说会做 X」当作 X 已发生——直到看到 PR / 工单关闭 / 实测才是 observed
- ❌ 配置文件 commit 了 ≠ 配置生效了——很多 reload 是 SIGHUP only / 重启 only

## 与其他纪律的关系

- `truth-ladder` → margin / detection 是 attempted → observed → confirmed 三级跳的具体保障；本 skill 是「为什么需要三级」，truth-ladder 是「怎么写三级」
- `vendor-api-param-validation` → vendor 边界悲观验证是本 skill 在 API 集成场景的特化
- `vendor-doc-actionability` → 对外文档里每个动作要配 margin 也要配 detection（谁触发 / 谁验收）
- `execution-discipline` § 边界处悲观 / 副作用留据 → 本 skill 是「悲观」的可操作化

## One-liner

**没有 margin + detection 的声明，等于赌博。**
