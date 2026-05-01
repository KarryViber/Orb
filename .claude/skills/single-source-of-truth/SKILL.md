---
name: single-source-of-truth
description: 真相源单一律——意图 / 逻辑 / 状态三层都禁止「真相源数量 > 1」，否则必 drift。Use when 设计新模块/新流程时面对一个概念有多处可能维护其状态、值或定义；或排查 drift 类 bug（A 处和 B 处不一致）；或重构时合并散点逻辑/共享 worker 创建/状态机生命周期对齐时。
provenance: user-authored
---

# Single Source of Truth — 真相源单一律

## When to Use

- 设计新模块 / 新流程时一个概念有多处可能维护其值
- 排查 drift 类 bug（A 处和 B 处不一致 / 状态错乱 / 定义冲突）
- 重构时考虑合并散点逻辑、共享 worker 创建路径、状态机 touchpoint 对齐
- 用户问「这个值在哪定义的？」「为什么 A 和 B 不一样？」

## 核心定律

**对任何一个概念，其 source of truth 的数量 = 1**。

数量 > 1 → 维护人会 drift，时间会 drift，bug 必至。

## 三个维度（同模式不同表现）

| 维度 | 反模式 | 来源 fact |
|------|--------|----------|
| **用户意图** | 单歧义词不澄清，在多 turn 里各自假设 | fact_53 |
| **代码逻辑** | worker 创建散点，每处自己 spawn，不抽共享 | fact_34 |
| **运行时状态** | stream lifecycle 6 个 touchpoint 各管各的 arm/clear | fact_96 |

## Workflow

1. **定位 SoT**：面对一个概念先问「它的 source of truth 在哪？」
2. **数 SoT 数量**：若 > 1 → 必须处置
3. **二选一处置**：
   - **集中**：合并到单一 owner（一个文件 / 一个函数 / 一个 anchor 文件）
   - **派生**：保留一个 SoT，其余从它**只读派生**（不允许独立写）
4. **禁止各自维护**：每个分支自己写自己的 = drift 已发生

## 典型反例

- ❌ 用户问 `可以` 你假设是 A 意图执行；下一个 turn 又来个 `可以` 假设是 B → 两次假设独立 drift
- ❌ scheduler 一处 fork worker，cron 又自己 fork，调试时谁也不知道用哪个
- ❌ stream start 在 A，append 在 B，stop 在 C，error path 在 D 各自 setState → lifecycle 必断
- ❌ Anchor ts 一处写文件、一处 in-memory 缓存、一处 history 反查 → 三个真相源同时漂

## 典型正例

- ✅ Slack daily anchor → `data/<topic>-daily-anchor.json` 一个文件，所有调用读它
- ✅ Worker spawn 抽到 `scheduler.spawnWorker()`，cron / inject / 手动触发都走它
- ✅ Stream lifecycle 集中到一个 controller 类，6 个 touchpoint 都调它

## Gotchas

- ❌ 「这次先复制一份，以后再统一」——以后没有了，drift 立刻发生
- ❌ 「我加个缓存做加速」——缓存是派生层但写也走它就变成第二个 SoT
- ❌ 把「文档」当 SoT，但代码里硬编码值不引用文档——文档腐化必至
- ⚠️ 派生层必须**只读**派生；任何能写的派生层都是新 SoT

## 与其他 skill 的关系

- `state-assumptions-before-acting` → 把「我假设 SoT 是 X」显式化让 Karry 拦截
- `terse-intent-classifier` → 短指令意图歧义就是「用户意图层 SoT 数量 > 1」的早期检测
- `truth-ladder` → 状态汇报阶梯本身就是「状态 SoT 单一律」的具体落地（attempted/observed/confirmed 不允许并存为同一事的真相）
