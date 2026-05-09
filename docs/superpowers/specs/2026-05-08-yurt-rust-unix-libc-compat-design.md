# Yurt Rust Unix/libc Compatibility Design

## Problem

`cargo-yurt` should make ordinary Rust dependencies feel like they are building for a Unix-like target. The current `wasm32-wasip1` target does not set `cfg(unix)`, so crates such as `fs2 0.4.3` do not select their Unix backend. Adding `--cfg unix` globally gets those backends selected, but it also makes the external `libc` crate enter its generic Unix module, which is not valid for WASI/Yurt.

The observed `pkg` acceptance build now gets through `zstd-sys`, `tar`, and the std Unix import surface, then fails in `fs2` because the external `libc` crate does not expose the POSIX APIs that `fs2` expects:

- `libc::dup`
- `libc::flock`
- `libc::LOCK_SH`, `LOCK_EX`, `LOCK_NB`, `LOCK_UN`
- `libc::statvfs` type and function
- `fs2::allocate` is compiled only for a fixed list of OS cfgs (`linux`, `freebsd`, `android`, `nacl`, `macos`, `ios`, `openbsd`, `netbsd`, `dragonfly`, `solaris`, `haiku`)

## Current Toolchain Shape

`cargo-yurt` should always build with the Yurt std. Package metadata must not be required for this.

User crate builds should receive:

```text
--sysroot=<yurt-rust-std> -Aexplicit-builtin-cfgs-in-flags --cfg yurt --cfg unix
```

The Yurt std build itself should receive only:

```text
--cfg yurt
```

This avoids making the std build's own vendored `libc` crate select generic Unix code.

Because Cargo needs to see `cfg(unix)` for target dependency selection, but the external `libc` crate must not compile as generic Unix, `cargo-yurt` installs a `RUSTC_WRAPPER` that strips only `--cfg unix` when compiling crate-name `libc`. Other crates still see `cfg(unix)`.

## Std Requirements

The patched Yurt std must expose a stable `std::os::unix` facade for WASI/Yurt:

- `std::os::unix::ffi::{OsStrExt, OsStringExt}`
- `std::os::unix::io::{AsRawFd, FromRawFd, IntoRawFd, RawFd, ...}`
- `std::os::unix::fs::{MetadataExt, FileTypeExt, OpenOptionsExt, DirEntryExt}`

The initial acceptance surface needs:

- `MetadataExt::{dev, ino, nlink, blocks, mode, uid, gid, rdev, size, atime, atime_nsec, mtime, mtime_nsec, ctime, ctime_nsec}`
- `FileTypeExt::{is_block_device, is_char_device, is_socket, is_fifo}`
- `OpenOptionsExt::custom_flags`
- `DirEntryExt::ino`

Do not expose the entire unstable `std::os::wasi::fs` module as stable. Use a Yurt-specific Unix facade.

## Yurt Crate Ports

Yurt needs a curated Rust crate port overlay for crates that encode host OS assumptions. `cargo-yurt` should discover every package under the Yurt crate ports directory and inject those packages with Cargo's `patch.crates-io` mechanism. Adding a new low-level port must be a data/source change in that directory, not a Rust-code change in `cargo-yurt`.

The initial ports are:

- `libc`: a curated external `libc` source for `target_os = "wasi"` plus `cfg(yurt)` that exposes POSIX names expected by Unix Rust crates while preserving WASI-compatible layout where applicable.
- `fs2`: a Yurt port that keeps the Unix backend and enables the existing `posix_fallocate` allocation path under `cfg(yurt)`, matching the `nacl` bucket without spoofing Linux.

Minimum `fs2` acceptance surface:

- Types:
  - `statvfs`
- Constants:
  - `LOCK_SH`
  - `LOCK_EX`
  - `LOCK_NB`
  - `LOCK_UN`
- Functions:
  - `dup(fd: c_int) -> c_int`
  - `flock(fd: c_int, operation: c_int) -> c_int`
  - `statvfs(path: *const c_char, buf: *mut statvfs) -> c_int`
  - `posix_fallocate(fd: c_int, offset: off_t, len: off_t) -> c_int`

The port implementation should remain upstreamable where practical by keying Yurt-specific behavior on `cfg(yurt)`.

## OS Cfg Decision

`cfg(unix)` alone is not sufficient for crates like `fs2`: some APIs are additionally gated on concrete `target_os` values.

Do not add crate-specific `cargo-yurt` cfg exceptions. That does not scale and makes the wrapper responsible for individual dependency internals. When a crate hard-codes concrete OS cfgs, port that crate in the Yurt crate ports directory.

Long-term target shape should be `target_os = "yurt"` with upstream crate patches where needed. Spoofing Linux globally is not acceptable: it makes crates select Linux ABI details that Yurt does not promise.

## Acceptance

From `yurt-pkg`, with no `YURT_CC_INCLUDE`:

```bash
env -u YURT_CC_INCLUDE \
  CC_wasm32_wasip1=/path/to/yurt-cc \
  AR_wasm32_wasip1=/path/to/yurt-ar \
  RANLIB_wasm32_wasip1=/path/to/yurt-ranlib \
  YURT_CC_ARCHIVE=/path/to/libyurt_abi.a \
  YURT_RUST_STD=/path/to/abi/build/rust-std/1.95.0 \
  /path/to/cargo-yurt build --release -p pkg
```

Expected result: `pkg` builds without removing or cfg-gating `fs2`.

Also keep:

```bash
scripts/build-rust-std.sh --rust 1.95.0
cargo test -p yurt-toolchain --tests
cargo build --release -p yurt-toolchain
```
