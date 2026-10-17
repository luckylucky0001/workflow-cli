#!/usr/bin/env bash
# One-shot verification of the whole demo, from a clean slate:
#   build + plugins → reset → up → scenarios → per-capability suites → provider swaps → live test suite.
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
quiet() { "$@" >/dev/null; }
# wait_http <url> [seconds]: services started by up.sh (Nacos, Jenkins, Consul) take a while to answer after a reset
wait_http() { local t=$(( $(date +%s) + ${2:-180} )); until curl -fs -o /dev/null --noproxy '*' "$1"; do [ $(date +%s) -gt $t ] && { echo "   not ready: $1"; return 1; }; sleep 3; done; }   # use as `check quiet cmd`: hides cmd output but keeps check's ok/FAILED line

step "build"
check npm run -s build
for p in demo-mq demo-search; do
  check quiet sh -c "node plugins/$p/build.mjs && node dist/workctl.js --json plugin install --file plugins/$p/dist/$p-plugin.tgz >/dev/null"
done

if [ -z "${SKIP_RESET:-}" ]; then
  step "reset"
  [ -x demo/environment/offline3-down.sh ] && demo/environment/offline3-down.sh >/dev/null 2>&1 || true
  demo/environment/reset.sh >/dev/null
  step "up"
  t0=$(date +%s); check quiet demo/environment/up.sh; echo "   up: $(( $(date +%s) - t0 ))s"
  step "scenarios"
  t0=$(date +%s)
  check quiet demo/scenarios/offline/run-all.sh
  check quiet node demo/scenarios/mysql-redis/scenario.mjs warm-cache
  check quiet node demo/scenarios/mq/produce-and-consume.mjs --reset
  check quiet node demo/scenarios/config/seed.mjs
  check wait_http http://127.0.0.1:18848/nacos/v1/console/health/readiness
  check wait_http http://127.0.0.1:18500/v1/status/leader
  check wait_http http://127.0.0.1:18091/login
  check quiet node demo/scenarios/config/seed-nacos.mjs
  check quiet node demo/scenarios/config/seed-consul.mjs
  check quiet node demo/scenarios/deploy/seed-jenkins.mjs
  check quiet node demo/scenarios/postgres/scenario.mjs reset-stats
  check quiet node demo/scenarios/postgres/scenario.mjs churn
  check quiet node demo/scenarios/search/seed.mjs
  node demo/scenarios/latency/loadgen.mjs --rps 8 --duration 30 --seed 9 --label verify >/dev/null 2>&1
  echo "   scenarios: $(( $(date +%s) - t0 ))s"
fi

step "per-capability suite (main)";  check node scripts/verify-demo.mjs demo/verification/cases.json
step "per-capability suite (trino)"; check node scripts/verify-demo.mjs demo/verification/cases.trino.json
step "per-capability suite (config)"; check node scripts/verify-demo.mjs demo/verification/cases.config.json
step "per-capability suite (postgres)"; check node scripts/verify-demo.mjs demo/verification/cases.postgres.json
step "per-capability suite (config: nacos)"; check node scripts/verify-demo.mjs demo/verification/cases.config-nacos.json
step "per-capability suite (config: consul)"; check node scripts/verify-demo.mjs demo/verification/cases.config-consul.json
step "per-capability suite (deploy: jenkins)"; check node scripts/verify-demo.mjs demo/verification/cases.deploy.json
step "per-capability suite (search plugin)"; check node scripts/verify-demo.mjs demo/verification/cases.search.json
step "consumers: cli == script == mcp"
check quiet node demo/scenarios/reuse/same-contract.mjs
check quiet node demo/scenarios/reuse/same-contract.mjs mq.consumer.lag '{"cluster":"demo-mq","group":"demo-consumer"}'
check quiet node demo/scenarios/reuse/same-contract.mjs search.index.get '{"cluster":"demo-search","index":"demo-orders-current"}'
step "log provider swap (docker ↔ loki)"
check node demo/scenarios/reuse/log-provider-swap.mjs --out demo/verification/log-provider-swap.md

if [ -n "${WITH_AF3:-}" ]; then
  step "airflow 3 version swap"
  check quiet demo/environment/offline3-up.sh
  check quiet demo/scenarios/reuse/af3-produce.sh
  check node demo/scenarios/reuse/version-swap.mjs --out demo/verification/version-swap.md
fi

if [ -n "${WITH_K8S:-}" ]; then
  step "kubernetes provider"
  check quiet demo/environment/k8s/k3s-up.sh
  until docker exec workctl-k3s kubectl top pods -n workctl-demo >/dev/null 2>&1; do sleep 5; done
  check env WORKCTL_CONFIG="$ROOT/demo/environment/k8s/workctl.k8s.yaml" node scripts/verify-demo.mjs demo/verification/cases.k8s.json
  step "deploy: kubernetes rollouts (break → suite incl. real rollback → recover)"
  check quiet demo/scenarios/deploy/k8s-rollouts.sh break
  check env WORKCTL_CONFIG="$ROOT/demo/environment/k8s/workctl.k8s.yaml" node scripts/verify-demo.mjs demo/verification/cases.deploy-k8s.json
  check quiet demo/scenarios/deploy/k8s-rollouts.sh recover
fi

step "live test suite"
flags=(WORKCTL_IT=1)
[ -n "${WITH_AF3:-}" ] && flags+=(WORKCTL_AF3=1)
[ -n "${WITH_K8S:-}" ] && flags+=(WORKCTL_K8S=1 "WORKCTL_K8S_KUBECONFIG=$ROOT/demo/environment/.runtime/k8s/kubeconfig.yaml")
check env "${flags[@]}" npx vitest run

step "done"; [ $STATUS -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $STATUS
