#!/usr/bin/env bash
# Set the demo MySQL account passwords from the generated secrets (idempotent).
#
# Why: init scripts in docker-entrypoint-initdb.d run as the `mysql` user and cannot read
# the 0600 root-owned secret files mounted at /run/secrets, so 02-users.sh creates the
# accounts LOCKED. This script re-runs 02-users.sh as root *inside* the container, where the
# secrets are readable. No password is passed on the command line or printed.
#
# Usage: demo/environment/mysql/provision-users.sh   (after `./up.sh mysql`)
set -euo pipefail
cd "$(dirname "$0")"
container="${MYSQL_CONTAINER:-demo-mysql}"

for i in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)"
  [ "$status" = "healthy" ] && break
  [ "$i" = 60 ] && { echo "container $container not healthy (status=$status)" >&2; exit 1; }
  sleep 2
done

docker exec -i -u root "$container" bash -s < ./init/02-users.sh
echo "mysql demo accounts provisioned (workctl_ro, demo_app)"
