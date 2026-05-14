#!/usr/bin/env bash
# Run tests across every sibling yurt-* repo + yurtos-kernel.
#
# Per-repo detection:
#   - `deno.json` with a `tasks.test` entry  → `deno task test`
#   - `deno.json` without a tasks.test       → `deno test --allow-all`
#   - `Cargo.toml`                            → `cargo test --workspace`
#   - `Makefile` with a `test` target         → `make test`
# A repo with none of the above is skipped.
#
# Continues past failures and prints a one-line summary per repo at the
# end (status, duration). Exit code is 1 if any repo failed, else 0.
#
# Usage:
#   scripts/test-all-yurt-repos.sh                # auto-detect everything
#   scripts/test-all-yurt-repos.sh --only kernel  # filter (substring match)
#   YURT_ROOT=/path scripts/test-all-yurt-repos.sh

set -uo pipefail

YURT_ROOT="${YURT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
FILTER="${1:-}"
case "$FILTER" in
  --only)
    shift; FILTER="${1:-}" ;;
  *)
    FILTER="" ;;
esac

if [[ ! -d "$YURT_ROOT" ]]; then
  echo "error: YURT_ROOT not found: $YURT_ROOT" >&2
  exit 2
fi

REPOS=()
for d in "$YURT_ROOT"/yurt-* "$YURT_ROOT/yurtos-kernel"; do
  [[ -d "$d" ]] || continue
  name="$(basename "$d")"
  if [[ -n "$FILTER" && "$name" != *"$FILTER"* ]]; then continue; fi
  REPOS+=("$d")
done

if [[ ${#REPOS[@]} -eq 0 ]]; then
  echo "no repos matched filter: $FILTER" >&2
  exit 2
fi

declare -a SUMMARY
overall=0

for repo in "${REPOS[@]}"; do
  name="$(basename "$repo")"
  cmd=""
  if [[ -f "$repo/deno.json" ]] && grep -q '"test"' "$repo/deno.json" 2>/dev/null; then
    cmd="deno task test"
  elif [[ -f "$repo/deno.json" ]]; then
    cmd="deno test --allow-all"
  elif [[ -f "$repo/Cargo.toml" ]]; then
    cmd="cargo test --workspace"
  elif [[ -f "$repo/Makefile" ]] && grep -q '^test:' "$repo/Makefile" 2>/dev/null; then
    cmd="make test"
  else
    SUMMARY+=("SKIP  $name  (no test infra detected)")
    continue
  fi

  echo
  echo "════════════════════════════════════════════════════════════"
  echo "  $name :: $cmd"
  echo "════════════════════════════════════════════════════════════"
  t0=$(date +%s)
  ( cd "$repo" && eval "$cmd" )
  rc=$?
  dt=$(( $(date +%s) - t0 ))
  if [[ $rc -eq 0 ]]; then
    SUMMARY+=("PASS  $name  (${dt}s)  $cmd")
  else
    SUMMARY+=("FAIL  $name  (${dt}s, rc=$rc)  $cmd")
    overall=1
  fi
done

echo
echo "════════════════════════════════════════════════════════════"
echo "  Summary"
echo "════════════════════════════════════════════════════════════"
for line in "${SUMMARY[@]}"; do echo "$line"; done
exit $overall
