#!/usr/bin/env bash
# Stop the Airflow 3 processes started by offline3-up.sh (api-server, scheduler, dag-processor).
# The Airflow 2 instance and the Spark history server (offline-up.sh) are not touched.
set -uo pipefail
cd "$(dirname "$0")"
AF3_HOME="$(pwd)/.runtime/airflow3"

stop_group() {
  local pidfile="$1" name="$2"
  [ -s "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "[offline3] stopping $name (pid $pid)"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

stop_group "$AF3_HOME/api-server.pid" "airflow3 api-server"
stop_group "$AF3_HOME/dag-processor.pid" "airflow3 dag-processor"
stop_group "$AF3_HOME/scheduler.pid" "airflow3 scheduler"
echo "[offline3] stopped"
