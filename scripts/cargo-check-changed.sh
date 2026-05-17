#!/usr/bin/env bash
set -euo pipefail

# Fast `cargo check --tests` scoped to crates that have staged Rust
# changes. Runs *before* the heavier per-crate clippy hook so a pure
# compile error (missing field, type mismatch, removed symbol) surfaces
# in seconds instead of waiting on the lint pass.
#
# Both hooks share the same crate-discovery shape as
# `lint-clippy-changed.sh` so they cover the same set, in the same
# order, just with cheaper feedback up-front.

mapfile -t CHANGED < <(git diff --cached --name-only --diff-filter=ACMRT -- '*.rs' || true)

if [[ ${#CHANGED[@]} -eq 0 ]]; then
  exec cargo check --all-targets
fi

# Map each changed file to the nearest *package* Cargo.toml directory.
# Virtual manifests (workspace-only Cargo.toml with no `name = ...`) are
# skipped — keep walking up.
declare -A CRATE_PKGS=()
for f in "${CHANGED[@]}"; do
  dir="$(dirname "$f")"
  while [[ "$dir" != "." && "$dir" != "/" ]]; do
    if [[ -f "$dir/Cargo.toml" ]]; then
      pkg="$(awk -F\" '/^name *=/ {print $2; exit}' "$dir/Cargo.toml")"
      if [[ -n "$pkg" ]]; then
        CRATE_PKGS["$pkg"]=1
        break
      fi
    fi
    dir="$(dirname "$dir")"
  done
done

if [[ ${#CRATE_PKGS[@]} -eq 0 ]]; then
  exec cargo check --all-targets
fi

for pkg in "${!CRATE_PKGS[@]}"; do
  echo "→ cargo check -p $pkg --tests"
  cargo check -p "$pkg" --tests
done
