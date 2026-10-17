"""demo-ods-orders: extract one business date of synthetic orders into ods.orders/dt=<date>.

Business date = data_interval_start in Asia/Shanghai (daily interval [D 00:00, D+1 00:00) +08:00).
"""
import os
from pathlib import Path

import pendulum
from airflow import DAG
from airflow.operators.bash import BashOperator

ROOT = Path(os.environ.get("WORKCTL_DEMO_ROOT") or Path(__file__).resolve().parents[3])
WAREHOUSE = os.environ.get("WORKCTL_WAREHOUSE_ROOT") or str(ROOT / "demo/environment/.runtime/warehouse")
TZ = pendulum.timezone("Asia/Shanghai")
BUSINESS_DATE = "{{ data_interval_start.in_timezone('Asia/Shanghai').strftime('%Y-%m-%d') }}"
OUT_DIR = f"{WAREHOUSE}/ods/orders/dt={BUSINESS_DATE}"

with DAG(
    dag_id="demo-ods-orders",
    description="抽取合成订单到 ods.orders 的业务日期分区",
    schedule="@daily",
    start_date=pendulum.datetime(2026, 10, 10, tz=TZ),
    catchup=False,
    max_active_runs=2,
    tags=["demo", "ods", "team-data"],
    default_args={"owner": "team-data", "retries": 1, "retry_delay": pendulum.duration(minutes=1)},
    doc_md=__doc__,
) as dag:
    BashOperator(
        task_id="extract_orders",
        bash_command=(
            f"set -euo pipefail; python3 {ROOT}/demo/synthetic-data/generate_orders.py "
            f"--date {BUSINESS_DATE} --out {OUT_DIR}; "
            f"[ -f {OUT_DIR}/_SUCCESS ] || touch {OUT_DIR}/_SUCCESS; ls -l {OUT_DIR}"
        ),
        execution_timeout=pendulum.duration(minutes=10),
    )
