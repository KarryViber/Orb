---
name: state-assumptions-before-acting
description: 非琐碎任务开工前显式化「我的解读 / 隐含假设 / 已知 tradeoff / 倾向方案」让 Karry 拦截；收工时同等显式化「这次牺牲了什么 / 高风险点要不要派 attacker 二次攻击」。Use when 任务 ≥3 步、含歧义解读、涉及 tradeoff、用户指令模糊有多种合理解读，或非琐碎任务即将收尾出结论。短指令作用层判定走 terse-intent-classifier。
provenance: user-authored
---

# State Assumptions Before Acting

非琐碎任务两端都摊牌：开工前把隐含假设摆出来让 Karry 拦截；收工前把盲点摆出来让 Karry 知道「这次没看哪条轴」。

借鉴 Yansu intent challenge（开工对齐）+ super-hermes constraint report（收工盲点），两端 hook 同一原则：把隐式判断升为显式声明。

## When to Use

**开工前触发**（满足任一即用）：
- 任务 ≥ 3 步且非纯执行（含设计决策 / 路径选择）
- 用户指令有 ≥ 2 种合理解读
- 涉及 tradeoff（性能 vs 简洁、即时 vs 持久、覆盖 vs 兼容）
- 改动会影响 Karry 之后的工作流（CLAUDE.md / skills / cron / 持久数据）

**收工前触发**（满足任一即用）：
- 出结论 / 给推荐 / 报告完成的非琐碎任务
- 调研、分析、复盘、spec 评审、code review 类输出
- 多步任务的最终交付，不是中间步骤

**不用**：
- ≤15 字短指令的作用层判定 → 走 `terse-intent-classifier`
- 已有 spec 且 spec 里已写清场景 → 走 `execplan`
- 单步 / 纯问答 / 明确无歧义的任务（「读这个文件」「跑这个脚本」）
- 中间步骤 / 进度回报（只在最终交付加 footer，不每步都加）

## 开工模板（动手前发给 Karry 的一段）

```
:thought_balloon: 开工前对齐：

*我的解读*
{用一句话复述任务目标，自己的理解版本}

*隐含假设*
- {假设 1，可能错}
- {假设 2，可能错}

*已知 tradeoff*
- {选项 A vs B}：A 偏 X，B 偏 Y。我倾向 A 因为 ...

*倾向方案*
{一句话方案 + 1-3 步骤}

*确认*：以上对吗？还是要改？
```

## 收工模板（结论后追加的 constraint footer）

```
:flashlight: 这次没看：
- {轴 1：例如 时效衰减 / 安全面 / 并发 / 成本 / 用户适应性}
- {轴 2}

*推荐下一步*：{要么明确「不需要」，要么指 1 个具体动作 — 例如「派 code-review subagent 攻击结论 4」「跑一遍 prism error_resilience 看遗漏的 silent failure」「3 天后回看决策是否仍成立」}
```

**触发 attacker pass 的硬条件**（满足即在 footer 里推荐）：
- 这次结论会落到生产 / 共享配置 / 对外动作
- 涉及不可逆操作（删数据、推生产、对外发送）
- 结论里含 ≥ 2 条「应该」「建议」类断言但只跑了一轮分析

attacker pass 落法：派 subagent（`subagent_type: pr-review-toolkit:code-reviewer` 或 general-purpose）只给结论 + 任务原文，让它专门攻击结论，不给本轮推理过程。

## 何时跳过模板直接动 / 直接收

**开工跳过**：
- 任务和上一轮强连续（Karry 刚说「继续」「OK」），假设已隐式确认
- 假设全部高置信（>90%）且无 tradeoff——直接做但在结果里 callback「我假设了 X，如不对告诉我」
- 紧急修复（Karry 说「快」「先救」）——先动后补对齐

**收工跳过**：
- 琐碎任务（单步 / 纯执行 / 信息查询）
- 中间进度回报（不是最终交付）
- 已经在 attacker pass 之后的最终输出（footer 已经隐含）

## Gotchas

- **不要**把开工模板用成话痨工具——4 段共 ≤8 行，超了就是没想清楚
- **不要**列假设清单 ≥5 条——说明任务本身没拆透，先拆任务
- **不要**「假设」其实是确定的事实（已读过的代码、明确的指令）
- 倾向方案必须是**单一推荐**，不要给选项让 Karry 选
- **收工 footer 不要凑**——「这次没看 X」如果 X 是凑的（任务本就不需要看），等于仪式性套话，宁可写「无明显盲点」
- **收工 footer 不要超 3 行**——盲点 ≤ 2 条，推荐下一步 1 条，再多说明任务本身就没收敛
- attacker pass 不是默认动作，是高风险任务才触发——日常调研 / 普通报告别浪费 turn

## 与相关 skill 的分工

| skill | 适用 |
|-------|------|
| `terse-intent-classifier` | ≤15 字短指令、含指代词、动词型短指令 |
| `state-assumptions-before-acting`（本文件） | 多步非琐碎任务、含歧义或 tradeoff、最终交付加 footer |
| `execplan` | >10 步骤、>30 文件、跨会话恢复 |
| `subagent-driven-development` | attacker pass 的实际派发流程 |

层次：terse-intent-classifier（秒级判层）→ state-assumptions（开工对齐 + 收工 footer）→ execplan（小时级方案）。

## 反模式

- :x: 不列假设直接干，做错再返工
- :x: 假设列了但是给「A or B 你选」（违反给推荐项原则）
- :x: 把对齐写成长篇方案——这是 execplan 的活
- :x: 每个任务都摆模板（琐碎任务直接做即可）
- :x: 收工 footer 写成「本次分析完整覆盖了所有轴」（仪式性套话，违反诚实原则）
- :x: 任何 footer 都默认派 attacker pass（浪费 token，attacker 是高风险任务才用）
- :x: 把 prism `references/prisms/*.md` 当 skill body 抄进来——它们是参考素材，不是 skill 内容
