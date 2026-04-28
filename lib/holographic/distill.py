#!/usr/bin/env python3
"""
Distill lessons from error context.
Input: JSON on stdin { "userText", "errorText", "responseText" }
Output: JSON array of lessons on stdout

v2: LLM distillation with regex fallback.
"""
import sys, json, re, subprocess

DISTILL_PROMPT = """You are a lesson distiller for an AI agent framework.
Given an error that occurred during a task, extract 1-3 actionable lessons that would prevent this error in future sessions.

Rules:
- Each lesson must be a single, concrete, actionable sentence
- Focus on WHAT TO DO DIFFERENTLY, not what went wrong
- Skip generic advice ("be careful", "check errors") — only specific, reusable insights
- If the error is trivial or transient (API 500, network blip), return empty array
- Add source_kind for each lesson:
  - extracted: directly stated in the user/error/agent text
  - inferred: derived from the surrounding context
  - ambiguous: contains uncertainty words such as "maybe", "probably", "可能", "也许", "估计"
- Few-shot:
  - Error says "ENOENT /tmp/a": {{"source_kind":"extracted","source_confidence":0.8}}
  - Context implies missing setup before test: {{"source_kind":"inferred","source_confidence":0.6}}
  - Text says "可能是权限问题": {{"source_kind":"ambiguous","source_confidence":0.35}}

Error: {error}
User was asking: {user}
Agent response (if any): {response}

Return ONLY a JSON array of objects: [{{"content": "lesson text", "category": "lesson", "severity": "high|medium|low", "source": "llm_distill", "source_kind": "extracted|inferred|ambiguous", "source_confidence": 0.0}}]
No markdown, no explanation, just the JSON array."""

def distill_llm(ctx):
    """Use Claude haiku via CLI for semantic distillation."""
    prompt = DISTILL_PROMPT.format(
        error=ctx.get('errorText', '')[:1000],
        user=ctx.get('userText', '')[:500],
        response=ctx.get('responseText', '')[:500],
    )

    try:
        result = subprocess.run(
            ['claude', '--print', '-p', '-', '--model', 'claude-haiku-4-5-20251001', '--max-turns', '1'],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return None

        # Parse output — claude --print outputs raw text or JSON
        output = result.stdout.strip()
        # Try to extract JSON array from output
        # Handle case where output has markdown fences
        if '```' in output:
            match = re.search(r'```(?:json)?\s*(\[.*?\])\s*```', output, re.DOTALL)
            if match:
                output = match.group(1)

        lessons = json.loads(output)
        if isinstance(lessons, list):
            # Validate structure
            valid = []
            for l in lessons[:3]:
                if isinstance(l, dict) and 'content' in l:
                    l.setdefault('category', 'lesson')
                    l.setdefault('severity', 'medium')
                    l.setdefault('source', 'llm_distill')
                    l.setdefault('source_kind', 'inferred')
                    l.setdefault('source_confidence', 0.6)
                    valid.append(l)
            return valid if valid else None
        return None
    except Exception:
        return None


def distill_regex(ctx):
    """Regex-based fallback distillation (v1 logic)."""
    lessons = []
    error = ctx.get('errorText', '')
    user = ctx.get('userText', '')

    if 'exit' in error.lower() or 'error' in error.lower():
        lessons.append({
            'content': f'Error encountered: {error[:500]}. Context: user asked "{user[:200]}"',
            'category': 'lesson',
            'severity': 'high',
            'source': 'error_capture',
            'source_kind': 'extracted',
            'source_confidence': 0.8,
        })

    patterns = [
        (r'permission denied|EACCES', 'Permission error — check file/dir permissions before operating'),
        (r'ETIMEDOUT|timeout|timed?\s*out', 'Operation timed out — consider chunking or retry strategy'),
        (r'No conversation found|session.*expired', 'Session expired — handle gracefully without assuming session continuity'),
        (r'ENOENT|not found|no such file', 'File/path not found — validate existence before operating'),
        (r'rate.?limit|429|too many requests', 'Rate limited — implement backoff or reduce request frequency'),
        (r'context.?window|token.?limit|too.?long', 'Context overflow — break task into smaller chunks'),
        (r'ENOMEM|out of memory|heap', 'Memory exhaustion — reduce buffer sizes or process in batches'),
        (r'ECONNREFUSED|connection refused', 'Service unreachable — verify service is running before calling'),
    ]

    combined = f'{error} {ctx.get("responseText", "")}'
    for pattern, lesson_text in patterns:
        if re.search(pattern, combined, re.IGNORECASE):
            lessons.append({
                'content': lesson_text,
                'category': 'lesson',
                'severity': 'medium',
                'source': 'pattern_match',
                'source_kind': 'extracted',
                'source_confidence': 0.8,
            })

    seen = set()
    unique = []
    for l in lessons:
        key = l['content'][:100]
        if key not in seen:
            seen.add(key)
            unique.append(l)
    return unique[:3]


def distill(ctx):
    """Try LLM first, fall back to regex."""
    # Skip transient errors — not worth distilling
    error = ctx.get('errorText', '')
    if re.search(r'(500|502|503|504)\s*(Internal|Bad Gateway|Service Unavailable|Gateway Timeout)', error, re.IGNORECASE):
        return []

    llm_result = distill_llm(ctx)
    if llm_result is not None:
        return llm_result
    return distill_regex(ctx)


CORRECTION_PROMPT = """You are a lesson distiller for an AI agent framework.
The user corrected the agent's output. Extract 1-2 lessons about what the user actually wanted.

Rules:
- Focus on the USER'S STANDARD or PREFERENCE, not the specific content
- Extract reusable patterns: "user prefers X style", "always do Y before Z"
- If the correction is too situation-specific to generalize, return empty array
- Add source_kind/source_confidence using the same evidence labels:
  extracted = directly stated, inferred = context-derived, ambiguous = uncertainty language.

Thread context (recent messages):
{thread}

User's correction: {correction}
Agent's response after correction: {response}

Return ONLY a JSON array: [{{"content": "lesson text", "category": "lesson", "severity": "medium", "source": "correction_capture", "source_kind": "extracted|inferred|ambiguous", "source_confidence": 0.0}}]
No markdown, no explanation, just the JSON array."""


def distill_correction(ctx):
    """Distill lessons from user corrections."""
    prompt = CORRECTION_PROMPT.format(
        thread=ctx.get('threadHistory', '')[:2000],
        correction=ctx.get('userText', '')[:500],
        response=ctx.get('responseText', '')[:500],
    )
    try:
        result = subprocess.run(
            ['claude', '--print', '-p', '-', '--model', 'claude-haiku-4-5-20251001', '--max-turns', '1'],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return []
        output = result.stdout.strip()
        if '```' in output:
            match = re.search(r'```(?:json)?\s*(\[.*?\])\s*```', output, re.DOTALL)
            if match:
                output = match.group(1)
        lessons = json.loads(output)
        if isinstance(lessons, list):
            valid = []
            for l in lessons[:2]:
                if isinstance(l, dict) and 'content' in l:
                    l.setdefault('category', 'lesson')
                    l.setdefault('severity', 'medium')
                    l.setdefault('source', 'correction_capture')
                    l.setdefault('source_kind', 'extracted')
                    l.setdefault('source_confidence', 0.8)
                    valid.append(l)
            return valid
        return []
    except Exception:
        return []


if __name__ == '__main__':
    try:
        ctx = json.load(sys.stdin)
        if ctx.get('mode') == 'correction':
            result = distill_correction(ctx)
        else:
            result = distill(ctx)
        print(json.dumps(result))
    except Exception:
        print(json.dumps([]))
        sys.exit(0)
