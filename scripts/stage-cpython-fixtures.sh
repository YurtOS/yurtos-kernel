#!/usr/bin/env bash
# Stage the cpython3 + pyzmq fixtures the runtime smoke test
# (packages/kernel/src/__tests__/cpython3-pyzmq_smoke_test.ts) needs.
#
# Inputs (built externally in the yurt-ports repo):
#   $YURT_PORTS_ROOT/ports/cpython/build/dist/cpython-3.14.4-yurt_0.yurtpkg
#   $YURT_PORTS_ROOT/ports/pyzmq/build/dist/pyzmq-26.4.0-yurt_0.yurtpkg
#
# Outputs (written under
# packages/kernel/src/platform/__tests__/fixtures/, all gitignored):
#   - cpython3.wasm                   (the interpreter)
#   - cpython3-lib/                   (Python stdlib + pyzmq site-packages)
#   - cpython3-lib-manifest.json      (file index for sandbox.installCpythonStdlib)
#
# Skipped subtrees (test/, idlelib/, turtledemo/, tkinter/,
# ensurepip/, __pycache__/) keep the staged tree at ~50 MB / ~1300
# files instead of ~110 MB; none are exercised by the smoke test.

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

PORTS_ROOT="$(resolve_path "${YURT_PORTS_ROOT:-$(default_sibling_root yurt-ports)}")"
FIXTURES="$KERNEL_ROOT/packages/kernel/src/platform/__tests__/fixtures"

CPYTHON_PKG="$PORTS_ROOT/ports/cpython/build/dist/cpython-3.14.4-yurt_0.yurtpkg"
PYZMQ_PKG="$PORTS_ROOT/ports/pyzmq/build/dist/pyzmq-26.4.0-yurt_0.yurtpkg"

if [[ ! -f "$CPYTHON_PKG" ]]; then
  echo "error: $CPYTHON_PKG not found." >&2
  echo "  Build it: (cd $PORTS_ROOT && ports/cpython/scripts/package.sh)" >&2
  exit 1
fi
if [[ ! -f "$PYZMQ_PKG" ]]; then
  echo "error: $PYZMQ_PKG not found." >&2
  echo "  Build it: (cd $PORTS_ROOT && ports/pyzmq/scripts/package.sh)" >&2
  exit 1
fi

WORK="$(mktemp -d -t yurt-cpython-stage)"
trap 'rm -rf "$WORK"' EXIT

echo "extracting cpython yurtpkg"
zstd -d -c "$CPYTHON_PKG" | tar -x -C "$WORK"
echo "extracting pyzmq yurtpkg over the same tree"
zstd -d -c "$PYZMQ_PKG" | tar -x -C "$WORK"

echo "staging cpython3.wasm"
mkdir -p "$FIXTURES"
cp "$WORK/usr/local/bin/cpython3.wasm" "$FIXTURES/cpython3.wasm"

echo "staging cpython3-lib/ (excluding test/, idlelib/, tkinter/, etc.)"
rm -rf "$FIXTURES/cpython3-lib"
mkdir -p "$FIXTURES/cpython3-lib"
(
  cd "$WORK/usr/local/lib/python3.14"
  find . -type f \
    -not -path './__pycache__/*' \
    -not -path '*/__pycache__/*' \
    -not -path './test/*' \
    -not -path './idlelib/*' \
    -not -path './turtledemo/*' \
    -not -path './tkinter/*' \
    -not -path './ensurepip/*' \
    | while read -r f; do
      rel="${f#./}"
      mkdir -p "${FIXTURES}/cpython3-lib/$(dirname "$rel")"
      cp "$f" "${FIXTURES}/cpython3-lib/$rel"
    done
)

# cpython aborts at startup with "Could not find platform dependent
# libraries <exec_prefix>" if /usr/local/lib/python3.14/lib-dynload/
# doesn't exist in the sandbox VFS. Our build is static-only (no
# dynamic extensions), so the dir is empty in the package — but the
# manifest needs at least one entry per directory for sandbox.ts's
# mkdirp(dir-of-file) to actually create the dir. Drop a placeholder.
mkdir -p "$FIXTURES/cpython3-lib/lib-dynload"
echo "# yurt placeholder so lib-dynload/ exists in the sandbox VFS." \
  > "$FIXTURES/cpython3-lib/lib-dynload/.keep"

echo "writing cpython3-lib-manifest.json"
python3 - "$FIXTURES" <<'PY'
import json, os, sys
fixtures = sys.argv[1]
files = []
for root, _, names in os.walk(os.path.join(fixtures, "cpython3-lib")):
    for n in names:
        files.append(os.path.relpath(os.path.join(root, n), os.path.join(fixtures, "cpython3-lib")))
files.sort()
with open(os.path.join(fixtures, "cpython3-lib-manifest.json"), "w") as f:
    json.dump(files, f)
print(f"  manifest: {len(files)} entries")
PY

count="$(find "$FIXTURES/cpython3-lib" -type f | wc -l | tr -d ' ')"
size_lib="$(du -sh "$FIXTURES/cpython3-lib" | cut -f1)"
size_wasm="$(ls -lh "$FIXTURES/cpython3.wasm" | awk '{print $5}')"
echo "fixtures staged:"
echo "  cpython3.wasm        $size_wasm"
echo "  cpython3-lib/        $size_lib ($count files)"
echo "  cpython3-lib-manifest.json"
echo ""
echo "now run:"
echo "  deno test --allow-all packages/kernel/src/__tests__/cpython3-pyzmq_smoke_test.ts"
