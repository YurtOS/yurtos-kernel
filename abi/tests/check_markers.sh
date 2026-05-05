#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUILD_DIR="$REPO_ROOT/abi/build"
if [ -z "${WASI_SDK_PATH:-}" ]; then
  if [ -x "$REPO_ROOT/target/release/yurt-cc" ]; then
    WASI_SDK_PATH="$("$REPO_ROOT/target/release/yurt-cc" --print-sdk-path)"
  else
    echo "set WASI_SDK_PATH or build yurt-cc first" >&2
    exit 1
  fi
fi
NM="$WASI_SDK_PATH/bin/llvm-nm"

# (symbol, object-file) pairs. Each symbol must have a marker defined in
# the same object file.
pairs=(
  "dup2 yurt_unistd.o"
  "getgroups yurt_unistd.o"
  "sched_getaffinity yurt_sched.o"
  "sched_setaffinity yurt_sched.o"
  "sched_getcpu yurt_sched.o"
  "signal yurt_signal.o"
  "sigaction yurt_signal.o"
  "raise yurt_signal.o"
  "alarm yurt_signal.o"
  "sigemptyset yurt_signal.o"
  "sigfillset yurt_signal.o"
  "sigaddset yurt_signal.o"
  "sigdelset yurt_signal.o"
  "sigismember yurt_signal.o"
  "sigprocmask yurt_signal.o"
  "sigsuspend yurt_signal.o"
)

fail=0
for pair in "${pairs[@]}"; do
  sym="${pair% *}"
  obj="${pair#* }"
  path="$BUILD_DIR/$obj"
  if [ ! -f "$path" ]; then
    echo "missing object $path — run make objects first" >&2
    exit 1
  fi
  defined_sym="$("$NM" --defined-only "$path" | awk -v s="$sym" '$3 == s {print $3; exit}')"
  defined_marker="$("$NM" --defined-only "$path" | awk -v s="__yurt_abi_marker_$sym" '$3 == s {print $3; exit}')"
  if [ -z "$defined_sym" ]; then
    echo "FAIL: $sym not defined in $obj" >&2; fail=1
  fi
  if [ -z "$defined_marker" ]; then
    echo "FAIL: __yurt_abi_marker_$sym not defined in $obj" >&2; fail=1
  fi
done

[ "$fail" -eq 0 ] || exit 1
echo "markers OK"
