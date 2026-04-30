#!/usr/bin/env bash
# cron-preflight.sh — Cron 启动时环境校验
# Usage: bash cron-preflight.sh <check1> [check2] ...
# Checks: longport | health | lark | freee | slack | claude | gh | blogwatcher | finance-screener
# Returns: 0 = all pass, 1 = failure (prints which failed)

set -euo pipefail

FAILED=0
WARNED=0
PROFILE_DIR="$HOME/Orb/profiles/karry"
ENV_FILE="$PROFILE_DIR/.env"

# Helper: read a key from .env file
read_env_key() {
  local key="$1"
  if [[ -f "$ENV_FILE" ]]; then
    grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' | tr -d "'" | tr -d '[:space:]'
  fi
}

for check in "$@"; do
  case "$check" in
    longport)
      if [[ ! -f "$ENV_FILE" ]]; then
        echo "❌ PREFLIGHT: .env file missing at $ENV_FILE"
        FAILED=1
      else
        MISSING_KEYS=()
        for key in LONGPORT_APP_KEY LONGPORT_APP_SECRET LONGPORT_ACCESS_TOKEN; do
          val="$(read_env_key "$key")"
          [[ -z "$val" ]] && MISSING_KEYS+=("$key")
        done
        if [[ ${#MISSING_KEYS[@]} -gt 0 ]]; then
          echo "❌ PREFLIGHT: LongPort credentials missing in .env: ${MISSING_KEYS[*]}"
          FAILED=1
        fi
      fi
      ;;
    health)
      HEALTH_FILE="$HOME/shared-memory/health/apple-health-latest.json"
      if [ ! -f "$HEALTH_FILE" ]; then
        echo "❌ PREFLIGHT: health data file missing"
        FAILED=1
      else
        AGE=$(( $(date +%s) - $(stat -f %m "$HEALTH_FILE") ))
        if [ $AGE -gt 86400 ]; then
          echo "⚠️ PREFLIGHT: health data is $(( AGE / 3600 ))h old (>24h)"
          WARNED=1
        fi
      fi
      ;;
    slack)
      if [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
        : # already in env, ok
      else
        TOKEN="$(read_env_key SLACK_BOT_TOKEN)"
        if [[ -z "$TOKEN" ]]; then
          echo "❌ PREFLIGHT: SLACK_BOT_TOKEN not found in env or $ENV_FILE"
          FAILED=1
        fi
      fi
      ;;
    freee)
      if [ ! -f "$PROFILE_DIR/data/freee-tokens.json" ] && [ ! -f "$PROFILE_DIR/data/.freee-tokens.json" ]; then
        echo "⚠️ PREFLIGHT: freee token file not found (may need refresh)"
        WARNED=1
      fi
      ;;
    claude)
      if ! command -v claude >/dev/null 2>&1; then
        echo "❌ PREFLIGHT: claude CLI not installed"
        FAILED=1
      fi
      ;;
    gh)
      if ! command -v gh >/dev/null 2>&1; then
        echo "❌ PREFLIGHT: gh CLI not installed"
        FAILED=1
      fi
      ;;
    blogwatcher)
      if ! command -v blogwatcher >/dev/null 2>&1; then
        echo "❌ PREFLIGHT: blogwatcher not installed"
        FAILED=1
      fi
      ;;
    finance-screener)
      # Check finance venv python can import key packages
      FINANCE_PYTHON="$PROFILE_DIR/scripts/finance/.venv/bin/python3"
      if [[ -x "$FINANCE_PYTHON" ]]; then
        if ! "$FINANCE_PYTHON" -c "import yfinance, pandas" >/dev/null 2>&1; then
          echo "❌ PREFLIGHT: finance python deps missing (yfinance/pandas)"
          FAILED=1
        fi
      elif command -v python3 >/dev/null 2>&1; then
        if ! python3 -c "import yfinance, pandas" >/dev/null 2>&1; then
          echo "❌ PREFLIGHT: finance python deps missing (yfinance/pandas) — no venv found either"
          FAILED=1
        fi
      else
        echo "❌ PREFLIGHT: python3 not found"
        FAILED=1
      fi
      if [ ! -d "$PROFILE_DIR/scripts/finance" ]; then
        echo "❌ PREFLIGHT: finance scripts directory missing"
        FAILED=1
      fi
      if [ ! -d "$HOME/shared-memory/finance" ]; then
        echo "⚠️ PREFLIGHT: shared-memory finance directory missing"
        WARNED=1
      fi
      ;;
    lark)
      echo "⚠️ PREFLIGHT: lark check not implemented yet"
      WARNED=1
      ;;
    *)
      echo "⚠️ PREFLIGHT: unknown check '$check'"
      WARNED=1
      ;;
  esac
done

if [ $FAILED -eq 0 ]; then
  if [ $WARNED -eq 0 ]; then
    echo "✅ PREFLIGHT: all checks passed"
  else
    echo "✅ PREFLIGHT: passed with warnings"
  fi
fi
exit $FAILED
