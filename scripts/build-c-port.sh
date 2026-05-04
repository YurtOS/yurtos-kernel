#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  build-c-port.sh env
  build-c-port.sh cc [clang-args...]
  build-c-port.sh --output <file> [--source <file>]... [--input <file>]... [--include <dir>]... [--define <macro>]... [--compile-only] [--cflag <flag>]... [--ldflag <flag>]...

Options:
  env               Print shell exports for a subprocess-safe wasi-sdk toolchain
                    contract.
  cc                Run clang with the shared yurt WASI defaults. Intended
                    for recipe subprocesses via exported CC.
  --source <file>   Add a C source file. Repeatable.
  --input <file>    Add an existing object or archive input. Repeatable.
  --include <dir>   Add an include directory. Repeatable.
  --define <macro>  Add a preprocessor define. Repeatable.
  --output <file>   Output object or wasm path.
  --compile-only    Compile to an object file instead of linking a wasm binary.
  --cflag <flag>    Extra compiler flag. Repeatable.
  --ldflag <flag>   Extra linker flag. Repeatable.
  --verbose         Print the final clang command before execution.
  --help, -h        Show this help text.
EOF
}

die() {
  echo "build-c-port.sh: $*" >&2
  exit 1
}

find_wasi_sdk() {
  local path
  local -a candidates=()

  if [ -n "${WASI_SDK_PATH:-}" ]; then
    candidates+=("${WASI_SDK_PATH}")
  fi

  candidates+=(
    "$HOME/.local/share/wasi-sdk"
    "$HOME/.local/share"/wasi-sdk-*
    "$HOME/wasi-sdk"
    "$HOME"/wasi-sdk-*
    "/opt/homebrew/opt/wasi-sdk/share/wasi-sdk"
    "/usr/local/opt/wasi-sdk/share/wasi-sdk"
    "/opt/wasi-sdk"
    "/opt"/wasi-sdk-*
    "/usr/local/share/wasi-sdk"
    "/usr/local/share"/wasi-sdk-*
  )

  for path in "${candidates[@]}"; do
    [ -n "${path}" ] || continue
    if [ -x "${path}/bin/clang" ] && [ -d "${path}/share/wasi-sysroot" ]; then
      printf '%s\n' "${path}"
      return 0
    fi
  done

  return 1
}

shell_quote() {
  printf '%q' "$1"
}

emit_env() {
  local script_path="$1"
  local wasi_root="$2"
  local cc="$3"
  local ar="$4"
  local ranlib="$5"
  local sysroot="$6"

  printf 'export YURT_C_PORT_BUILDER=%s\n' "$(shell_quote "${script_path}")"
  printf 'export WASI_SDK_PATH=%s\n' "$(shell_quote "${wasi_root}")"
  printf 'export YURT_C_PORT_CLANG=%s\n' "$(shell_quote "${cc}")"
  printf 'export YURT_C_PORT_AR=%s\n' "$(shell_quote "${ar}")"
  printf 'export YURT_C_PORT_RANLIB=%s\n' "$(shell_quote "${ranlib}")"
  printf 'export YURT_C_PORT_SYSROOT=%s\n' "$(shell_quote "${sysroot}")"
  printf 'export YURT_C_PORT_TARGET=%s\n' "$(shell_quote "wasm32-wasip1")"
  printf 'export CC=%s\n' "$(shell_quote "${script_path} cc")"
  printf 'export AR=%s\n' "$(shell_quote "${ar}")"
  printf 'export RANLIB=%s\n' "$(shell_quote "${ranlib}")"
}

MODE="build"
if [ $# -gt 0 ]; then
  case "$1" in
    env)
      MODE="env"
      shift
      ;;
    cc)
      MODE="cc"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
  esac
fi

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
WASI_ROOT="$(find_wasi_sdk)" || die "wasi-sdk not found; set WASI_SDK_PATH to the installation root"
CC="${WASI_ROOT}/bin/clang"
AR="${WASI_ROOT}/bin/llvm-ar"
RANLIB="${WASI_ROOT}/bin/llvm-ranlib"
SYSROOT="${WASI_ROOT}/share/wasi-sysroot"

if [ "${MODE}" = "env" ]; then
  [ $# -eq 0 ] || die "env does not accept extra arguments"
  emit_env "${SCRIPT_PATH}" "${WASI_ROOT}" "${CC}" "${AR}" "${RANLIB}" "${SYSROOT}"
  exit 0
fi

if [ "${MODE}" = "cc" ]; then
  exec "${CC}" \
    --sysroot="${SYSROOT}" \
    --target=wasm32-wasip1 \
    -O2 \
    -std=c11 \
    -Wall \
    -Wextra \
    "$@"
  exit 0
fi

OUTPUT=""
COMPILE_ONLY=0
VERBOSE=0
declare -a SOURCES=()
declare -a INPUTS=()
declare -a INCLUDES=()
declare -a DEFINES=()
declare -a EXTRA_CFLAGS=()
declare -a EXTRA_LDFLAGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --source)
      [ $# -ge 2 ] || die "missing value for --source"
      SOURCES+=("$2")
      shift 2
      ;;
    --input)
      [ $# -ge 2 ] || die "missing value for --input"
      INPUTS+=("$2")
      shift 2
      ;;
    --include)
      [ $# -ge 2 ] || die "missing value for --include"
      INCLUDES+=("$2")
      shift 2
      ;;
    --define)
      [ $# -ge 2 ] || die "missing value for --define"
      DEFINES+=("$2")
      shift 2
      ;;
    --output)
      [ $# -ge 2 ] || die "missing value for --output"
      OUTPUT="$2"
      shift 2
      ;;
    --compile-only)
      COMPILE_ONLY=1
      shift
      ;;
    --cflag)
      [ $# -ge 2 ] || die "missing value for --cflag"
      EXTRA_CFLAGS+=("$2")
      shift 2
      ;;
    --ldflag)
      [ $# -ge 2 ] || die "missing value for --ldflag"
      EXTRA_LDFLAGS+=("$2")
      shift 2
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "${OUTPUT}" ] || die "--output is required"
[ "${#SOURCES[@]}" -gt 0 ] || [ "${#INPUTS[@]}" -gt 0 ] || die "provide at least one --source or --input"

if [ "${COMPILE_ONLY}" -eq 1 ]; then
  [ "${#SOURCES[@]}" -eq 1 ] || die "--compile-only expects exactly one --source"
  [ "${#INPUTS[@]}" -eq 0 ] || die "--compile-only does not accept --input"
fi

declare -a ARGS=()
ARGS+=("--sysroot=${SYSROOT}" "--target=wasm32-wasip1" "-O2" "-std=c11" "-Wall" "-Wextra")

if [ "${#INCLUDES[@]}" -gt 0 ]; then
  for include_dir in "${INCLUDES[@]}"; do
    ARGS+=("-I${include_dir}")
  done
fi

if [ "${#DEFINES[@]}" -gt 0 ]; then
  for define_value in "${DEFINES[@]}"; do
    ARGS+=("-D${define_value}")
  done
fi

if [ "${#EXTRA_CFLAGS[@]}" -gt 0 ]; then
  ARGS+=("${EXTRA_CFLAGS[@]}")
fi

if [ "${COMPILE_ONLY}" -eq 1 ]; then
  ARGS+=("-c")
fi

if [ "${#INPUTS[@]}" -gt 0 ]; then
  ARGS+=("${INPUTS[@]}")
fi

if [ "${#SOURCES[@]}" -gt 0 ]; then
  ARGS+=("${SOURCES[@]}")
fi

if [ "${#EXTRA_LDFLAGS[@]}" -gt 0 ]; then
  ARGS+=("${EXTRA_LDFLAGS[@]}")
fi

ARGS+=("-o" "${OUTPUT}")

if [ "${VERBOSE}" -eq 1 ]; then
  printf '+ %q' "${CC}" "${ARGS[@]}"
  printf '\n'
fi

exec "${CC}" "${ARGS[@]}"
