#!/bin/bash
# 单容器模式启动脚本：首次启动安装 SQLTools 扩展，然后启动 code-server
set -e

EXT=/workspaces/.shared-extensions
if [ ! -f "$EXT/.install_done" ]; then
  echo "[startup] 安装 SQLTools..."
  lib/node out/node/entry.js --install-extension mtxr.sqltools --extensions-dir "$EXT" --force
  lib/node out/node/entry.js --install-extension mtxr.sqltools-driver-pg --extensions-dir "$EXT" --force

  touch "$EXT/.install_done"
  echo "[startup] 扩展安装完成"
fi

exec dumb-init lib/node out/node/entry.js "$@"
