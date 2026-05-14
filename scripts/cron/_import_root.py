"""Single bootstrap for cron-side Python imports.

Why this exists: prior to 2026-05-04, every cron caller of `cron_run_log`
hand-rolled its own `sys.path.insert`, and the canonical location of the
shared script kept drifting (`profiles/<your-profile>/scripts/` vs
`scripts/cron/`). The drift surfaced one cron at a time, never as a
single broken trigger — exactly the failure mode described in周报 P2.

Usage (3 lines per consumer, no further sys.path manipulation):

    import sys
    sys.path.insert(0, "~/Orb/scripts/cron")
    import _import_root  # noqa: F401  side effect: register canonical paths

After the import, both `cron_run_log` (this dir) and `lib.archive_audit`
(profiles/<your-profile>/scripts/lib/) are importable.

Idempotent: re-importing or running multiple consumers in one process
does not duplicate sys.path entries.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Canonical roots. Add new entries here only — never in consumers.
_CANONICAL_PATHS: tuple[Path, ...] = (
    Path("~/Orb/scripts/cron"),
    Path("~/Orb/profiles/<your-profile>/scripts"),
)


def _ensure_on_path() -> None:
    for p in _CANONICAL_PATHS:
        s = str(p)
        if s not in sys.path:
            sys.path.insert(0, s)


_ensure_on_path()
