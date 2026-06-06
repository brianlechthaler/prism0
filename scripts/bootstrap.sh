#!/usr/bin/env bash
set -euo pipefail

npm ci

if command -v kubectl >/dev/null 2>&1 && command -v kubeconform >/dev/null 2>&1; then
  exit 0
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "Skipping optional kubectl/kubeconform install because sudo is unavailable." >&2
  exit 0
fi

if ! command -v kubectl >/dev/null 2>&1; then
  version="$(curl -L -s https://dl.k8s.io/release/stable.txt)"
  curl -L -o /tmp/kubectl "https://dl.k8s.io/release/${version}/bin/linux/amd64/kubectl"
  chmod +x /tmp/kubectl
  sudo mv /tmp/kubectl /usr/local/bin/kubectl
fi

if ! command -v kubeconform >/dev/null 2>&1; then
  GOBIN=/usr/local/bin sudo -E go install github.com/yannh/kubeconform/cmd/kubeconform@latest
fi
