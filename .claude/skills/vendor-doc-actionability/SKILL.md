---
name: vendor-doc-actionability
description: 对外合作文档（交付文档 / POC 文档 / Solution Doc / 提案书）必须为每个「需对方执行」的动作写清具体操作入口（URL / 工单系统 / 脚本路径 / 联系人 + 联系方式 / 步骤编号）。Use when 给客户、vendor、合作方写交付文档、POC 文档、Solution Doc、提案书；或检视已有对外文档是否抽象到无法执行。
provenance: user-authored
---

# 对外合作文档必须含具体操作入口

## When to Use

- 给客户 / vendor / 合作方写交付文档（Solution Doc / POC 文档 / 提案书 / 工单 / SOW）
- 检视已起草的对外文档是否过于抽象
- Karry 说「写个交付文档」「整理给客户」「POC 出来一份给对方」

## 规则

每个「需对方执行的动作」都必须闭环——读者看完知道**下一步点哪里**。最低要素：

| 要素 | 形式 |
|------|------|
| **URL** | 具体登录页 / 文档页 / 工单系统入口 |
| **工单/系统** | 系统名 + 模块路径（例：「AWS Console > Service Quotas > Amazon Connect」） |
| **脚本路径** | 仓库 + 相对路径 + 命令行 |
| **联系人** | 姓名 + 角色 + 邮箱/Slack handle |
| **步骤编号** | 1.→ 2.→ 3. 显式编号，不要散文化 |

## 不可接受的写法

- 「申请配额」（缺 URL / 系统）
- 「联系 AWS Support」（缺联系入口、工单类型）
- 「按照流程提交」（缺流程指向）
- 「负责方：客户侧 IT 团队」（缺具体人 / 邮箱）
- 「相关文档参考官方说明」（缺 URL）

## 可接受的写法（对照）

- 「申请 External Voice Transfer 配额：AWS Console > Service Quotas > Amazon Connect > 'External Voice System Integration' → Request quota increase（建议值：5）」
- 「联系点：山田太郎（AWS TAM, taro.yamada@amazon.com），通过 Premium Support Case 提交，分类选 Account and billing > Service limit increase」
- 「执行命令：`cd ~/work/idom/scripts && python3 chime-quota-check.py`，输出在 `out/quota-status.json`」

## 为什么

对外文档是**交付物**不是思考记录。抽象逻辑看似完整，但读者不知道下一步去哪点 → 推进停滞 → 项目卡在「等对方动」的状态而对方根本不知道要动什么。

具体入口 = 可执行性 = 推进力。

## Gotchas

- ❌ 用「相关方」「负责团队」「按内部流程」等抽象主语逃避具体联系人
- ❌ 把「URL 后续补充」当占位符留下——要么现在查到，要么显式标 `TBD by <date>` 不让它沉默腐烂
- ❌ 中文文档里只写日文系统名（例：「サポートポータル」）不给入口 URL——客户找不到等于没写
- ❌ 把多步动作压成一句话——拆步骤编号才能让对方逐项打勾

## 与其他 skill 的关系

- `compliance-delivery-checklist` § 事实 / 措辞 → 本 skill 是「事实层」的可执行性标准
- `internal-solution-poc-document` / `internal-project-brief` → 模板写作时套用本 skill 的最低要素表
