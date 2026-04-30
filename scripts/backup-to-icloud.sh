#!/bin/bash
# Orb 全量冷备脚本 — 每日一次打 tarball 进 iCloud Drive
# 目的：Mac 彻底挂了能从 iCloud 拉最新 tarball 完整复活
set -euo pipefail

ORB_ROOT="$HOME/Orb"
ICLOUD_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/OrbBackup"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DATE=$(date +%Y%m%d)
TS=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$HOME/Orb/logs/backup-to-icloud.log"
mkdir -p "$(dirname "$LOG_FILE")" "$ICLOUD_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

log "=== Backup start: $TS ==="
log "Staging: $STAGING"

# ─── 1. rsync Orb 到 staging，排除无需备份的垃圾 ───
log "Step 1/5: rsync Orb -> staging"
rsync -a \
  --exclude='node_modules/' \
  --exclude='.git/' \
  --exclude='logs/' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='venvs/' \
  --exclude='.venv/' \
  "$ORB_ROOT/" "$STAGING/Orb/"

# ─── 2. 为每个 venv 导出 pip freeze 快照（取代二进制） ───
log "Step 2/5: snapshot venvs via pip freeze"
while IFS= read -r venv_dir; do
  [ -z "$venv_dir" ] && continue
  rel_path="${venv_dir#$ORB_ROOT/}"
  pip_bin="$venv_dir/bin/pip"
  [ -x "$pip_bin" ] || continue
  snapshot_dir="$STAGING/Orb/$rel_path"
  mkdir -p "$snapshot_dir"
  "$pip_bin" freeze > "$snapshot_dir/requirements-snapshot.txt" 2>/dev/null || \
    log "  WARN: pip freeze failed for $venv_dir"
  # 记录 python 版本，重建时好对齐
  "$venv_dir/bin/python" --version > "$snapshot_dir/python-version.txt" 2>&1 || true
  log "  snapshot: $rel_path"
done < <(find "$ORB_ROOT/profiles" -type d -name "venvs" -not -path "*/node_modules/*" 2>/dev/null | \
         xargs -I{} find {} -mindepth 1 -maxdepth 1 -type d 2>/dev/null)

# ─── 3. SQLite 原子快照替换 live DB ───
log "Step 3/5: sqlite .backup for all *.db"
while IFS= read -r db; do
  [ -z "$db" ] && continue
  rel_path="${db#$ORB_ROOT/}"
  target="$STAGING/Orb/$rel_path"
  mkdir -p "$(dirname "$target")"
  if sqlite3 "$db" ".backup '$target'" 2>>"$LOG_FILE"; then
    log "  backup: $rel_path"
  else
    log "  WARN: sqlite backup failed for $db (keeping rsync copy)"
  fi
done < <(find "$ORB_ROOT/profiles" -name "*.db" -not -path "*/node_modules/*" -not -path "*/venvs/*" 2>/dev/null)

# 清理 WAL/SHM/journal（已被 .backup 合并进主库）
find "$STAGING/Orb" \( -name "*.db-wal" -o -name "*.db-shm" -o -name "*.db-journal" \) -delete 2>/dev/null || true

# ─── 4. 带上所有 com.orb.* launchd plist ───
log "Step 4/5: copy launchd plists"
mkdir -p "$STAGING/LaunchAgents"
copied=0
for plist in "$LAUNCH_AGENTS_DIR"/com.orb.*.plist; do
  [ -f "$plist" ] || continue
  # 跳过 .bak* 备份文件
  case "$plist" in
    *.bak*) continue ;;
  esac
  cp "$plist" "$STAGING/LaunchAgents/"
  copied=$((copied + 1))
done
log "  copied $copied plist(s)"

# ─── 5. 打包 + 原子覆盖 iCloud 唯一副本 ───
TARBALL_NAME="orb-full-latest.tar.gz"
TARBALL_PATH="$STAGING/$TARBALL_NAME"
log "Step 5/5: tar -> $TARBALL_NAME"
tar czf "$TARBALL_PATH" -C "$STAGING" Orb LaunchAgents 2>>"$LOG_FILE"

SIZE=$(du -h "$TARBALL_PATH" | awk '{print $1}')
log "  tarball size: $SIZE"

# 原子覆盖：先写 .tmp 再 mv，避免中途失败留下损坏文件
cp "$TARBALL_PATH" "$ICLOUD_DIR/$TARBALL_NAME.tmp"
mv -f "$ICLOUD_DIR/$TARBALL_NAME.tmp" "$ICLOUD_DIR/$TARBALL_NAME"
log "  delivered: $ICLOUD_DIR/$TARBALL_NAME"

# 清理旧格式 orb-full-YYYYMMDD.tar.gz（迁移后一次性清空）
removed=0
for f in "$ICLOUD_DIR"/orb-full-[0-9]*.tar.gz; do
  [ -f "$f" ] || continue
  rm -f "$f"
  removed=$((removed + 1))
  log "  removed old: $(basename "$f")"
done
[ "$removed" -gt 0 ] && log "  cleaned $removed legacy dated tarball(s)"

log "=== Backup done: $TARBALL_NAME ($SIZE) ==="
echo "OK $TARBALL_NAME $SIZE"
