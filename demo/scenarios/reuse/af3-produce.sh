#!/usr/bin/env bash
# Produce the offline scenarios on the Airflow 3 instance (demo/environment/offline3-up.sh, REST API v2)
# with the SAME run ids, business dates and conf as demo/scenarios/offline/run-all.sh on Airflow 2.
# Only the Airflow 3 instance is called (127.0.0.1:18090); its runs write .runtime/warehouse-af3.
# Runs are triggered before the DAGs are unpaused (the scheduler skips a scheduled run whose
# logical_date already exists) and both DAGs are paused again at the end to freeze the state.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_DIR="$(cd "$HERE/../../environment" && pwd)"
AF3_URL="${AF3_URL:-http://127.0.0.1:18090}"
TZ_OFFSET="+08:00"

token() { # POST /auth/token (SimpleAuthManager) -> JWT; the password is read from the secret file, never printed
  python3 - "$ENV_DIR/.runtime/secrets/airflow_admin_password" "$AF3_URL" <<'PY'
import json, sys, urllib.request
pw = open(sys.argv[1], encoding="utf-8").read().strip()
req = urllib.request.Request(sys.argv[2] + "/auth/token", data=json.dumps({"username": "admin", "password": pw}).encode(),
                             headers={"content-type": "application/json"}, method="POST")
print(json.load(urllib.request.urlopen(req))["access_token"])
PY
}
TOKEN="$(token)"
af() { # af METHOD PATH [JSON]
  local m="$1" p="$2" d="${3:-}"
  if [ -n "$d" ]; then
    curl -sS -H "Authorization: Bearer $TOKEN" -X "$m" -H 'content-type: application/json' -d "$d" "$AF3_URL/api/v2$p"
  else
    curl -sS -H "Authorization: Bearer $TOKEN" -X "$m" "$AF3_URL/api/v2$p"
  fi
}
next_day() { python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])+datetime.timedelta(days=1))" "$1"; }

# REST v2: logical_date is a required key; data interval passed explicitly as [D, D+1) like on Airflow 2
trigger() {
  local dag="$1" d="$2" run_id="$3" conf="${4:-{\}}"
  local start="${d}T00:00:00${TZ_OFFSET}" end
  end="$(next_day "$d")T00:00:00${TZ_OFFSET}"
  local body out
  body=$(printf '{"dag_run_id":"%s","logical_date":"%s","data_interval_start":"%s","data_interval_end":"%s","conf":%s,"note":"workctl offline scenario (airflow 3)"}' "$run_id" "$start" "$start" "$end" "$conf")
  out=$(af POST "/dags/$dag/dagRuns" "$body")
  if echo "$out" | grep -q '"dag_run_id"'; then echo "triggered $dag $run_id (business date $d)";
  elif echo "$out" | grep -qi 'already exists\|unique constraint'; then echo "exists    $dag $run_id";
  else echo "trigger failed: $out" >&2; return 1; fi
}
set_paused() { af PATCH "/dags/$1?update_mask=is_paused" "{\"is_paused\": $2}" >/dev/null && echo "$1 is_paused=$2"; }
run_state() { af GET "/dags/$1/dagRuns/$2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state"))'; }
ti_state() { af GET "/dags/$1/dagRuns/$2/taskInstances/$3" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state"))'; }
wait_run() {
  local dag="$1" run="$2" t="${3:-900}" s
  for _ in $(seq 1 $((t / 5))); do
    s=$(run_state "$dag" "$run"); case "$s" in success|failed) echo "$dag $run -> $s"; return 0;; esac; sleep 5
  done
  echo "$dag $run still $s after ${t}s" >&2; return 1
}
wait_ti() {
  local dag="$1" run="$2" task="$3" want="$4" t="${5:-300}" s
  for _ in $(seq 1 $((t / 5))); do
    s=$(ti_state "$dag" "$run" "$task"); [ "$s" = "$want" ] && { echo "$dag $run $task -> $s"; return 0; }; sleep 5
  done
  echo "$dag $run $task is $s (wanted $want) after ${t}s" >&2; return 1
}

trigger demo-ods-orders 2026-10-15 demo__2026-10-15__ods
trigger demo-ods-orders 2026-10-16 demo__2026-10-16__ods
trigger demo-daily-orders 2026-10-15 demo__2026-10-15__ok
trigger demo-daily-orders 2026-10-16 demo__2026-10-16__wrong_partition '{"fault":"wrong_partition"}'
trigger demo-daily-orders 2026-10-14 demo__2026-10-14__missing_upstream
set_paused demo-ods-orders false
set_paused demo-daily-orders false
wait_run demo-ods-orders demo__2026-10-15__ods 600
wait_run demo-ods-orders demo__2026-10-16__ods 600
wait_run demo-daily-orders demo__2026-10-15__ok 900
wait_run demo-daily-orders demo__2026-10-16__wrong_partition 900
wait_ti demo-daily-orders demo__2026-10-14__missing_upstream wait_for_ods_partition up_for_reschedule 300
set_paused demo-ods-orders true
set_paused demo-daily-orders true
echo "warehouse (airflow 3): $(cd "$ENV_DIR/.runtime/warehouse-af3" && find . -name _SUCCESS | sort | tr '\n' ' ')"
