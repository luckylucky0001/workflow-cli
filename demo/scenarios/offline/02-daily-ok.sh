#!/usr/bin/env bash
# Scenario 2: normal daily aggregation for 2026-10-15 -> analytics.daily_orders/dt=2026-10-15.
. "$(dirname "$0")/lib.sh"
trigger demo-daily-orders 2026-10-15 demo__2026-10-15__ok
unpause demo-daily-orders
wait_run demo-daily-orders demo__2026-10-15__ok 900
