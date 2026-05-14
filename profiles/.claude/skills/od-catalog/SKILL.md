---
name: od-catalog
description: Open Design 渐进式设计工具索引——113 skills + 145 design systems 目录，按需加载到 workspace
---

# Open Design Catalog

当用户需要生成设计产物（landing page / dashboard / deck / 移动端 / 邮件 / 海报 / 视频帧等），从本索引选择合适的 skill + design system，用 `od-load.sh` 加载后执行。

## When to Use

- 用户要求生成 web prototype、slides/deck、mobile mockup、poster、wireframe 等视觉产物
- 用户说「做个页面」「出个 deck」「画个线框图」「设计一个 XX」
- 需要特定品牌风格（Stripe / Linear / Vercel / Apple 等）的视觉产物

## 工作流

1. 根据任务从下方索引选 skill + design system
2. 运行加载脚本：
   ```bash
   bash ~/Orb/profiles/<your-profile>/scripts/od-load.sh <skill-name> [design-system-name]
   # 首次自动 clone repo；用过的 skill 自动 symlink 到 ~/Orb/.claude/skills/od-* 供后续 session 复用
   ```
3. 脚本会把 SKILL.md 和 DESIGN.md 内容输出到 stdout——**直接读取并按其指令生成产物**
4. 产物输出到当前工作目录（手动 `open file://` 看视觉效果）

## Skill 索引

### Prototype（web/desktop/mobile 页面）

| Skill | Platform | 用途 |
|-------|----------|------|
| `web-prototype` | desktop | 通用单页 web 原型 |
| `web-prototype-taste-brutalist` | - | 编辑/报纸/瑞士设计风 |
| `web-prototype-taste-editorial` | - | Notion/Linear 风营销页 |
| `web-prototype-taste-soft` | - | Apple/Linear 级高端消费者风 |
| `saas-landing` | desktop | SaaS landing page |
| `waitlist-page` | desktop | 预发布等候页 |
| `pricing-page` | desktop | 定价页 |
| `dashboard` | desktop | 管理/分析仪表盘 |
| `docs-page` | desktop | 三栏文档页 |
| `blog-post` | desktop | 长文编辑排版 |
| `email-marketing` | desktop | HTML 营销邮件 |
| `invoice` | desktop | 可打印发票 |
| `kanban-board` | desktop | 看板 |
| `finance-report` | desktop | 财务报告 |
| `eng-runbook` | desktop | 工程运维手册 |
| `pm-spec` | desktop | 产品 PRD |
| `team-okrs` | desktop | OKR 追踪器 |
| `hr-onboarding` | desktop | 入职计划 |
| `meeting-notes` | desktop | 会议记录 |
| `mobile-app` | mobile | iPhone mockup |
| `mobile-onboarding` | mobile | 三屏引导流程 |
| `gamified-app` | mobile | 游戏化多屏原型 |
| `magazine-poster` | desktop | 杂志风海报 |
| `social-carousel` | desktop | 社交轮播 |
| `clinical-case-report` | desktop | 医学病例报告 |
| `wireframe-sketch` | desktop | 手绘线框图 |
| `social-media-dashboard` | desktop | 社媒分析仪表盘 |
| `live-dashboard` | desktop | 实时仪表盘 |
| `critique` | desktop | 设计评审报告 |

### Deck（HTML slides）

| Skill | 用途 |
|-------|------|
| `html-ppt` | 通用演示（主 skill，8+ 主题） |
| `simple-deck` | 简约 deck |
| `weekly-update` | 周报 deck |
| `ib-pitch-book` | 投行 pitch book |
| `kami-deck` | 纸系编辑 deck |
| `html-ppt-pitch-deck` | Pitch deck |
| `html-ppt-product-launch` | 产品发布 |
| `html-ppt-tech-sharing` | 技术分享 |
| `html-ppt-weekly-report` | 周报 |
| `guizang-ppt` | 中文风 PPT |

30+ zhangzara 风格变体（`html-ppt-zhangzara-*`）和 12 个 html-ppt 视觉变体可用。

### 其他

| Skill | Mode | 用途 |
|-------|------|------|
| `image-poster` | image | 图片资产 |
| `hyperframes` | video | HTML→视频 |
| `video-shortform` | video | 短视频 ≤10s |
| `audio-jingle` | audio | 音频 jingle |
| `design-brief` | design-system | 设计简报→DESIGN.md |

## Design System 索引（145 个）

**Fintech**: `stripe` · `revolut` · `wise` · `mastercard` · `binance` · `coinbase` · `kraken`
**AI/LLM**: `claude` · `openai` · `mistral-ai` · `cohere` · `huggingface` · `elevenlabs` · `replicate` · `runwayml` · `ollama` · `together-ai` · `x-ai`
**DevTools**: `vercel` · `cursor` · `github` · `expo` · `raycast` · `superhuman` · `warp` · `lovable`
**SaaS**: `notion` · `linear-app` · `slack` · `discord` · `cal` · `mintlify` · `duolingo` · `zapier` · `arc`
**Retail**: `shopify` · `airbnb` · `nike` · `starbucks` · `meta`
**Media**: `apple` · `spotify` · `uber` · `nvidia` · `spacex` · `pinterest` · `xiaohongshu` · `theverge` · `wired`
**Design**: `figma` · `framer` · `webflow` · `canva` · `miro` · `airtable`
**Data**: `supabase` · `mongodb` · `sentry` · `posthog` · `clickhouse` · `hashicorp`
**Auto**: `tesla` · `bmw` · `ferrari` · `lamborghini` · `bugatti` · `renault`
**通用**: `minimal` · `clean` · `modern` · `simple` · `sleek` · `premium` · `professional` · `elegant` · `bold` · `colorful` · `dramatic` · `neobrutalism` · `brutalism` · `editorial` · `creative` · `cosmic` · `fantasy`
**特效**: `glassmorphism` · `neumorphism` · `claymorphism` · `gradient` · `neon` · `bento`
**复古**: `retro` · `vintage` · `paper` · `dithered`
**特殊**: `kami` · `warm-editorial` · `default` · `shadcn` · `mono`

## 上游同步

`~/.od-repo` 由 cron `od-upstream-sync`（每周一 04:00 JST）自动 `git pull`，保持索引不过期。如发现新 skill / DS 不在本索引，是上游加得快于索引更新——可手动 `git -C ~/.od-repo log --since="1 week ago" --oneline skills/ design-systems/` 看新增，必要时让 Karry 触发 catalog 重生成。
