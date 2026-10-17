#!/usr/bin/env bash
# Bring up the isolated demo environment. Idempotent; reset with ./reset.sh.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .runtime/secrets
for s in mysql_root_password mysql_ro_password mysql_app_password airflow_admin_password; do
  [ -s ".runtime/secrets/$s" ] || head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20 > ".runtime/secrets/$s"
done
chmod 600 .runtime/secrets/*
services="${*:-mysql redis kafka demo-order prometheus}"
docker compose up -d --build $services
if [ -x ./offline-up.sh ] && [ -z "${SKIP_OFFLINE:-}" ]; then ./offline-up.sh; fi
echo "demo environment is up. export WORKCTL_CONFIG=$(pwd)/workctl.yaml"
