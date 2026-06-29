#!/usr/bin/env bash
set -euo pipefail

main() {
  cd "$(dirname "$0")/../.."

  if [ -d "lib/vscode" ] && [ -f "lib/vscode/out/server-main.js" ]; then
    echo "VS Code prebuilt already exists, skipping download"
    exit 0
  fi

  echo "Downloading official code-server npm package to extract VS Code prebuilt..."

  mkdir -p /tmp/cs-vscode
  cd /tmp/cs-vscode

  npm pack code-server@4.99.3
  tar -xzf code-server-*.tgz

  cd "$OLDPWD"
  mkdir -p lib
  cp -r /tmp/cs-vscode/package/lib/vscode lib/vscode
  rm -rf /tmp/cs-vscode

  echo "VS Code prebuilt extracted to lib/vscode"
}

main "$@"
