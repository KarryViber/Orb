#!/usr/bin/env python3
"""一次性脚本：备份当前 Slack 频道 topic/purpose，应用新草稿。

读 SLACK_BOT_TOKEN env。
- 备份 → ~/Orb/profiles/karry/data/slack-channel-prompts-backup-<date>.json
- 草稿 → 同目录 slack-channel-prompts-applied-<date>.json
失败的频道写入 stderr。
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import date
from pathlib import Path

TOKEN = os.environ["SLACK_BOT_TOKEN"]
DATA_DIR = Path.home() / "Orb/profiles/karry/data"
TODAY = date.today().isoformat()

DRAFTS = {
    "CXXXXXXXXXX": ("00-general", "综合频道，无频道级 override。", "杂项讨论 / 路由测试 / 临时话题。Orb 按 workspace 全局人格响应。"),
    "CXXXXXXXXXX": ("01-reflection", "自我复盘场。INTJ mentor 人格，不附和不安慰。", "Orb 切换为 intj-mentor skill 默认行为：找盲点 / 追问根因 / 给判断不给选项 / 拒绝情绪兜底。触发场景：决策咨询、纠结、规划、反思。冷幽默关闭，直球优先。"),
    "C0AMQ789ACX": ("02-training", "学习与训练记录场。", "课程笔记 / 技能练习 / 学习计划。Orb 扮演陪练角色：鼓励刻意练习，给具体下一步而非泛泛点赞。"),
    "CXXXXXXXXXX": ("03-bookmarks", "链接收纳场。任何 URL = 书签收录，不路由不反问。", "Orb 行为：收到链接走 bookmarks-intake skill 出审批卡，不触发 dm-routing。存量不动，只对新增生效。"),
    "CXXXXXXXXXX": ("04-finance", "freee 记账场 / invoice 路由目标。", "PDF invoice / 收据 / freee 操作。Orb 优先调 freee CLI，遵守個人事業主限制（无取引先コード，ref_number ≤20 字）。涉及金钱动作必须出审批卡。"),
    "CXXXXXXXXXX": ("05-health", "健康记录场。", "体检 / 用药 / 运动 / 睡眠记录与趋势观察。Orb 不做医疗诊断，健康议题给 disclaimer 建议就医。"),
    "CXXXXXXXXXX": ("your-channel-name", "Dyna.AI 主业工作场。", "psr 岗位 / 公司协作 / 内部知识。涉及对外发言（邮件 / 提案 / 客户消息）必须出审批卡。客户名 / 项目名保留日文原文。"),
    "CXXXXXXXXXX": ("07-reports", "报告产出落地场。", "cron 报告 / 周报 / 月报 / 数据汇总。Orb 按 slack-output-format skill 输出结构化卡片，长文走 thread reply。"),
    "CXXXXXXXXXX": ("08-evolution", "Orb 自进化 / GitHub 调研路由目标。", "GitHub 链接收录 / 开源项目调研 / Orb 架构演进。新调研走 adopt-from-external-repo skill；既有 lessons 决策前先 grep。"),
    "CXXXXXXXXXX": ("09-collab", "协作沟通场。", "与他人协作的对话准备 / 沟通策略 / 关系维护。涉及对外消息走审批卡。"),
    "C0AP013V056": ("10-x-ops", "X/Twitter 拟稿路由目标。", "X 推文起草 / 引用 / 长推。走 x-twitter + x-content-strategy skill：日本市场定位 / Premium 不限 280 字 / 三步审批流程。发推必须出审批卡。"),
    "C0AP005PDUG": ("20-x-articles", "X Article 长文场。", "X Article 长文起草 / Premium 长文。同 10-x-ops 规则但聚焦长文体例，鼓励观点深度。"),
    "C0AMZA5JESX": ("21-note", "笔记场。", "临时笔记 / 灵感 / 待整理素材。Orb 不主动加工，等显式要求时再处理。"),
    "C0AMX1S2DJP": ("cola-family", "家庭场。", "家庭话题 / 育儿 / 出游规划。带亲子维度（3 岁儿子）+ 世田谷自驾视角。"),
    "CXXXXXXXXXX": ("test", "通用测试频道。", "测试用，无业务约束，可大胆动手。"),
    "C0AQ6AH0L22": ("idom", "idom 项目跟踪场。", "Dyna 项目工作。涉及对客户输出（提案 / 文档 / 邮件）走审批卡 + compliance-delivery-checklist。客户名保留日文原文。"),
    "C0AUYAX3X8W": ("micard", "micard 项目跟踪场。", "Dyna 项目工作。涉及对客户输出走审批卡 + compliance-delivery-checklist。客户名保留日文原文。"),
    "C0ARH9J9EJ2": ("npd", "npd 项目跟踪场。", "Dyna 项目工作。涉及对客户输出走审批卡 + compliance-delivery-checklist。客户名保留日文原文。"),
    "C0AQM943UUR": ("ricoh-leasing", "ricoh-leasing 项目跟踪场。", "Dyna 项目工作。涉及对客户输出走审批卡 + compliance-delivery-checklist。客户名保留日文原文。"),
    "C0AQ8BTPMH8": ("ymfg", "ymfg 项目跟踪场。", "Dyna 项目工作。涉及对客户输出走审批卡 + compliance-delivery-checklist。客户名保留日文原文。"),
}

# Slack topic/purpose 上限 250 char；脚本 fail-fast 校验
for cid, (name, topic, purpose) in DRAFTS.items():
    if len(topic) > 250 or len(purpose) > 250:
        print(f"FATAL: {name} topic({len(topic)})/purpose({len(purpose)}) 超 250 字", file=sys.stderr)
        sys.exit(1)


def slack_call(method: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"http_{e.code}", "body": e.read().decode()}


def fetch_info(cid: str) -> dict:
    req = urllib.request.Request(
        f"https://slack.com/api/conversations.info?channel={cid}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def main():
    backup = {}
    applied = {}
    failures = []

    for cid, (name, topic, purpose) in DRAFTS.items():
        info = fetch_info(cid)
        if not info.get("ok"):
            failures.append({"cid": cid, "name": name, "stage": "fetch", "error": info.get("error")})
            continue
        ch = info["channel"]
        backup[cid] = {
            "name": name,
            "topic": ch.get("topic", {}).get("value", ""),
            "purpose": ch.get("purpose", {}).get("value", ""),
        }

        r1 = slack_call("conversations.setTopic", {"channel": cid, "topic": topic})
        time.sleep(0.3)
        r2 = slack_call("conversations.setPurpose", {"channel": cid, "purpose": purpose})
        time.sleep(0.3)

        applied[cid] = {
            "name": name,
            "topic_ok": r1.get("ok"),
            "purpose_ok": r2.get("ok"),
            "topic_error": r1.get("error") if not r1.get("ok") else None,
            "purpose_error": r2.get("error") if not r2.get("ok") else None,
        }
        if not (r1.get("ok") and r2.get("ok")):
            failures.append({"cid": cid, "name": name, "stage": "apply", "topic_err": r1.get("error"), "purpose_err": r2.get("error")})

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    backup_path = DATA_DIR / f"slack-channel-prompts-backup-{TODAY}.json"
    applied_path = DATA_DIR / f"slack-channel-prompts-applied-{TODAY}.json"
    backup_path.write_text(json.dumps(backup, ensure_ascii=False, indent=2))
    applied_path.write_text(json.dumps(applied, ensure_ascii=False, indent=2))

    print(f"backup: {backup_path}")
    print(f"applied: {applied_path}")
    print(f"channels processed: {len(applied)}")
    print(f"failures: {len(failures)}")
    if failures:
        for f in failures:
            print(f"  - {f}", file=sys.stderr)


if __name__ == "__main__":
    main()
