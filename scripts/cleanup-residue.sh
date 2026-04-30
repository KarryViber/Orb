#!/usr/bin/env bash
# Weekly cleanup: residual files from worker cycles, backups, /tmp leftovers, .DS_Store.
# Idempotent. Safe to run anytime.
set -euo pipefail

ORB="$HOME/Orb"
DATA="$ORB/profiles/karry/data"
WS="$ORB/profiles/karry/workspace"

now=$(date +%s)
report=()
report_add() { report+=("$1"); }

# 1. cron-jobs.json.bak — keep newest 3
cd "$DATA"
to_del=$(ls -t cron-jobs.json.bak* 2>/dev/null | tail -n +4 || true)
if [ -n "$to_del" ]; then
  echo "$to_del" | xargs -r rm -f
  count=$(echo "$to_del" | wc -l | tr -d ' ')
  report_add "cron-jobs.bak: kept newest 3, removed $count"
fi

# 2. cc-events / silent-suppressed / traces / reflections — keep 7 days
for d in cc-events silent-suppressed traces reflections; do
  if [ -d "$DATA/$d" ]; then
    n=$(find "$DATA/$d" -maxdepth 1 -type f -mtime +7 -delete -print 2>/dev/null | wc -l | tr -d ' ')
    [ "$n" -gt 0 ] && report_add "$d: pruned $n files >7d"
  fi
done

# 3. digests — keep 7 days, archive older into .archive/
if [ -d "$DATA/digests" ]; then
  mkdir -p "$DATA/digests/.archive"
  n=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    mv "$f" "$DATA/digests/.archive/"
    n=$((n+1))
  done < <(find "$DATA/digests" -maxdepth 1 -type f -mtime +7)
  [ "$n" -gt 0 ] && report_add "digests: archived $n >7d"
fi

# 4. workspace/.images — keep 30 days
if [ -d "$WS/.images" ]; then
  n=$(find "$WS/.images" -maxdepth 1 -type f -mtime +30 -delete -print 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && report_add ".images: pruned $n files >30d"
fi

# 4b. cron run audit logs — keep 30 days
if [ -d "$DATA/cron-runs" ]; then
  n=$(find "$DATA/cron-runs" -type f -name '*.json' -mtime +30 -delete -print 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && report_add "cron-runs: pruned $n files >30d"
fi

# 5. /tmp Orb residues — keep 7 days
n=0
for pattern in "/tmp/orb-*" "/tmp/cron-jobs*" "/tmp/skill_*" "/tmp/skill-*" "/tmp/bookmark-*" "/tmp/bookmarks_*"; do
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    rm -rf "$f"
    n=$((n+1))
  done < <(find $pattern -maxdepth 0 -mtime +7 2>/dev/null || true)
done
[ "$n" -gt 0 ] && report_add "/tmp: removed $n stale Orb files"

# 6. .DS_Store sweep
n=$(find "$ORB" -name '.DS_Store' -not -path '*/node_modules/*' -not -path '*/.git/*' -delete -print 2>/dev/null | wc -l | tr -d ' ')
[ "$n" -gt 0 ] && report_add ".DS_Store: removed $n"

# Output
if [ ${#report[@]} -eq 0 ]; then
  echo "🧹 cleanup-residue｜nothing to do"
else
  echo "🧹 cleanup-residue｜$(date +%m/%d)"
  for line in "${report[@]}"; do echo "  • $line"; done
fi
