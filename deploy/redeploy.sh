#!/usr/bin/env bash
# Redeploy the backend to the AWS EC2 box (single-box docker-compose stack).
# Ships backend/ + deploy/ source, rebuilds the image, restarts the backend
# container, and checks health. Reuses the Postgres volume (NEVER wipes the DB —
# the schema can't be rebuilt from scratch; see CLAUDE.md).
#
# Usage:  ./deploy/redeploy.sh        (run from the repo root)
set -euo pipefail

EIP=52.5.45.84
DOMAIN=52-5-45-84.sslip.io
PEM=deploy/sr-ec2.pem
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
"${SSH[@]}" "ec2-user@${EIP}" 'cd /opt/sr && tar xzf sr-redeploy.tgz && rm -f sr-redeploy.tgz && find /opt/sr -name "._*" -delete'

echo "==> rebuild + restart backend container (DB volume preserved)"
"${SSH[@]}" "ec2-user@${EIP}" 'cd /opt/sr/deploy && sudo docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build backend'

echo "==> health check"
sleep 5
KEY="$(grep -E '^API_KEY=' deploy/.env.prod | cut -d= -f2-)"
curl -fsS -H "X-API-Key: ${KEY}" "https://${DOMAIN}/v1/health" && echo "  <- backend healthy"
echo "==> done. Remember: rebuild/reload the extension + re-sync the daemon if those changed."
