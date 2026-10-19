#!/usr/bin/env bash
# Redeploy the backend to the AWS EC2 box (docker-compose stack).
# Ships backend/ + deploy/ source, rebuilds the image, restarts the backend
# container, and checks health. Reuses the Postgres volume (NEVER wipes the DB —
# the schema can't be rebuilt from scratch; see CLAUDE.md).
#
# Since 2026-10-19 BOTH environments live on ONE box (the PROD EC2), as two compose
# projects in two directories; TARGET picks which one (required — no default, so an
# old habit can't hit the wrong env):
#   DEV:   TARGET=dev  ./deploy/redeploy.sh
#   PROD:  TARGET=prod API_KEY=<prod-gateway-key> ./deploy/redeploy.sh
# API_KEY (for the health check) defaults to the value grepped from the LOCAL
# deploy/$ENV_FILE (= dev's) — pass it explicitly for prod.
set -euo pipefail

case "${TARGET:-}" in
  dev)
    REMOTE_DIR=/opt/sr-dev; COMPOSE=docker-compose.dev.yml; SERVICE=backend-dev
    DOMAIN="${DOMAIN:-52-5-45-84.sslip.io}" ;;
  prod)
    REMOTE_DIR=/opt/sr; COMPOSE=docker-compose.prod.yml; SERVICE=backend
    DOMAIN="${DOMAIN:-54-211-23-18.sslip.io}"
    [ -n "${API_KEY:-}" ] || { echo "TARGET=prod needs API_KEY=<prod-gateway-key> (health check)"; exit 1; } ;;
  *)
    echo "usage: TARGET=dev|prod [API_KEY=...] $0"; exit 1 ;;
esac
EIP="${EIP:-54.211.23.18}"          # the shared box (DEV's 52.5.45.84 points here too)
PEM="${PEM:-deploy/sr-prod.pem}"
ENV_FILE="${ENV_FILE:-.env.prod}"
KH=/tmp/sr_known_hosts
SSH=(ssh -i "$PEM" -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=accept-new)
SCP=(scp -i "$PEM" -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=accept-new)

cd "$(dirname "$0")/.."   # repo root

echo "==> [$TARGET] packaging backend + deploy (no secrets, no AppleDouble/caches)"
COPYFILE_DISABLE=1 tar czf /tmp/sr-redeploy.tgz \
  --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' \
  --exclude='.pytest_cache' --exclude='.ruff_cache' --exclude='*.egg-info' \
  --exclude='artifact_storage' --exclude='.env.prod' --exclude='*.pem' \
  backend deploy

echo "==> [$TARGET] shipping to ${EIP}:${REMOTE_DIR}"
"${SCP[@]}" /tmp/sr-redeploy.tgz "ec2-user@${EIP}:${REMOTE_DIR}/"
"${SSH[@]}" "ec2-user@${EIP}" "cd ${REMOTE_DIR} && tar xzf sr-redeploy.tgz && rm -f sr-redeploy.tgz && sudo find ${REMOTE_DIR} -name '._*' -delete 2>/dev/null || true"

echo "==> [$TARGET] rebuild + restart ${SERVICE} container (DB volume preserved)"
"${SSH[@]}" "ec2-user@${EIP}" "cd ${REMOTE_DIR}/deploy && sudo docker compose -f ${COMPOSE} --env-file ${ENV_FILE} up -d --build ${SERVICE} && sudo docker image prune -f >/dev/null"

echo "==> [$TARGET] health check"
sleep 5
KEY="${API_KEY:-$(grep -E '^API_KEY=' "deploy/${ENV_FILE}" | cut -d= -f2-)}"
curl -fsS -H "X-API-Key: ${KEY}" "https://${DOMAIN}/v1/health" && echo "  <- backend healthy"
echo "==> done. Remember: rebuild/reload the extension + re-sync the daemon if those changed."
