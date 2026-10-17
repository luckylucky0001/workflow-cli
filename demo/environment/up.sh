#!/usr/bin/env bash
# Bring up the isolated demo environment. Idempotent; reset with ./reset.sh.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .runtime/secrets
for s in mysql_root_password mysql_ro_password mysql_app_password airflow_admin_password; do
  [ -s ".runtime/secrets/$s" ] || head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20 > ".runtime/secrets/$s"
done
chmod 600 .runtime/secrets/*
services="${*:-mysql redis kafka demo-order prometheus trino loki promtail}"
# demo-order image copies a prebuilt bundle (needs root `npm ci` first)
node ../sample-service/build.mjs
docker compose up -d --build $services
# MySQL init scripts cannot read the 0600 secret files; set account passwords as root once healthy.
case " $services " in *" mysql "*) ./mysql/provision-users.sh ;; esac
if [ -x ./offline-up.sh ] && [ -z "${SKIP_OFFLINE:-}" ]; then ./offline-up.sh; fi
echo "demo environment is up. export WORKCTL_CONFIG=$(pwd)/workctl.yaml"
