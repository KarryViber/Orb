#!/usr/bin/env python3
"""
Fact extraction from conversation turns.

Takes a user message + assistant response, extracts structured facts
worth remembering. Filters out noise (greetings, confirmations,
implementation details).

Usage:
    python3 extract.py <user_text> <response_text>

Output: JSON array of extracted facts, each with:
    { "content": "...", "category": "...", "importance": "high"|"medium"|"low",
      "source_kind": "extracted"|"inferred"|"ambiguous" }

Categories:
    - preference: User preferences, habits, style choices
    - decision:   Explicit decisions made ("用X方案", "不做Y")
    - entity:     People, companies, projects, tools mentioned with context
    - event:      Meetings, deadlines, milestones, status changes
    - knowledge:  Technical facts, architecture decisions, domain knowledge
    - instruction: Explicit "记住", "以后都", "默认" type instructions
"""

import json
import re
import sys


# ── Skip patterns: conversations not worth extracting ──

SKIP_PATTERNS = [
    r"^(ok|好|好的|可以|收到|了解|知道了|嗯|明白|行|没问题|thanks|谢|thx)\s*[。！!.~～]?\s*$",
    r"^(继续|next|go|开始|start)\s*[。！!.~～]?\s*$",
    r"^(重启好了|重启一下|重启了)\s*$",
]

SKIP_RESPONSE_PATTERNS = [
    r"^(好的|收到|了解|明白)\s*[。，,]",
]

MIN_USER_LEN = 8       # Skip very short user messages
MIN_RESPONSE_LEN = 20  # Skip very short responses
AMBIGUOUS_PATTERN = re.compile(
    r"(可能|也许|估计|大概|似乎|看起来|不确定|maybe|probably|likely|seems|appears)",
    re.IGNORECASE,
)


# ── Category detection ──

INSTRUCTION_PATTERNS = [
    (r"记住|以后都|以后.*默认|从现在起|永远|始终|不要再|别再|每次都", "instruction"),
    (r"我(喜欢|偏好|习惯|倾向|不喜欢|不想|讨厌|受不了)", "preference"),
    (r"(决定|确定|就这样|就用|不用|不做|放弃|选|采用|用这个|就这么定)", "decision"),
    (r"(会议|meeting|打合せ|截止|deadline|上线|发布|里程碑|milestone)", "event"),
    (r"(客户|项目|公司|团队|partner|同事|老板|上司)", "entity"),
]

KNOWLEDGE_PATTERNS = [
    r"(架构|设计|方案|实现|原理|机制|流程|策略|算法)",
    r"(区别|差异|对比|优劣|trade.?off)",
    r"(原因|根因|root cause|为什么)",
]


def should_skip(user_text: str, response_text: str) -> bool:
    """Check if this conversation turn is too trivial to extract from."""
    u = user_text.strip()

    # Skip short messages
    if len(u) < MIN_USER_LEN and len(response_text.strip()) < MIN_RESPONSE_LEN:
        return True

    # Skip greeting/confirmation-only messages
    for pattern in SKIP_PATTERNS:
        if re.match(pattern, u, re.IGNORECASE):
            return True

    return False


def detect_category(text: str) -> str:
    """Detect the most likely category for a piece of text."""
    for pattern, category in INSTRUCTION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return category
    for pattern in KNOWLEDGE_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return "knowledge"
    return "conversation"


def assess_importance(user_text: str, category: str) -> str:
    """Rough importance assessment."""
    if category == "instruction":
        return "high"
    if category in ("decision", "preference"):
        return "high"
    if category in ("entity", "event"):
        return "medium"
    if len(user_text) > 200:
        return "medium"
    return "low"


def _confidence_for(category: str, importance: str) -> str:
    """Map (category, importance) → confidence tier consumed by store.add_fact.

    confirmed   → explicit user instruction/preference/decision (trust 0.9, frozen)
    default     → ordinary extracted knowledge/entity/event (trust 0.5)
    speculative → regex-derived entities or low-importance conversation (trust 0.2)
    """
    if category in ("instruction", "preference", "decision") and importance == "high":
        return "confirmed"
    if importance == "low":
        return "speculative"
    return "default"


def classify_source_kind(text: str, derived_from_response: bool = False) -> str:
    """Classify evidence source: direct text, inference, or ambiguous language.

    Few-shot intent:
    - "User: 以后都用 sonnet" -> extracted
    - "Q: ... A: We should use strategy B" -> inferred
    - "可能用 strategy B" -> ambiguous
    """
    if AMBIGUOUS_PATTERN.search(text):
        return "ambiguous"
    if derived_from_response:
        return "inferred"
    return "extracted"


def source_confidence(source_kind: str, trust_confidence: str) -> float:
    if source_kind == "ambiguous":
        return 0.35
    if source_kind == "inferred":
        return 0.6
    return {"confirmed": 0.9, "default": 0.7, "speculative": 0.5}.get(trust_confidence, 0.7)


def extract_facts(user_text: str, response_text: str) -> list[dict]:
    """Extract structured facts from a conversation turn."""
    if should_skip(user_text, response_text):
        return []

    facts = []

    # The user message itself often contains the most valuable signal
    user_category = detect_category(user_text)

    # For instruction/preference/decision, store the user's exact words
    if user_category in ("instruction", "preference", "decision"):
        trust_confidence = _confidence_for(user_category, "high")
        source_kind = classify_source_kind(user_text)
        facts.append({
            "content": f"User: {user_text.strip()}",
            "category": user_category,
            "importance": "high",
            "confidence": trust_confidence,
            "source_kind": source_kind,
            "source_confidence": source_confidence(source_kind, trust_confidence),
        })

    # Build a condensed summary of the exchange
    # For long responses, extract the conclusion/decision part
    response_lines = response_text.strip().split('\n')

    # Take first meaningful line of response as summary
    summary_line = ""
    for line in response_lines:
        line = line.strip()
        if len(line) > 10 and not line.startswith('#') and not line.startswith('-'):
            summary_line = line
            break

    if not summary_line and response_lines:
        summary_line = response_lines[0].strip()

    # Build the fact content
    if user_category == "conversation":
        # For general conversation, store a condensed version
        condensed_user = user_text.strip()
        if len(condensed_user) > 300:
            condensed_user = condensed_user[:300] + "..."

        condensed_response = summary_line
        if len(condensed_response) > 300:
            condensed_response = condensed_response[:300] + "..."

        if condensed_response:
            content = f"Q: {condensed_user}\nA: {condensed_response}"
        else:
            content = f"Q: {condensed_user}"

        category = detect_category(condensed_user + " " + condensed_response)
        importance = assess_importance(condensed_user, category)

        # Skip low-importance general conversation
        if importance == "low" and category == "conversation":
            return []

        trust_confidence = _confidence_for(category, importance)
        source_kind = classify_source_kind(content, derived_from_response=bool(condensed_response))
        facts.append({
            "content": content,
            "category": category,
            "importance": importance,
            "confidence": trust_confidence,
            "source_kind": source_kind,
            "source_confidence": source_confidence(source_kind, trust_confidence),
        })

    # Extract any explicit entities mentioned
    entity_patterns = [
        # Japanese company names
        r"([\u4e00-\u9fff]+(?:株式会社|フィナンシャル|グループ|リース|銀行))",
        # Project/product names in context
        r"(?:プロジェクト|project|案件)[：:\s]*([^\s,，。.]{2,20})",
    ]

    combined = user_text + " " + response_text
    for pattern in entity_patterns:
        for match in re.finditer(pattern, combined):
            entity = match.group(1).strip()
            if len(entity) > 2 and entity not in [f["content"] for f in facts]:
                trust_confidence = _confidence_for("entity", "low")
                facts.append({
                    "content": f"Entity: {entity}",
                    "category": "entity",
                    "importance": "low",
                    "confidence": trust_confidence,
                    "source_kind": "extracted",
                    "source_confidence": source_confidence("extracted", trust_confidence),
                })

    return facts


def main():
    if len(sys.argv) >= 3:
        # Legacy: argv mode (kept for backward-compat)
        user_text = sys.argv[1]
        response_text = sys.argv[2]
    else:
        # New: stdin JSON mode (avoids ARG_MAX on large texts)
        try:
            data = json.loads(sys.stdin.read())
            user_text = data.get('user', '')
            response_text = data.get('response', '')
        except Exception:
            print(json.dumps([]))
            sys.exit(0)

    facts = extract_facts(user_text, response_text)
    print(json.dumps(facts, ensure_ascii=False))


if __name__ == "__main__":
    main()
