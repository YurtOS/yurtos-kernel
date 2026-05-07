#!/usr/bin/env bash
# Source this file to set up the yurt development environment.
# Usage: source scripts/dev-init.sh

# --- PATH additions ---
[[ ":$PATH:" != *":$HOME/.deno/bin:"* ]] && export PATH="$HOME/.deno/bin:$PATH"
[[ ":$PATH:" != *":$HOME/.cargo/bin:"* ]] && export PATH="$HOME/.cargo/bin:$PATH"

# --- Verify tools ---
_ok=true
for cmd in deno rustc cargo; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "[dev-init] WARNING: $cmd not found"
    _ok=false
  fi
done

if $_ok; then
  echo "[dev-init] OK — deno $(deno --version 2>/dev/null | head -1 | awk '{print $2}'), rustc $(rustc --version 2>/dev/null | awk '{print $2}')"
fi
unset _ok

# --- Hook check ---
if [[ -f .git/hooks/pre-commit ]] && grep -q "pre-commit.com" .git/hooks/pre-commit 2>/dev/null; then
  : # hooks installed
else
  echo "[dev-init] hint: run scripts/install-hooks.sh to install local gates"
fi
