#!/usr/bin/env python3
"""异常驱动的 mac 健康巡检。

输出 JSON `{"anomalies": [...], "state_path": ...}`。
异常分类：zombie / stale_worker / daemon_dead / disk_growth / large_new_file。
无异常时 anomalies 为空数组。所有错误吞进 anomalies，不抛异常。
"""

import json
import os
import re
import subprocess
import time
from pathlib import Path

STATE = Path.home() / "Orb/profiles/karry/data/.disk-usage-state.json"
WATCH_DIRS = [
    Path.home() / ".claude/projects",
    Path.home() / "Orb/profiles/karry/data",
    Path("/tmp"),
    Path.home() / "Library/Logs",
]
DELTA_THRESHOLD_GB = 3.0
WORKER_STALE_HOURS = 2
LARGE_FILE_THRESHOLD_MB = 500
RUNAWAY_RSS_GB = 4.0       # 全 mac 扫，单进程 RSS 超 4GB → 异常
RUNAWAY_CPU_PCT = 80.0      # 单进程 CPU% 超 80 → 异常（瞬时采样）
# 已知大户：这些进程本来就吃内存，不算异常
RUNAWAY_RSS_WHITELIST = [
    # 浏览器 / Electron app（Helper 进程可能 4-8GB 正常）
    r"Google Chrome", r"Chromium", r"Safari", r"Firefox",
    r"Code Helper", r"Slack Helper", r"Cursor Helper", r"Claude Helper",
    r"Electron", r"ms-teams",
    # macOS 系统进程
    r"WindowServer", r"kernel_task", r"mds", r"mds_stores", r"mdworker",
    r"Photos\.app", r"photoanalysisd", r"mediaanalysisd", r"photolibraryd",
    # 虚拟化 / 容器
    r"Docker", r"com\.docker", r"qemu", r"Parallels", r"VirtualBoxVM", r"VMware",
    r"Virtualization\.framework",
    # 开发工具（吃内存正常）
    r"Xcode", r"clangd", r"sourcekit", r"rust-analyzer", r"gopls", r"jetbrains",
]
ORB_DAEMON_PATTERN = "node.*src/main.js"
WORKER_PATTERN = "claude.*cli|orb.*worker"
LARGE_FILE_WHITELIST = [
    r"/Movies/", r"/Downloads/", r"\.dmg$", r"\.iso$", r"\.mp4$", r"\.mov$", r"\.mkv$",
    r"/VirtualBox VMs/", r"/Parallels/", r"/\.Trash/",
    # macOS / 第三方 app 正常数据目录
    r"/Library/",
    # Photos 库
    r"\.photoslibrary/",
]


def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:
        return 1, "", str(e)


def check_zombies():
    out = []
    rc, stdout, _ = run(["ps", "-axo", "stat,pid,command"])
    if rc != 0:
        return out
    for line in stdout.splitlines()[1:]:
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        stat, pid, cmd = parts
        if stat.startswith("Z"):
            out.append({"type": "zombie", "detail": f"PID {pid} {cmd[:80]}"})
    return out


def check_runaway_procs():
    """全 mac 扫 RSS/CPU 异常进程（不是 zombie，是『活着但吃资源不退』）。"""
    out = []
    # ps 字段：pid, %cpu, rss(KB), command
    rc, stdout, _ = run(["ps", "-axo", "pid=,%cpu=,rss=,command="])
    if rc != 0:
        return out
    wl = re.compile("|".join(RUNAWAY_RSS_WHITELIST))
    for line in stdout.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) < 4:
            continue
        pid, cpu_s, rss_s, cmd = parts
        try:
            cpu = float(cpu_s)
            rss_gb = int(rss_s) / 1024 / 1024
        except ValueError:
            continue
        if rss_gb >= RUNAWAY_RSS_GB and not wl.search(cmd):
            out.append({
                "type": "runaway_rss",
                "detail": f"PID {pid} RSS {rss_gb:.1f}GB: {cmd[:80]}",
            })
        if cpu >= RUNAWAY_CPU_PCT:
            out.append({
                "type": "runaway_cpu",
                "detail": f"PID {pid} CPU {cpu:.0f}%: {cmd[:80]}",
            })
    return out


def _parse_etime(s):
    """macOS ps etime: [[DD-]HH:]MM:SS → 秒。"""
    s = s.strip()
    days = 0
    if "-" in s:
        d, s = s.split("-", 1)
        days = int(d)
    parts = s.split(":")
    parts = [int(p) for p in parts]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, sec = parts
    return days * 86400 + h * 3600 + m * 60 + sec


def _ps_match(pattern):
    """macOS pgrep -f 对短命令行不可靠（实测 22 char 内的 cmd 不匹配）；改 ps 自己 grep。
    macOS BSD ps 没有 etimes，只有 etime（[[DD-]HH:]MM:SS），所以分两次 ps。
    返回 [(pid, sec, cmd)]。"""
    rc, stdout, _ = run(["ps", "-axo", "pid=,command="])
    if rc != 0:
        return []
    pat = re.compile(pattern)
    out = []
    for line in stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        pid, cmd = parts
        if not pat.search(cmd):
            continue
        rc2, stdout2, _ = run(["ps", "-o", "etime=", "-p", pid])
        if rc2 != 0:
            continue
        try:
            sec = _parse_etime(stdout2)
        except (ValueError, IndexError):
            continue
        out.append((pid, sec, cmd))
    return out


def check_stale_workers():
    out = []
    for pid, sec, cmd in _ps_match(WORKER_PATTERN):
        if sec > WORKER_STALE_HOURS * 3600:
            hrs = sec / 3600
            out.append({
                "type": "stale_worker",
                "detail": f"PID {pid} running {hrs:.1f}h: {cmd[:80]}",
            })
    return out


def check_daemon():
    matches = _ps_match(ORB_DAEMON_PATTERN)
    if not matches:
        return [{"type": "daemon_dead", "detail": "no Orb main.js process running"}]
    return []


def check_disk_growth():
    out = []
    state = {}
    if STATE.exists():
        try:
            state = json.loads(STATE.read_text())
        except Exception:
            state = {}
    prev = state.get("usage", {})
    prev_ts = state.get("timestamp", 0)
    now_ts = time.time()
    hours_since = (now_ts - prev_ts) / 3600 if prev_ts else 0

    cur = {}
    for d in WATCH_DIRS:
        if not d.exists():
            continue
        rc, stdout, _ = run(["du", "-sk", str(d)], timeout=120)
        if rc != 0:
            continue
        try:
            kb = int(stdout.split()[0])
        except (ValueError, IndexError):
            continue
        cur[str(d)] = kb
        if str(d) in prev and hours_since > 0:
            delta_gb = (kb - prev[str(d)]) / 1024 / 1024
            scaled_threshold = DELTA_THRESHOLD_GB * (hours_since / 24) if hours_since < 24 else DELTA_THRESHOLD_GB
            scaled_threshold = max(scaled_threshold, 0.5)  # 间隔再短也至少 0.5GB 才算异常
            if delta_gb >= scaled_threshold:
                out.append({
                    "type": "disk_growth",
                    "detail": f"{d}: +{delta_gb:.1f}GB in {hours_since:.1f}h (now {kb/1024/1024:.1f}GB)",
                })

    try:
        STATE.write_text(json.dumps({"timestamp": now_ts, "usage": cur}, indent=2))
    except Exception:
        pass
    return out


def check_large_new_files():
    out = []
    rc, stdout, _ = run(
        ["find", str(Path.home()), "-type", "f", "-size", f"+{LARGE_FILE_THRESHOLD_MB}M", "-mtime", "-1"],
        timeout=90,
    )
    if rc not in (0, 1):
        return out
    for line in stdout.splitlines()[:10]:
        if any(re.search(p, line) for p in LARGE_FILE_WHITELIST):
            continue
        try:
            sz = os.path.getsize(line) / 1024 / 1024
        except OSError:
            continue
        out.append({
            "type": "large_new_file",
            "detail": f"{line[:100]} ({sz:.0f}MB, new in 24h)",
        })
    return out


def main():
    anomalies = []
    for fn in (check_zombies, check_runaway_procs, check_stale_workers, check_daemon, check_disk_growth, check_large_new_files):
        try:
            anomalies.extend(fn())
        except Exception as e:
            anomalies.append({"type": "check_error", "detail": f"{fn.__name__}: {e}"})
    print(json.dumps({"anomalies": anomalies, "state_path": str(STATE)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
