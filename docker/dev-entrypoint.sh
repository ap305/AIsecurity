#!/bin/sh
# Container dev entrypoint — first-run install deps with China mirror, then exec CMD
set -e

NPM_MIRROR="https://registry.npmmirror.com"

# Install pnpm via mirror
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[entrypoint] Installing pnpm via mirror..."
  npm install -g pnpm@9 --registry="$NPM_MIRROR"
  pnpm config set registry "$NPM_MIRROR"
fi

# Install dependencies if not yet done
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.pnpm-installed" ]; then
  echo "[entrypoint] Installing dependencies (first run)..."
  pnpm install --frozen-lockfile
  touch node_modules/.pnpm-installed
fi

# 确保判题 Python 依赖可用（numpy/pillow，幂等；失败时仅影响依赖 numpy 的场景）
if ! python3 -c 'import numpy' >/dev/null 2>&1; then
  echo "[entrypoint] Installing judge python deps (python3-numpy/python3-pil)..."
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq --no-install-recommends python3-numpy python3-pil >/dev/null 2>&1 || echo "[entrypoint] python deps install failed (numpy judges may be limited)"
fi

# 受管 7z 模型类判题依赖（torch-cpu/torchvision/scikit-learn，幂等）
if ! python3 -c 'import torch, torchvision, sklearn' >/dev/null 2>&1; then
  echo '[entrypoint] Installing managed-judge deps (torch-cpu/torchvision/scikit-learn)...'
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq --no-install-recommends python3-pip python3-sklearn >/dev/null 2>&1 || true
  # GPU 服务器驱动 550：使用 CUDA 12.4 版 torch 2.5.1 + torchvision 0.20.1
  python3 -m pip install --break-system-packages --no-cache-dir torch==2.5.1 torchvision==0.20.1 >/dev/null 2>&1 \
    || echo '[entrypoint] torch install failed (model managed judges may be limited)'
fi

echo "[entrypoint] Starting: $*"
exec "$@"
