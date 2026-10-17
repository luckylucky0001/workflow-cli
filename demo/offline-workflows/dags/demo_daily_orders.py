"""demo-daily-orders: aggregate ods.orders of one business date into analytics.daily_orders/dt=<date>.

wait_for_ods_partition (sensor, reschedule) -> aggregate_orders (spark-submit, pool demo-batch-pool) -> validate_output

Business date = data_interval_start in Asia/Shanghai. Fault injection for the demo (dag_run conf / params):
  {"fault": "wrong_partition"}  the output path uses data_interval_end (the "next_ds" bug): the job succeeds
                                but writes dt=<D+1>, leaving dt=<D> missing.
"""
import os
from pathlib import Path

import pendulum
from airflow import DAG
from airflow.models.param import Param
from airflow.operators.bash import BashOperator
from airflow.operators.python import PythonOperator
from airflow.sensors.python import PythonSensor

ROOT = Path(os.environ.get("WORKCTL_DEMO_ROOT") or Path(__file__).resolve().parents[3])
WAREHOUSE = os.environ.get("WORKCTL_WAREHOUSE_ROOT") or str(ROOT / "demo/environment/.runtime/warehouse")
SENSOR_TIMEOUT = int(os.environ.get("WORKCTL_DEMO_SENSOR_TIMEOUT", str(6 * 3600)))
TZ = pendulum.timezone("Asia/Shanghai")
BUSINESS_DATE = "{{ data_interval_start.in_timezone('Asia/Shanghai').strftime('%Y-%m-%d') }}"
# Output date: correct = business date; fault wrong_partition = end of the interval (D+1).
OUTPUT_DATE = (
    "{{ (data_interval_end if params.fault == 'wrong_partition' else data_interval_start)"
    ".in_timezone('Asia/Shanghai').strftime('%Y-%m-%d') }}"
)
ODS_DIR = f"{WAREHOUSE}/ods/orders/dt={BUSINESS_DATE}"
OUT_DIR = f"{WAREHOUSE}/analytics/daily_orders/dt={OUTPUT_DATE}"


def _ods_ready(path: str) -> bool:
    ok = os.path.isdir(path) and os.path.exists(os.path.join(path, "_SUCCESS"))
    print(f"ods partition {path}: {'ready' if ok else 'not ready (directory or _SUCCESS missing)'}")
    return ok


def _validate(path: str) -> None:
    parts = [f for f in os.listdir(path) if f.startswith("part-")] if os.path.isdir(path) else []
    if not parts:
        raise ValueError(f"output partition has no data files: {path}")
    rows = sum(1 for f in parts for _ in open(os.path.join(path, f), encoding="utf-8"))
    print(f"output partition {path}: {len(parts)} file(s), {rows} row(s)")


with DAG(
    dag_id="demo-daily-orders",
    description="按业务日期聚合订单（Spark SQL）写入 analytics.daily_orders",
    schedule="@daily",
    start_date=pendulum.datetime(2026, 10, 10, tz=TZ),
    catchup=False,
    max_active_runs=3,
    tags=["demo", "analytics", "team-data"],
    params={"fault": Param(None, type=["null", "string"], description="演示故障注入：wrong_partition")},
    default_args={"owner": "team-data", "retries": 0},
    doc_md=__doc__,
) as dag:
    wait = PythonSensor(
        task_id="wait_for_ods_partition",
        python_callable=_ods_ready,
        op_kwargs={"path": ODS_DIR},
        mode="reschedule",
        poke_interval=30,
        timeout=SENSOR_TIMEOUT,
    )
    aggregate = BashOperator(
        task_id="aggregate_orders",
        pool="demo-batch-pool",
        execution_timeout=pendulum.duration(minutes=30),
        bash_command=(
            f"{ROOT}/demo/offline-workflows/spark/spark-submit.sh demo-daily-orders.aggregate_orders "
            f"--mode partition --sql-file {ROOT}/demo/offline-workflows/sql/daily_orders.sql "
            f"--business-date {BUSINESS_DATE} --input-view ods_orders={ODS_DIR} "
            f"--output {OUT_DIR} --write-mode overwrite"
        ),
    )
    validate = PythonOperator(
        task_id="validate_output",
        python_callable=_validate,
        op_kwargs={"path": OUT_DIR},
    )
    wait >> aggregate >> validate
