#!/usr/bin/env bash
# One-shot verification of the whole demo, from a clean slate:
#   reset → up → scenarios → per-capability suites → provider swaps → live test suite.
# Results land in demo/verification/ (reports + raw envelopes) and the step log on stdout.
#
# Options (env):
#   SKIP_RESET=1   keep the current environment (no reset/up/scenarios)
#   WITH_K8S=1     also verify the Kubernetes provider (needs privileged containers; see demo/environment/k8s/k3s-up.sh)
#   WITH_AF3=1     also run the Airflow 3 (REST v2) version swap
#   K3S_EXTRA_CA / K3S_OOM_WORKAROUND are passed through to k3s-up.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
export WORKCTL_CONFIG="$ROOT/demo/environment/workctl.yaml"
STATUS=0
step() { printf '\n== %s (%s)\n' "$1" "$(date -u +%H:%M:%S)"; }
check() { if "$@"; then echo "   ok"; else echo "   FAILED: $*"; STATUS=1; fi; }

step "build"
check npm run -s build
node plugins/demo-mq/build.mjs >/dev/null && node dist/workctl.js --json plugin install --file plugins/demo-mq/dist/demo-mq-plugin.tgz >/dev/null

if [ -z "${SKIP_RESET:-}" ]; then
  step "reset"
  [ -x demo/environment/offline3-down.sh ] && demo/environment/offline3-down.sh >/dev/null 2>&1 || true
  demo/environment/reset.sh >/dev/null
  step "up"
  t0=$(date +%s); check demo/environment/up.sh >/dev/null; echo "   up: $(( $(date +%s) - t0 ))s"
  step "scenarios"
  t0=$(date +%s)
  check demo/scenarios/offline/run-all.sh >/dev/null
  check node demo/scenarios/mysql-redis/scenario.mjs warm-cache >/dev/null
  check node demo/scenarios/mq/produce-and-consume.mjs --reset >/dev/null
  check node demo/scenarios/config/seed.mjs >/dev/null
  node demo/scenarios/latency/loadgen.mjs --rps 8 --duration 30 --seed 9 --label verify >/dev/null 2>&1
  echo "   scenarios: $(( $(date +%s) - t0 ))s"
fi

step "per-capability suite (main)";  check node scripts/verify-demo.mjs demo/verification/cases.json
step "per-capability suite (trino)"; check node scripts/verify-demo.mjs demo/verification/cases.trino.json
step "per-capability suite (config)"; check node scripts/verify-demo.mjs demo/verification/cases.config.json
step "consumers: cli == script == mcp"
check node demo/scenarios/reuse/same-contract.mjs >/dev/null
check node demo/scenarios/reuse/same-contract.mjs mq.consumer.lag '{"cluster":"demo-mq","group":"demo-consumer"}' >/dev/null
step "log provider swap (docker ↔ loki)"
check node demo/scenarios/reuse/log-provider-swap.mjs --out demo/verification/log-provider-swap.md

if [ -n "${WITH_AF3:-}" ]; then
  step "airflow 3 version swap"
  check demo/environment/offline3-up.sh >/dev/null
  check demo/scenarios/reuse/af3-produce.sh >/dev/null
  check node demo/scenarios/reuse/version-swap.mjs --out demo/verification/version-swap.md
fi

if [ -n "${WITH_K8S:-}" ]; then
  step "kubernetes provider"
  check demo/environment/k8s/k3s-up.sh >/dev/null
  until docker exec workctl-k3s kubectl top pods -n workctl-demo >/dev/null 2>&1; do sleep 5; done
  check env WORKCTL_CONFIG="$ROOT/demo/environment/k8s/workctl.k8s.yaml" node scripts/verify-demo.mjs demo/verification/cases.k8s.json
fi

step "live test suite"
flags=(WORKCTL_IT=1)
[ -n "${WITH_AF3:-}" ] && flags+=(WORKCTL_AF3=1)
[ -n "${WITH_K8S:-}" ] && flags+=(WORKCTL_K8S=1 "WORKCTL_K8S_KUBECONFIG=$ROOT/demo/environment/.runtime/k8s/kubeconfig.yaml")
check env "${flags[@]}" npx vitest run

step "done"; [ $STATUS -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $STATUS
