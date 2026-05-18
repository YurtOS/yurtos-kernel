#!/usr/bin/env bash
set -euo pipefail

# Run cargo clippy scoped to crates that have staged Rust changes.
# Falls back to a full workspace lint if no Rust files are staged
# (e.g. when invoked via `pre-commit run --all-files`).

# `mapfile` is bash 4+; macOS ships bash 3.2, so populate the array
# with a portable while-read loop. Pre-commit invokes via `/usr/bin/env
# bash`, which on macOS resolves to the system 3.2.
CHANGED=()
while IFS= read -r f; do
  [[ -n "$f" ]] && CHANGED+=("$f")
done < <(git diff --cached --name-only --diff-filter=ACMRT -- '*.rs' || true)

if [[ ${#CHANGED[@]} -eq 0 ]]; then
  # Default-members only — wasm-only canary crates need a different target.
  exec cargo clippy --all-targets -- -D warnings
fi

# Map each changed file to the nearest *package* Cargo.toml directory.
# Virtual manifests (workspace-only Cargo.toml with no `name = ...`) are
# skipped — keep walking up.
#
# bash 3.2 (macOS) lacks `declare -A`; dedupe package names via a
# newline-separated list and `sort -u` instead.
PKG_LIST=""
for f in "${CHANGED[@]}"; do
  dir="$(dirname "$f")"
  while [[ "$dir" != "." && "$dir" != "/" ]]; do
    if [[ -f "$dir/Cargo.toml" ]]; then
      pkg="$(awk -F\" '/^name *=/ {print $2; exit}' "$dir/Cargo.toml")"
      if [[ -n "$pkg" ]]; then
        PKG_LIST+="$pkg"$'\n'
        break
      fi
    fi
    dir="$(dirname "$dir")"
  done
done

PKGS_UNIQ=()
while IFS= read -r pkg; do
  [[ -n "$pkg" ]] && PKGS_UNIQ+=("$pkg")
done < <(printf '%s' "$PKG_LIST" | sort -u)

if [[ ${#PKGS_UNIQ[@]} -eq 0 ]]; then
  # Default-members only — wasm-only canary crates need a different target.
  exec cargo clippy --all-targets -- -D warnings
fi

for pkg in "${PKGS_UNIQ[@]}"; do
  echo "→ cargo clippy -p $pkg --all-targets -- -D warnings"
  cargo clippy -p "$pkg" --all-targets -- -D warnings
done
