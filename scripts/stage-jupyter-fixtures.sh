#!/usr/bin/env bash
# Stage the yurt-jupyter site-packages tree + helper scripts under
# packages/kernel/src/platform/__tests__/fixtures/yurt-jupyter/ so
# the kernel's jupyter_smoke_test.ts can run against real Jupyter
# bits.
#
# Inputs (built externally in the yurt-jupyter repo):
#   $YURT_JUPYTER_ROOT/dist/extracted/usr/local/lib/python3.14/site-packages/
#   $YURT_JUPYTER_ROOT/dist/extracted/usr/share/yurt-jupyter/
#     (psutil.py, sitecustomize.py, ipykernel-launch-dry-run.py)
#
# Override input via YURT_JUPYTER_ROOT=/path/to/yurt-jupyter. The
# script copies, doesn't symlink, so the fixture stays stable if
# yurt-jupyter is rebuilt mid-test.
#
# Outputs (under packages/kernel/src/platform/__tests__/fixtures/,
# all gitignored — too large to commit):
#   - yurt-jupyter/site-packages/   (~200 MB, ~12k files)
#   - yurt-jupyter/usr-share/       (psutil + sitecustomize + dry-run)
#
# Skipped when $YURT_JUPYTER_ROOT/dist/extracted/ is absent.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
KERNEL_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

resolve_path() {
  local path="$1"
  if [[ -d "$path" ]]; then
    cd -- "$path" && pwd -P
  else
    local parent
    parent="$(dirname -- "$path")"
    if [[ -d "$parent" ]]; then
      printf '%s/%s\n' "$(cd -- "$parent" && pwd -P)" "$(basename -- "$path")"
    else
      printf '%s\n' "$path"
    fi
  fi
}

default_sibling_root() {
  local name="$1"
  local base="$KERNEL_ROOT"
  while [[ "$base" != "/" ]]; do
    local candidate="$base/../$name"
    if [[ -d "$candidate" ]]; then
      resolve_path "$candidate"
      return
    fi
    base="$(dirname -- "$base")"
  done
  resolve_path "$KERNEL_ROOT/../$name"
}

YURT_JUPYTER_ROOT="$(resolve_path "${YURT_JUPYTER_ROOT:-$(default_sibling_root yurt-jupyter)}")"
FIXTURES="$KERNEL_ROOT/packages/kernel/src/platform/__tests__/fixtures"
EXTRACTED="$YURT_JUPYTER_ROOT/dist/extracted"

if [[ ! -d "$EXTRACTED" ]]; then
  echo "error: $EXTRACTED not found." >&2
  echo "  Build it: (cd $YURT_JUPYTER_ROOT && ./scripts/stage-jupyter-site-packages.sh && ./scripts/package.sh && ./scripts/extract.sh)" >&2
  exit 1
fi

SRC_SP="$EXTRACTED/usr/local/lib/python3.14/site-packages"
SRC_US="$EXTRACTED/usr/share/yurt-jupyter"
if [[ ! -d "$SRC_SP" ]]; then
  echo "error: $SRC_SP missing — yurt-jupyter extract didn't include site-packages" >&2
  exit 1
fi
if [[ ! -f "$SRC_US/psutil.py" || ! -f "$SRC_US/sitecustomize.py" ]]; then
  echo "error: yurt-jupyter helper files missing under $SRC_US" >&2
  exit 1
fi

DST="$FIXTURES/yurt-jupyter"
echo "staging $EXTRACTED -> $DST"
rm -rf "$DST"
mkdir -p "$DST/site-packages" "$DST/usr-share"

# cp -R is enough; the source tree has no symlinks (the yurt-jupyter
# staging script already resolved any).
cp -R "$SRC_SP/." "$DST/site-packages/"
cp -R "$SRC_US/." "$DST/usr-share/"

sp_files="$(find "$DST/site-packages" -type f | wc -l | tr -d ' ')"
sp_size="$(du -sh "$DST/site-packages" | cut -f1)"
echo "staged: site-packages ($sp_files files, $sp_size)"
echo "staged: usr-share ($(ls "$DST/usr-share" | wc -l | tr -d ' ') files)"
echo ""
echo "now run:"
echo "  deno test --allow-all packages/kernel/src/__tests__/jupyter_smoke_test.ts"
