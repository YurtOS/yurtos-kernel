#!/usr/bin/env bash
set -euo pipefail

# Run cargo clippy scoped to crates that have staged Rust changes.
# Falls back to a full workspace lint if no Rust files are staged
# (e.g. when invoked via `pre-commit run --all-files`).

mapfile -t CHANGED < <(git diff --cached --name-only --diff-filter=ACMRT -- '*.rs' || true)

if [[ ${#CHANGED[@]} -eq 0 ]]; then
  # Default-members only — wasm-only canary crates need a different target.
  exec cargo clippy --all-targets -- -D warnings
fi

# Map each changed file to the nearest Cargo.toml directory, dedupe.
declare -A CRATE_DIRS=()
for f in "${CHANGED[@]}"; do
  dir="$(dirname "$f")"
  while [[ "$dir" != "." && "$dir" != "/" ]]; do
    if [[ -f "$dir/Cargo.toml" ]]; then
      CRATE_DIRS["$dir"]=1
      break
    fi
    dir="$(dirname "$dir")"
  done
done

if [[ ${#CRATE_DIRS[@]} -eq 0 ]]; then
  # Default-members only — wasm-only canary crates need a different target.
  exec cargo clippy --all-targets -- -D warnings
fi

for dir in "${!CRATE_DIRS[@]}"; do
  pkg="$(awk -F\" '/^name *=/ {print $2; exit}' "$dir/Cargo.toml")"
  if [[ -z "$pkg" ]]; then
    echo "lint-clippy-changed: could not parse package name in $dir/Cargo.toml" >&2
    exit 2
  fi
  echo "→ cargo clippy -p $pkg --all-targets -- -D warnings"
  cargo clippy -p "$pkg" --all-targets -- -D warnings
done
