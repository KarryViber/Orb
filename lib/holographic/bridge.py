#!/usr/bin/env python3
"""
CLI bridge for Node.js ↔ Holographic memory.

Usage:
    python3 bridge.py <db_path> <command> [json_args]

Commands:
    search          {"query": "...", "category": null, "min_trust": 0.3, "limit": 5}
    session_search  {"query": "", "thread_ts": "...", "user_id": "...", "limit": 20}
    add             {"content": "...", "category": "general", "tags": "",
                     "confidence": "default", "skip_arbitrate": false}
    probe           {"entity": "...", "category": null, "limit": 10}
    related         {"entity": "...", "category": null, "limit": 10}
    reason          {"entities": ["a","b"], "category": null, "limit": 10}
    contradict      {"category": null, "threshold": 0.3, "limit": 10}
    feedback        {"fact_id": 1, "helpful": true}
    remove          {"fact_id": 1}                    — default = tombstone (soft)
    tombstone       {"fact_id": 1, "superseded_by": null}
    purge           {"fact_id": 1}                    — admin/migration hard-delete
    purge_transient {"categories": [...], "max_age_days": 7}
    list            {"category": null, "min_trust": 0.0, "limit": 50}
    arbitrate       {"content": "...", "neighbors": [...]}  — debug, returns decision only
    batch           {"operations": [...]}

Output: JSON to stdout. Exit 0 on success, 1 on error.

Arbitration (write-time LLM curation):
  On `add`, bridge searches for up to 3 FTS5 near-neighbors (trust > 0.3).
  If neighbors exist, it calls `claude -p` (Haiku, 5s timeout) to decide
  ADD / UPDATE / DELETE / NONE. Any failure degrades to ADD (fail-open).

  Environment toggles:
    MEMORY_ARBITRATE=false        disable arbitration entirely
    MEMORY_ARBITRATE_MODEL=haiku  model for claude -p (haiku/sonnet/opus)
    MEMORY_ARBITRATE_TIMEOUT_SEC=5  subprocess timeout
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Allow relative imports when run as script
sys.path.insert(0, str(Path(__file__).parent))

from store import MemoryStore
from retrieval import FactRetriever


# ── Arbitration via Claude CLI subprocess ─────────────────────────────

_ARBITRATE_ENABLED = os.environ.get("MEMORY_ARBITRATE", "true").lower() != "false"
_ARBITRATE_MODEL = os.environ.get("MEMORY_ARBITRATE_MODEL", "haiku")
_ARBITRATE_TIMEOUT = float(os.environ.get("MEMORY_ARBITRATE_TIMEOUT_SEC", "15.0"))
_ARBITRATE_SYSTEM = (
    "You are a memory curator. Reply with a single-line JSON object only. "
    "No prose, no markdown fences."
)


def _utc_ts() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _log_arbitrate(event: str, **fields) -> None:
    entry = {
        "ts": _utc_ts(),
        "component": "arbitrate",
        "event": event,
    }
    entry.update(fields)
    print(json.dumps(entry, ensure_ascii=False), file=sys.stderr, flush=True)


def arbitrate(content: str, neighbors: list[dict]) -> dict:
    """Ask Haiku to decide ADD/UPDATE/DELETE/NONE given a new fact + neighbors.

    Returns: {"action": "ADD|UPDATE|DELETE|NONE", "target_id": int|None, "reason": "..."}
    Fails open: any subprocess / parse error → {"action": "ADD", "reason": "..."}.
    """
    started_at = time.monotonic()
    preview = (content or "")[:80]
    neighbor_count = len(neighbors)
    _log_arbitrate(
        "start",
        content_preview=preview,
        neighbors=neighbor_count,
        model=_ARBITRATE_MODEL,
    )

    def finalize(action: str, target_id: int | None, reason: str) -> dict:
        decision = {"action": action, "target_id": target_id, "reason": reason}
        _log_arbitrate(
            "decision",
            action=action,
            target_id=target_id,
            neighbors=neighbor_count,
            elapsed_ms=int((time.monotonic() - started_at) * 1000),
            reason=reason,
        )
        return decision

    if not _ARBITRATE_ENABLED or not neighbors:
        return finalize("ADD", None, "arbitrate-skipped")

    nbr_lines = []
    for n in neighbors:
        nbr_lines.append(
            f"  [id={n.get('fact_id')}] {str(n.get('content', ''))[:300]} "
            f"(trust={float(n.get('trust_score', 0) or 0):.2f})"
        )

    prompt = (
        f"NEW FACT:\n  {content}\n\n"
        "EXISTING NEIGHBORS:\n" + "\n".join(nbr_lines) + "\n\n"
        "Decide one of:\n"
        "  ADD — genuinely new, no real conflict\n"
        "  UPDATE — new supersedes a specific neighbor (requires target_id)\n"
        "  DELETE — new says a neighbor is wrong; drop it (requires target_id)\n"
        "  NONE — new is duplicate or strictly weaker than a neighbor\n\n"
        'Reply JSON only: {"action":"ADD","target_id":null,"reason":"..."}'
    )

    try:
        result = subprocess.run(
            [
                "claude", "-p", prompt,
                "--model", _ARBITRATE_MODEL,
                "--output-format", "json",
                "--system-prompt", _ARBITRATE_SYSTEM,
            ],
            capture_output=True,
            text=True,
            timeout=_ARBITRATE_TIMEOUT,
            cwd="/tmp",  # don't pick up project CLAUDE.md / skills
        )
    except subprocess.TimeoutExpired:
        reason = "arbitrate-timeout"
        _log_arbitrate(
            "timeout",
            neighbors=neighbor_count,
            elapsed_ms=int((time.monotonic() - started_at) * 1000),
            reason=reason,
        )
        return finalize("ADD", None, reason)
    except FileNotFoundError:
        reason = "claude-cli-missing"
        _log_arbitrate(
            "cli-missing",
            neighbors=neighbor_count,
            elapsed_ms=int((time.monotonic() - started_at) * 1000),
            reason=reason,
        )
        return finalize("ADD", None, reason)
    except Exception as e:
        reason = f"subprocess-err-{type(e).__name__}"
        _log_arbitrate(
            "subprocess-error",
            neighbors=neighbor_count,
            elapsed_ms=int((time.monotonic() - started_at) * 1000),
            reason=reason,
        )
        return finalize("ADD", None, reason)

    if result.returncode != 0:
        reason = f"cli-returncode-{result.returncode}"
        _log_arbitrate(
            "cli-returncode",
            neighbors=neighbor_count,
            elapsed_ms=int((time.monotonic() - started_at) * 1000),
            reason=reason,
        )
        return finalize("ADD", None, reason)

    try:
        envelope = json.loads(result.stdout)
        text = (envelope.get("result") or "").strip()
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        decision = json.loads(text)
    except Exception:
        reason = "arbitrate-bad-json"
        _log_arbitrate(
            "bad-json",
            neighbors=neighbor_count,
            elapsed_ms=int((time.monotonic() - started_at) * 1000),
            reason=reason,
        )
        return finalize("ADD", None, reason)

    action = (decision.get("action") or "").upper()
    if action not in {"ADD", "UPDATE", "DELETE", "NONE"}:
        reason = f"arbitrate-invalid-action-{action}"
        _log_arbitrate(
            "invalid-action",
            neighbors=neighbor_count,
            elapsed_ms=int((time.monotonic() - started_at) * 1000),
            reason=reason,
        )
        return finalize("ADD", None, reason)

    # Haiku sometimes returns target_id as a numeric string — coerce.
    raw_target = decision.get("target_id")
    target_id: int | None = None
    if isinstance(raw_target, int):
        target_id = raw_target
    elif isinstance(raw_target, str) and raw_target.strip().isdigit():
        target_id = int(raw_target.strip())

    if action in {"UPDATE", "DELETE"} and target_id is None:
        reason = "arbitrate-missing-target"
        _log_arbitrate(
            "missing-target",
            neighbors=neighbor_count,
            elapsed_ms=int((time.monotonic() - started_at) * 1000),
            reason=reason,
        )
        return finalize("ADD", None, reason)

    return finalize(action, target_id, str(decision.get("reason", "")))


# ── Add path: search neighbors → arbitrate → apply ───────────────────

def apply_fact_write(
    store: MemoryStore,
    retriever: FactRetriever,
    content: str,
    category: str,
    tags: str,
    source: str,
    confidence: str,
    skip_arbitrate: bool,
) -> dict:
    """One-shot fact write with arbitration.

    Returns a rich result dict with:
      action: ADD|UPDATE|DELETE|NONE
      fact_id: int|None
      tombstoned: int (present if UPDATE or DELETE)
      reason: str
    """
    content = (content or "").strip()
    if not content:
        return {"error": "empty content"}

    # Auto-upgrade confidence for high-signal sources when caller didn't specify.
    # correction_capture = Karry 亲自纠正蒸馏，llm_distill lesson = 已策划复盘，
    # 都应该是 confirmed (0.9, frozen)，而不是 default (0.5)。
    if confidence == "default":
        if source == "correction_capture":
            confidence = "confirmed"
        elif source == "llm_distill" and category == "lesson":
            confidence = "confirmed"

    neighbors: list[dict] = []
    if not skip_arbitrate and _ARBITRATE_ENABLED:
        try:
            # FTS5 treats the raw sentence as implicit AND — misses near-neighbors
            # that differ by any token. OR-join meaningful tokens (≥2 chars,
            # alphanumeric or CJK) for semantic-ish matching.
            tokens = re.findall(r"[\w\u4e00-\u9fff]{2,}", content)[:10]
            if tokens:
                fts_query = " OR ".join(tokens)
                neighbors = retriever.search(
                    query=fts_query, category=None, min_trust=0.3, limit=3
                )
        except Exception:
            neighbors = []
        # Drop exact self-matches (defensive; add_fact dedupes by content anyway)
        neighbors = [n for n in neighbors if n.get("content") != content]

    decision = (
        arbitrate(content, neighbors) if neighbors else
        {"action": "ADD", "target_id": None, "reason": "no-neighbors"}
    )
    action = decision["action"]

    if action == "NONE":
        return {
            "fact_id": None, "action": "NONE",
            "reason": decision.get("reason"),
        }

    if action == "DELETE":
        target = decision["target_id"]
        ok = store.tombstone_fact(target)
        return {
            "fact_id": None, "action": "DELETE",
            "tombstoned": target if ok else None,
            "reason": decision.get("reason"),
        }

    if action == "UPDATE":
        target = decision["target_id"]
        fact_id = store.add_fact(
            content=content, category=category, tags=tags,
            source=source, confidence=confidence,
        )
        store.tombstone_fact(target, superseded_by=fact_id)
        return {
            "fact_id": fact_id, "action": "UPDATE",
            "tombstoned": target,
            "reason": decision.get("reason"),
        }

    # ADD (default + fallback)
    fact_id = store.add_fact(
        content=content, category=category, tags=tags,
        source=source, confidence=confidence,
    )
    return {
        "fact_id": fact_id, "action": "ADD",
        "reason": decision.get("reason", ""),
    }


# ── Command dispatch ─────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: bridge.py <db_path> <command> [json_args]"}))
        sys.exit(1)

    db_path = sys.argv[1]
    command = sys.argv[2]
    args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}

    try:
        store = MemoryStore(db_path=db_path)
        # temporal_decay_half_life=0 — decay is disabled project-wide
        retriever = FactRetriever(store, temporal_decay_half_life=0)

        if command == "search":
            result = retriever.search(
                query=args.get("query", ""),
                category=args.get("category"),
                min_trust=args.get("min_trust", 0.3),
                limit=args.get("limit", 5),
            )
        elif command == "add":
            result = apply_fact_write(
                store, retriever,
                content=args["content"],
                category=args.get("category", "general"),
                tags=args.get("tags", ""),
                source=args.get("source", "unknown"),
                confidence=args.get("confidence", "default"),
                skip_arbitrate=args.get("skip_arbitrate", False),
            )
        elif command == "session_search":
            result = retriever.session_search(
                query=args.get("query", ""),
                thread_ts=args.get("thread_ts"),
                user_id=args.get("user_id"),
                min_trust=args.get("min_trust", 0.0),
                limit=args.get("limit", 20),
            )
        elif command == "probe":
            result = retriever.probe(
                entity=args["entity"],
                category=args.get("category"),
                limit=args.get("limit", 10),
            )
        elif command == "related":
            result = retriever.related(
                entity=args["entity"],
                category=args.get("category"),
                limit=args.get("limit", 10),
            )
        elif command == "reason":
            result = retriever.reason(
                entities=args["entities"],
                category=args.get("category"),
                limit=args.get("limit", 10),
            )
        elif command == "contradict":
            result = retriever.contradict(
                category=args.get("category"),
                threshold=args.get("threshold", 0.3),
                limit=args.get("limit", 10),
            )
        elif command == "feedback":
            result = store.record_feedback(
                fact_id=args["fact_id"],
                helpful=args["helpful"],
            )
        elif command == "remove":
            # Default soft-delete — backwards-compat name, now tombstones.
            ok = store.tombstone_fact(args["fact_id"])
            result = {"tombstoned": ok}
        elif command == "tombstone":
            ok = store.tombstone_fact(
                args["fact_id"],
                superseded_by=args.get("superseded_by"),
            )
            result = {"tombstoned": ok}
        elif command == "purge":
            ok = store.purge_fact(args["fact_id"])
            result = {"purged": ok}
        elif command == "purge_transient":
            n = store.purge_transient(
                categories=tuple(args.get("categories", ["transient_state", "session_context"])),
                max_age_days=args.get("max_age_days", 7),
            )
            result = {"purged": n}
        elif command == "arbitrate":
            result = arbitrate(args["content"], args.get("neighbors", []))
        elif command == "batch":
            results = []
            for op in args.get("operations", []):
                cmd = op["command"]
                op_args = op.get("args", {})
                if cmd == "add":
                    results.append(apply_fact_write(
                        store, retriever,
                        content=op_args["content"],
                        category=op_args.get("category", "general"),
                        tags=op_args.get("tags", ""),
                        source=op_args.get("source", "unknown"),
                        confidence=op_args.get("confidence", "default"),
                        skip_arbitrate=op_args.get("skip_arbitrate", False),
                    ))
                elif cmd == "remove":
                    ok = store.tombstone_fact(op_args["fact_id"])
                    results.append({"tombstoned": ok})
                else:
                    results.append({"error": f"Unsupported batch command: {cmd}"})
            result = results
        elif command == "list":
            result = store.list_facts(
                category=args.get("category"),
                min_trust=args.get("min_trust", 0.0),
                limit=args.get("limit", 50),
                offset=int(args.get("offset", 0)),
            )
        else:
            result = {"error": f"Unknown command: {command}"}

        store.close()
        print(json.dumps(result, default=str, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
