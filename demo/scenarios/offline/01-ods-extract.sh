#!/usr/bin/env bash
# Scenario 1: extract ods.orders for business dates 2026-10-15 and 2026-10-16 (real Airflow runs).
. "$(dirname "$0")/lib.sh"
trigger demo-ods-orders 2026-10-15 demo__2026-10-15__ods
trigger demo-ods-orders 2026-10-16 demo__2026-10-16__ods
unpause demo-ods-orders
wait_run demo-ods-orders demo__2026-10-15__ods 600
wait_run demo-ods-orders demo__2026-10-16__ods 600
