#!/usr/bin/env python3
"""
Memory health check — detect orphans, duplicates, and weak lessons (all categories).

Usage: python3 memory-lint.py <db_path> [--fix]

Output: JSON report to stdout
  { "total", "orphans", "duplicates", "weak", "actions_taken" }

With --fix: auto-removes orphans and lower-trust duplicates.
Without --fix: dry-run, only reports.

Category scope:
  - orphan detection:    all categories (7-day no-recall threshold)
  - duplicate detection: all categories (>60% keyword overlap)
  - weak detection:      lesson category only (actionable verb check)
"""
import sys, json, re
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))
from store import MemoryStore


def tokenize(text):
    """Simple word tokenizer for similarity."""
    return set(re.findall(r'\w{3,}', text.lower()))


def jaccard(a, b):
    """Jaccard similarity between two token sets."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def lint(db_path, fix=False):
    store = MemoryStore(db_path=db_path)
    facts = store.list_facts(min_trust=0.0, limit=500)  # all categories
    store.close()

    if not isinstance(facts, list):
        return {"total": 0, "orphans": [], "duplicates": [], "weak": [], "actions_taken": []}

    report = {
        "total": len(facts),
        "orphans": [],
        "duplicates": [],
        "weak": [],
        "actions_taken": [],
    }

    now_ts = __import__('time').time()

    # 1. Orphan detection: hits=0, older than 7 days — all categories
    for f in facts:
        created = f.get('created_at', '')
        try:
            age_days = (now_ts - datetime.fromisoformat(str(created)).timestamp()) / 86400
        except Exception:
            age_days = 0

        hits = f.get('access_count', 0)
        if hits == 0 and age_days > 7:
            report['orphans'].append({
                'id': f.get('fact_id'),
                'category': f.get('category', 'unknown'),
                'content': f.get('content', '')[:100],
                'age_days': round(age_days, 1),
            })

    # 2. Duplicate detection: >60% keyword overlap — all categories
    tokens_cache = {}
    for f in facts:
        tokens_cache[f['fact_id']] = tokenize(f.get('content', ''))

    seen_pairs = set()
    for i, a in enumerate(facts):
        for b in facts[i+1:]:
            pair = (min(a['fact_id'], b['fact_id']), max(a['fact_id'], b['fact_id']))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            sim = jaccard(tokens_cache[a['fact_id']], tokens_cache[b['fact_id']])
            if sim > 0.6:
                # Keep higher trust, flag lower
                loser = b if (a.get('trust_score', 0.5) >= b.get('trust_score', 0.5)) else a
                report['duplicates'].append({
                    'id': loser.get('fact_id'),
                    'category': loser.get('category', 'unknown'),
                    'content': loser.get('content', '')[:100],
                    'similar_to': (a if loser == b else b).get('fact_id'),
                    'similarity': round(sim, 2),
                })

    # 3. Weak lesson detection: no actionable verb — lesson category only
    action_verbs = re.compile(
        r'\b(check|verify|validate|ensure|use|avoid|implement|add|remove|split|chunk|break|reduce|increase|retry|handle|catch|wrap|test|confirm)\b',
        re.IGNORECASE,
    )
    for f in facts:
        if f.get('category') != 'lesson':
            continue
        content = f.get('content', '')
        if not action_verbs.search(content):
            report['weak'].append({
                'id': f.get('fact_id'),
                'content': content[:100],
                'reason': 'no actionable verb found',
            })

    # Auto-fix if requested
    if fix and (report['orphans'] or report['duplicates']):
        store = MemoryStore(db_path=db_path)
        # Remove orphans older than 14 days (stricter for auto-fix)
        for o in report['orphans']:
            if o['age_days'] > 14:
                store.remove_fact(fact_id=o['id'])
                report['actions_taken'].append(f"removed orphan {o['id']} ({o['category']})")
        # Remove duplicate losers
        for d in report['duplicates']:
            store.remove_fact(fact_id=d['id'])
            report['actions_taken'].append(f"removed duplicate {d['id']} ({d['category']})")
        store.close()

    # Summary counts
    report['orphan_count'] = len(report['orphans'])
    report['duplicate_count'] = len(report['duplicates'])
    report['weak_count'] = len(report['weak'])

    return report


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: memory-lint.py <db_path> [--fix]"}))
        sys.exit(1)

    db_path = sys.argv[1]
    fix = '--fix' in sys.argv

    result = lint(db_path, fix=fix)
    print(json.dumps(result, default=str, ensure_ascii=False))
