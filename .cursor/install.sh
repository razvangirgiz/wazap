#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for wazap.
# Does not start the WhatsApp MCP or pair a session.
set -euo pipefail

export PATH=/usr/bin:$PATH
export DEBIAN_FRONTEND=noninteractive

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

apt_install() {
  sudo apt-get install -y --no-install-recommends \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold \
    "$@"
}

if ! command -v node >/dev/null 2>&1; then
  sudo apt-get update -qq
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  apt_install nodejs
fi

echo "==> Installing npm dependencies (npm ci)"
npm ci

echo "==> install.sh complete"
