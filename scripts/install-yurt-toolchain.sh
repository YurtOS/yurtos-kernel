#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${CARGO_HOME:-$HOME/.cargo}/bin"
YURT_HOME="${YURT_HOME:-$HOME/.yurt}"
BUILD_PROFILE="release"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir)
      BIN_DIR="${2:?missing bin dir}"
      shift 2
      ;;
    --yurt-home)
      YURT_HOME="${2:?missing yurt home}"
      shift 2
      ;;
    --debug)
      BUILD_PROFILE="debug"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "usage: $0 [--bin-dir <dir>] [--yurt-home <dir>] [--debug] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo "bin_dir=$BIN_DIR"
  echo "yurt_home=$YURT_HOME"
  echo "build_profile=$BUILD_PROFILE"
  exit 0
fi

if [[ "$BUILD_PROFILE" == "release" ]]; then
  cargo build -p yurt-toolchain --release
  TARGET_DIR="$ROOT/target/release"
else
  cargo build -p yurt-toolchain
  TARGET_DIR="$ROOT/target/debug"
fi

mkdir -p "$BIN_DIR" "$YURT_HOME/rust-std"

for bin in cargo-yurt maturin-yurt yurt-cc yurt-ar yurt-ranlib yurt-check yurt-conf; do
  install -m 0755 "$TARGET_DIR/$bin" "$BIN_DIR/$bin"
done

if [[ -d "$ROOT/packages/guest-compat/build/rust-std" ]]; then
  for version_dir in "$ROOT"/packages/guest-compat/build/rust-std/*; do
    [[ -d "$version_dir" ]] || continue
    version="$(basename "$version_dir")"
    rm -rf "$YURT_HOME/rust-std/$version"
    mkdir -p "$YURT_HOME/rust-std"
    cp -R "$version_dir" "$YURT_HOME/rust-std/$version"
  done
fi

cat <<EOF
Installed Yurt toolchain:
  binaries: $BIN_DIR
  YURT_HOME: $YURT_HOME

Use:
  cargo yurt build
  maturin-yurt build
EOF
