#!/usr/bin/env bash
set -euo pipefail

main() {
  cd "$(dirname "$0")/../.."

  RELEASE_DIR="./release"
  rm -rf "$RELEASE_DIR"

  echo "==> 1. Compiling TypeScript..."
  npx tsc

  echo "==> 2. Preparing VS Code prebuilt..."
  bash ./ci/build/prep-vscode.sh

  echo "==> 3. Assembling release..."
  mkdir -p "$RELEASE_DIR/out" "$RELEASE_DIR/src/browser" "$RELEASE_DIR/lib/vscode"
  rsync -a out/ "$RELEASE_DIR/out"
  rsync -a src/browser/ "$RELEASE_DIR/src/browser"
  rsync -a lib/vscode/ "$RELEASE_DIR/lib/vscode"

  echo "==> 4. Installing VS Code dependencies..."
  cd "$RELEASE_DIR/lib/vscode"
  npm install --omit=dev --ignore-scripts 2>&1 | tail -3
  cd "$OLDPWD"

  rsync LICENSE "$RELEASE_DIR"
  rsync ThirdPartyNotices.txt "$RELEASE_DIR" 2>/dev/null || true

  node -e "
    const pkg = require('./package.json');
    const release = {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      main: pkg.main,
      bin: pkg.bin,
      engines: pkg.engines,
      dependencies: pkg.dependencies,
    };
    require('fs').writeFileSync('$RELEASE_DIR/package.json', JSON.stringify(release, null, 2) + '\n');
  "

  rsync ci/build/npm-postinstall.sh "$RELEASE_DIR/postinstall.sh" 2>/dev/null || true

  echo "==> Release ready at $RELEASE_DIR/"
  echo "    Run: cd $RELEASE_DIR && npm publish --access public"
}

main "$@"
