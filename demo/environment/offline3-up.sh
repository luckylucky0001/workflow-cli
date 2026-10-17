#!/usr/bin/env bash
# Start a SECOND scheduler for the "version swap" demo (design §10.4): Airflow 3.x (REST API v2)
# next to the Airflow 2.10 instance of offline-up.sh. Nothing of the Airflow 2 instance is touched.
#   - Airflow 3 (LocalExecutor + sqlite) api-server on 127.0.0.1:18090, scheduler, dag-processor
#   - same DAG files (demo/offline-workflows/dags), same Spark install / history server (event logs
#     go to the same directory; offline-up.sh must already have started the history server)
#   - ISOLATED data: DAG runs write into .runtime/warehouse-af3 (WORKCTL_WAREHOUSE_ROOT), so the
#     frozen Airflow 2 scenario partitions in .runtime/warehouse are never rewritten
#   - SimpleAuthManager, user admin, password = .runtime/secrets/airflow_admin_password;
#     REST clients exchange it for a JWT via POST /auth/token
# Idempotent: running processes are left alone. Stop with ./offline3-down.sh.
set -euo pipefail
cd "$(dirname "$0")"
ENV_DIR="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"
RUNTIME="$ENV_DIR/.runtime"
AF3_HOME="$RUNTIME/airflow3"
PORT="${AIRFLOW3_PORT:-18090}"

AIRFLOW3_VENV="${AIRFLOW3_VENV:-/opt/venvs/airflow3}"
SPARK_VENV="${SPARK_VENV:-/opt/venvs/spark}"
SPARK_HOME="${SPARK_HOME:-$SPARK_VENV/lib/python3.12/site-packages/pyspark}"

[ -x "$AIRFLOW3_VENV/bin/airflow" ] || {
  echo "[offline3] $AIRFLOW3_VENV/bin/airflow not found. Install (Python 3.12):" >&2
  echo "  uv venv -p /usr/bin/python3.12 $AIRFLOW3_VENV && VIRTUAL_ENV=$AIRFLOW3_VENV uv pip install 'apache-airflow==3.3.2' \\" >&2
  echo "    --constraint https://raw.githubusercontent.com/apache/airflow/constraints-3.3.2/constraints-3.12.txt" >&2
  exit 1
}

mkdir -p "$RUNTIME/secrets" "$AF3_HOME/logs" "$RUNTIME/warehouse-af3" "$RUNTIME/state-af3" \
  "$RUNTIME/spark/events" "$RUNTIME/spark/driver-logs"
# admin password is shared with the Airflow 2 instance (same secret file); JWT / API keys are per instance
for s in airflow_admin_password airflow3_jwt_secret airflow3_api_secret_key; do
  [ -s "$RUNTIME/secrets/$s" ] || head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > "$RUNTIME/secrets/$s"
done
# SimpleAuthManager reads {"user": "password"} from this file (kept with the other secrets, 0600)
python3 - "$RUNTIME/secrets/airflow_admin_password" "$RUNTIME/secrets/airflow3_simple_auth_passwords.json" <<'PY'
import json, sys
pw = open(sys.argv[1], encoding="utf-8").read().strip()
with open(sys.argv[2], "w", encoding="utf-8") as f:
    f.write(json.dumps({"admin": pw}) + "\n")
PY
chmod 600 "$RUNTIME"/secrets/*

# Environment shared by api-server, scheduler, dag-processor, task subprocesses and CLI calls.
# Use the CLI by hand: `set -a; . .runtime/airflow3/airflow.env; set +a; /opt/venvs/airflow3/bin/airflow ...`
cat > "$AF3_HOME/airflow.env" <<EOF
AIRFLOW_HOME=$AF3_HOME
AIRFLOW__CORE__DAGS_FOLDER=$REPO_ROOT/demo/offline-workflows/dags
AIRFLOW__CORE__EXECUTOR=LocalExecutor
AIRFLOW__CORE__PARALLELISM=4
AIRFLOW__DATABASE__SQL_ALCHEMY_CONN=sqlite:///$AF3_HOME/airflow.db
AIRFLOW__CORE__LOAD_EXAMPLES=False
AIRFLOW__CORE__DEFAULT_TIMEZONE=Asia/Shanghai
AIRFLOW__CORE__DAGS_ARE_PAUSED_AT_CREATION=True
AIRFLOW__CORE__DAGBAG_IMPORT_TIMEOUT=60
AIRFLOW__CORE__AUTH_MANAGER=airflow.api_fastapi.auth.managers.simple.simple_auth_manager.SimpleAuthManager
AIRFLOW__CORE__SIMPLE_AUTH_MANAGER_USERS=admin:admin
AIRFLOW__CORE__SIMPLE_AUTH_MANAGER_PASSWORDS_FILE=$RUNTIME/secrets/airflow3_simple_auth_passwords.json
AIRFLOW__CORE__EXECUTION_API_SERVER_URL=http://127.0.0.1:$PORT/execution/
AIRFLOW__API__BASE_URL=http://127.0.0.1:$PORT
AIRFLOW__API__HOST=127.0.0.1
AIRFLOW__API__PORT=$PORT
AIRFLOW__API__WORKERS=1
AIRFLOW__API__EXPOSE_CONFIG=False
AIRFLOW__API__SECRET_KEY=$(cat "$RUNTIME/secrets/airflow3_api_secret_key")
AIRFLOW__API_AUTH__JWT_SECRET=$(cat "$RUNTIME/secrets/airflow3_jwt_secret")
AIRFLOW__DAG_PROCESSOR__REFRESH_INTERVAL=30
AIRFLOW__DAG_PROCESSOR__MIN_FILE_PROCESS_INTERVAL=15
AIRFLOW__DAG_PROCESSOR__DAG_FILE_PROCESSOR_TIMEOUT=120
AIRFLOW__LOGGING__BASE_LOG_FOLDER=$AF3_HOME/logs
AIRFLOW__LOGGING__WORKER_LOG_SERVER_PORT=18793
AIRFLOW__SCHEDULER__ENABLE_HEALTH_CHECK=False
# Airflow 3 defaults cron schedules to CronTriggerTimetable (zero-length data interval, logical_date = run time).
# Keep the Airflow 2 semantics the DAGs are written for: @daily run of business date D has interval [D, D+1).
AIRFLOW__SCHEDULER__CREATE_CRON_DATA_INTERVALS=True
WORKCTL_DEMO_ROOT=$REPO_ROOT
WORKCTL_WAREHOUSE_ROOT=$RUNTIME/warehouse-af3
WORKCTL_SPARK_HOME=$SPARK_HOME
WORKCTL_SPARK_PYTHON=$SPARK_VENV/bin/python
WORKCTL_SPARK_EVENT_DIR=$RUNTIME/spark/events
WORKCTL_SPARK_DRIVER_LOG_DIR=$RUNTIME/spark/driver-logs
EOF
chmod 600 "$AF3_HOME/airflow.env"
set -a
# shellcheck disable=SC1091
. "$AF3_HOME/airflow.env"
set +a
export PATH="$AIRFLOW3_VENV/bin:$PATH"

alive() { [ -s "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

echo "[offline3] airflow db migrate ($(airflow version 2>/dev/null | tail -1))"
airflow db migrate >"$AF3_HOME/db-migrate.log" 2>&1 || { tail -20 "$AF3_HOME/db-migrate.log"; exit 1; }
airflow pools set demo-batch-pool 2 "demo batch pool (Spark aggregate tasks)" >"$AF3_HOME/pools.log" 2>&1 || { tail -5 "$AF3_HOME/pools.log"; exit 1; }

start() { # start NAME CMD...
  local name="$1"; shift
  if alive "$AF3_HOME/$name.pid"; then
    echo "[offline3] $name already running (pid $(cat "$AF3_HOME/$name.pid"))"
  else
    echo "[offline3] starting $name"
    setsid nohup "$@" >"$AF3_HOME/$name.out" 2>&1 < /dev/null &
    echo $! > "$AF3_HOME/$name.pid"
  fi
}
start api-server airflow api-server --host 127.0.0.1 --port "$PORT"
start scheduler airflow scheduler
start dag-processor airflow dag-processor
# The demo DAGs use a reschedule-mode sensor (not deferrable), so no triggerer is started.

echo "[offline3] waiting for api-server on 127.0.0.1:$PORT"
for _ in $(seq 1 90); do
  h=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v2/monitor/health" || true)
  if [ "$h" = "200" ]; then echo "[offline3] airflow 3 ready (http://127.0.0.1:$PORT)"; exit 0; fi
  sleep 2
done
echo "[offline3] api-server not ready (health=$h); see $AF3_HOME/*.out" >&2
exit 1
