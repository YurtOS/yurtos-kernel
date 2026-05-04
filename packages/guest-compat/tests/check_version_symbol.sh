#!/usr/bin/env bash
set -euo pipefail

# Verify the version sentinel symbol is defined in the built object, and
# that the header exposes the corresponding compile-time major/minor
# macros (so cpcc and header stay in sync textually). This is presence-
# only — extracting the encoded uint32_t out of the archive to value-
# match against the header constants requires parsing the wasm object
# format and is deferred to Step 3 (see §Versioning and the Self-Review
# note). Task 7's cpcc archive check likewise enforces presence only at
# Step 1.
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUILD_DIR="$REPO_ROOT/packages/guest-compat/build"
OBJ="$BUILD_DIR/yurt_version.o"
HDR="$REPO_ROOT/packages/guest-compat/include/yurt_compat.h"

# These test shell scripts require a wasi-sdk install located via the
# standard WASI_SDK_PATH env var. After Task 6, use:
#   WASI_SDK_PATH="$("$REPO_ROOT/target/release/cpcc" --print-sdk-path)"
# For Tasks 2–4 (before cpcc is built), require the caller to set
# WASI_SDK_PATH themselves.
if [ -z "${WASI_SDK_PATH:-}" ]; then
  if [ -x "$REPO_ROOT/target/release/cpcc" ]; then
    WASI_SDK_PATH="$("$REPO_ROOT/target/release/cpcc" --print-sdk-path)"
  else
    echo "set WASI_SDK_PATH or build cpcc first" >&2
    exit 1
  fi
fi
NM="$WASI_SDK_PATH/bin/llvm-nm"

if [ ! -f "$OBJ" ]; then
  echo "missing $OBJ — run make first" >&2
  exit 1
fi

# The symbol must be defined (D or R) and named `yurt_guest_compat_version`.
if ! "$NM" --defined-only "$OBJ" | grep -E ' [DR] yurt_guest_compat_version$' >/dev/null; then
  echo "yurt_guest_compat_version not defined in $OBJ" >&2
  "$NM" --defined-only "$OBJ" >&2
  exit 1
fi

# The header must expose YURT_GUEST_COMPAT_VERSION_MAJOR and _MINOR.
grep -q 'YURT_GUEST_COMPAT_VERSION_MAJOR' "$HDR" || { echo "missing major in header" >&2; exit 1; }
grep -q 'YURT_GUEST_COMPAT_VERSION_MINOR' "$HDR" || { echo "missing minor in header" >&2; exit 1; }

echo "version symbol OK"
