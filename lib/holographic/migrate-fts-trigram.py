#!/usr/bin/env python3
"""
Migrate FTS5 index from unicode61 → trigram tokenizer.
Safe to run multiple times (idempotent).

Usage: python3 migrate-fts-trigram.py <db_path>
"""
import sqlite3
import sys


def migrate(db_path):
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")

    # Check current tokenizer
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name='facts_fts'"
    ).fetchone()

    if row and 'trigram' in row[0].lower():
        print("Already using trigram tokenizer, skipping.")
        conn.close()
        return

    print(f"Migrating FTS5 index in {db_path}...")

    # Drop old FTS table and triggers
    conn.execute("DROP TRIGGER IF EXISTS facts_ai")
    conn.execute("DROP TRIGGER IF EXISTS facts_ad")
    conn.execute("DROP TRIGGER IF EXISTS facts_au")
    conn.execute("DROP TABLE IF EXISTS facts_fts")

    # Recreate with trigram tokenizer
    conn.execute("""
        CREATE VIRTUAL TABLE facts_fts
        USING fts5(content, tags, content=facts, content_rowid=fact_id, tokenize='trigram')
    """)

    # Recreate triggers
    conn.execute("""
        CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
            INSERT INTO facts_fts(rowid, content, tags)
                VALUES (new.fact_id, new.content, new.tags);
        END
    """)
    conn.execute("""
        CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
            INSERT INTO facts_fts(facts_fts, rowid, content, tags)
                VALUES ('delete', old.fact_id, old.content, old.tags);
        END
    """)
    conn.execute("""
        CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
            INSERT INTO facts_fts(facts_fts, rowid, content, tags)
                VALUES ('delete', old.fact_id, old.content, old.tags);
            INSERT INTO facts_fts(rowid, content, tags)
                VALUES (new.fact_id, new.content, new.tags);
        END
    """)

    # Rebuild index from existing facts
    conn.execute("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')")
    conn.commit()

    # Verify
    count = conn.execute("SELECT count(*) FROM facts").fetchone()[0]
    # Test CJK search
    test = conn.execute(
        "SELECT count(*) FROM facts_fts WHERE facts_fts MATCH '的'"
    ).fetchone()[0]

    print(f"Migration complete. {count} facts indexed. CJK test ('的'): {test} hits.")
    conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 migrate-fts-trigram.py <db_path>")
        sys.exit(1)
    migrate(sys.argv[1])
