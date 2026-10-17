#!/usr/bin/env bash
# Launch sql_runner.py with spark-submit (local[2], event log on) and keep the driver log as
# <driver_log_dir>/<application id>.log. Prints WORKCTL_SPARK_APP_ID=<id> as the last line.
# usage: spark-submit.sh <app-name> <runner args...>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${WORKCTL_DEMO_ROOT:-$(cd "$HERE/../../.." && pwd)}"
RUNTIME="$ROOT/demo/environment/.runtime"
SPARK_HOME="${WORKCTL_SPARK_HOME:-/opt/venvs/spark/lib/python3.12/site-packages/pyspark}"
PY="${WORKCTL_SPARK_PYTHON:-/opt/venvs/spark/bin/python}"
EVENT_DIR="${WORKCTL_SPARK_EVENT_DIR:-$RUNTIME/spark/events}"
export WORKCTL_SPARK_DRIVER_LOG_DIR="${WORKCTL_SPARK_DRIVER_LOG_DIR:-$RUNTIME/spark/driver-logs}"
export WORKCTL_WAREHOUSE_ROOT="${WORKCTL_WAREHOUSE_ROOT:-$RUNTIME/warehouse}"
export SPARK_HOME PYSPARK_PYTHON="$PY" PYSPARK_DRIVER_PYTHON="$PY" SPARK_LOCAL_IP=127.0.0.1
mkdir -p "$EVENT_DIR" "$WORKCTL_SPARK_DRIVER_LOG_DIR"
APP_NAME="$1"; shift
export WORKCTL_DRIVER_LOG_TMP="$WORKCTL_SPARK_DRIVER_LOG_DIR/.pending-$$.log"
APPID_FILE="$WORKCTL_SPARK_DRIVER_LOG_DIR/.pending-$$.appid"

"$SPARK_HOME/bin/spark-submit" \
  --master 'local[2]' \
  --name "$APP_NAME" \
  --conf spark.eventLog.enabled=true \
  --conf "spark.eventLog.dir=file://$EVENT_DIR" \
  --conf spark.ui.enabled=false \
  --conf spark.sql.session.timeZone=Asia/Shanghai \
  --conf spark.driver.memory=1g \
  "$HERE/sql_runner.py" --app-name "$APP_NAME" --app-id-file "$APPID_FILE" "$@" 2>&1 | tee "$WORKCTL_DRIVER_LOG_TMP"
rc=${PIPESTATUS[0]}
APP_ID="$(cat "$APPID_FILE" 2>/dev/null || true)"
rm -f "$APPID_FILE"
if [ -n "$APP_ID" ]; then
  mv -f "$WORKCTL_DRIVER_LOG_TMP" "$WORKCTL_SPARK_DRIVER_LOG_DIR/$APP_ID.log"
  echo "WORKCTL_DRIVER_LOG=$WORKCTL_SPARK_DRIVER_LOG_DIR/$APP_ID.log"
  echo "WORKCTL_SPARK_EXIT_CODE=$rc"
  echo "WORKCTL_SPARK_APP_ID=$APP_ID"
else
  echo "WORKCTL_SPARK_EXIT_CODE=$rc (spark application did not start; log kept at $WORKCTL_DRIVER_LOG_TMP)"
fi
exit "$rc"
