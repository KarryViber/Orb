#!/usr/bin/env python3
"""Rebuild bge-m3 embeddings + priority_layer for all chunks in doc-index.db.

Idempotent. Safe to run repeatedly. Reads chunk content directly, encodes via
the shared `encode_chunks` from `docindex`, writes embedding BLOB + recomputed
priority_layer back, then VACUUMs the DB.
"""
from __future__ import annotations

import os as _os
_os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
_os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

# Allow running directly without package install
sys.path.insert(0, str(Path(__file__).parent))
from docindex import (  # type: ignore
    EMBEDDING_BATCH_SIZE,
    derive_priority_layer,
    encode_chunks,
    migrate_schema,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-path", default=os.environ.get("DOC_INDEX_DB", ""))
    parser.add_argument("--slug", default=None, help="Only rebuild chunks for this slug")
    parser.add_argument("--batch", type=int, default=32, help="Chunks per encode batch (model batch_size is fixed at 4)")
    parser.add_argument("--only-missing", action="store_true", help="Only encode chunks where embedding IS NULL")
    args = parser.parse_args()

    if not args.db_path:
        print("ERROR: --db-path or DOC_INDEX_DB required", file=sys.stderr)
        return 2
    db_path = Path(args.db_path).expanduser()
    if not db_path.exists():
        print(f"ERROR: db not found: {db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    migrate_schema(conn)

    where = []
    params: list = []
    if args.slug:
        where.append("slug = ?")
        params.append(args.slug)
    if args.only_missing:
        where.append("embedding IS NULL")
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute(f"SELECT COUNT(*) FROM chunks{where_sql}", params).fetchone()[0]
    print(f"chunks to process: {total}")
    if total == 0:
        return 0

    rows = conn.execute(
        f"SELECT id, path, content FROM chunks{where_sql} ORDER BY id",
        params,
    ).fetchall()

    t0 = time.time()
    done = 0
    BATCH = max(1, args.batch)
    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        texts = [r["content"] for r in batch]
        try:
            blobs = encode_chunks(texts)
        except Exception as e:
            print(f"encode failed: {e}", file=sys.stderr)
            return 1
        for r, blob in zip(batch, blobs, strict=True):
            pl = derive_priority_layer(r["path"])
            conn.execute(
                "UPDATE chunks SET embedding = ?, priority_layer = ? WHERE id = ?",
                (blob, pl, r["id"]),
            )
        conn.commit()
        done += len(batch)
        elapsed = time.time() - t0
        rate = done / elapsed if elapsed > 0 else 0
        eta = (total - done) / rate if rate > 0 else 0
        print(f"  [{done}/{total}] elapsed={elapsed:.1f}s rate={rate:.1f}/s eta={eta:.0f}s", flush=True)

    conn.commit()
    print("VACUUM ...", flush=True)
    conn.execute("VACUUM")
    conn.close()
    elapsed = time.time() - t0
    print(f"done. total={total} elapsed={elapsed:.1f}s ({total/elapsed:.1f} chunks/s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
