#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
YURT_CC="$REPO_ROOT/target/release/yurt-cc"

if [ ! -x "$YURT_CC" ]; then
  echo "missing $YURT_CC; run: cargo build --release -p yurt-toolchain" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yurt-abi-headers.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

cat >"$TMP_DIR/getpid.c" <<'EOF'
#include <unistd.h>

int main(void) {
    return (int)getpid();
}
EOF

YURT_CC_INCLUDE="$REPO_ROOT/abi/include" \
  "$YURT_CC" -Werror=deprecated-declarations -c \
  "$TMP_DIR/getpid.c" -o "$TMP_DIR/getpid.o"

echo "headers OK"
