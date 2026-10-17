#!/usr/bin/env bash
# Remove the demo k3s container and its generated credentials.
set -euo pipefail
cd "$(dirname "$0")"
docker rm -f "${K3S_CONTAINER:-workctl-k3s}" >/dev/null 2>&1 || true
rm -rf ../.runtime/k8s
echo "k3s demo removed"
