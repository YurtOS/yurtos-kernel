#!/usr/bin/env bash
# Rebuild cpython3 + its dependent ports (zlib, libzmq, pyzmq, openssl)
# against the worker-SAB threaded toolchain, then re-stage the kernel
# fixtures. Run from anywhere; reads YURT_KERNEL_ROOT / YURT_PORTS_ROOT
# from the env or defaults to the canonical local checkouts.
#
# Usage:
#   ./scripts/rebuild-threaded-cpython.sh           # full rebuild
#   ./scripts/rebuild-threaded-cpython.sh stage     # skip the build, just re-stage
#
# What it does (in order):
#   1. cargo build --release for yurt-cc + yurt-ar + yurt-ranlib
#   2. make -C abi clean lib (rebuilds libyurt_abi.a — now always
#      thread-capable since yurt-cc bakes -pthread/-matomics/-bulk-memory
#      and --target=wasm32-wasip1-threads into every invocation)
#   3. Rebuild dependent ports (zlib, libzmq, pyzmq, openssl) so their
#      static archives carry the same wasm features as cpython will
#   4. Rebuild cpython3.wasm + package it as a .yurtpkg
#   5. Stage cpython3.wasm + cpython3-lib into the kernel fixtures
#   6. Stage yurt-jupyter fixtures
#   7. Run the cpython3-pyzmq + jupyter smoke tests
#
# All builds set YURT_CC_USE_THREADS=1 explicitly even though yurt-cc
# now defaults to threads — this future-proofs against a yurt-cc that
# regains the toggle.

set -euo pipefail

KERNEL_ROOT="${YURT_KERNEL_ROOT:-/Users/ofer/work/yurt/yurtos-kernel/.claude/worktrees/worker-sab-pthread-runtime}"
PORTS_ROOT="${YURT_PORTS_ROOT:-/Users/ofer/work/yurt/yurt-ports}"
JUPYTER_ROOT="${YURT_JUPYTER_ROOT:-/Users/ofer/work/yurt/yurt-jupyter}"

if [[ ! -d "$KERNEL_ROOT" ]]; then
  echo "error: YURT_KERNEL_ROOT not a directory: $KERNEL_ROOT" >&2
  exit 1
fi
if [[ ! -d "$PORTS_ROOT" ]]; then
  echo "error: YURT_PORTS_ROOT not a directory: $PORTS_ROOT" >&2
  exit 1
fi

YURT_CC_ARCHIVE="$KERNEL_ROOT/abi/build/libyurt_abi.a"

# Common env for every port build. YURT_CC_USE_THREADS=1 is kept for
# the case where yurt-cc retains the toggle; with the threads-by-default
# yurt-cc it's redundant but harmless.
export YURT_KERNEL_ROOT="$KERNEL_ROOT"
export YURT_PORTS_ROOT="$PORTS_ROOT"
export YURT_CC_USE_THREADS=1
export YURT_CC_ARCHIVE
unset CC LD AR RANLIB   # let yurt-cc paths resolve from build.sh defaults

step() { echo; echo "==> $*"; }

if [[ "${1:-}" == "stage" ]]; then
  step "Skip-build mode: re-staging existing artifacts only"
else
  step "1/7  Build yurt-cc + libyurt_abi.a"
  cd "$KERNEL_ROOT"
  cargo build --release -p yurt-toolchain --bin yurt-cc --bin yurt-ar --bin yurt-ranlib
  make -C abi clean lib

  step "2/7  Rebuild dependent ports (in dependency order)"
  cd "$PORTS_ROOT"
  for port in zlib openssl libzmq pyzmq; do
    if [[ -x "ports/$port/scripts/build.sh" ]]; then
      step "  rebuild $port"
      ports/"$port"/scripts/build.sh
    else
      echo "  skip $port (no scripts/build.sh)"
    fi
  done

  step "3/7  Rebuild cpython3.wasm"
  ports/cpython/scripts/build.sh

  step "4/7  Package cpython3 as .yurtpkg"
  ports/cpython/scripts/package.sh
fi

step "5/7  Stage cpython3 fixtures into the kernel"
cd "$KERNEL_ROOT"
scripts/stage-cpython-fixtures.sh

if [[ -d "$JUPYTER_ROOT/dist/extracted" ]]; then
  step "6/7  Stage yurt-jupyter fixtures"
  YURT_JUPYTER_ROOT="$JUPYTER_ROOT" scripts/stage-jupyter-fixtures.sh
else
  echo
  echo "==> 6/7  Skip yurt-jupyter staging — $JUPYTER_ROOT/dist/extracted absent"
  echo "         Build it: (cd $JUPYTER_ROOT && ./scripts/stage-jupyter-site-packages.sh && ./scripts/package.sh && ./scripts/extract.sh)"
fi

step "7/7  Verify staged cpython3.wasm is thread-capable"
deno eval --no-check '
const b = await Deno.readFile("packages/kernel/src/platform/__tests__/fixtures/cpython3.wasm");
const m = await WebAssembly.compile(b);
const imps = WebAssembly.Module.imports(m).filter(i => i.kind === "memory");
console.log("memory imports:", imps);
const feats = [...WebAssembly.Module.customSections(m, "yurt.features")].map(s => new TextDecoder().decode(s));
console.log("yurt.features sections:", feats);
if (imps.length === 0) {
  console.error("FAIL: cpython3.wasm does not import memory — kernel cannot route through worker-sab");
  Deno.exit(1);
}
if (!feats.some(f => f.includes("threads"))) {
  console.error("FAIL: cpython3.wasm missing yurt.features:[\"threads\"]");
  Deno.exit(1);
}
console.log("ok: cpython3.wasm is thread-capable");
'

step "Done. To run the smokes:"
echo "    cd $KERNEL_ROOT"
echo "    deno test --allow-all packages/kernel/src/__tests__/cpython3-pyzmq_smoke_test.ts"
echo "    deno test --allow-all packages/kernel/src/__tests__/jupyter_smoke_test.ts"
