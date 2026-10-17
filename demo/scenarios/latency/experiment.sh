#!/usr/bin/env bash
# Controlled experiment: same deterministic load before and after fault injection.
#   ./experiment.sh                       # defaults: 10 rps, 30 s warm-up, 120 s per phase, seed 42
#   RPS=30 PHASE_SECONDS=180 ./experiment.sh
#   KEEP_FAULT=1 ./experiment.sh          # leave cache bypass on for the investigation
# Phases: warm-up (not measured) -> baseline (cache normal) -> inject (cache bypass) -> recover.
# Writes loadgen summaries + phase timestamps to $OUT_DIR; numbers are whatever is measured.
set -euo pipefail
cd "$(dirname "$0")"
RPS="${RPS:-10}"
PHASE_SECONDS="${PHASE_SECONDS:-120}"
WARMUP_SECONDS="${WARMUP_SECONDS:-30}"
SEED="${SEED:-42}"
OUT_DIR="${OUT_DIR:-../../environment/.runtime/scenarios/latency/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT_DIR"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

./recover.sh >/dev/null
# unmeasured warm-up with the same seed, so the baseline starts with a warm cache
node loadgen.mjs --rps "$RPS" --duration "$WARMUP_SECONDS" --seed "$SEED" --label warmup >/dev/null
echo "baseline_start=$(ts)" | tee "$OUT_DIR/phases.env"
node loadgen.mjs --rps "$RPS" --duration "$PHASE_SECONDS" --seed "$SEED" --label baseline --out "$OUT_DIR/baseline.json" >/dev/null
echo "baseline_end=$(ts)" | tee -a "$OUT_DIR/phases.env"

./inject.sh
echo "inject_start=$(ts)" | tee -a "$OUT_DIR/phases.env"
node loadgen.mjs --rps "$RPS" --duration "$PHASE_SECONDS" --seed "$SEED" --label bypass --out "$OUT_DIR/bypass.json" >/dev/null
echo "inject_end=$(ts)" | tee -a "$OUT_DIR/phases.env"

if [ -z "${KEEP_FAULT:-}" ]; then
  ./recover.sh
  echo "recovered=$(ts)" | tee -a "$OUT_DIR/phases.env"
fi

node -e '
const [b, x] = process.argv.slice(1).map((f) => require(f));
const row = (s) => ({ requests: s.overall.requests, p50_ms: s.overall.latency_ms.p50, p95_ms: s.overall.latency_ms.p95, p99_ms: s.overall.latency_ms.p99, codes: s.overall.codes });
console.log(JSON.stringify({ baseline: row(b), bypass: row(x) }, null, 2));
' "$(realpath "$OUT_DIR/baseline.json")" "$(realpath "$OUT_DIR/bypass.json")"
echo "results in $OUT_DIR"
