#!/usr/bin/env bash
# Set the demo PostgreSQL role password from the generated secret (idempotent).
#
# Why: init scripts in docker-entrypoint-initdb.d run as the `postgres` OS user and cannot read
# the 0600 root-owned secret files mounted at /run/secrets, so 02-roles.sh creates workctl_ro
# NOLOGIN. This script re-runs 02-roles.sh as root *inside* the container, where the secret is
# readable. No password is passed on the command line or printed.
#
# Usage: demo/environment/postgres/provision-users.sh   (after `./up.sh postgres`)
set -euo pipefail
cd "$(dirname "$0")"
container="${POSTGRES_CONTAINER:-demo-postgres}"

for i in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)"
  [ "$status" = "healthy" ] && break
  [ "$i" = 60 ] && { echo "container $container not healthy (status=$status)" >&2; exit 1; }
  sleep 2
done

docker exec -i -u root "$container" bash -s < ./init/02-roles.sh
echo "postgres demo role provisioned (workctl_ro)"
