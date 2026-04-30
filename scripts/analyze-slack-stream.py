#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from collections import defaultdict
from pathlib import Path
from statistics import median


DEFAULT_LOG = "~/Orb/logs/stdout.log"
LINE_RE = re.compile(r"^(?P<ts>\S+).*?\[slack:(?P<event>startStream|appendStream|appendStream:error|stopStream|stopStream:error)\]\s*(?P<body>.*)$")
KV_RE = re.compile(r"(\w+)=([^=]*?)(?=\s+\w+=|$)")


def parse_kv(body: str) -> dict[str, str]:
    return {k: v.strip() for k, v in KV_RE.findall(body)}


def to_int(value: str | None) -> int | None:
    if value in (None, "", "null"):
        return None
    try:
        return int(value)
    except ValueError:
        return None


def fmt_duration(ms: int | None) -> str:
    if ms is None:
        return "unknown"
    seconds = max(0, ms // 1000)
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h{minutes:02d}m{sec:02d}s"
    if minutes:
        return f"{minutes}m{sec:02d}s"
    return f"{sec}s"


def fmt_seconds(ms: int | None) -> str:
    if ms is None:
        return "null"
    if ms >= 120000:
        return fmt_duration(ms)
    if ms >= 1000:
        return f"{ms / 1000:.1f}s"
    return f"{ms}ms"


def percentile(values: list[int], pct: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    idx = round((len(ordered) - 1) * pct)
    return ordered[idx]


def verdict(appends: list[dict], intervals: list[int]) -> str:
    if any((a.get("len") or 0) >= 12000 for a in appends):
        return "LIKELY_12K_HIT"
    if any(i < 1000 for i in intervals):
        return "LIKELY_RATE_LIMITED"
    short_run = 0
    for interval in intervals:
        short_run = short_run + 1 if interval < 3000 else 0
        if short_run >= 3:
            return "LIKELY_RATE_LIMITED"
    if any(i > 5 * 60 * 1000 for i in intervals):
        return "LIKELY_STALE"
    return "OK"


def load_streams(log_path: Path) -> dict[str, dict]:
    streams = defaultdict(lambda: {"appends": [], "errors": []})
    if not log_path.exists():
        raise FileNotFoundError(f"log not found: {log_path}")

    with log_path.open(errors="replace") as fh:
        for line in fh:
            match = LINE_RE.search(line)
            if not match:
                continue
            data = parse_kv(match.group("body"))
            stream_id = data.get("stream_id")
            if not stream_id:
                continue
            stream = streams[stream_id]
            event = match.group("event")
            if event == "startStream":
                stream["started"] = match.group("ts")
                stream["display_mode"] = data.get("display_mode", "unknown")
                stream["initial_chunks"] = to_int(data.get("initial_chunks"))
                stream["initial_len"] = to_int(data.get("initial_len"))
            elif event == "appendStream":
                stream["appends"].append({
                    "ts": match.group("ts"),
                    "chunks": to_int(data.get("chunks")),
                    "len": to_int(data.get("len")) or 0,
                    "since_last_ms": to_int(data.get("since_last_ms")),
                    "n": to_int(data.get("n")),
                    "total_len": to_int(data.get("total_len")),
                    "life_ms": to_int(data.get("life_ms")),
                })
            elif event == "stopStream":
                stream["stop"] = {
                    "life_ms": to_int(data.get("life_ms")),
                    "total_appends": to_int(data.get("total_appends")),
                    "total_append_len": to_int(data.get("total_append_len")),
                    "final_len": to_int(data.get("final_len")),
                    "final_blocks": to_int(data.get("final_blocks")),
                }
            else:
                stream["errors"].append({
                    "ts": match.group("ts"),
                    "event": event,
                    "error": data.get("error", "unknown"),
                })
    return dict(streams)


def render_stream(stream_id: str, stream: dict) -> str:
    appends = stream["appends"]
    lengths = [a["len"] for a in appends]
    intervals = [a["since_last_ms"] for a in appends if a.get("since_last_ms") is not None]
    stop = stream.get("stop") or {}
    life_ms = stop.get("life_ms")
    if life_ms is None and appends:
        life_ms = appends[-1].get("life_ms")

    total_len = stop.get("total_append_len")
    if total_len is None:
        total_len = sum(lengths)
    avg_len = round(total_len / len(appends)) if appends else 0
    max_single = max(lengths) if lengths else 0
    min_interval = min(intervals) if intervals else None
    p50_interval = int(median(intervals)) if intervals else None
    p95_interval = percentile(intervals, 0.95)
    max_interval = max(intervals) if intervals else None

    lines = [
        f"stream_id={stream_id}",
        f"  started: {stream.get('started', 'unknown')}  display_mode={stream.get('display_mode', 'unknown')}",
        f"  lived: {fmt_duration(life_ms)}",
        f"  appends: {len(appends)}  total_len: {total_len:,} chars  avg_len: {avg_len:,}  max_single: {max_single:,}",
        f"  intervals: min={fmt_seconds(min_interval)}  p50={fmt_seconds(p50_interval)}  p95={fmt_seconds(p95_interval)}  max={fmt_seconds(max_interval)}",
        f"  final: markdown_text={stop.get('final_len', 0) or 0} chars, blocks={stop.get('final_blocks', 0) or 0}",
        f"  errors: {len(stream['errors'])}",
        f"  verdict: {verdict(appends, intervals)}",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze Slack streaming observability logs.")
    parser.add_argument("--log", default=DEFAULT_LOG, help=f"log file path (default: {DEFAULT_LOG})")
    parser.add_argument("--thread", help="filter by stream id or Slack timestamp suffix")
    parser.add_argument("--all", action="store_true", help="list recent streams")
    parser.add_argument("-n", "--limit", type=int, default=20, help="number of streams to show with --all/default")
    args = parser.parse_args()

    streams = load_streams(Path(args.log).expanduser())
    items = sorted(streams.items(), key=lambda item: item[1].get("started", ""))
    if args.thread:
        items = [(sid, s) for sid, s in items if args.thread in sid]
    else:
        items = items[-args.limit:]

    if not items:
        print("no matching streams")
        return 1
    print("\n\n".join(render_stream(sid, stream) for sid, stream in items))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
