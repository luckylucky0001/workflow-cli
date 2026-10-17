#!/usr/bin/env bash
# Scenario 3: fault "wrong_partition" for 2026-10-16. Every task succeeds, but the Spark job writes
# dt=2026-10-17 (data_interval_end) instead of dt=2026-10-16: scheduler success != data produced.
. "$(dirname "$0")/lib.sh"
trigger demo-daily-orders 2026-10-16 demo__2026-10-16__wrong_partition '{"fault":"wrong_partition"}'
unpause demo-daily-orders
wait_run demo-daily-orders demo__2026-10-16__wrong_partition 900
