#!/usr/bin/env bash
# Rebuild cpython3 + its dependent ports (zlib, libzmq, pyzmq, openssl)
# against the worker-SAB threaded toolchain, then re-stage the kernel
# fixtures. Run from anywhere; reads YURT_KERNEL_ROOT / YURT_PORTS_ROOT
# from the env or defaults to the canonical local checkouts.
#
# Usage:
#   ./scripts/rebuild-threaded-cpython.sh           # full rebuild + verify
#   ./scripts/rebuild-threaded-cpython.sh stage     # skip the build, just re-stage + verify
#   ./scripts/rebuild-threaded-cpython.sh verify    # skip the build AND staging, run smokes only
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
#   7. Verify staged cpython3.wasm has the threads shape (memory import +
#      yurt.features section)
#   8. Run the regression smokes:
#       - cpython3-pyzmq smoke (5 steps, should be 5/5 green)
#       - file-conformance integration test (sunny's guard on the WASI
#         async-wrap surface — adding path_* to ASYNC_WASI_IMPORTS in
#         loader.ts must keep this green)
#       - libzmq-reactor-spawn reproducer (currently FAILS — expected;
#         flips to green when the WASI path_* async-wrap lands; see the
#         comment block in loader.ts about ASYNC_WASI_IMPORTS)
#       - jupyter smoke (steps 1+2 should pass; step 3 currently hangs
#         on the same gate the reproducer pins)
#
# All builds set YURT_CC_USE_THREADS=1 explicitly even though yurt-cc
# now defaults to threads — this future-proofs against a yurt-cc that
# regains the toggle.
#
# On the JSPI / asyncify-imports prerequisite:
#   - cpython3 (threaded build) uses JSPI, not asyncify. yurt-cc only
#     runs the --asyncify pass when YURT_CC_USE_CONTINUATION=1, which
#     is mutually exclusive with threads (see abi/toolchain/.../env.rs).
#   - JSPI suspends any WASM import that returns a Promise, with no
#     per-import declaration needed.
#   - The one remaining JSPI concern for path_*: i64 argument handling.
#     If you flip ASYNC_WASI_IMPORTS in loader.ts to include path_open,
#     this script's file-conformance smoke is the regression test that
#     catches an i64-arg JSPI bug (or proves it's safe). See sunny's
#     guard comment in packages/kernel/src/process/loader.ts:115.

set -euo pipefail

KERNEL_ROOT="${YURT_KERNEL_ROOT:-/Users/ofer/work/yurt/yurtos-kernel}"
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

MODE="${1:-full}"
case "$MODE" in
  full|stage|verify) ;;
  *) echo "error: unknown mode '$MODE' (expected: full, stage, verify)" >&2; exit 2 ;;
esac

if [[ "$MODE" == "verify" ]]; then
  step "Verify-only mode: skipping build + staging, running smokes only"
elif [[ "$MODE" == "stage" ]]; then
  step "Stage-only mode: skipping build, re-staging existing artifacts"
else
  step "1/8  Build yurt-cc + libyurt_abi.a"
  cd "$KERNEL_ROOT"
  cargo build --release -p yurt-toolchain --bin yurt-cc --bin yurt-ar --bin yurt-ranlib
  make -C abi clean lib

  step "2/8  Rebuild dependent ports (in dependency order)"
  cd "$PORTS_ROOT"
  for port in zlib openssl libzmq pyzmq; do
    if [[ -x "ports/$port/scripts/build.sh" ]]; then
      step "  rebuild $port"
      ports/"$port"/scripts/build.sh
    else
      echo "  skip $port (no scripts/build.sh)"
    fi
  done

  step "3/8  Rebuild cpython3.wasm"
  # Tee configure+make output to a log so the next config.site
  # expansion can be auto-generated. After a successful build, run:
  #   grep -oE 'checking for [a-zA-Z0-9_]+\.\.\. (yes|no)' /tmp/cpython-build.log \
  #     | sort -u | sed -E 's/checking for ([a-zA-Z0-9_]+)\.\.\. (yes|no)/ac_cv_func_\1=\2/'
  # Compare against existing ports/cpython/files/config.site; add new
  # rows to kill future probe-storms. Same shape for `header` and
  # `lib` checks (sed pattern needs adjusting).
  ports/cpython/scripts/build.sh 2>&1 | tee /tmp/cpython-build.log

  step "4/8  Package cpython3 as .yurtpkg"
  ports/cpython/scripts/package.sh
fi

if [[ "$MODE" != "verify" ]]; then
  step "5/8  Stage cpython3 fixtures into the kernel"
  cd "$KERNEL_ROOT"
  scripts/stage-cpython-fixtures.sh

  if [[ -d "$JUPYTER_ROOT/dist/extracted" ]]; then
    step "6/8  Stage yurt-jupyter fixtures"
    YURT_JUPYTER_ROOT="$JUPYTER_ROOT" scripts/stage-jupyter-fixtures.sh
  else
    echo
    echo "==> 6/8  Skip yurt-jupyter staging — $JUPYTER_ROOT/dist/extracted absent"
    echo "         Build it: (cd $JUPYTER_ROOT && ./scripts/stage-jupyter-site-packages.sh && ./scripts/package.sh && ./scripts/extract.sh)"
  fi
fi

cd "$KERNEL_ROOT"
step "7/8  Verify staged cpython3.wasm is thread-capable"
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

step "8/8  Run regression smokes + the deadlock reproducer"

# Track pass/fail of each smoke so the summary at the bottom is honest.
# Each one runs even if the previous failed — they're independent gates.
PASS=()
FAIL=()
run_smoke() {
  local name="$1"
  local path="$2"
  step "  smoke: $name"
  if deno test --allow-all "$path"; then
    PASS+=("$name")
  else
    FAIL+=("$name")
  fi
}

run_smoke "cpython3-pyzmq (must stay 5/5 green)" \
  packages/kernel/src/__tests__/cpython3-pyzmq_smoke_test.ts

run_smoke "file-conformance integration (regression gate for adding path_* to ASYNC_WASI_IMPORTS)" \
  packages/kernel/src/__tests__/file-conformance_integration_test.ts

# The reproducer is the canonical gate for the next layer of the
# worker-host deadlock chain. Today it FAILS by design — that's the
# bug it pins. It flips green when packages/kernel/src/process/
# loader.ts's ASYNC_WASI_IMPORTS gains path_* (after the
# file-conformance smoke above confirms JSPI i64-arg behavior is
# safe). See the PR #42 status comment for the full layering.
run_smoke "libzmq-reactor-spawn reproducer (currently FAILS — expected; flips green when path_* async-wrap lands)" \
  packages/kernel/src/__tests__/libzmq-reactor-spawn_reproducer_test.ts

if [[ -d packages/kernel/src/platform/__tests__/fixtures/yurt-jupyter ]]; then
  run_smoke "jupyter (step 3 currently hangs on the same gate the reproducer pins)" \
    packages/kernel/src/__tests__/jupyter_smoke_test.ts
fi

step "Summary"
for t in "${PASS[@]}"; do echo "  ✅ $t"; done
for t in "${FAIL[@]}"; do echo "  ❌ $t"; done
echo
if [[ ${#FAIL[@]} -eq 0 ]]; then
  echo "All smokes green. If the libzmq-reactor-spawn reproducer is in PASS"
  echo "and it WAS hanging before, the deadlock chain is fully resolved."
else
  echo "${#FAIL[@]} smoke(s) failed. Expected today: the reproducer (and"
  echo "jupyter step 3) until the WASI path_* async-wrap lands."
fi
