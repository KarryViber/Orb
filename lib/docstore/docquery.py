#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

_registry = os.environ.get("DOC_REGISTRY_PATH", "")
REGISTRY_PATH = Path(_registry) if _registry else None
_projects_root = os.environ.get("DOC_PROJECTS_ROOT", "")
PROJECTS_ROOT = Path(_projects_root) if _projects_root else None
INDEX_SCRIPT = Path(__file__).parent / "docindex.py"
_doc_index_db = os.environ.get("DOC_INDEX_DB", "")
DEFAULT_DB_PATH = Path(_doc_index_db) if _doc_index_db else None

DOC_TYPE_HINTS = [
    ("01_meetings", [r"\bmeeting\b", r"\bminutes\b", r"\bmtg\b", r"会议", r"紀要", r"议事录", r"打合せ"]),
    ("02_draft", [r"\bdraft\b", r"草稿", r"初稿"]),
    ("03_delivery", [r"project brief", r"\bbrief\b", r"\bproposal\b", r"提案", r"交付", r"作业分担表", r"sow"]),
    ("00_source", [r"\bsource\b", r"原始资料", r"素材", r"源文件"]),
]

FILLER_PATTERNS = [
    r"帮我找",
    r"给我找",
    r"给我看",
    r"看看",
    r"写了什么",
    r"讲了什么",
    r"说了什么",
    r"哪段",
    r"那段",
    r"在哪(?:里)?",
    r"里面",
    r"里",
    r"关于",
]


@dataclass(frozen=True)
class RegistryProject:
    slug: str
    directory: str
    aliases: tuple[str, ...]


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def parse_registry() -> list[RegistryProject]:
    if not REGISTRY_PATH or not REGISTRY_PATH.exists():
        return []
    current_section = "projects"
    projects: list[RegistryProject] = []
    for raw_line in REGISTRY_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("## "):
            lower = line.lower()
            if "internal registry" in lower:
                current_section = "internal"
            elif "partner registry" in lower:
                current_section = "partner"
            else:
                current_section = "projects"
            continue
        if current_section not in {"projects", "internal"}:
            continue
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 4:
            continue
        if cells[0] in {"slug", "------"}:
            continue
        slug, directory, _name, aliases = cells[:4]
        alias_list = [slug, directory]
        alias_list.extend([a.strip() for a in aliases.split("/") if a.strip()])
        deduped = []
        seen = set()
        for alias in alias_list:
            key = normalize_text(alias)
            if not key or key in seen:
                continue
            seen.add(key)
            deduped.append(alias)
        projects.append(RegistryProject(slug=slug, directory=directory, aliases=tuple(deduped)))
    return projects


def infer_slug_from_cwd(cwd: Path, projects: list[RegistryProject]) -> tuple[str | None, str | None]:
    cwd = cwd.resolve()
    for project in projects:
        if not PROJECTS_ROOT:
            return None, None
        project_path = PROJECTS_ROOT / project.directory
        try:
            cwd.relative_to(project_path)
            return project.slug, f"cwd:{project.directory}"
        except Exception:
            continue
    return None, None


def alias_pattern(alias: str) -> re.Pattern[str]:
    escaped = re.escape(alias)
    if re.fullmatch(r"[A-Za-z0-9_-]+", alias):
        return re.compile(rf"(?<![A-Za-z0-9_-]){escaped}(?![A-Za-z0-9_-])", re.IGNORECASE)
    return re.compile(escaped, re.IGNORECASE)


def infer_slug_from_query(query: str, projects: list[RegistryProject]) -> tuple[str | None, str | None, str]:
    candidates: list[tuple[str, str, str]] = []
    for project in projects:
        for alias in sorted(project.aliases, key=len, reverse=True):
            pattern = alias_pattern(alias)
            if pattern.search(query):
                candidates.append((project.slug, alias, pattern.pattern))
                break
    slugs = {slug for slug, _alias, _pattern in candidates}
    if len(slugs) != 1:
        return None, None, query
    slug = next(iter(slugs))
    matched_aliases = [alias for cand_slug, alias, _ in candidates if cand_slug == slug]
    cleaned = query
    for alias in sorted(matched_aliases, key=len, reverse=True):
        cleaned = alias_pattern(alias).sub(" ", cleaned)
    cleaned = re.sub(r"[\s:：,，/]+", " ", cleaned).strip()
    if len(cleaned) < 4:
        cleaned = query
    return slug, f"query:{matched_aliases[0]}", cleaned or query


def infer_doc_type(query: str) -> tuple[str | None, str | None]:
    q = normalize_text(query)
    for doc_type, patterns in DOC_TYPE_HINTS:
        for pattern in patterns:
            if re.search(pattern, q, re.IGNORECASE):
                return doc_type, f"query:{pattern}"
    return None, None


def strip_fillers(query: str) -> str:
    cleaned = query
    for pattern in FILLER_PATTERNS:
        cleaned = re.sub(pattern, " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[\s:：,，/]+", " ", cleaned).strip()
    return cleaned if len(cleaned) >= 2 else query


def run_search(db_path: Path, query: str, slug: str | None, doc_type: str | None, limit: int) -> list[dict]:
    cmd = [
        os.environ.get("PYTHON_PATH", "python3"),
        str(INDEX_SCRIPT),
        "--db-path",
        str(db_path),
        "search",
        query,
        "--limit",
        str(limit),
        "--json",
    ]
    if slug:
        cmd.extend(["--slug", slug])
    if doc_type:
        cmd.extend(["--doc-type", doc_type])
    proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return json.loads(proc.stdout or "[]")


def build_attempts(query: str, explicit_slug: str | None, explicit_doc_type: str | None, inferred_slug: str | None, inferred_doc_type: str | None):
    if explicit_slug or explicit_doc_type:
        return [(query, explicit_slug, explicit_doc_type, "explicit")]
    attempts = []
    if inferred_slug or inferred_doc_type:
        attempts.append((query, inferred_slug, inferred_doc_type, "inferred"))
    if inferred_slug and inferred_doc_type:
        attempts.append((query, inferred_slug, None, "relax-doc-type"))
    if inferred_slug:
        attempts.append((query, None, None, "relax-slug"))
    elif inferred_doc_type:
        attempts.append((query, None, None, "relax-doc-type"))
    if not attempts:
        attempts.append((query, None, None, "unscoped"))
    return attempts


def print_text(meta: dict, results: list[dict]) -> None:
    lines = []
    scope_parts = []
    if meta.get("slug"):
        scope_parts.append(f"slug={meta['slug']}")
    if meta.get("doc_type"):
        scope_parts.append(f"doc_type={meta['doc_type']}")
    scope_text = " ".join(scope_parts) if scope_parts else "none"
    lines.append(f"query={meta['query']}")
    lines.append(f"scope={scope_text} mode={meta['mode']}")
    if meta.get("slug_reason"):
        lines.append(f"slug_reason={meta['slug_reason']}")
    if meta.get("doc_type_reason"):
        lines.append(f"doc_type_reason={meta['doc_type_reason']}")
    for idx, row in enumerate(results, start=1):
        lines.append(f"[{idx}] {row['slug']} {row['doc_type']} {row['title']}")
        lines.append(f"    path={row['path']}")
        lines.append(f"    ext={row.get('ext','')} section={row['section']} score={row['score']:.4f}")
        lines.append(f"    {row['snippet']}")
    print("\n".join(lines))


def main() -> int:
    parser = argparse.ArgumentParser(description="Workspace doc query with auto scope narrowing.")
    parser.add_argument("query")
    parser.add_argument("--slug")
    parser.add_argument("--doc-type", choices=["00_source", "01_meetings", "02_draft", "03_delivery"])
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH or ""))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    db_path = Path(args.db_path).expanduser()
    projects = parse_registry()
    inferred_slug = None
    slug_reason = None
    cleaned_query = args.query
    if not args.slug:
        inferred_slug, slug_reason = infer_slug_from_cwd(Path(args.cwd), projects)
        q_slug, q_reason, q_clean = infer_slug_from_query(cleaned_query, projects)
        if q_slug:
            inferred_slug, slug_reason, cleaned_query = q_slug, q_reason, q_clean
    cleaned_query = strip_fillers(cleaned_query)
    inferred_doc_type = None
    doc_type_reason = None
    if not args.doc_type:
        inferred_doc_type, doc_type_reason = infer_doc_type(cleaned_query)

    attempts = build_attempts(cleaned_query, args.slug, args.doc_type, inferred_slug, inferred_doc_type)
    used_query = cleaned_query
    used_slug = args.slug or inferred_slug
    used_doc_type = args.doc_type or inferred_doc_type
    used_mode = attempts[0][3]
    results: list[dict] = []
    for query, slug, doc_type, mode in attempts:
        used_query, used_slug, used_doc_type, used_mode = query, slug, doc_type, mode
        results = run_search(db_path, query, slug, doc_type, args.limit)
        if results:
            break

    payload = {
        "query": used_query,
        "original_query": args.query,
        "slug": used_slug,
        "doc_type": used_doc_type,
        "slug_reason": slug_reason if used_slug == inferred_slug and not args.slug else ("explicit" if args.slug else None),
        "doc_type_reason": doc_type_reason if used_doc_type == inferred_doc_type and not args.doc_type else ("explicit" if args.doc_type else None),
        "mode": used_mode,
        "results": results,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print_text(payload, results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
