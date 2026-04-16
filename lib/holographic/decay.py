#!/usr/bin/env python3
"""
Daily trust decay for Holographic memory.

Run via cron/launchd once per day. Decays all trust_score values by a factor
derived from the configured half-life. Facts that get retrieved are boosted
back up during search (retrieval_count increment in store.py).

Usage:
    python3 decay.py <db_path> [--half-life 90] [--retrieval-boost 0.02] [--dry-run]

No facts are deleted. Low-trust facts are naturally filtered out by min_trust
threshold during search.
"""

import argparse
import math
import sqlite3
import sys
from pathlib import Path


def decay(db_path: str, half_life_days: int = 90, retrieval_boost: float = 0.02, dry_run: bool = False):
    """Apply daily trust decay and retrieval-based boost."""
    db = Path(db_path).expanduser()
    if not db.exists():
        print(f"DB not found: {db}")
        sys.exit(1)

    conn = sqlite3.connect(str(db), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")

    # Daily decay factor: solve 0.5 = factor^half_life → factor = 0.5^(1/half_life)
    daily_factor = math.pow(0.5, 1.0 / half_life_days)

    # Count facts before
    total = conn.execute("SELECT COUNT(*) as c FROM facts").fetchone()["c"]
    low_trust = conn.execute("SELECT COUNT(*) as c FROM facts WHERE trust_score < 0.3").fetchone()["c"]

    if dry_run:
        print(f"[dry-run] total={total}, low_trust(<0.3)={low_trust}, daily_factor={daily_factor:.6f}")
        after_decay = conn.execute(
            "SELECT COUNT(*) as c FROM facts WHERE trust_score * ? < 0.3", (daily_factor,)
        ).fetchone()["c"]
        print(f"[dry-run] after decay: {after_decay} facts would drop below 0.3")
        conn.close()
        return

    # Step 1: Apply decay to all facts
    conn.execute(
        "UPDATE facts SET trust_score = MAX(0.01, trust_score * ?), updated_at = CURRENT_TIMESTAMP",
        (daily_factor,),
    )

    # Step 2: Boost recently retrieved facts (retrieval_count > 0)
    # Then reset retrieval_count to 0 for next cycle
    if retrieval_boost > 0:
        conn.execute(
            """
            UPDATE facts
            SET trust_score = MIN(1.0, trust_score + ? * retrieval_count),
                retrieval_count = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE retrieval_count > 0
            """,
            (retrieval_boost,),
        )

    conn.commit()

    # Report
    new_low = conn.execute("SELECT COUNT(*) as c FROM facts WHERE trust_score < 0.3").fetchone()["c"]
    print(f"decay applied: total={total}, factor={daily_factor:.6f}, low_trust: {low_trust}→{new_low}")

    conn.close()


def main():
    parser = argparse.ArgumentParser(description="Daily trust decay for Holographic memory")
    parser.add_argument("db_path", help="Path to memory.db")
    parser.add_argument("--half-life", type=int, default=90, help="Half-life in days (default: 90)")
    parser.add_argument("--retrieval-boost", type=float, default=0.02, help="Trust boost per retrieval (default: 0.02)")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    decay(args.db_path, args.half_life, args.retrieval_boost, args.dry_run)


if __name__ == "__main__":
    main()
