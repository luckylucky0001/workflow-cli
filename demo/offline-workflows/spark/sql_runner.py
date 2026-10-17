"""Spark SQL runner for the workctl demo (run through spark-submit).

Two modes:
  partition  run a (templated) SQL file for one business date and overwrite one output partition
             (used by the Airflow DAG demo-daily-orders, task aggregate_orders)
  query      run a read-only SELECT file submitted by `workctl sql query submit`; keep a state file
             (submitted -> running -> succeeded|failed) with app id, row count, preview and result location

Tables: every <warehouse>/<db>/<table>/ directory is registered as a temporary view `<db>_<table>`
(partition directories `dt=YYYY-MM-DD` become a `dt` column). In partition mode the input partition is
also exposed as the view named by --input-view.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone

APP_ID_MARKER = "WORKCTL_SPARK_APP_ID="


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_state(path: str | None, patch: dict) -> None:
    if not path:
        return
    state = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                state = json.load(f)
        except Exception:
            state = {}
    if state.get("state") == "cancelled":
        return  # cancelled by `workctl sql query cancel`: never overwrite with a later failure
    state.update(patch)
    state["updated_at"] = now_iso()
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2, default=str)
    os.replace(tmp, path)


def render(sql: str, params: dict[str, str]) -> str:
    def sub(m: re.Match) -> str:
        key = m.group(1)
        if key not in params:
            raise ValueError(f"SQL placeholder ${{{key}}} has no value")
        return params[key]

    return re.sub(r"\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}", sub, sql)


def strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def statements(sql: str) -> list[str]:
    return [s.strip() for s in strip_comments(sql).split(";") if s.strip()]


def register_warehouse_views(spark, warehouse: str) -> list[str]:
    views = []
    if not warehouse or not os.path.isdir(warehouse):
        return views
    for db in sorted(os.listdir(warehouse)):
        dbdir = os.path.join(warehouse, db)
        if not os.path.isdir(dbdir) or db.startswith((".", "_")):
            continue
        for table in sorted(os.listdir(dbdir)):
            tdir = os.path.join(dbdir, table)
            if not os.path.isdir(tdir) or table.startswith((".", "_")):
                continue
            try:
                df = spark.read.option("basePath", tdir).json(tdir)
                if not df.columns:
                    continue
                name = f"{db}_{table}"
                df.createOrReplaceTempView(name)
                views.append(name)
            except Exception as e:  # unreadable / empty table: leave it out, record why
                print(f"[sql_runner] skip view {db}_{table}: {e.__class__.__name__}", file=sys.stderr)
    return views


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["partition", "query"], required=True)
    p.add_argument("--sql-file", required=True)
    p.add_argument("--app-name", default="workctl-sql")
    p.add_argument("--warehouse", default=os.environ.get("WORKCTL_WAREHOUSE_ROOT", ""))
    # partition mode
    p.add_argument("--business-date")
    p.add_argument("--input-view", action="append", default=[], help="name=path of an input partition")
    p.add_argument("--output")
    p.add_argument("--write-mode", default="overwrite", choices=["overwrite", "append", "errorifexists"])
    # query mode
    p.add_argument("--query-id")
    p.add_argument("--state-file")
    p.add_argument("--preview-rows", type=int, default=20)
    p.add_argument("--app-id-file", help="file to receive the Spark application id as soon as it is known")
    args = p.parse_args()

    with open(args.sql_file, encoding="utf-8") as f:
        raw_sql = f.read()

    from pyspark.sql import SparkSession

    spark = SparkSession.builder.appName(args.app_name).getOrCreate()
    sc = spark.sparkContext
    app_id = sc.applicationId
    print(f"{APP_ID_MARKER}{app_id}", flush=True)
    print(f"{APP_ID_MARKER}{app_id}", file=sys.stderr, flush=True)
    if args.app_id_file:
        with open(args.app_id_file, "w", encoding="utf-8") as f:
            f.write(app_id)
    # expose the in-flight driver log under <driver_log_dir>/<app_id>.log (replaced by the real file at exit)
    tmp_log, log_dir = os.environ.get("WORKCTL_DRIVER_LOG_TMP"), os.environ.get("WORKCTL_SPARK_DRIVER_LOG_DIR")
    if tmp_log and log_dir:
        link = os.path.join(log_dir, f"{app_id}.log")
        try:
            if not os.path.exists(link):
                os.symlink(tmp_log, link)
        except OSError:
            pass
    started = time.time()
    write_state(args.state_file, {"state": "running", "app_id": app_id, "spark_version": spark.version, "started_at": now_iso()})

    try:
        if args.mode == "partition":
            if not args.business_date or not args.output:
                raise ValueError("partition mode needs --business-date and --output")
            for spec in args.input_view:
                name, path = spec.split("=", 1)
                if not os.path.isdir(path):
                    raise FileNotFoundError(f"input partition not found: {path}")
                spark.read.json(path).createOrReplaceTempView(name)
                print(f"[sql_runner] view {name} <- {path}", file=sys.stderr)
            stmts = statements(render(raw_sql, {"business_date": args.business_date}))
            if not stmts:
                raise ValueError("SQL file has no statements")
            for s in stmts[:-1]:
                spark.sql(s)
            df = spark.sql(stmts[-1])
            df.coalesce(1).write.mode(args.write_mode).json(args.output)
            rows = spark.read.json(args.output).count()
            print(f"[sql_runner] wrote {rows} rows to {args.output} (mode={args.write_mode}) "
                  f"business_date={args.business_date} app_id={app_id}", file=sys.stderr)
        else:
            views = register_warehouse_views(spark, args.warehouse)
            write_state(args.state_file, {"views": views})
            stmts = statements(raw_sql)
            if len(stmts) != 1:
                raise ValueError(f"query mode expects exactly one SELECT statement, got {len(stmts)}")
            df = spark.sql(stmts[0])
            out = args.output
            df.write.mode("errorifexists").json(out)
            res = spark.read.json(out) if any(n.startswith("part-") for n in os.listdir(out)) else None
            row_count = res.count() if res is not None else 0
            preview = [json.loads(r) for r in (res.toJSON().take(args.preview_rows) if res is not None else [])]
            write_state(args.state_file, {
                "state": "succeeded",
                "row_count": row_count,
                "columns": df.columns,
                "preview": preview,
                "preview_truncated": row_count > len(preview),
                "result_location": out,
                "result_format": "json-lines",
                "finished_at": now_iso(),
                "duration_ms": int((time.time() - started) * 1000),
            })
        return 0
    except Exception as e:
        traceback.print_exc()
        write_state(args.state_file, {
            "state": "failed",
            "error": {"type": e.__class__.__name__, "message": str(e)[:2000]},
            "finished_at": now_iso(),
            "duration_ms": int((time.time() - started) * 1000),
        })
        return 1
    finally:
        spark.stop()


if __name__ == "__main__":
    sys.exit(main())
