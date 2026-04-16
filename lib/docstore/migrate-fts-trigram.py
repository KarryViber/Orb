#!/usr/bin/env python3
"""
Migrate chunks_fts FTS5 index from unicode61 → trigram tokenizer.
Safe to run multiple times (idempotent).

Usage: python3 migrate-fts-trigram.py <db_path>
"""
import sqlite3
import sys


def migrate(db_path):
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=OFF")

    # Check current tokenizer
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name='chunks_fts'"
    ).fetchone()

    if not row:
        print("chunks_fts table not found, nothing to migrate.")
        conn.close()
        return

    if 'trigram' in row[0].lower():
        print("Already using trigram tokenizer, skipping.")
        conn.close()
        return

    print(f"Migrating FTS5 index in {db_path}...")

    # Drop old FTS table (content table, so data lives in chunks)
    conn.execute("DROP TABLE IF EXISTS chunks_fts")

    # Recreate with trigram tokenizer (external content table)
    conn.execute("""
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
            path,
            slug,
            doc_type,
            title,
            section,
            content,
            tokenize = 'trigram'
        )
    """)

    # Repopulate from chunks table
    conn.execute("""
        INSERT INTO chunks_fts(rowid, path, slug, doc_type, title, section, content)
        SELECT id, path, slug, doc_type, title, section, content FROM chunks
    """)
    conn.commit()

    # Verify
    chunk_count = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
    fts_count = conn.execute("SELECT count(*) FROM chunks_fts").fetchone()[0]

    # Test CJK search if there's any content
    cjk_hits = 0
    try:
        cjk_hits = conn.execute(
            "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '的'"
        ).fetchone()[0]
    except Exception:
        pass

    print(f"Migration complete. {chunk_count} chunks → {fts_count} FTS rows. CJK test ('的'): {cjk_hits} hits.")
    conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 migrate-fts-trigram.py <db_path>")
        sys.exit(1)
    migrate(sys.argv[1])
