#!/usr/bin/env bash
# Redeploy the backend to an AWS EC2 box (single-box docker-compose stack).
# Ships backend/ + deploy/ source, rebuilds the image, restarts the backend
# container, and checks health. Reuses the Postgres volume (NEVER wipes the DB —
# the schema can't be rebuilt from scratch; see CLAUDE.md).
#
# Two environments share this script; the target is chosen by env overrides
# (defaults = DEV). PROD is a SEPARATE EC2 box with its own EIP/domain/key/env.
#   DEV  (default):  ./deploy/redeploy.sh
#   PROD:            EIP=<prod-ip> DOMAIN=<prod-ip-dashed>.sslip.io \
#                    PEM=deploy/sr-prod.pem API_KEY=<prod-gateway-key> \
#                    ./deploy/redeploy.sh
# ENV_FILE = the .env filename ON the box (default .env.prod; each box holds its
# own). API_KEY (for the health check) defaults to the value grepped from the
# LOCAL deploy/$ENV_FILE — pass it explicitly for prod so dev's local file isn't
# used against the prod box.
set -euo pipefail

EIP="${EIP:-52.5.45.84}"
DOMAIN="${DOMAIN:-52-5-45-84.sslip.io}"
PEM="${PEM:-deploy/sr-ec2.pem}"
ENV_FILE="${ENV_FILE:-.env.prod}"
KH=/tmp/sr_known_hosts
SSH=(ssh -i "$PEM" -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=accept-new)
SCP=(scp -i "$PEM" -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=accept-new)

cd "$(dirname "$0")/.."   # repo root

echo "==> packaging backend + deploy (no secrets, no AppleDouble/caches)"
COPYFILE_DISABLE=1 tar czf /tmp/sr-redeploy.tgz \
  --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' \
  --exclude='.pytest_cache' --exclude='.ruff_cache' --exclude='*.egg-info' \
  --exclude='artifact_storage' --exclude='.env.prod' --exclude='*.pem' \
  backend deploy

echo "==> shipping to EC2"
"${SCP[@]}" /tmp/sr-redeploy.tgz "ec2-user@${EIP}:/opt/sr/"
"${SSH[@]}" "ec2-user@${EIP}" 'cd /opt/sr && tar xzf sr-redeploy.tgz && rm -f sr-redeploy.tgz && sudo find /opt/sr -name "._*" -delete 2>/dev/null || true'

echo "==> rebuild + restart backend container (DB volume preserved)"
"${SSH[@]}" "ec2-user@${EIP}" "cd /opt/sr/deploy && sudo docker compose -f docker-compose.prod.yml --env-file ${ENV_FILE} up -d --build backend"

echo "==> health check"
sleep 5
KEY="${API_KEY:-$(grep -E '^API_KEY=' "deploy/${ENV_FILE}" | cut -d= -f2-)}"
curl -fsS -H "X-API-Key: ${KEY}" "https://${DOMAIN}/v1/health" && echo "  <- backend healthy"
echo "==> done. Remember: rebuild/reload the extension + re-sync the daemon if those changed."
