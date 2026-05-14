---
name: askuserquestion-triggers
description: 何时调 AskUserQuestion 工具（出 Slack Block Kit 选择卡）vs 何时直接做 / 文字反问。Use when 用户指令含「帮我看下 / 可以吗 / 你看着办 / 哪个 / 选 / 用 X 还是 Y」等歧义表达；或动作不可逆（push/删/对外发）且有多个等价方案；或同一指令有 ≥2 种合理解读且代价差异大。Skip when 自己能 grep/读文件查到、常规决策、thread 近 5 条已有就近答、cron worker。
---

# AskUserQuestion 触发规则

## When to Use

满足 **≥1 条**就**必须**调 `AskUserQuestion` 工具（不是文字反问 a/b/c）：

1. **多解读 + 代价差异大**：同一指令有 ≥2 种合理解读且选错代价不对称
   - 「清理下」→ 删 vs 归档？
   - 「换客户名」→ A 客户全局替换 vs 仅本文件？
   - 「修这个 bug」→ 改根因 vs 加 workaround？
2. **不可逆动作 + 多等价方案**：动作不可逆（push / git reset --hard / 删文件 / 对外发消息 / 撤单）且至少 2 个候选
   - 回退到哪个 commit？
   - push 到 main 还是 feature branch？
   - 撤销 A 单还是 B 单？
3. **开放式表达 + 上下文不足**：用户用「帮我看下 / 可以吗 / 你看着办 / 随便 / 都行」等表达，且 thread / context / 代码无法定向
   - 不要把「你看着办」当作"任意发挥"许可——是要你**给候选**让他选
4. **批量放权 + done 标准歧义**：Karry 用「干 / 派吧 / 全做 / 派 codex」等批量放权词，且任务的 done 标准存在 ≥2 种合理验收线
   - 「派吧，干」+ 任务是 holographic 抽取修复 → done 是「能跑通」还是「窗口恢复正常天均」？
   - 「派 codex 跑」+ 任务是 cron 异常清理 → done 是「本次异常闭合」还是「同类存量全扫一遍」？
   - 推 2-3 个候选 done 标准让他一键点选，比事后被 truth-ladder 探针追省 1-2 轮
   - 不适用于：done 标准从 spec / 上下文已明确（如「跑完 Step 3 通过验收」）/ 任务琐碎一目了然

## When NOT to Use（防 chatty）

- **自己 grep/读文件就能查到**：先查再问；查不到再问
- **常规决策低阻力**：默认 Opus low-thinking 走 INTJ 自主判断；不要把所有决策点都抛给 Karry
- **Thread 近 5 条已有就近答**：同一会话刚拍过板的事别再问
- **Cron worker**：cron 默认 `disablePermissionPrompt=true`，AUQ 自动 deny；cron prompt 不应触发 AUQ
- **简单是非问题**：「要继续吗」「要 commit 吗」这类已经隐含答案的别绕弯，直接做或直接问
- **Done 标准已明确**：spec 已写 / 上下文 thread 已定 / 任务 trivially 验收 → 不要为了「显式化」硬塞 AUQ

## 落地协议

调用形态：
```
AskUserQuestion({
  questions: [
    { question: "...?", header: "≤12 字标签",
      options: [{label, description}, ...],   // 2-4 个
      multiSelect: false }                     // 默认单选；"想跑哪几个"用 multi
  ]
})
```

约束：
- **一次最多 4 题**——超过说明你拆得太细，先做主决策再问后续
- **每题 2-4 选项**——3 个最佳；选项 `description` 写清 tradeoff 别只写 label
- **不要塞 Other 选项**——MVP 自动给「Other...」按钮支持自定义文本输入
- **永挂等答**——AUQ callback 不超时，等 Karry 点为止；不要怕"卡住"用文字 fallback

与既有 skill 联动：
- `terse-intent-classifier`：判定到「需要先问」时 → 出 AUQ 而不是文字列作用层
- `state-assumptions-before-acting`：把"显式化假设"中的"哪种解读"那一层 → 出 AUQ
- `coding-agent-workflow`：派 codex / 自己做 / Task fork 三选时 → 出 AUQ
- `terse-intent-classifier` 的「短指令含指代」判定 → 反问改 AUQ
- **批量放权 done-criteria**：放权词命中且 done 模糊 → 推候选 done 标准 AUQ（见 When to Use #4）

## Gotchas

- **AUQ 不是 confirmation dialog**：「我要做 X，确认吗？」这种是噪音；只有"做哪个 / 怎么做"才用
- **不要套娃**：用户答完一轮 AUQ 不要立刻发第二张追问细节——要么一次性把 1-4 题打包，要么动手做完再说
- **Cron / 长跑后台任务调到 AUQ 会 hang**：cron worker 的 `disablePermissionPrompt` 已自动 deny；自己派的 codex external session 不应使用 AUQ（外部 session 是无人值守跑）
- **option.value 限长 150 char**（Slack 硬限制）——MVP 实现已自动短编码，但**不要在 question/option label 文本里塞超长内容**预防卡 Slack
- **option.label 显示截断 ~75 char**——长 label 会被 Slack 截尾；description 字段可以长点放 tradeoff 解释
- **AUQ 在 cron / DM-routing / bookmarks-intake 等无人值守路径里调 = 死锁**：这些路径有专门 skill 约束「自驱不反问」，要遵守
- **Done-criteria AUQ 别滥用**：每次「派吧」都问 done 会反噬批量放权效率；只在 done 真有歧义且代价差异大时推（自进化/数据完整性/对外动作类高 ROI；纯重构/修 bug/文档改动通常不需要）

## 反例（不要这么干）

❌ 「我要 commit 这 5 个文件，确认吗？」（noise）
❌ 「请回复 a 选 X，b 选 Y，c 选 Z」（应该是 AUQ）
❌ AUQ 第一题问"做不做"，第二题问"怎么做"（应该合并：用 multiSelect 或第一题就直接给具体方案）
❌ 在 cron 里调 AUQ（必死）
❌ 用户已经说「按你建议」还出 AUQ（他已经放权，直接做）
❌ 「派吧，干」每次都附 done-criteria AUQ（done 已明确时纯噪音）

## 正例

✅ 「这个 spec 我应该自己做、派 codex、还是 Task fork？」三选 + tradeoff description
✅ 「检测到客户名同时出现 IDOM 和 ニッコクソフト，需要替换哪个？」选项 + 影响范围
✅ 「准备 push，目标分支」main / feature/xxx / 不 push 三选
✅ 「派吧，干」+ holographic 抽取修复 → AUQ 推三档 done：「脚本能跑通无报错 / 当日窗口恢复天均 / 三天 backfill 完毕入库」让 Karry 选验收线
