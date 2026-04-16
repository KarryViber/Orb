#!/usr/bin/env python3
"""
CLI bridge for Node.js ↔ DocStore.

Usage:
    python3 bridge.py search <db_path> <query> [--slug X] [--doc-type X] [--limit N]
    python3 bridge.py update <db_path> [--slug X]
    python3 bridge.py stats <db_path>

Output: JSON to stdout.
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from docindex import (
    connect,
    search_rows,
    iter_candidate_files,
    extract_document,
    upsert_document,
    delete_stale_documents,
    now_iso,
)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: bridge.py <command> <db_path> [args...]"}))
        sys.exit(1)

    command = sys.argv[1]
    db_path = Path(sys.argv[2]).expanduser()

    try:
        conn = connect(db_path)

        if command == "search":
            query = sys.argv[3] if len(sys.argv) > 3 else ""
            slug = None
            doc_type = None
            limit = 5
            i = 4
            while i < len(sys.argv):
                if sys.argv[i] == "--slug" and i + 1 < len(sys.argv):
                    slug = sys.argv[i + 1]
                    i += 2
                elif sys.argv[i] == "--doc-type" and i + 1 < len(sys.argv):
                    doc_type = sys.argv[i + 1]
                    i += 2
                elif sys.argv[i] == "--limit" and i + 1 < len(sys.argv):
                    limit = int(sys.argv[i + 1])
                    i += 2
                else:
                    i += 1
            results = search_rows(conn, query, slug, doc_type, limit)
            print(json.dumps(results, default=str, ensure_ascii=False))

        elif command == "update":
            slug_filter = None
            if len(sys.argv) > 3 and sys.argv[3] == "--slug" and len(sys.argv) > 4:
                slug_filter = sys.argv[4]
            inserted = updated = unchanged = skipped = 0
            live_paths = set()
            for file in iter_candidate_files(slug_filter=slug_filter):
                live_paths.add(str(file.path))
                try:
                    extracted = extract_document(file)
                except Exception:
                    skipped += 1
                    continue
                if not extracted.text.strip():
                    skipped += 1
                    continue
                status, _ = upsert_document(conn, file, extracted.text, extracted.title_hint)
                if status == "inserted":
                    inserted += 1
                elif status == "updated":
                    updated += 1
                else:
                    unchanged += 1
            deleted = delete_stale_documents(conn, live_paths, slug_filter=slug_filter)
            conn.execute(
                "INSERT INTO index_meta(key, value) VALUES('last_updated_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (now_iso(),),
            )
            conn.commit()
            docs = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            print(json.dumps({
                "documents": docs, "chunks": chunks,
                "inserted": inserted, "updated": updated,
                "unchanged": unchanged, "deleted": deleted, "skipped": skipped,
            }))

        elif command == "stats":
            docs = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            last = conn.execute("SELECT value FROM index_meta WHERE key = 'last_updated_at'").fetchone()
            print(json.dumps({
                "documents": docs, "chunks": chunks,
                "last_updated_at": last[0] if last else None,
            }))

        else:
            print(json.dumps({"error": f"Unknown command: {command}"}))

        conn.close()

    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
