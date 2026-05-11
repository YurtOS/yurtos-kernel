#!/usr/bin/env bash
# Stage the yurt-jupyter site-packages tree + helper scripts under
# packages/kernel/src/platform/__tests__/fixtures/yurt-jupyter/ so
# the kernel's jupyter_smoke_test.ts can run against real Jupyter
# bits.
#
# Inputs (built externally in the sibling yurt-jupyter repo):
#   ../yurt-jupyter/dist/extracted/usr/local/lib/python3.14/site-packages/
#   ../yurt-jupyter/dist/extracted/usr/share/yurt-jupyter/
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
# Skipped when ../yurt-jupyter/dist/extracted/ is absent — run
# `(cd ../yurt-jupyter && ./scripts/{stage-jupyter-site-packages,package,extract}.sh)`
# first.

set -euo pipefail

KERNEL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
YURT_JUPYTER_ROOT="${YURT_JUPYTER_ROOT:-"$KERNEL_ROOT/../yurt-jupyter"}"
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
