//! Runtime-library replacements for wasip1 stdlib functions that panic
//! (`library/std/src/sys/pal/wasi/os.rs`). Each shim is exported under a
//! stable `#[export_name = "__yurt_wasi_shim_*"]` identifier.
//!
//! Consumers add this crate as a direct dependency. After link, the
//! `yurt-wasi-postlink` binary scans the resulting .wasm for the
//! mangled stdlib symbols listed in `yurt-wasi-postlink`'s target
//! table and rewrites each body to a tail-call into the matching shim
//! export below. The wasm type signatures are identical by construction
//! (both sides are plain Rust functions of matching types), so the
//! rewrite is a drop-in body replacement.
//!
//! The `#[used]` static on each shim keeps it from being DCE'd before
//! post-link processing sees the file.

use std::path::PathBuf;

/// Replacement for `std::env::temp_dir` on wasip1.
///
/// Rust's wasip1 stdlib hard-panics with "no filesystem on wasm" —
/// `/tmp` is the POSIX convention and the directory that wasmtime
/// runtimes typically preopen via `--dir=/tmp`.
#[export_name = "__yurt_wasi_shim_env_temp_dir"]
pub extern "Rust" fn env_temp_dir() -> PathBuf {
    PathBuf::from("/tmp")
}

#[used]
static _KEEP_ENV_TEMP_DIR: extern "Rust" fn() -> PathBuf = env_temp_dir;
