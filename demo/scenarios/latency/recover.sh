#!/usr/bin/env bash
# Undo ./inject.sh: restore normal cache-aside mode (TTL from CACHE_TTL_SECONDS or --ttl).
set -euo pipefail
URL="${DEMO_ORDER_URL:-http://127.0.0.1:18081}"
TTL="${1:-300}"
echo "before: $(curl -fsS "$URL/admin/cache-mode")"
curl -fsS -X POST "$URL/admin/cache-mode" -H 'content-type: application/json' -d "{\"mode\":\"normal\",\"ttl_seconds\":${TTL}}"
echo
echo "recovered at $(date -u +%Y-%m-%dT%H:%M:%SZ): cache mode = normal"
