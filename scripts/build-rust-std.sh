#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_VERSION=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rust)
      RUST_VERSION="${2:?missing rust version}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "usage: $0 --rust <version> [--dry-run]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RUST_VERSION" ]]; then
  echo "build-rust-std: --rust is required" >&2
  exit 2
fi

PATCH_DIR="$ROOT/patches/rust/$RUST_VERSION"
YURT_STD_SRC="$ROOT/patches/rust/yurt/yurt.rs"
YURT_FS_SRC="$ROOT/patches/rust/yurt/fs.rs"
OUT_DIR="$ROOT/abi/build/rust-std/$RUST_VERSION"
WORK_DIR="${TMPDIR:-/tmp}/yurt-rust-src-$RUST_VERSION"
FAKE_SYSROOT="${TMPDIR:-/tmp}/yurt-rust-sysroot-$RUST_VERSION"
BUILD_CRATE="${TMPDIR:-/tmp}/yurt-rust-std-probe-$RUST_VERSION"

if [[ ! -d "$PATCH_DIR" ]]; then
  echo "build-rust-std: missing patch directory $PATCH_DIR" >&2
  exit 1
fi
if [[ ! -f "$YURT_STD_SRC" ]]; then
  echo "build-rust-std: missing shared Yurt std source $YURT_STD_SRC" >&2
  exit 1
fi
if [[ ! -f "$YURT_FS_SRC" ]]; then
  echo "build-rust-std: missing shared Yurt fs source $YURT_FS_SRC" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "rust=$RUST_VERSION"
  echo "patch_dir=$PATCH_DIR"
  echo "yurt_std_src=$YURT_STD_SRC"
  echo "yurt_fs_src=$YURT_FS_SRC"
  echo "work_dir=$WORK_DIR"
  echo "fake_sysroot=$FAKE_SYSROOT"
  echo "build_crate=$BUILD_CRATE"
  echo "out_dir=$OUT_DIR"
  exit 0
fi

SYSROOT="$(rustc "+$RUST_VERSION" --print sysroot 2>/dev/null || true)"
if [[ -z "$SYSROOT" ]]; then
  echo "build-rust-std: rust toolchain $RUST_VERSION is not installed" >&2
  exit 1
fi

SRC_ROOT="$SYSROOT/lib/rustlib/src/rust"
if [[ ! -d "$SRC_ROOT/library" ]]; then
  echo "build-rust-std: rust-src missing for $RUST_VERSION; run: rustup +$RUST_VERSION component add rust-src" >&2
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$(dirname "$WORK_DIR")"
cp -R "$SRC_ROOT" "$WORK_DIR"

shopt -s nullglob
for patch_file in "$PATCH_DIR"/*.patch; do
  echo "applying $(basename "$patch_file")"
  (cd "$WORK_DIR" && patch -p1 < "$patch_file")
done

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

rm -rf "$FAKE_SYSROOT" "$BUILD_CRATE"
mkdir -p "$FAKE_SYSROOT/lib/rustlib" "$FAKE_SYSROOT/lib" "$BUILD_CRATE/src" "$OUT_DIR/bin"

find "$SYSROOT/lib" -mindepth 1 -maxdepth 1 ! -name rustlib -exec ln -s {} "$FAKE_SYSROOT/lib/" \;
find "$SYSROOT/lib/rustlib" -mindepth 1 -maxdepth 1 ! -name src -exec ln -s {} "$FAKE_SYSROOT/lib/rustlib/" \;
mkdir -p "$FAKE_SYSROOT/lib/rustlib/src"
mv "$WORK_DIR" "$FAKE_SYSROOT/lib/rustlib/src/rust"

YURT_STD_DEST=""
for platform_dir in \
  "$FAKE_SYSROOT/lib/rustlib/src/rust/library/std/src/sys/pal/wasip1" \
  "$FAKE_SYSROOT/lib/rustlib/src/rust/library/std/src/sys/pal/wasi"; do
  if [[ -d "$platform_dir" ]]; then
    YURT_STD_DEST="$platform_dir/yurt.rs"
    break
  fi
done
if [[ -z "$YURT_STD_DEST" ]]; then
  echo "build-rust-std: cannot find WASI platform directory in rust-src for $RUST_VERSION" >&2
  exit 1
fi
cp "$YURT_STD_SRC" "$YURT_STD_DEST"

YURT_FS_DEST="$FAKE_SYSROOT/lib/rustlib/src/rust/library/std/src/sys/fs/yurt_fs.rs"
if [[ -d "$(dirname "$YURT_FS_DEST")" ]]; then
  cp "$YURT_FS_SRC" "$YURT_FS_DEST"
fi

cat > "$BUILD_CRATE/Cargo.toml" <<'EOF'
[package]
name = "yurt-rust-std-probe"
version = "0.0.0"
edition = "2021"

[workspace]
EOF

cat > "$BUILD_CRATE/src/main.rs" <<'EOF'
fn main() {
    println!("{}", std::env::temp_dir().display());
}
EOF

RUSTC_WRAPPER="$OUT_DIR/bin/rustc-yurt-std-$RUST_VERSION"
cat > "$RUSTC_WRAPPER" <<EOF
#!/usr/bin/env bash
exec rustc "+$RUST_VERSION" --sysroot "$FAKE_SYSROOT" "\$@"
EOF
chmod +x "$RUSTC_WRAPPER"

CARGO_TARGET_DIR="$OUT_DIR/target" \
RUSTC="$RUSTC_WRAPPER" \
RUSTC_BOOTSTRAP=1 \
cargo "+$RUST_VERSION" build \
  -Z build-std=core,alloc,std,panic_abort,proc_macro,test \
  --target wasm32-wasip1 \
  --manifest-path "$BUILD_CRATE/Cargo.toml" \
  --release

TARGET_DEPS="$OUT_DIR/target/wasm32-wasip1/release/deps"
LIB_DIR="$OUT_DIR/lib/rustlib/wasm32-wasip1/lib"
mkdir -p "$LIB_DIR"
find "$TARGET_DEPS" -maxdepth 1 -type f \( -name '*.rlib' -o -name '*.rmeta' \) -exec cp {} "$LIB_DIR/" \;

SOURCE_LIB_DIR="$SYSROOT/lib/rustlib/wasm32-wasip1/lib"
if [[ -d "$SOURCE_LIB_DIR/self-contained" ]]; then
  cp -R "$SOURCE_LIB_DIR/self-contained" "$LIB_DIR/self-contained"
fi

if ! find "$LIB_DIR" -maxdepth 1 -name 'libcompiler_builtins-*.rlib' | grep -q .; then
  echo "build-rust-std: packaged sysroot is missing compiler_builtins" >&2
  exit 1
fi
if ! find "$LIB_DIR" -maxdepth 1 -name 'libstd-*.rlib' | grep -q .; then
  echo "build-rust-std: packaged sysroot is missing std" >&2
  exit 1
fi
if ! find "$LIB_DIR" -maxdepth 1 -name 'libtest-*.rlib' | grep -q .; then
  echo "build-rust-std: packaged sysroot is missing test" >&2
  exit 1
fi
if [[ ! -f "$LIB_DIR/self-contained/crt1-command.o" ]]; then
  echo "build-rust-std: packaged sysroot is missing self-contained/crt1-command.o" >&2
  exit 1
fi
if [[ ! -f "$LIB_DIR/self-contained/libc.a" ]]; then
  echo "build-rust-std: packaged sysroot is missing self-contained/libc.a" >&2
  exit 1
fi

rustc "+$RUST_VERSION" --version > "$OUT_DIR/rustc-version.txt"
echo "wasm32-wasip1" > "$OUT_DIR/target.txt"
echo "built $OUT_DIR"
