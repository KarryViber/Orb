---
name: browser-cdp
description: 通过 Chrome CDP + Playwright 操作浏览器：复用 Karry 的登录态访问 Lark、Plaud、及任何需要认证的 Web 页面
provenance: user-authored
---
# Browser CDP — 浏览器自动化

## When to Use
- 需要读取 Lark 消息、文档、日历
- 需要读取 Plaud 录音/摘要
- 任何需要 Karry 的 Chrome 登录态来访问的网页
- 需要对已登录的 Web 应用执行自动化操作

## 架构

```
Chrome (--user-data-dir=~/.chrome-cdp-profile, --remote-debugging-port=9223)
  ↓
Playwright connect_over_cdp("http://127.0.0.1:9223")
  ↓
复用 Karry 的登录态 → 打开页面 → evaluate JS → 提取数据 → 关闭标签
```

原理：将 Chrome 真实 profile 的 Cookie/Session/IndexedDB 复制到独立目录，绕过 Chrome 147+ 对 CDP 要求"非默认 data dir"的限制。

## 启动 / 管理

```bash
# 启动 CDP Chrome（自动关闭普通 Chrome → 复制 profile → 启动）
~/Orb/profiles/<your-profile>/scripts/chrome-cdp-start.sh

# 检查状态
~/Orb/profiles/<your-profile>/scripts/chrome-cdp-start.sh --status

# 登录态过期时：关闭 → 重新复制 profile → 重启
~/Orb/profiles/<your-profile>/scripts/chrome-cdp-start.sh --refresh

# 关闭
~/Orb/profiles/<your-profile>/scripts/chrome-cdp-start.sh --kill
```

## Playwright 连接模板

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9223")
    context = browser.contexts[0] if browser.contexts else browser.new_context()
    page = context.new_page()
    try:
        page.goto(TARGET_URL, wait_until="load", timeout=30000)
        # ... 操作 ...
    finally:
        page.close()  # ⚠️ 只关自己开的标签
        # 禁止 browser.close() / context.close() — 会杀掉用户整个浏览器
```

## 已验证的目标站点

| 站点 | URL | 提取方式 | 脚本 |
|------|-----|---------|------|
| Lark Messenger | `dyna.sg.larksuite.com/next/messenger` | JS evaluate `__CHAT_MESSAGE_LIST` + DOM `.a11y_feed_card_item` | `lark-playwright-extract.py` |
| Plaud | `web.plaud.ai` | DOM 解析录音列表 | `plaud-playwright-extract.py` |

## 操作规范

1. **启动前检查**: 先 `--status`，已运行则直接连接，不重复启动
2. **绝对禁止关闭浏览器**: 只用 `page.close()` 关自己开的标签。禁止调用 `browser.close()`、`context.close()`、或任何会关闭浏览器/上下文的操作。用户的其他标签页必须保持不动
3. **只开新标签**: `context.new_page()` 打开，操作完 `page.close()` 关掉，不碰用户已有标签
4. **超时保护**: 所有 goto/wait 设 timeout，避免挂死
5. **登录态检查**: 导航后检查 URL 是否跳转到 login 页面，如果是则报错提示 `--refresh`
6. **不修改页面状态**: 只读取，不点击"已读"、不发送消息、不修改设置

## 新增站点模板

添加新的浏览器采集目标时，遵循此结构：

```python
def extract_xxx(page, target_date):
    """提取 XXX 数据"""
    page.goto("https://xxx.com/...", wait_until="load", timeout=30000)
    page.wait_for_timeout(3000)
    
    # 检查登录态
    if "login" in page.url.lower():
        return {"error": "未登录，需要 chrome-cdp-start.sh --refresh"}
    
    # 提取数据（优先 JS evaluate > DOM selector）
    data = page.evaluate("() => { ... }")
    return data
```

## 常见问题

- **CDP 连不上**: 运行 `chrome-cdp-start.sh`（会自动关闭普通 Chrome）
- **登录态丢失**: `chrome-cdp-start.sh --refresh`（重新复制 cookie）
- **Lark selector 失效**: 检查 `__CHAT_MESSAGE_LIST` 是否还存在，Lark 前端更新可能改变
- **端口冲突**: `--port 9224` 换端口
- **普通 Chrome 和 CDP Chrome 不能同时运行**: profile lock 限制，只能选一个
