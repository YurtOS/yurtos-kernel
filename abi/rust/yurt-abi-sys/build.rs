//! Build-time link directives for `libyurt_abi.a`. Three paths:
//!  1. Host target → no-op (archive is a wasm artifact, host has nothing to link).
//!  2. wasm32-wasip1 + YURT_LINK_INJECTED=1 → no-op (cargo-yurt already
//!     framed --whole-archive via RUSTFLAGS; emitting here would link twice).
//!  3. wasm32-wasip1 without YURT_LINK_INJECTED → emit link-search, whole-
//!     archive bundle lib, and per-Tier-1-symbol --export flags. Requires
//!     YURT_ABI_LIBDIR or YURT_CC_ARCHIVE; errors with a clear
//!     message if neither is set.
//!
//! Also runs an llvm-nm presence check on the archive in path 3, mirroring
//! `yurt-cc`'s `archive::check_version` so plain-cargo consumers get the same
//! version-mismatch surface as cargo-yurt consumers.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=YURT_LINK_INJECTED");
    println!("cargo:rerun-if-env-changed=YURT_ABI_LIBDIR");
    println!("cargo:rerun-if-env-changed=YURT_CC_ARCHIVE");
    println!("cargo:rerun-if-env-changed=YURT_CC_SKIP_VERSION_CHECK");

    // CARGO_CFG_TARGET_OS + CARGO_CFG_TARGET_ARCH are how build.rs scripts
    // learn what cargo is actually targeting. For wasm32-wasip1 these are
    // `wasi` and `wasm32`. TARGET is the full triple; we use it because
    // `wasm32-wasip1` and `wasm32-wasi` both have TARGET_OS=wasi but we
    // only want to inject into the p1 variant yurt ships.
    let target = env::var("TARGET").unwrap_or_default();
    if target != "wasm32-wasip1" {
        // Path 1: host (or any non-wasip1) build. Harmless no-op so workspace
        // builds never fail for developers who aren't targeting yurt.
        return;
    }

    if env::var("YURT_LINK_INJECTED").is_ok() {
        // Path 2: cargo-yurt already injected via RUSTFLAGS.
        println!(
            "cargo:warning=yurt-abi-sys: YURT_LINK_INJECTED set, skipping link directives"
        );
        return;
    }

    // Path 3: wasm32-wasip1 under plain cargo — archive env is required.
    let lib_path = locate_archive();
    let lib_dir: PathBuf = lib_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    if env::var("YURT_CC_SKIP_VERSION_CHECK").is_err() {
        run_version_check(&lib_path);
    }

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    // `static:+whole-archive+bundle` mirrors the Phase A C-side --whole-archive
    // semantics (§Override And Link Precedence > Link Order C frontend).
    println!("cargo:rustc-link-lib=static:+whole-archive+bundle=yurt_abi");

    // Per-Tier-1-symbol --export framing so the implementation-signature
    // check (§Verifying Precedence) finds markers in the pre-opt wasm. Same
    // symbols as yurt-toolchain::TIER1 — must stay in sync with
    // abi/toolchain/yurt-toolchain/src/lib.rs TIER1.
    for sym in TIER1 {
        println!("cargo:rustc-link-arg=-Wl,--export={sym}");
        println!("cargo:rustc-link-arg=-Wl,--export=__yurt_abi_marker_{sym}");
    }
}

/// Must stay in sync with `yurt_toolchain::TIER1`. A CI parity check
/// (Task 18 step 2.5) asserts this at build time.
const TIER1: &[&str] = &[
    "chown",
    "chroot",
    "chmod",
    "flockfile",
    "ftrylockfile",
    "funlockfile",
    "qsort_r",
    "setresgid",
    "setresuid",
    "dup",
    "dup2",
    "dup3",
    "execv",
    "execve",
    "execvp",
    "fchdir",
    "fchown",
    "fork",
    "vfork",
    "gethostname",
    "getaddrinfo",
    "freeaddrinfo",
    "getnameinfo",
    "gethostbyname",
    "gethostbyaddr",
    "getgroups",
    "getpriority",
    "getrlimit",
    "getpgid",
    "getpgrp",
    "getsid",
    "lchown",
    "mkdtemp",
    "mkostemp",
    "mkstemp",
    "mktemp",
    "setpgid",
    "setpgrp",
    "setpriority",
    "setsid",
    "tcgetpgrp",
    "tcsetpgrp",
    "umask",
    "pipe",
    "pipe2",
    "if_indextoname",
    "if_nametoindex",
    "sendfile",
    "posix_spawn",
    "posix_spawnp",
    "posix_spawn_file_actions_init",
    "posix_spawnattr_init",
    "setrlimit",
    "sched_getaffinity",
    "sched_setaffinity",
    "sched_getcpu",
    "signal",
    "sigaction",
    "raise",
    "alarm",
    "sigemptyset",
    "sigfillset",
    "sigaddset",
    "sigdelset",
    "sigismember",
    "sigprocmask",
    "sigsuspend",
    "tzset",
    "wait",
    "waitpid",
    "pthread_create",
    "pthread_join",
    "pthread_detach",
    "pthread_exit",
    "pthread_self",
    "pthread_mutex_lock",
    "pthread_mutex_unlock",
    "pthread_cond_wait",
    "pthread_cond_signal",
    "pthread_key_create",
    "pthread_setspecific",
    "pthread_getspecific",
    "pthread_once",
];

fn locate_archive() -> PathBuf {
    if let Ok(explicit) = env::var("YURT_ABI_LIBDIR") {
        return PathBuf::from(explicit).join("libyurt_abi.a");
    }
    if let Ok(explicit) = env::var("YURT_CC_ARCHIVE") {
        return PathBuf::from(explicit);
    }
    // Only reachable when TARGET is wasm32-wasip1 AND YURT_LINK_INJECTED
    // is unset — i.e. the "alternate path" for plain cargo. Host builds
    // never see this.
    panic!(
        "yurt-abi-sys: targeting wasm32-wasip1 with neither YURT_ABI_LIBDIR nor YURT_CC_ARCHIVE set. Either set one to point at libyurt_abi.a, or build via cargo-yurt which sets YURT_LINK_INJECTED=1 and frames the archive itself."
    );
}

fn run_version_check(archive: &Path) {
    let nm = locate_nm();
    let out = Command::new(&nm)
        .arg("--defined-only")
        .arg(archive)
        .output()
        .unwrap_or_else(|e| panic!("running {} on {}: {e}", nm.display(), archive.display()));
    if !out.status.success() {
        panic!(
            "llvm-nm failed on {}: {}",
            archive.display(),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let present = stdout
        .lines()
        .any(|line| line.split_whitespace().last() == Some("yurt_abi_version"));
    if !present {
        panic!(
            "archive {} does not define yurt_abi_version (§Versioning); set YURT_CC_SKIP_VERSION_CHECK=1 to bypass",
            archive.display()
        );
    }
}

fn locate_nm() -> PathBuf {
    if let Ok(p) = env::var("LLVM_NM") {
        return PathBuf::from(p);
    }
    if let Ok(sdk) = env::var("WASI_SDK_PATH") {
        return PathBuf::from(sdk).join("bin/llvm-nm");
    }
    PathBuf::from("llvm-nm")
}
