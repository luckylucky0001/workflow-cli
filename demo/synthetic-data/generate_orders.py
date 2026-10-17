#!/usr/bin/env python3
"""Deterministic SYNTHETIC orders for one business date (workctl demo; stdlib only).

Writes one ods.orders partition the way Spark's df.write.json does:
    <out>/part-00000.json   JSON lines, one order per line
    <out>/_SUCCESS          written last
The partition is assembled in a hidden sibling directory and renamed into place, so readers
never see a half-written partition; an existing partition is replaced (overwrite_partition).

Business timezone is Asia/Shanghai: created_at falls inside [D 00:00, D+1 00:00) +08:00.
All values are generated; nothing is derived from real people or real orders.

Examples:
    python3 generate_orders.py --date 2026-10-16 --out <warehouse>/ods/orders/dt=2026-10-16
    python3 generate_orders.py --date 2026-10-16 --out /tmp/p --rows 200 --inject duplicates --inject nulls
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import shutil
import sys
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo

    BUSINESS_TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # tzdata missing: Asia/Shanghai has been fixed UTC+8 since 1991
    BUSINESS_TZ = timezone(timedelta(hours=8), "Asia/Shanghai")

# Same status vocabulary and rough mix as the demo MySQL table demo.orders.
STATUSES = [("DELIVERED", 40), ("SHIPPED", 20), ("PAID", 20), ("PENDING", 10), ("CANCELLED", 5), ("REFUNDED", 5)]
COLUMNS = ["order_id", "customer_id", "status", "amount", "item_count", "created_at", "updated_at"]
INJECTIONS = ("duplicates", "nulls", "bad_status")


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate deterministic synthetic orders for one business date")
    p.add_argument("--date", required=True, help="business date YYYY-MM-DD (Asia/Shanghai)")
    p.add_argument("--out", required=True, help="partition directory to (re)create, e.g. .../ods/orders/dt=2026-10-16")
    p.add_argument("--rows", type=int, default=5000, help="number of orders (default 5000)")
    p.add_argument("--seed", type=int, help="random seed (default: derived from --date, so reruns are identical)")
    p.add_argument("--format", choices=["json", "csv"], default="json", help="json lines (default) or csv with header")
    p.add_argument("--inject", action="append", choices=INJECTIONS, default=[],
                   help="deliberate quality defects for demos: duplicates (repeat ~0.5%% order_id), "
                        "nulls (null customer_id/amount in ~0.5%% rows), bad_status (unknown status values)")
    a = p.parse_args(argv)
    try:
        a.business_date = date.fromisoformat(a.date)
    except ValueError:
        p.error(f"--date must be YYYY-MM-DD: {a.date}")
    if a.rows < 0 or a.rows > 999_999:
        p.error("--rows must be within 0..999999")
    return a


def generate(business_date: date, rows: int, seed: int, inject: list[str]) -> tuple[list[dict], dict]:
    rng = random.Random(seed)
    start = datetime(business_date.year, business_date.month, business_date.day, tzinfo=BUSINESS_TZ)
    offsets = sorted(rng.randrange(86400) for _ in range(rows))
    names = [s for s, _ in STATUSES]
    weights = [w for _, w in STATUSES]
    prefix = int(business_date.strftime("%Y%m%d")) * 1_000_000
    out = []
    for i, off in enumerate(offsets, start=1):
        created = start + timedelta(seconds=off)
        updated = created + timedelta(seconds=rng.randrange(7200))
        customer = rng.randint(1, 100) if rng.random() < 0.1 else rng.randint(1, 20000)
        out.append({
            "order_id": prefix + i,
            "customer_id": customer,
            "status": rng.choices(names, weights)[0],
            "amount": round(rng.uniform(5, 1000), 2),
            "item_count": rng.randint(1, 6),
            "created_at": created.isoformat(),
            "updated_at": updated.isoformat(),
        })
    injected: dict[str, int] = {}
    n_defect = max(1, rows // 200) if rows else 0
    if "nulls" in inject and out:
        for r in rng.sample(out, min(n_defect, len(out))):
            r[rng.choice(["customer_id", "amount"])] = None
        injected["nulls"] = min(n_defect, len(out))
    if "bad_status" in inject and out:
        for r in rng.sample(out, min(n_defect, len(out))):
            r["status"] = rng.choice(["UNKNOWN", "paid", ""])
        injected["bad_status"] = min(n_defect, len(out))
    if "duplicates" in inject and out:
        dups = [dict(r) for r in rng.sample(out, min(n_defect, len(out)))]
        out.extend(dups)
        out.sort(key=lambda r: r["created_at"])
        injected["duplicates"] = len(dups)
    return out, injected


def write_partition(out_dir: str, rows: list[dict], fmt: str) -> list[str]:
    out_dir = os.path.abspath(out_dir)
    parent, name = os.path.split(out_dir)
    os.makedirs(parent, exist_ok=True)
    tmp = os.path.join(parent, f".{name}.tmp-{os.getpid()}")
    old = os.path.join(parent, f".{name}.old-{os.getpid()}")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    data_file = f"part-00000.{fmt}"
    with open(os.path.join(tmp, data_file), "w", encoding="utf-8", newline="") as f:
        if fmt == "json":
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
        else:
            w = csv.DictWriter(f, fieldnames=COLUMNS)
            w.writeheader()
            for r in rows:
                w.writerow({k: ("" if v is None else v) for k, v in r.items()})
        f.flush()
        os.fsync(f.fileno())
    open(os.path.join(tmp, "_SUCCESS"), "w").close()
    if os.path.exists(out_dir):
        os.rename(out_dir, old)
    os.rename(tmp, out_dir)
    shutil.rmtree(old, ignore_errors=True)
    return [data_file, "_SUCCESS"]


def main(argv: list[str]) -> int:
    a = parse_args(argv)
    seed = a.seed if a.seed is not None else int(a.business_date.strftime("%Y%m%d"))
    rows, injected = generate(a.business_date, a.rows, seed, a.inject)
    files = write_partition(a.out, rows, a.format)
    print(json.dumps({
        "synthetic": True,
        "business_date": a.business_date.isoformat(),
        "timezone": "Asia/Shanghai",
        "out": os.path.abspath(a.out),
        "files": files,
        "rows": len(rows),
        "seed": seed,
        "format": a.format,
        "injected": injected,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
