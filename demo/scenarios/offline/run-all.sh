#!/usr/bin/env bash
# Produce all offline scenarios. Runs are triggered BEFORE the DAGs are unpaused so the scheduler
# does not create its own scheduled run for the same logical date (it skips existing ones).
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
trigger demo-ods-orders 2026-10-15 demo__2026-10-15__ods
trigger demo-ods-orders 2026-10-16 demo__2026-10-16__ods
trigger demo-daily-orders 2026-10-15 demo__2026-10-15__ok
trigger demo-daily-orders 2026-10-16 demo__2026-10-16__wrong_partition '{"fault":"wrong_partition"}'
trigger demo-daily-orders 2026-10-14 demo__2026-10-14__missing_upstream
unpause demo-ods-orders
unpause demo-daily-orders
./01-ods-extract.sh
./02-daily-ok.sh
./03-wrong-partition.sh
./04-missing-upstream.sh
# Freeze the scenario state: otherwise the scheduler creates the next business day's run at
# 00:00 Asia/Shanghai and overwrites the wrong-partition evidence. Unpause to resume scheduling.
pause demo-ods-orders
pause demo-daily-orders
