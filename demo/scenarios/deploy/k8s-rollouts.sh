#!/usr/bin/env bash
# Rollout history for `workctl deploy ...` on the k3s demo (demo/environment/k8s, container workctl-k3s).
# Creates real Deployment revisions of workctl-demo/demo-order with kubernetes.io/change-cause:
#   v1.4.0, v1.4.1 (env RELEASE_VERSION changes; same local image nginx:1.27-alpine, pods start),
#   v1.4.2-bad   (nonexistent image tag + progressDeadlineSeconds=30 → ImagePullBackOff, ProgressDeadlineExceeded)
# Usage:
#   k8s-rollouts.sh          all: the three releases, wait for the failure, show it, recover (kubectl rollout undo)
#   k8s-rollouts.sh break    the three releases and leave the failed rollout (recover with workctl deploy rollback plan
#                            + operation execute, see demo/verification/cases.deploy-k8s.json), then `recover`
#   k8s-rollouts.sh recover  undo a failed rollout if needed, restore progressDeadlineSeconds=120, wait until healthy
# Old pods keep serving during the failed rollout (maxUnavailable=0). Ends healthy except in `break` mode.
set -euo pipefail
cd "$(dirname "$0")/../../.."
NS=workctl-demo
DEP=demo-order
K="docker exec workctl-k3s kubectl -n $NS"
mode="${1:-all}"

release() { # version image deadline cause
  local patch
  patch=$(printf '{"metadata":{"annotations":{"kubernetes.io/change-cause":"%s"}},"spec":{"progressDeadlineSeconds":%s,"template":{"spec":{"containers":[{"name":"nginx","image":"%s","env":[{"name":"RELEASE_VERSION","value":"%s"}]}]}}}}' "$4" "$3" "$2" "$1")
  $K patch deployment $DEP --type=strategic -p "$patch" >/dev/null
  echo "released $1 ($2): $4"
}

failed() { $K get deployment $DEP -o jsonpath='{.status.conditions[?(@.type=="Progressing")].reason}' | grep -q ProgressDeadlineExceeded; }

recover() {
  if failed; then
    $K rollout undo deployment/$DEP >/dev/null
    $K annotate deployment $DEP kubernetes.io/change-cause="rollback after failed v1.4.2-bad (kubectl rollout undo)" --overwrite >/dev/null
    echo "rolled back failed rollout (kubectl rollout undo)"
  fi
  $K patch deployment $DEP --type=merge -p '{"spec":{"progressDeadlineSeconds":120}}' >/dev/null
  $K rollout status deployment/$DEP --timeout=180s
}

if [ "$mode" = recover ]; then recover; exit 0; fi
# start from a settled deployment
$K rollout status deployment/$DEP --timeout=180s >/dev/null
release v1.4.0 nginx:1.27-alpine 120 "release v1.4.0: order api pagination"
$K rollout status deployment/$DEP --timeout=180s
release v1.4.1 nginx:1.27-alpine 120 "release v1.4.1: cache ttl tuning"
$K rollout status deployment/$DEP --timeout=180s
release v1.4.2-bad nginx:1.27-alpine-workctl-missing 30 "release v1.4.2-bad: image tag that does not exist"
echo "waiting for ProgressDeadlineExceeded (progressDeadlineSeconds=30)..."
for _ in $(seq 1 45); do failed && break; sleep 2; done
failed || { echo "rollout did not report ProgressDeadlineExceeded" >&2; exit 1; }
$K get deployment $DEP -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
if [ -f dist/workctl.js ]; then
  WORKCTL_CONFIG=demo/environment/k8s/workctl.k8s.yaml node dist/workctl.js deploy status get --service demo-order --env sandbox | head -12 || true
fi
if [ "$mode" = break ]; then
  echo "left the failed rollout in place; recover with workctl deploy rollback plan + operation execute, then: $0 recover"
  exit 0
fi
recover
