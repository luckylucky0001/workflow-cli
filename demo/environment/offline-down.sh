#!/usr/bin/env bash
# Stop the offline demo processes started by offline-up.sh (Airflow scheduler/webserver, Spark history server).
set -uo pipefail
cd "$(dirname "$0")"
RUNTIME="$(pwd)/.runtime"
SPARK_HOME="${SPARK_HOME:-/opt/venvs/spark/lib/python3.12/site-packages/pyspark}"

stop_group() {
  local pidfile="$1" name="$2"
  [ -s "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "[offline] stopping $name (pid $pid)"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

stop_group "$RUNTIME/airflow/webserver.pid" "airflow webserver"
stop_group "$RUNTIME/airflow/scheduler.pid" "airflow scheduler"
# gunicorn writes its own pid file in AIRFLOW_HOME
[ -s "$RUNTIME/airflow/airflow-webserver.pid" ] && kill -TERM "$(cat "$RUNTIME/airflow/airflow-webserver.pid")" 2>/dev/null; rm -f "$RUNTIME/airflow/airflow-webserver.pid"

if [ -d "$RUNTIME/spark/history" ]; then
  SPARK_PID_DIR="$RUNTIME/spark/history" SPARK_LOG_DIR="$RUNTIME/spark/history" "$SPARK_HOME/sbin/stop-history-server.sh" >/dev/null 2>&1 || true
fi
echo "[offline] stopped"
