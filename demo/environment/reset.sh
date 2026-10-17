#!/usr/bin/env bash
# Tear down containers, volumes and runtime state (secrets are regenerated on next up).
set -euo pipefail
cd "$(dirname "$0")"
[ -x ./offline-down.sh ] && ./offline-down.sh || true
docker compose down -v --remove-orphans
rm -rf .runtime
echo "demo environment reset"
