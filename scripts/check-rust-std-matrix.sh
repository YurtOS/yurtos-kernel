#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS=(1.93.0 1.94.1 1.95.0)

for version in "${VERSIONS[@]}"; do
  if ! rustc "+$version" --version >/dev/null 2>&1; then
    echo "SKIP rust $version: toolchain not installed"
    continue
  fi
  if [[ ! -d "$ROOT/patches/rust/$version" ]]; then
    echo "SKIP rust $version: patch directory missing"
    continue
  fi
  "$ROOT/scripts/build-rust-std.sh" --rust "$version"
done
