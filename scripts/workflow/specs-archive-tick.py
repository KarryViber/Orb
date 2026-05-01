#!/usr/bin/env python3
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


AGE_DAYS = 14
DEFAULT_DM_CHANNEL = "D0ANGB3M1CZ"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def is_completed_spec(path: Path, cutoff_ts: float) -> bool:
    if not path.is_file() or path.suffix != ".md":
        return False
    if path.stat().st_mtime > cutoff_ts:
        return False
    return path.name.endswith("-REPORT.md") or path.name.endswith("-AUDIT.md")


def find_candidates(specs_dir: Path, cutoff_ts: float) -> list[Path]:
    return sorted(path for path in specs_dir.glob("*.md") if is_completed_spec(path, cutoff_ts))


def archive(candidates: list[Path], archive_dir: Path) -> list[Path]:
    archive_dir.mkdir(parents=True, exist_ok=True)
    archived = []
    for source in candidates:
        stat = source.stat()
        target = archive_dir / source.name
        if target.exists():
            raise FileExistsError(f"archive target exists: {target}")
        shutil.move(str(source), str(target))
        os.utime(target, (stat.st_atime, stat.st_mtime))
        archived.append(target)
    return archived


def deliver_dm(repo: Path, archived: list[Path]) -> None:
    channel = os.environ.get("ORB_SPECS_ARCHIVE_DM_CHANNEL") or os.environ.get("ORB_FAILURE_DM_CHANNEL") or DEFAULT_DM_CHANNEL
    thread = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, prefix="specs-archive-", suffix=".md")
    try:
        with thread:
            thread.write("\n".join(f"- `{path.name}`" for path in archived))
            thread.write("\n")
        main_msg = f"🗄️ Specs Archive Tick｜archived {len(archived)} completed specs"
        subprocess.run(
            [
                "bash",
                str(repo / "scripts/cron/cron-deliver.sh"),
                "--cron-name",
                "Specs Archive Tick",
                "--channel",
                channel,
                "--main-msg",
                main_msg,
                "--thread-file",
                thread.name,
            ],
            check=True,
        )
    finally:
        try:
            os.unlink(thread.name)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive completed specs older than 14 days.")
    parser.add_argument("--dry-run", action="store_true", help="List candidates without moving files or sending DM.")
    args = parser.parse_args()

    repo = repo_root()
    specs_dir = repo / "specs"
    archive_dir = specs_dir / ".archive"
    cutoff_ts = datetime.now(timezone.utc).timestamp() - AGE_DAYS * 24 * 60 * 60

    candidates = find_candidates(specs_dir, cutoff_ts)
    if not candidates:
        print("[SILENT]")
        return 0

    if args.dry_run:
        for path in candidates:
            print(path)
        return 0

    archived = archive(candidates, archive_dir)
    for path in archived:
        print(path)
    deliver_dm(repo, archived)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
