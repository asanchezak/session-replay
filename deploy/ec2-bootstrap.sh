#!/bin/bash
# EC2 user-data bootstrap for a session-replay stack box (AL2023, arm64/Graviton).
# Installs docker + the compose & buildx plugin binaries (AL2023 ships neither), a 2GB
# swapfile (so `docker build` won't OOM on a 1GB t4g.micro), and the /opt/sr layout.
# Pass via `aws ec2 run-instances --user-data file://deploy/ec2-bootstrap.sh`.
# Runs once at first boot; log → /var/log/sr-bootstrap.log; marker → /opt/sr/.bootstrap-done.
set -eux
exec > /var/log/sr-bootstrap.log 2>&1

dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user

mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-aarch64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
curl -fsSL "https://github.com/docker/buildx/releases/download/v0.19.3/buildx-v0.19.3.linux-arm64" \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-buildx

# 2GB swap (build headroom on a 1GB box)
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p /opt/sr/deploy
chown -R ec2-user:ec2-user /opt/sr
touch /opt/sr/.bootstrap-done
