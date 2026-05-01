#!/usr/bin/env python3
"""Small JSON audit log helper for cron runs."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


JST = timezone.utc


def _default_run_dir() -> Path:
    return Path(os.path.expanduser("~/Orb/profiles/karry/data/cron-runs"))


class RunLog:
    def __init__(self, cron_id: str, run_dir: str | Path | None = None):
        self.cron_id = cron_id
        self.run_dir = Path(run_dir) if run_dir is not None else _default_run_dir()
        self.started_at = datetime.now().astimezone()
        self.metrics: dict[str, Any] = {}
        self.changes: list[dict[str, str]] = []
        self.errors: list[dict[str, str]] = []
        self._finished = False

    def add_metric(self, key: str, value: Any) -> None:
        self.metrics[str(key)] = value

    def add_change(self, kind: str, path: str | Path, detail: str) -> None:
        self.changes.append({"kind": str(kind), "path": str(path), "detail": str(detail)})

    def add_error(self, where: str, message: str) -> None:
        self.errors.append({"where": str(where), "message": str(message)})

    def finish(self, status: str) -> Path:
        if status not in {"ok", "partial", "failed"}:
            raise ValueError(f"invalid run status: {status}")
        ended_at = datetime.now().astimezone()
        payload = {
            "cron_id": self.cron_id,
            "started_at": self.started_at.isoformat(timespec="seconds"),
            "ended_at": ended_at.isoformat(timespec="seconds"),
            "duration_ms": int((ended_at - self.started_at).total_seconds() * 1000),
            "status": status,
            "metrics": self.metrics,
            "changes": self.changes,
            "errors": self.errors,
        }
        target_dir = self.run_dir / self.cron_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"{self.started_at.strftime('%Y-%m-%dT%H-%M-%S')}.json"
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self._finished = True
        return target
