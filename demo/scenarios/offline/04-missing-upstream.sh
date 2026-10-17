#!/usr/bin/env bash
# Scenario 4: daily for 2026-10-14 whose ods partition was never extracted. The sensor
# wait_for_ods_partition keeps poking (state up_for_reschedule) until its timeout
# (WORKCTL_DEMO_SENSOR_TIMEOUT, default 6h, read when offline-up.sh starts the scheduler).
. "$(dirname "$0")/lib.sh"
trigger demo-daily-orders 2026-10-14 demo__2026-10-14__missing_upstream
unpause demo-daily-orders
wait_ti demo-daily-orders demo__2026-10-14__missing_upstream wait_for_ods_partition up_for_reschedule 600
