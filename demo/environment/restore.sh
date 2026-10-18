#!/usr/bin/env bash
# Bring the whole demo back after the host restarted (e.g. an ephemeral cloud container was reclaimed):
# start dockerd if it is not running, rebuild the environment from a clean slate and replay every
# scenario/seed, so suites and live tests can run again. Writes demo/environment/.runtime/READY when done.
#   WITH_K8S=1  also restart k3s and regenerate its kubeconfig/token (reset.sh removes .runtime/k8s)
set -euo pipefail
cd "$(dirname "$0")/../.."
if ! docker info >/dev/null 2>&1; then
  command -v dockerd >/dev/null || { echo "docker daemon not reachable and dockerd not installed" >&2; exit 1; }
  rm -f /var/run/docker.sock /var/run/docker.pid
  nohup dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || { echo "dockerd did not start (see /tmp/dockerd.log)" >&2; exit 1; }
fi
demo/environment/reset.sh >/dev/null
demo/environment/up.sh >/dev/null
export WORKCTL_CONFIG="$PWD/demo/environment/workctl.yaml"
wait_http() { local t=$(( $(date +%s) + 180 )); until curl -fs -o /dev/null --noproxy '*' "$1"; do [ "$(date +%s)" -gt "$t" ] && { echo "not ready: $1" >&2; return 1; }; sleep 3; done; }
demo/scenarios/offline/run-all.sh >/dev/null
node demo/scenarios/mysql-redis/scenario.mjs warm-cache >/dev/null
node demo/scenarios/mq/produce-and-consume.mjs --reset >/dev/null 2>&1
node demo/scenarios/config/seed.mjs >/dev/null
wait_http http://127.0.0.1:18848/nacos/v1/console/health/readiness
wait_http http://127.0.0.1:18500/v1/status/leader
wait_http http://127.0.0.1:18091/login
node demo/scenarios/config/seed-nacos.mjs >/dev/null
node demo/scenarios/config/seed-consul.mjs >/dev/null
node demo/scenarios/deploy/seed-jenkins.mjs >/dev/null
node demo/scenarios/postgres/scenario.mjs reset-stats >/dev/null
node demo/scenarios/postgres/scenario.mjs churn >/dev/null
node demo/scenarios/search/seed.mjs >/dev/null
if [ -n "${WITH_K8S:-}" ]; then demo/environment/k8s/k3s-up.sh >/dev/null; fi
date -u +%FT%TZ > demo/environment/.runtime/READY
echo "demo environment restored. export WORKCTL_CONFIG=$WORKCTL_CONFIG"
