#!/usr/bin/env bash
# Start the offline part of the demo environment (no containers):
#   - Airflow 2.10 (SequentialExecutor + sqlite) on 127.0.0.1:18080, DAGs from demo/offline-workflows/dags
#   - Spark history server on 127.0.0.1:18088 reading demo/environment/.runtime/spark/events
# Idempotent: already-running processes are left alone. Stop with ./offline-down.sh.
set -euo pipefail
cd "$(dirname "$0")"
ENV_DIR="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"
RUNTIME="$ENV_DIR/.runtime"

AIRFLOW_VENV="${AIRFLOW_VENV:-/opt/venvs/airflow}"
SPARK_VENV="${SPARK_VENV:-/opt/venvs/spark}"
SPARK_HOME="${SPARK_HOME:-$SPARK_VENV/lib/python3.12/site-packages/pyspark}"

mkdir -p "$RUNTIME/secrets" "$RUNTIME/airflow" "$RUNTIME/spark/events" "$RUNTIME/spark/driver-logs" \
  "$RUNTIME/spark/queries" "$RUNTIME/spark/history" "$RUNTIME/warehouse"
for s in airflow_admin_password airflow_webserver_secret; do
  [ -s "$RUNTIME/secrets/$s" ] || head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24 > "$RUNTIME/secrets/$s"
done
chmod 600 "$RUNTIME"/secrets/*

# Environment shared by the scheduler, the webserver, task subprocesses and `airflow` CLI calls.
# Source this file to use the CLI by hand: `set -a; . .runtime/airflow/airflow.env; set +a`.
cat > "$RUNTIME/airflow/airflow.env" <<EOF
AIRFLOW_HOME=$RUNTIME/airflow
AIRFLOW__CORE__DAGS_FOLDER=$REPO_ROOT/demo/offline-workflows/dags
AIRFLOW__CORE__EXECUTOR=SequentialExecutor
AIRFLOW__DATABASE__SQL_ALCHEMY_CONN=sqlite:///$RUNTIME/airflow/airflow.db
AIRFLOW__CORE__LOAD_EXAMPLES=False
AIRFLOW__CORE__DEFAULT_TIMEZONE=Asia/Shanghai
AIRFLOW__CORE__DAGS_ARE_PAUSED_AT_CREATION=True
AIRFLOW__CORE__DAG_FILE_PROCESSOR_TIMEOUT=120
AIRFLOW__CORE__DAGBAG_IMPORT_TIMEOUT=60
AIRFLOW__WEBSERVER__DEFAULT_UI_TIMEZONE=Asia/Shanghai
AIRFLOW__WEBSERVER__WEB_SERVER_HOST=127.0.0.1
AIRFLOW__WEBSERVER__WEB_SERVER_PORT=18080
AIRFLOW__WEBSERVER__WORKERS=2
AIRFLOW__WEBSERVER__EXPOSE_CONFIG=False
AIRFLOW__API__AUTH_BACKENDS=airflow.api.auth.backend.basic_auth,airflow.api.auth.backend.session
AIRFLOW__SCHEDULER__DAG_DIR_LIST_INTERVAL=30
AIRFLOW__SCHEDULER__MIN_FILE_PROCESS_INTERVAL=15
AIRFLOW__LOGGING__BASE_LOG_FOLDER=$RUNTIME/airflow/logs
AIRFLOW__LOGGING__DAG_PROCESSOR_MANAGER_LOG_LOCATION=$RUNTIME/airflow/logs/dag_processor_manager/dag_processor_manager.log
AIRFLOW__SCHEDULER__CHILD_PROCESS_LOG_DIRECTORY=$RUNTIME/airflow/logs/scheduler
AIRFLOW__WEBSERVER__SECRET_KEY=$(cat "$RUNTIME/secrets/airflow_webserver_secret")
WORKCTL_DEMO_ROOT=$REPO_ROOT
WORKCTL_WAREHOUSE_ROOT=$RUNTIME/warehouse
WORKCTL_SPARK_HOME=$SPARK_HOME
WORKCTL_SPARK_PYTHON=$SPARK_VENV/bin/python
WORKCTL_SPARK_EVENT_DIR=$RUNTIME/spark/events
WORKCTL_SPARK_DRIVER_LOG_DIR=$RUNTIME/spark/driver-logs
EOF
chmod 600 "$RUNTIME/airflow/airflow.env"
set -a
# shellcheck disable=SC1091
. "$RUNTIME/airflow/airflow.env"
set +a
export PATH="$AIRFLOW_VENV/bin:$PATH"

alive() { [ -s "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

echo "[offline] airflow db migrate"
airflow db migrate >"$RUNTIME/airflow/db-migrate.log" 2>&1 || { tail -20 "$RUNTIME/airflow/db-migrate.log"; exit 1; }

ADMIN_PW="$(cat "$RUNTIME/secrets/airflow_admin_password")"
if airflow users list -o plain 2>/dev/null | awk '{print $2}' | grep -qx admin; then
  airflow users reset-password --username admin --password "$ADMIN_PW" >/dev/null 2>&1 || true
else
  airflow users create --username admin --password "$ADMIN_PW" --firstname Demo --lastname Admin \
    --role Admin --email admin@example.invalid >/dev/null 2>&1
fi
unset ADMIN_PW
airflow pools set demo-batch-pool 2 "demo batch pool (Spark aggregate tasks)" >/dev/null 2>&1

if alive "$RUNTIME/airflow/scheduler.pid"; then
  echo "[offline] scheduler already running (pid $(cat "$RUNTIME/airflow/scheduler.pid"))"
else
  echo "[offline] starting scheduler"
  setsid nohup airflow scheduler >"$RUNTIME/airflow/scheduler.out" 2>&1 < /dev/null &
  echo $! > "$RUNTIME/airflow/scheduler.pid"
fi

if alive "$RUNTIME/airflow/webserver.pid"; then
  echo "[offline] webserver already running (pid $(cat "$RUNTIME/airflow/webserver.pid"))"
else
  echo "[offline] starting webserver on 127.0.0.1:18080"
  setsid nohup airflow webserver --hostname 127.0.0.1 --port 18080 >"$RUNTIME/airflow/webserver.out" 2>&1 < /dev/null &
  echo $! > "$RUNTIME/airflow/webserver.pid"
fi

# Spark history server (daemon script manages its own pid file under SPARK_PID_DIR).
export SPARK_HOME
export SPARK_LOG_DIR="$RUNTIME/spark/history"
export SPARK_PID_DIR="$RUNTIME/spark/history"
export SPARK_LOCAL_IP=127.0.0.1
export SPARK_HISTORY_OPTS="-Dspark.history.fs.logDirectory=file://$RUNTIME/spark/events -Dspark.history.ui.port=18088 -Dspark.history.fs.update.interval=5s -Dspark.history.retainedApplications=50"
if ls "$SPARK_PID_DIR"/*HistoryServer*.pid >/dev/null 2>&1 && kill -0 "$(cat "$SPARK_PID_DIR"/*HistoryServer*.pid)" 2>/dev/null; then
  echo "[offline] spark history server already running"
else
  echo "[offline] starting spark history server on 127.0.0.1:18088"
  "$SPARK_HOME/sbin/start-history-server.sh" >/dev/null
fi

echo "[offline] waiting for endpoints"
for i in $(seq 1 90); do
  a=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/health || true)
  s=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18088/api/v1/version || true)
  if [ "$a" = "200" ] && [ "$s" = "200" ]; then echo "[offline] airflow + spark history ready"; exit 0; fi
  sleep 2
done
echo "[offline] endpoints not ready (airflow=$a spark-history=$s); see $RUNTIME/airflow/*.out and $SPARK_LOG_DIR" >&2
exit 1
