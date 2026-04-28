"""
SQLite-backed fact store with entity resolution and trust scoring.
Single-user Hermes memory store plugin.
"""

import logging
import re
import sqlite3
import sys
import threading
from pathlib import Path

try:
    from . import holographic as hrr
except ImportError:
    import holographic as hrr  # type: ignore[no-redef]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS facts (
    fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content         TEXT NOT NULL UNIQUE,
    category        TEXT DEFAULT 'general',
    tags            TEXT DEFAULT '',
    source_kind     TEXT DEFAULT 'extracted',
    confidence      REAL DEFAULT 0.5,
    trust_score     REAL DEFAULT 0.5,
    retrieval_count INTEGER DEFAULT 0,
    helpful_count   INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    hrr_vector      BLOB
);

CREATE TABLE IF NOT EXISTS entities (
    entity_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    entity_type TEXT DEFAULT 'unknown',
    aliases     TEXT DEFAULT '',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fact_entities (
    fact_id   INTEGER REFERENCES facts(fact_id),
    entity_id INTEGER REFERENCES entities(entity_id),
    PRIMARY KEY (fact_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_facts_trust    ON facts(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_entities_name  ON entities(name);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
    USING fts5(content, tags, content=facts, content_rowid=fact_id, tokenize='trigram');

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, content, tags)
        VALUES (new.fact_id, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content, tags)
        VALUES ('delete', old.fact_id, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content, tags)
        VALUES ('delete', old.fact_id, old.content, old.tags);
    INSERT INTO facts_fts(rowid, content, tags)
        VALUES (new.fact_id, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS memory_banks (
    bank_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_name  TEXT NOT NULL UNIQUE,
    vector     BLOB NOT NULL,
    dim        INTEGER NOT NULL,
    fact_count INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""

# Trust adjustment constants
_HELPFUL_DELTA   =  0.05
_UNHELPFUL_DELTA = -0.10
_TRUST_MIN       =  0.0
_TRUST_MAX       =  1.0

# Confidence → trust_score mapping (write-time, frozen thereafter).
_CONFIDENCE_TRUST = {
    "confirmed":   0.9,
    "default":     0.5,
    "speculative": 0.2,
}

logger = logging.getLogger(__name__)

_POLARITY_PAIRS = [
    ("喜欢", "不喜欢"), ("喜欢", "讨厌"),
    ("偏好", "不偏好"),
    ("习惯", "不习惯"),
    ("用", "不用"), ("采用", "不采用"),
    ("做", "不做"),
    ("要", "不要"),
    ("想", "不想"),
    ("可以", "不可以"),
    ("启用", "禁用"), ("开启", "关闭"),
]
_GENERIC_NEGATION = re.compile(r"(不|从不|再也不|别|永远不|绝不)")
_COMMON_PUNCTUATION = re.compile(r"[\s,.;:!?，。；：！？、（）()\[\]{}<>《》\"'`~@#$%^&*_+=|\\/\\-]+")
_TERM_PATTERN = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]{2,}")

# Entity extraction patterns
_RE_CAPITALIZED  = re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b')
_RE_DOUBLE_QUOTE = re.compile(r'"([^"]+)"')
_RE_SINGLE_QUOTE = re.compile(r"'([^']+)'")
_RE_AKA          = re.compile(
    r'(\w+(?:\s+\w+)*)\s+(?:aka|also known as)\s+(\w+(?:\s+\w+)*)',
    re.IGNORECASE,
)


def _clamp_trust(value: float) -> float:
    return max(_TRUST_MIN, min(_TRUST_MAX, value))


def _normalize_conflict_text(text: str) -> str:
    return _COMMON_PUNCTUATION.sub(" ", text.lower()).strip()


def _terms(text: str) -> set[str]:
    return {token for token in _TERM_PATTERN.findall(text) if len(token) >= 2}


def _term_overlap(left: str, right: str) -> float:
    left_terms = _terms(left)
    right_terms = _terms(right)
    if not left_terms or not right_terms:
        return 0.0
    return len(left_terms & right_terms) / max(len(left_terms), len(right_terms))


def _remove_once(text: str, term: str) -> str:
    return text.replace(term, " ")


def _detect_conflict(existing_content: str, incoming_content: str) -> bool:
    """Detect conservative polarity conflicts between two fact strings."""
    existing = _normalize_conflict_text(existing_content)
    incoming = _normalize_conflict_text(incoming_content)

    for positive, negative in _POLARITY_PAIRS:
        existing_pos = positive in existing
        existing_neg = negative in existing
        incoming_pos = positive in incoming
        incoming_neg = negative in incoming

        if existing_pos and incoming_neg:
            if _term_overlap(_remove_once(existing, positive), _remove_once(incoming, negative)) >= 0.5:
                return True
        if existing_neg and incoming_pos:
            if _term_overlap(_remove_once(existing, negative), _remove_once(incoming, positive)) >= 0.5:
                return True

    existing_negated = _GENERIC_NEGATION.search(existing) is not None
    incoming_negated = _GENERIC_NEGATION.search(incoming) is not None
    if existing_negated != incoming_negated:
        return _term_overlap(existing, incoming) >= 0.7

    return False


class MemoryStore:
    """SQLite-backed fact store with entity resolution and trust scoring."""

    def __init__(
        self,
        db_path: "str | Path | None" = None,
        default_trust: float = 0.5,
        hrr_dim: int = 1024,
    ) -> None:
        if db_path is None:
            raise ValueError("db_path is required")
        self.db_path = Path(db_path).expanduser()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.default_trust = _clamp_trust(default_trust)
        self.hrr_dim = hrr_dim
        self._hrr_available = hrr._HAS_NUMPY
        self._conn: sqlite3.Connection = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            timeout=10.0,
        )
        self._lock = threading.RLock()
        self._conn.row_factory = sqlite3.Row
        self._init_db()

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _init_db(self) -> None:
        """Create tables, indexes, and triggers if they do not exist. Enable WAL mode."""
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._migrate_v2()
        # Migrate: add columns if missing (safe for existing databases)
        columns = {row[1] for row in self._conn.execute("PRAGMA table_info(facts)").fetchall()}
        if "hrr_vector" not in columns:
            self._conn.execute("ALTER TABLE facts ADD COLUMN hrr_vector BLOB")
        if "source" not in columns:
            self._conn.execute("ALTER TABLE facts ADD COLUMN source TEXT DEFAULT 'unknown'")
        # Graphiti-style tombstone columns (additive, rollback-safe)
        if "invalid_at" not in columns:
            self._conn.execute("ALTER TABLE facts ADD COLUMN invalid_at TIMESTAMP")
        if "superseded_by" not in columns:
            self._conn.execute(
                "ALTER TABLE facts ADD COLUMN superseded_by INTEGER REFERENCES facts(fact_id)"
            )
        if "trust_frozen" not in columns:
            self._conn.execute("ALTER TABLE facts ADD COLUMN trust_frozen INTEGER DEFAULT 0")
        # Partial index: only live (non-tombstoned) facts, speeds up the default query path.
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(invalid_at) WHERE invalid_at IS NULL"
        )
        self._conn.commit()

    def _migrate_v2(self) -> None:
        """Add source_kind/confidence metadata columns, safely re-runnable."""
        try:
            columns = {row[1] for row in self._conn.execute("PRAGMA table_info(facts)").fetchall()}
            if "source_kind" not in columns:
                self._conn.execute("ALTER TABLE facts ADD COLUMN source_kind TEXT DEFAULT 'extracted'")
            if "confidence" not in columns:
                self._conn.execute("ALTER TABLE facts ADD COLUMN confidence REAL DEFAULT 0.5")
            self._conn.execute(
                "UPDATE facts SET source_kind = 'extracted' WHERE source_kind IS NULL OR source_kind = ''"
            )
            self._conn.execute(
                "UPDATE facts SET confidence = 0.5 WHERE confidence IS NULL"
            )
            self._conn.commit()
        except sqlite3.Error:
            self._conn.rollback()
            logger.exception("holographic v2 migration failed")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add_fact(
        self,
        content: str,
        category: str = "general",
        tags: str = "",
        source: str = "unknown",
        confidence: str = "default",
        source_kind: str = "extracted",
        confidence_score: float | None = None,
    ) -> int:
        """Insert a fact and return its fact_id.

        Deduplicates by content (UNIQUE constraint). On duplicate, returns
        the existing fact_id without modifying the row. Extracts entities from
        the content and links them to the fact.

        confidence ∈ {"confirmed", "default", "speculative"} → maps to trust_score
        (0.9 / 0.5 / 0.2) and locks trust_frozen=1 so subsequent reads won't decay.
        """
        with self._lock:
            content = content.strip()
            if not content:
                raise ValueError("content must not be empty")

            trust_score = _CONFIDENCE_TRUST.get(confidence, self.default_trust)
            if source_kind not in {"extracted", "inferred", "ambiguous"}:
                source_kind = "extracted"
            if confidence_score is None:
                confidence_score = {
                    "confirmed": 0.9,
                    "default": 0.5,
                    "speculative": 0.2,
                }.get(confidence, 0.5)
            confidence_score = max(0.0, min(1.0, float(confidence_score)))

            duplicate = self._conn.execute(
                "SELECT fact_id FROM facts WHERE content = ?", (content,)
            ).fetchone()
            if duplicate is not None:
                return int(duplicate["fact_id"])

            candidates = self._conn.execute(
                """
                SELECT fact_id, content, trust_score
                FROM facts
                WHERE category = ? AND invalid_at IS NULL
                ORDER BY updated_at DESC
                LIMIT 201
                """,
                (category,),
            ).fetchall()
            if len(candidates) > 200:
                candidates = candidates[:200]

            losing_conflicts: list[sqlite3.Row] = []
            for candidate in candidates:
                if not _detect_conflict(candidate["content"], content):
                    continue
                existing_trust = candidate["trust_score"]
                if trust_score < existing_trust:
                    return int(candidate["fact_id"])
                losing_conflicts.append(candidate)

            for loser in losing_conflicts:
                self._conn.execute(
                    """
                    UPDATE facts
                    SET invalid_at = CURRENT_TIMESTAMP,
                        trust_score = 0.05,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE fact_id = ?
                    """,
                    (loser["fact_id"],),
                )

            try:
                cur = self._conn.execute(
                    """
                    INSERT INTO facts (
                        content, category, tags, source_kind, confidence,
                        trust_score, source, trust_frozen
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                    """,
                    (content, category, tags, source_kind, confidence_score, trust_score, source),
                )
                self._conn.commit()
                fact_id: int = cur.lastrowid  # type: ignore[assignment]
            except sqlite3.IntegrityError:
                # Duplicate content — return existing id (live or tombstoned alike)
                row = self._conn.execute(
                    "SELECT fact_id FROM facts WHERE content = ?", (content,)
                ).fetchone()
                return int(row["fact_id"])

            # Entity extraction and linking
            for name in self._extract_entities(content):
                entity_id = self._resolve_entity(name)
                self._link_fact_entity(fact_id, entity_id)

            # Compute HRR vector after entity linking
            self._compute_hrr_vector(fact_id, content)
            self._rebuild_bank(category)

            for loser in losing_conflicts:
                logger.info(
                    {
                        "event": "polarity_conflict",
                        "winner": fact_id,
                        "loser": int(loser["fact_id"]),
                        "category": category,
                    }
                )

            return fact_id

    def search_facts(
        self,
        query: str,
        category: str | None = None,
        min_trust: float = 0.3,
        limit: int = 10,
        include_invalidated: bool = False,
    ) -> list[dict]:
        """Full-text search over facts using FTS5.

        Returns a list of fact dicts ordered by FTS5 rank, then trust_score
        descending. Also increments retrieval_count for matched facts.
        Tombstoned facts (invalid_at IS NOT NULL) are excluded by default.
        """
        with self._lock:
            query = query.strip()
            if not query:
                return []

            params: list = [query, min_trust]
            category_clause = ""
            if category is not None:
                category_clause = "AND f.category = ?"
                params.append(category)
            invalid_clause = "" if include_invalidated else "AND f.invalid_at IS NULL"
            params.append(limit)

            sql = f"""
                SELECT f.fact_id, f.content, f.category, f.tags,
                       f.source_kind, f.confidence, f.trust_score,
                       f.retrieval_count, f.helpful_count,
                       f.created_at, f.updated_at
                FROM facts f
                JOIN facts_fts fts ON fts.rowid = f.fact_id
                WHERE facts_fts MATCH ?
                  AND f.trust_score >= ?
                  {category_clause}
                  {invalid_clause}
                ORDER BY fts.rank, f.trust_score DESC
                LIMIT ?
            """

            rows = self._conn.execute(sql, params).fetchall()
            results = [self._row_to_dict(r) for r in rows]

            if results:
                ids = [r["fact_id"] for r in results]
                placeholders = ",".join("?" * len(ids))
                self._conn.execute(
                    f"UPDATE facts SET retrieval_count = retrieval_count + 1 WHERE fact_id IN ({placeholders})",
                    ids,
                )
                self._conn.commit()

            return results

    def update_fact(
        self,
        fact_id: int,
        content: str | None = None,
        trust_delta: float | None = None,
        tags: str | None = None,
        category: str | None = None,
    ) -> bool:
        """Partially update a fact. Trust is clamped to [0, 1].

        Returns True if the row existed, False otherwise.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT fact_id, trust_score FROM facts WHERE fact_id = ?", (fact_id,)
            ).fetchone()
            if row is None:
                return False

            assignments: list[str] = ["updated_at = CURRENT_TIMESTAMP"]
            params: list = []

            if content is not None:
                assignments.append("content = ?")
                params.append(content.strip())
            if tags is not None:
                assignments.append("tags = ?")
                params.append(tags)
            if category is not None:
                assignments.append("category = ?")
                params.append(category)
            if trust_delta is not None:
                new_trust = _clamp_trust(row["trust_score"] + trust_delta)
                assignments.append("trust_score = ?")
                params.append(new_trust)

            params.append(fact_id)
            self._conn.execute(
                f"UPDATE facts SET {', '.join(assignments)} WHERE fact_id = ?",
                params,
            )
            self._conn.commit()

            # If content changed, re-extract entities
            if content is not None:
                self._conn.execute(
                    "DELETE FROM fact_entities WHERE fact_id = ?", (fact_id,)
                )
                for name in self._extract_entities(content):
                    entity_id = self._resolve_entity(name)
                    self._link_fact_entity(fact_id, entity_id)
                self._conn.commit()

            # Recompute HRR vector if content changed
            if content is not None:
                self._compute_hrr_vector(fact_id, content)
            # Rebuild bank for relevant category
            cat = category or self._conn.execute(
                "SELECT category FROM facts WHERE fact_id = ?", (fact_id,)
            ).fetchone()["category"]
            self._rebuild_bank(cat)

            return True

    def tombstone_fact(self, fact_id: int, superseded_by: int | None = None) -> bool:
        """Soft-delete (tombstone): mark invalid_at, optionally link supersedor.

        Tombstoned facts survive in the DB (for audit / superseded_by graph traversal)
        but are excluded from search / list by default. Rebuilds the HRR bank so the
        fact stops contributing to category-level similarity search.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT fact_id, category, invalid_at FROM facts WHERE fact_id = ?", (fact_id,)
            ).fetchone()
            if row is None:
                return False
            if row["invalid_at"] is not None and superseded_by is None:
                return True  # already tombstoned, nothing to do

            self._conn.execute(
                """
                UPDATE facts
                SET invalid_at = COALESCE(invalid_at, CURRENT_TIMESTAMP),
                    superseded_by = COALESCE(?, superseded_by),
                    updated_at = CURRENT_TIMESTAMP
                WHERE fact_id = ?
                """,
                (superseded_by, fact_id),
            )
            self._conn.commit()
            self._rebuild_bank(row["category"])
            return True

    def purge_fact(self, fact_id: int) -> bool:
        """Hard-delete (admin/migration only). Default flow should use tombstone_fact.

        Removes the fact + its entity links permanently. Returns True if the row existed.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT fact_id, category FROM facts WHERE fact_id = ?", (fact_id,)
            ).fetchone()
            if row is None:
                return False

            self._conn.execute(
                "DELETE FROM fact_entities WHERE fact_id = ?", (fact_id,)
            )
            self._conn.execute("DELETE FROM facts WHERE fact_id = ?", (fact_id,))
            self._conn.commit()
            self._rebuild_bank(row["category"])
            return True

    # Backwards-compat shim: retain old name for any callers we haven't migrated yet.
    # New code should call tombstone_fact (default) or purge_fact (admin).
    remove_fact = tombstone_fact

    def purge_transient(
        self,
        categories: tuple[str, ...] = ("transient_state", "session_context"),
        max_age_days: int = 7,
    ) -> int:
        """Hard-delete transient-category facts older than max_age_days.

        Transient categories (e.g. current session window, ephemeral UI state)
        are the only place where real deletion — not tombstoning — is correct.
        Returns count of rows deleted.
        """
        with self._lock:
            if not categories:
                return 0
            placeholders = ",".join("?" * len(categories))
            params: list = list(categories)
            params.append(max_age_days)

            # Select first so we can rebuild affected banks after deletion.
            affected = self._conn.execute(
                f"""
                SELECT fact_id, category FROM facts
                WHERE category IN ({placeholders})
                  AND (julianday('now') - julianday(created_at)) > ?
                """,
                params,
            ).fetchall()
            if not affected:
                return 0

            ids = [r["fact_id"] for r in affected]
            cats = {r["category"] for r in affected}
            id_placeholders = ",".join("?" * len(ids))
            self._conn.execute(
                f"DELETE FROM fact_entities WHERE fact_id IN ({id_placeholders})", ids
            )
            self._conn.execute(
                f"DELETE FROM facts WHERE fact_id IN ({id_placeholders})", ids
            )
            self._conn.commit()
            for c in cats:
                self._rebuild_bank(c)
            return len(ids)

    def list_facts(
        self,
        category: str | None = None,
        min_trust: float = 0.0,
        limit: int = 50,
        offset: int = 0,
        include_invalidated: bool = False,
    ) -> list[dict]:
        """Browse facts ordered by trust_score descending.

        Optionally filter by category and minimum trust score.
        Supports pagination via offset. Tombstoned facts excluded by default.
        """
        with self._lock:
            params: list = [min_trust]
            category_clause = ""
            if category is not None:
                category_clause = "AND category = ?"
                params.append(category)
            invalid_clause = "" if include_invalidated else "AND invalid_at IS NULL"
            params.append(limit)
            params.append(offset)

            sql = f"""
                SELECT fact_id, content, category, tags, trust_score,
                       source_kind, confidence, retrieval_count, helpful_count,
                       created_at, updated_at
                FROM facts
                WHERE trust_score >= ?
                  {category_clause}
                  {invalid_clause}
                ORDER BY trust_score DESC
                LIMIT ?
                OFFSET ?
            """
            rows = self._conn.execute(sql, params).fetchall()
            return [self._row_to_dict(r) for r in rows]

    def record_feedback(self, fact_id: int, helpful: bool) -> dict:
        """Record user feedback and adjust trust asymmetrically.

        helpful=True  -> trust += 0.05, helpful_count += 1
        helpful=False -> trust -= 0.10

        Returns a dict with fact_id, old_trust, new_trust, helpful_count.
        Raises KeyError if fact_id does not exist.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT fact_id, trust_score, helpful_count FROM facts WHERE fact_id = ?",
                (fact_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"fact_id {fact_id} not found")

            old_trust: float = row["trust_score"]
            delta = _HELPFUL_DELTA if helpful else _UNHELPFUL_DELTA
            new_trust = _clamp_trust(old_trust + delta)

            helpful_increment = 1 if helpful else 0
            self._conn.execute(
                """
                UPDATE facts
                SET trust_score    = ?,
                    helpful_count  = helpful_count + ?,
                    updated_at     = CURRENT_TIMESTAMP
                WHERE fact_id = ?
                """,
                (new_trust, helpful_increment, fact_id),
            )
            self._conn.commit()

            return {
                "fact_id":      fact_id,
                "old_trust":    old_trust,
                "new_trust":    new_trust,
                "helpful_count": row["helpful_count"] + helpful_increment,
            }

    # ------------------------------------------------------------------
    # Entity helpers
    # ------------------------------------------------------------------

    def _extract_entities(self, text: str) -> list[str]:
        """Extract entity candidates from text using simple regex rules.

        Rules applied (in order):
        1. Capitalized multi-word phrases  e.g. "John Doe"
        2. Double-quoted terms             e.g. "Python"
        3. Single-quoted terms             e.g. 'pytest'
        4. AKA patterns                    e.g. "Guido aka BDFL" -> two entities

        Returns a deduplicated list preserving first-seen order.
        """
        seen: set[str] = set()
        candidates: list[str] = []

        def _add(name: str) -> None:
            stripped = name.strip()
            if stripped and stripped.lower() not in seen:
                seen.add(stripped.lower())
                candidates.append(stripped)

        for m in _RE_CAPITALIZED.finditer(text):
            _add(m.group(1))

        for m in _RE_DOUBLE_QUOTE.finditer(text):
            _add(m.group(1))

        for m in _RE_SINGLE_QUOTE.finditer(text):
            _add(m.group(1))

        for m in _RE_AKA.finditer(text):
            _add(m.group(1))
            _add(m.group(2))

        return candidates

    def _resolve_entity(self, name: str) -> int:
        """Find an existing entity by name or alias (case-insensitive) or create one.

        Returns the entity_id.
        """
        # Exact name match
        row = self._conn.execute(
            "SELECT entity_id FROM entities WHERE name LIKE ?", (name,)
        ).fetchone()
        if row is not None:
            return int(row["entity_id"])

        # Search aliases — aliases stored as comma-separated; use LIKE with % boundaries
        alias_row = self._conn.execute(
            """
            SELECT entity_id FROM entities
            WHERE ',' || aliases || ',' LIKE '%,' || ? || ',%'
            """,
            (name,),
        ).fetchone()
        if alias_row is not None:
            return int(alias_row["entity_id"])

        # Create new entity
        cur = self._conn.execute(
            "INSERT INTO entities (name) VALUES (?)", (name,)
        )
        self._conn.commit()
        return int(cur.lastrowid)  # type: ignore[return-value]

    def _link_fact_entity(self, fact_id: int, entity_id: int) -> None:
        """Insert into fact_entities, silently ignore if the link already exists."""
        self._conn.execute(
            """
            INSERT OR IGNORE INTO fact_entities (fact_id, entity_id)
            VALUES (?, ?)
            """,
            (fact_id, entity_id),
        )
        self._conn.commit()

    def _compute_hrr_vector(self, fact_id: int, content: str) -> None:
        """Compute and store HRR vector for a fact. No-op if numpy unavailable."""
        with self._lock:
            if not self._hrr_available:
                return

            # Get entities linked to this fact
            rows = self._conn.execute(
                """
                SELECT e.name FROM entities e
                JOIN fact_entities fe ON fe.entity_id = e.entity_id
                WHERE fe.fact_id = ?
                """,
                (fact_id,),
            ).fetchall()
            entities = [row["name"] for row in rows]

            vector = hrr.encode_fact(content, entities, self.hrr_dim)
            self._conn.execute(
                "UPDATE facts SET hrr_vector = ? WHERE fact_id = ?",
                (hrr.phases_to_bytes(vector), fact_id),
            )
            self._conn.commit()

    def _rebuild_bank(self, category: str) -> None:
        """Full rebuild of a category's memory bank from all its fact vectors."""
        with self._lock:
            if not self._hrr_available:
                return

            bank_name = f"cat:{category}"
            rows = self._conn.execute(
                """
                SELECT hrr_vector FROM facts
                WHERE category = ? AND hrr_vector IS NOT NULL AND invalid_at IS NULL
                """,
                (category,),
            ).fetchall()

            if not rows:
                self._conn.execute("DELETE FROM memory_banks WHERE bank_name = ?", (bank_name,))
                self._conn.commit()
                return

            vectors = [hrr.bytes_to_phases(row["hrr_vector"]) for row in rows]
            bank_vector = hrr.bundle(*vectors)
            fact_count = len(vectors)

            # Check SNR
            hrr.snr_estimate(self.hrr_dim, fact_count)

            self._conn.execute(
                """
                INSERT INTO memory_banks (bank_name, vector, dim, fact_count, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(bank_name) DO UPDATE SET
                    vector = excluded.vector,
                    dim = excluded.dim,
                    fact_count = excluded.fact_count,
                    updated_at = excluded.updated_at
                """,
                (bank_name, hrr.phases_to_bytes(bank_vector), self.hrr_dim, fact_count),
            )
            self._conn.commit()

    def rebuild_all_vectors(self, dim: int | None = None) -> int:
        """Recompute all HRR vectors + banks from text. For recovery/migration.

        Returns the number of facts processed.
        """
        with self._lock:
            if not self._hrr_available:
                return 0

            if dim is not None:
                self.hrr_dim = dim

            rows = self._conn.execute(
                "SELECT fact_id, content, category FROM facts"
            ).fetchall()

            categories: set[str] = set()
            for row in rows:
                self._compute_hrr_vector(row["fact_id"], row["content"])
                categories.add(row["category"])

            for category in categories:
                self._rebuild_bank(category)

            return len(rows)

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    def _row_to_dict(self, row: sqlite3.Row) -> dict:
        """Convert a sqlite3.Row to a plain dict."""
        return dict(row)

    def close(self) -> None:
        """Close the database connection."""
        self._conn.close()

    def __enter__(self) -> "MemoryStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def _run_conflict_smoke_tests() -> int:
    cases = [
        ("我喜欢 dark mode", "我不喜欢 dark mode", True),
        ("我喜欢咖啡", "我不喜欢茶", False),
        ("以后都用 sonnet", "不用 sonnet", True),
        ("Karry 偏好简体中文输出", "Karry 偏好简体中文输出", False),
        ("Connect 接法用方案 1", "Connect 接法用方案 2", False),
    ]
    passed = 0
    failures: list[str] = []
    for index, (existing, incoming, expected) in enumerate(cases, start=1):
        actual = _detect_conflict(existing, incoming)
        if actual == expected:
            passed += 1
        else:
            failures.append(
                f"case {index} failed: expected {expected}, got {actual} "
                f"for {existing!r} vs {incoming!r}"
            )

    if failures:
        for failure in failures:
            print(failure)
        print(f"FAIL: {passed}/{len(cases)}")
        return 1

    print(f"OK: {passed}/{len(cases)}")
    return 0


if __name__ == "__main__" and len(sys.argv) >= 2 and sys.argv[1] == "test-conflict":
    raise SystemExit(_run_conflict_smoke_tests())
