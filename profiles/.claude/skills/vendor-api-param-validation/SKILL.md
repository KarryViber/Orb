---
name: vendor-api-param-validation
description: 第三方 API / SDK 集成开工前，强制先列参数 checklist 并对照官方文档逐项验证（名称 / 类型 / 必填 / 默认 / 上限），通过后再编码——不是「写完再调通」。Use when 新接 vendor API/SDK（Slack / LongPort / freee / LLM API 等）、既有集成追加新 endpoint 或新字段、用户说「调通某接口」「接入 X」「集成 X」。
provenance: user-authored
---

# Vendor API 参数前置验证

## When to Use（满足任一）

- 新接 vendor API / SDK：Slack / LongPort / freee / Anthropic / OpenAI / AWS / Google API 等
- 既有集成追加新 endpoint / 新字段
- 用户说「调通 X 接口」「接入 X」「集成 X 服务」「这个接口怎么调」
- 准备开始写第一行调用代码前

## Workflow

### 1. 列参数 checklist（编码前）

按 endpoint 列表格：

| 字段 | 位置 | 类型 | 必填 | 默认 | 上限 / 取值 | 来源页 |
|------|------|------|------|------|-------------|--------|
| `channel` | body | string | Y | — | C/D/G prefix | <doc URL> |
| `text` | body | string | Y* | — | ≤4000 chars | <doc URL> |

`位置` = path / query / header / body / form。`必填` 标 Y/N/conditional。`来源页` 必须是 vendor 官方文档 URL，不是 SDK README / blog。

### 2. 对照 source of truth

- ✅ vendor 官方 API reference（developer portal / docs.vendor.com）
- ❌ Stack Overflow / blog / 第三方 SDK README / 老 issue
- 三方资源只能作辅助，最终以 vendor 官方页为准

### 3. 发现歧义立刻问

- 文档没说必填？→ 问，不要按经验填默认
- 类型模糊（string vs enum）？→ 问 / 翻 vendor changelog
- 上限不明（max length / rate limit）？→ 翻 docs，找不到就构造测试探测一次再记录

### 4. checklist 完成才开始编码

跳过 checklist 直接写代码 = 把 debug 时间从「编码前 5 分钟」推到「编码后 30 分钟 + 已 commit + 已被引用」。

## 为什么

编码后才发现参数差异 → 已经写了引用 / 已经 debug 过 / 已经 commit → 返工成本远高于前置验证。

vendor 文档是唯一 source of truth：
- SDK wrapper 有滞后（vendor 改了字段，SDK 没跟）
- blog 容易过期（写于旧版本）
- Stack Overflow 答案常基于错误前提

## Gotchas

- ❌ 用 SDK 类型定义当 source of truth——SDK 字段可能比 API 少 / 字段名 snake_case vs camelCase 转换
- ❌ 跳过「条件必填」验证——LongPort `replace_order` 的 `quantity` 在 ELO 单和 LO 单条件不同
- ❌ Slack `filesUploadV2` 的 `channels` vs `channel_id` 历史改名，老文档还写 `channels`
- ❌ 信任 vendor 错误码文档——很多 vendor 实际返回的 error 字段比 doc 列的多 / 少；要拿真实 sandbox 探一次
- ❌ 不验证 rate limit / size limit → 上线后 burst 触发 429 / 413 才发现

## 与其他 skill 的关系

- `truth-ladder` → 验证后说「checklist 已完成」是 attempted，调通一次拿到响应是 observed，跑过完整流程才是 confirmed
- `execution-discipline` § Fail-fast / 边界处悲观 → 本 skill 是「边界处悲观」在 vendor API 边界的具体落地
- `slack-cli-api-reference` / `longport-*` 等工具类 skill → 用本 skill 验证后的 checklist 落到对应 vendor 的工具类 skill 里沉淀
