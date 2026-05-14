---
name: opencli
description: 通用 CLI 框架——79+ 适配器把网站/App 转为 CLI。Use when 需要把新外部服务（GitHub/Notion/Slack/X 以外）包成 CLI、或查已有适配器能力。X/Twitter 场景改走 x-twitter skill。
provenance: user-authored
---
# opencli

## When to Use
需要通过 CLI 读取/操作网站数据时（非 X 写入场景）。

## 安装状态
- 版本: v1.7.3 (`npm install -g @jackwener/opencli`)
- Daemon: port 19825
- 路径: /opt/homebrew/bin/opencli

## 常用命令
```bash
opencli list                          # 所有可用命令
opencli twitter timeline              # X 时间线
opencli twitter tweet <id>            # 读推文
opencli twitter search "query"        # 搜索
opencli twitter post "内容"           # 发帖
opencli hackernews top --limit 5      # HN 热榜
```

## 适配器分类
| 类型 | 示例 | 需要 Extension |
|------|------|---------------|
| 纯 API | HackerNews, GitHub | ❌ |
| 浏览器 | Bilibili, 小红书, Spotify | ✅ Chrome Bridge |
| Electron | Cursor, Notion, Discord | ✅ CDP |

## Daemon API 直调
无预置 adapter 时，通过 HTTP API 让 Extension 在真实 Chrome 执行 JS：
```python
import requests
# 导航
r = requests.post("http://localhost:19825/command",
    headers={"X-OpenCLI": "1", "Content-Type": "application/json"},
    json={"id": "nav1", "action": "navigate", "url": url, "waitMs": 5000})
# 执行 JS
r = requests.post("http://localhost:19825/command",
    headers={"X-OpenCLI": "1", "Content-Type": "application/json"},
    json={"id": "exec1", "action": "exec", "tabId": tab_id, "code": js_code})
```

## 约束
- X/Twitter 写入统一走脚本层 (`~/Orb/profiles/<your-profile>/scripts/x-*.sh`)，不直接调 opencli
- 浏览器适配器在 cron/服务端不适用
