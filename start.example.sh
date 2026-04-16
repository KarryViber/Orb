#!/bin/bash
# Orb startup script
# Copy to start.sh and customize for your environment

cd "$(dirname "$0")"

# Load environment
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

exec node src/main.js
