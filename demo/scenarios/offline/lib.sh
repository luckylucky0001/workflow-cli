#!/usr/bin/env bash
# Helpers for the offline scenarios: Airflow stable REST API v1 via curl.
# Credentials are read from the generated secret file and never printed.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_DIR="$(cd "$HERE/../../environment" && pwd)"
AIRFLOW_URL="${AIRFLOW_URL:-http://127.0.0.1:18080}"
TZ_OFFSET="${TZ_OFFSET:-+08:00}"   # business timezone Asia/Shanghai
_pw() { cat "$ENV_DIR/.runtime/secrets/airflow_admin_password"; }
af() { # af METHOD PATH [JSON]
  local m="$1" p="$2" d="${3:-}"
  if [ -n "$d" ]; then
    curl -sS -u "admin:$(_pw)" -X "$m" -H 'content-type: application/json' -d "$d" "$AIRFLOW_URL/api/v1$p"
  else
    curl -sS -u "admin:$(_pw)" -X "$m" "$AIRFLOW_URL/api/v1$p"
  fi
}
next_day() { python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])+datetime.timedelta(days=1))" "$1"; }

# trigger DAG BUSINESS_DATE RUN_ID [CONF_JSON]
# logical_date = D 00:00 in the business timezone; data interval passed explicitly as [D, D+1)
# (without it Airflow infers the previous complete interval for manual runs).
trigger() {
  local dag="$1" d="$2" run_id="$3" conf="${4:-{\}}"
  local start="${d}T00:00:00${TZ_OFFSET}" end
  end="$(next_day "$d")T00:00:00${TZ_OFFSET}"
  local body
  body=$(printf '{"dag_run_id":"%s","logical_date":"%s","data_interval_start":"%s","data_interval_end":"%s","conf":%s,"note":"workctl offline scenario"}' "$run_id" "$start" "$start" "$end" "$conf")
  local out; out=$(af POST "/dags/$dag/dagRuns" "$body")
  if echo "$out" | grep -q '"dag_run_id"'; then echo "triggered $dag $run_id (business date $d)";
  elif echo "$out" | grep -q 'already exists'; then echo "exists    $dag $run_id";
  else echo "trigger failed: $out" >&2; return 1; fi
}

unpause() { af PATCH "/dags/$1?update_mask=is_paused" '{"is_paused": false}' >/dev/null && echo "unpaused $1"; }

run_state() { af GET "/dags/$1/dagRuns/$2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state"))'; }
ti_state() { af GET "/dags/$1/dagRuns/$2/taskInstances/$3" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state"))'; }

# wait_run DAG RUN_ID TIMEOUT_S  -> waits for success|failed
wait_run() {
  local dag="$1" run="$2" t="${3:-600}" s
  for _ in $(seq 1 $((t / 5))); do
    s=$(run_state "$dag" "$run")
    case "$s" in success|failed) echo "$dag $run -> $s"; return 0;; esac
    sleep 5
  done
  echo "$dag $run still $s after ${t}s" >&2; return 1
}

# wait_ti DAG RUN_ID TASK STATE TIMEOUT_S
wait_ti() {
  local dag="$1" run="$2" task="$3" want="$4" t="${5:-600}" s
  for _ in $(seq 1 $((t / 5))); do
    s=$(ti_state "$dag" "$run" "$task")
    [ "$s" = "$want" ] && { echo "$dag $run $task -> $s"; return 0; }
    sleep 5
  done
  echo "$dag $run $task is $s (wanted $want) after ${t}s" >&2; return 1
}
