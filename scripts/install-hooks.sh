#!/usr/bin/env bash
set -euo pipefail

# Install the pre-commit framework and register both pre-commit and
# pre-push hooks. Idempotent.

if ! command -v pre-commit >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install pre-commit
  elif command -v pipx >/dev/null 2>&1; then
    pipx install pre-commit
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m pip install --user pre-commit
  else
    echo "install-hooks: need one of brew, pipx, or python3 to install pre-commit" >&2
    exit 1
  fi
fi

pre-commit install --hook-type pre-commit --hook-type pre-push
echo "install-hooks: pre-commit and pre-push hooks installed."
