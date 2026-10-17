#!/usr/bin/env bash
# Fault injection for the latency scenario: switch demo-order to cache bypass, so every
# request goes to MySQL (including the full-scan query on orders.customer_id).
# Reversible with ./recover.sh. Only for the isolated demo environment.
set -euo pipefail
URL="${DEMO_ORDER_URL:-http://127.0.0.1:18081}"
echo "before: $(curl -fsS "$URL/admin/cache-mode")"
curl -fsS -X POST "$URL/admin/cache-mode" -H 'content-type: application/json' -d '{"mode":"bypass"}'
echo
echo "injected at $(date -u +%Y-%m-%dT%H:%M:%SZ): cache mode = bypass"
