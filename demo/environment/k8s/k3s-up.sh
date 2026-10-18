#!/usr/bin/env bash
# Start a single-node k3s (v1.31) in Docker for the workctl Kubernetes provider demo.
# NOTE: k3s needs a *privileged* container. Run this only on a host where that is allowed.
# Verified in the isolated demo environment (see docs/compatibility.md).
#
# Environment knobs (all optional):
#   K3S_HOST_NETWORK=1   run k3s with host networking (default 1; needed when outbound traffic must go
#                        through a proxy that only listens on the host's loopback)
#   HTTPS_PROXY/HTTP_PROXY are passed to k3s when set; the node's own IPs, localhost and the cluster
#                        CIDRs are added to NO_PROXY so apiserver→kubelet traffic stays direct
#   K3S_EXTRA_CA=<file>  CA bundle mounted as the container's system trust store (e.g. a TLS-intercepting proxy CA)
#   K3S_OOM_WORKAROUND=1 install a runc wrapper that drops process.oomScoreAdj from pod specs; only for
#                        sandboxed kernels that deny lowering oom_score_adj ("failed to update
#                        /proc/self/oom_score_adj: Permission denied"). Demo-only; never use on real clusters.
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
  args=(-e K3S_KUBECONFIG_MODE=644)
  server_args=(server --disable=traefik --tls-san=127.0.0.1)
  if [ "${K3S_HOST_NETWORK:-1}" = "1" ]; then
    args+=(--network host --cgroupns=host)
    server_args+=(--https-listen-port="$K3S_PORT")
  else
    args+=(--tmpfs /run --tmpfs /var/run -p "127.0.0.1:${K3S_PORT}:6443")
  fi
  if [ -n "${HTTPS_PROXY:-}${HTTP_PROXY:-}" ]; then
    node_ips=$(hostname -I 2>/dev/null | tr ' ' ',' | sed 's/,$//')
    no_proxy="localhost,127.0.0.1,${node_ips},10.42.0.0/16,10.43.0.0/16,.svc,.cluster.local"
    args+=(-e "HTTPS_PROXY=${HTTPS_PROXY:-}" -e "HTTP_PROXY=${HTTP_PROXY:-${HTTPS_PROXY:-}}" -e "NO_PROXY=$no_proxy")
  fi
  [ -n "${K3S_EXTRA_CA:-}" ] && args+=(-v "${K3S_EXTRA_CA}:/etc/ssl/certs/ca-certificates.crt:ro")
  docker run -d --privileged --name "$NAME" "${args[@]}" "$K3S_IMAGE" "${server_args[@]}" >/dev/null
fi

apply_oom_workaround() {
    for _ in $(seq 1 30); do docker exec "$NAME" test -f /var/lib/rancher/k3s/agent/etc/containerd/config.toml 2>/dev/null && break; sleep 2; done
    docker exec -i "$NAME" sh -c 'cat > /var/lib/rancher/k3s/runc-oom-workaround && chmod +x /var/lib/rancher/k3s/runc-oom-workaround' <<'WRAP'
#!/bin/sh
# Demo-only: drop process.oomScoreAdj before "runc create" (sandbox kernel denies lowering it).
BUNDLE=""; prev=""
for a in "$@"; do [ "$prev" = "--bundle" ] && BUNDLE="$a"; prev="$a"; done
if [ -n "$BUNDLE" ] && [ -f "$BUNDLE/config.json" ]; then
  sed -i -E 's/,"oomScoreAdj":-?[0-9]+//; s/"oomScoreAdj":-?[0-9]+,//' "$BUNDLE/config.json"
fi
exec /bin/runc "$@"
WRAP
    docker exec "$NAME" sh -c 'cd /var/lib/rancher/k3s/agent/etc/containerd && sed "s#SystemdCgroup = false#SystemdCgroup = false\n  BinaryName = \"/var/lib/rancher/k3s/runc-oom-workaround\"#" config.toml > config.toml.tmpl'
    docker restart "$NAME" >/dev/null
}
# idempotent: also covers a cluster container recreated or restarted without the workaround
if [ "${K3S_OOM_WORKAROUND:-0}" = "1" ] && ! docker exec "$NAME" test -f /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl 2>/dev/null; then
  apply_oom_workaround
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
