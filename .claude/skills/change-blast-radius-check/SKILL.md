---
name: change-blast-radius-check
description: 改动开工前强制评估爆炸半径，避免「修一漏二 / 头疼医头」。Use when 改动涉及：删除文件/符号、重命名、路径迁移、接口签名变更、状态机修改、短路逻辑修正、配置 key 改名，或用户原话含「改 X / 删 X / 重命名 / 迁移 / 重构 X / 修这个 bug」+ 该 X 在多处被引用。不适用于纯新增、孤立 bugfix（无外部依赖）、文档/注释改动。
---

# change-blast-radius-check

改动开工前强制走三步爆炸半径评估，把「改这一处」升级为「这一处的所有兄弟和上下游一起改」。

## When to Use

触发词命中任一即召回：
- **删除类**：删文件 / 删符号 / 删字段 / 删配置 key / 删 step
- **重命名类**：rename / 改 key 名 / 改函数名 / 改路径
- **迁移类**：路径迁移 / 模块拆分 / scope 变更（system ↔ workspace）
- **接口类**：函数签名改、参数增删、返回结构变
- **状态机/逻辑类**：状态枚举增删、短路条件修正、分支合并
- 用户原话含「修这个 bug / 改 X / 重构 X」且 X 在 ≥2 处被引用

不召回：纯新增功能、孤立 bugfix（grep 旧符号 ≤1 命中）、纯文档/注释。

## 强制三步（开工前必须完成）

### Step 1: 全仓 grep 旧符号
对**每一个**要改的符号 / 路径 / 配置 key：
```
Grep "<old_symbol>" 全仓（含 specs/ data/ scripts/ profiles/）
Grep "<old_path>" 全仓
```
命中点全部列进 TodoWrite，每条 = 一个待改 todo。**不允许只改触发本次任务的那一处。**

### Step 2: 反向追上下游
问三个问题：
1. **谁调用我**：当前改动点的 caller 是谁？config / cron job / spec / handler 脚本里有没有引用？
2. **我调用谁**：当前改动点依赖什么？删了之后下游会不会断链？
3. **动态拼接**：CLI args / 模板字符串 / config 插值（`${VAR}`）/ 反射调用里有没有藏引用？grep 不到的隐式依赖必须人工想一遍。

### Step 3: 同类存量扫描
本次 bug / 改动是不是有兄弟实例？
- 修了 A 路径的短路逻辑 → B / C 路径有没有同样的短路？
- 删了 step 5.5 → 其他 step 的上游动态有没有同模式依赖？
- 改了 cron A 的 deliver.mode → 同分类 cron 有没有一并改？

**Truth-ladder 第二探针的预防版**：等用户问「之前出现的几个同类处理了吗」就晚了，开工时就扫。

## Case Study（本周 3 次失误锚点，2026-05-04 ~ 05-09）

| Case | 主动线（改了） | 漏掉的从属线 | 教训 |
|---|---|---|---|
| Step 5.5 删除 | 删了 step 5.5 节点 | 上游动态依赖 CLI 参数没同步删 | Step 1 grep 漏 |
| evolution_aggregate.py 路径 drift | 改了脚本主路径 | 调用方 cron / handler 没跟随 | Step 2 反向追漏 |
| [SILENT] 短路修正 | 修了主路径短路 | 副路相同短路逻辑没改 | Step 3 同类存量漏 |

## 落地动作

开工首条 TodoWrite 必须是：「跑 blast-radius check：grep <X> + 反向追 caller + 同类扫描」。这一条不完成不允许写第一行 Edit。

完成后把命中点全部展开成后续 todo 项，再开始改。

## Gotchas

- **动态拼接最容易漏**：`f"step_{n}"` / `${CONFIG_KEY}` / 反射调用，grep 不到字面量。Step 2 必须人工想一遍。
- **specs/ 和 data/ 也要扫**：旧 spec 里的引用、cron jobs.json 里的命令字符串、handler 脚本——这些不在 src/ 但会被 runtime 加载。
- **不要被「改完测了能跑」骗**：本次改动跑通不代表兄弟路径没断，CI 不一定覆盖。Step 3 同类扫描比测试更可靠。
- **TodoWrite 不能省**：「我心里记着」= 没记着。命中点超过 3 个就必须落 TodoWrite，否则推进中漏项。
