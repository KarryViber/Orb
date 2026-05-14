---
name: adopt-from-external-repo
description: 调研开源 repo 看「可偷什么」时，用这个流程——克隆读全源、按 ROI 排清单、审视现有系统、偷抽象不偷代码、融入现有机制不做加法。Use when 用户发 GitHub 链接 + 问「可以偷师 / 借鉴什么」，或你提议要参考外部项目。
provenance: user-authored
---

# Adopt From External Repo — 抽象收敛而非功能堆砌

## 核心原则

> *偷代码是加法，偷抽象是结构性收敛。*

当现有系统已经有一套机制在转（Orb 有 18 cron / 4 文档轴 / holographic / handlers），加功能几乎总是错的——应该找「把现有机制闭环起来的缺失抽象」。

## 五步工作流

### 1. 克隆 + 读全源（不要只看 README）

```bash
cd /tmp && rm -rf <name> && git clone --depth 1 <url>
wc -l <name>/**/*.{py,js,ts,md}     # 先知道总量
```

小仓库（<2000 行）全部读。大仓库按 README 的核心模块图挑 3-5 个关键文件。

### 2. 列「可偷清单」，按 ROI 初排

按什么标准判 ROI：
- *P0 立即可落地* — 一段可复用的工具函数 / 一个简单 pattern
- *P1 新能力* — 当前系统没有的机制（发散采样 / lifecycle / 反馈通道）
- *P2 治理增强* — doctor / schema / 日志
- *P3 小增强* — 命名 / 模板 / 辅助

### 3. *审视自身系统*（最关键的一步，别跳）

*盘 3 件事*：
- 有多少类似机制已在跑？（cron 数 / 文档轴数 / 积累的候选池 / 已有 handler）
- 哪些是「沉淀但不晋升」「产出但不消费」「存了但不打分」的*断点*？
- 偷的清单里哪些是**复制**现有（不做），哪些是**补断点**（做）？

*运行真实命令查数据*（见 lesson `data-reality-before-design`）：
```bash
wc -l <pool>              # 候选池真实行数
sqlite3 <db> "SELECT COUNT(*) WHERE ..."   # DB 当前状态
ls <cron-jobs>            # 现有调度
```

### 4. 翻转清单：从「加法」收敛为「一件结构性事」

最终输出*不是*偷来清单的子集，*是*一个把现有 N 处断点连起来的抽象。剩下的清单条目分类为：
- ✅ *做*（1-2 件结构性）
- 🔧 *小补丁*（健壮性级）
- ❌ *不做*（加法 / 已有功能重复 / 概念负担）

每条「不做」都要写出*为什么不做*（避免未来某天又想加）。

### 5. 融入而非叠加

*铁律*：零新 cron、零新文档轴、零新概念。新逻辑插进现有 cron 的 prompt / 现有 handler / 现有 pipeline。

实战手法：
- 新功能接进已存在但空转的基础设施（如 `skill-candidates.jsonl` 空着就直接用它）
- 周期性任务挂在现有 cron 的附加步骤，用「失败不阻塞主体」模式
- Slack 按钮复用 `handlers/` 框架（新增 handler 脚本 + action_id）

## 反模式

- ❌ 读 README 就开始列清单（源码里的约束 / 边角机制全漏掉）
- ❌ 直接抄单个脚本（加了新 cron、新文档轴、新概念负担）
- ❌ 跳过「审视自身」→ 叠加式膨胀
- ❌ 把「偷清单」本身当交付（应该是收敛后的一件结构性事）

## 验收标准

出结果时能清晰回答：
- *真正做的那一件* 是什么？解决哪 N 处断点？
- *不做的每条* 的理由是什么？
- *改动文件数* 和 *新增概念数* 分别是多少？（后者应该接近 0）

## 案例

本 profile 2026-04-23 的 *six6 → Seed Lifecycle* 调研就是典型落地：
- six6 6 模块 906 行全读
- 列出 9 条可偷（deadletter / atomic write / daydream / lifecycle / doctor / schema / pulse 语义 / evolution.md / tag 输出）
- 盘自身：Orb 有 18 cron / 4 文档轴 / 3 候选池但都不闭环 / trust_score = 0 的隐藏 bug
- 收敛为：*Seed Lifecycle 抽象* 一件事，把 `skill-candidates + evolution/suggestions + idea` 三池用 maturity + 浇水 + 晋升统一
- 零新 cron（复用 01:15 自进化 + 周一 10:30 归档建议周检），零新 handler 框架（复用现有）
