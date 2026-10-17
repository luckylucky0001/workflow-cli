#!/usr/bin/env bash
# Start a single-node k3s (v1.31) in Docker for the workctl Kubernetes provider demo.
# NOTE: k3s needs a *privileged* container. Run this only on a host where that is allowed
# (it was NOT run while developing the provider; the provider is verified against a fake API only).
#
# Produces (git-ignored) under demo/environment/.runtime/k8s/:
#   kubeconfig.yaml   admin kubeconfig (server rewritten to https://127.0.0.1:${K3S_PORT})
#   ca.crt            cluster CA (for endpoints.kubernetes.<name>.ca_file)
#   workctl-token     ServiceAccount token of workctl-demo/workctl (least-privilege Role from demo-order.yaml)
# Then: WORKCTL_CONFIG=demo/environment/k8s/workctl.k8s.yaml workctl container workload get --service demo-order
set -euo pipefail
cd "$(dirname "$0")"
K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.31.4-k3s1}"
K3S_PORT="${K3S_PORT:-16443}"
NAME="${K3S_CONTAINER:-workctl-k3s}"
OUT=../.runtime/k8s
mkdir -p "$OUT"

if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # same settings as docker-compose.k3s.yml
  docker run -d --name "$NAME" --privileged --tmpfs /run --tmpfs /var/run \
    -p "127.0.0.1:${K3S_PORT}:6443" \
    -e K3S_KUBECONFIG_MODE=644 \
    "$K3S_IMAGE" server --disable=traefik --tls-san=127.0.0.1 >/dev/null
fi

echo "waiting for the k3s API server and node..."
for _ in $(seq 1 90); do
  if docker exec "$NAME" kubectl get nodes 2>/dev/null | grep -q ' Ready'; then break; fi
  sleep 2
done
docker exec "$NAME" kubectl get nodes

docker exec "$NAME" cat /etc/rancher/k3s/k3s.yaml | sed "s#https://127.0.0.1:6443#https://127.0.0.1:${K3S_PORT}#" > "$OUT/kubeconfig.yaml"
chmod 600 "$OUT/kubeconfig.yaml"
grep 'certificate-authority-data' "$OUT/kubeconfig.yaml" | awk '{print $2}' | base64 -d > "$OUT/ca.crt"

docker exec -i "$NAME" kubectl apply -f - < demo-order.yaml
docker exec "$NAME" kubectl -n workctl-demo rollout status deployment/demo-order --timeout=180s
# metrics-server ships with k3s; it needs ~1 minute before metrics.k8s.io serves pod metrics
docker exec "$NAME" kubectl -n kube-system rollout status deployment/metrics-server --timeout=180s || true

docker exec "$NAME" kubectl -n workctl-demo create token workctl --duration=24h > "$OUT/workctl-token"
chmod 600 "$OUT/workctl-token"

echo "k3s is up."
echo "  export WORKCTL_CONFIG=$(cd .. && pwd)/k8s/workctl.k8s.yaml"
echo "  live tests: WORKCTL_IT=1 WORKCTL_K8S=1 WORKCTL_K8S_KUBECONFIG=$(cd .. && pwd)/.runtime/k8s/kubeconfig.yaml npx vitest run test/container/k8s-live.test.ts"
