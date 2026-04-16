#!/usr/bin/env python3
"""
CLI bridge for Node.js ↔ Holographic memory.

Usage:
    python3 bridge.py <db_path> <command> [json_args]

Commands:
    search         {"query": "...", "category": null, "min_trust": 0.3, "limit": 5}
    session_search {"query": "", "thread_ts": "...", "user_id": "...", "limit": 20}
    add            {"content": "...", "category": "general", "tags": ""}
    probe    {"entity": "...", "category": null, "limit": 10}
    related  {"entity": "...", "category": null, "limit": 10}
    reason   {"entities": ["a","b"], "category": null, "limit": 10}
    contradict {"category": null, "threshold": 0.3, "limit": 10}
    feedback {"fact_id": 1, "helpful": true}
    remove   {"fact_id": 1}
    list     {"category": null, "min_trust": 0.0, "limit": 50}

Output: JSON to stdout. Exit 0 on success, 1 on error.
"""

import json
import sys
from pathlib import Path

# Allow relative imports when run as script
sys.path.insert(0, str(Path(__file__).parent))

from store import MemoryStore
from retrieval import FactRetriever


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: bridge.py <db_path> <command> [json_args]"}))
        sys.exit(1)

    db_path = sys.argv[1]
    command = sys.argv[2]
    args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}

    try:
        store = MemoryStore(db_path=db_path)
        retriever = FactRetriever(store, temporal_decay_half_life=90)

        if command == "search":
            result = retriever.search(
                query=args.get("query", ""),
                category=args.get("category"),
                min_trust=args.get("min_trust", 0.3),
                limit=args.get("limit", 5),
            )
        elif command == "add":
            fact_id = store.add_fact(
                content=args["content"],
                category=args.get("category", "general"),
                tags=args.get("tags", ""),
                source=args.get("source", "unknown"),
            )
            result = {"fact_id": fact_id}
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
            ok = store.remove_fact(fact_id=args["fact_id"])
            result = {"removed": ok}
        elif command == "batch":
            results = []
            for op in args.get("operations", []):
                cmd = op["command"]
                op_args = op.get("args", {})
                if cmd == "add":
                    fact_id = store.add_fact(
                        content=op_args["content"],
                        category=op_args.get("category", "general"),
                        tags=op_args.get("tags", ""),
                        source=op_args.get("source", "unknown"),
                    )
                    results.append({"fact_id": fact_id})
                elif cmd == "remove":
                    ok = store.remove_fact(fact_id=op_args["fact_id"])
                    results.append({"removed": ok})
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
