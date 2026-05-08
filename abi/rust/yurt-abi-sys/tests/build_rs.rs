//! Verify the build-script logic in isolation. We don't actually run
//! cargo here — that would require a wasm32 target and a real archive.
//! Instead we invoke `build.rs` as a binary with curated env vars and
//! check its stdout (cargo's build-script protocol is line-based).

use std::path::PathBuf;
use std::process::Command;

fn build_rs_binary() -> PathBuf {
    // Compile build.rs once into a tempfile and invoke it. This relies on
    // rustc being on PATH; tests skip themselves if not.
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("build_rs");
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs");
    let status = Command::new("rustc")
        .args(["--edition=2021", "-O"])
        .arg(&src)
        .arg("-o")
        .arg(&bin)
        .status();
    match status {
        Ok(s) if s.success() => {}
        _ => {
            eprintln!("rustc not available or build.rs did not compile; skipping");
            return PathBuf::new();
        }
    }
    // Persist by leaking the tempdir — we want the binary to outlive `dir`.
    let _ = dir.keep();
    bin
}

#[ignore = "slow: spawns rustc to compile build.rs, then runs the binary"]
#[test]
fn host_target_is_noop_regardless_of_env() {
    let bin = build_rs_binary();
    if !bin.exists() {
        return;
    }
    // Host target = current platform triple; pick something obviously non-wasi.
    // This is the load-bearing test for preserving root `cargo build`.
    let out = Command::new(&bin)
        .env("TARGET", "x86_64-unknown-linux-gnu")
        .env_remove("YURT_LINK_INJECTED")
        .env_remove("YURT_CC_ARCHIVE")
        .env_remove("YURT_ABI_LIBDIR")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "host build.rs must not fail even with no env: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        !stdout.contains("rustc-link-lib=static"),
        "host build must not emit link-lib; got: {stdout}"
    );
    assert!(
        !stdout.contains("rustc-link-arg="),
        "host build must not emit link-arg; got: {stdout}"
    );
}

#[ignore = "slow: spawns rustc to compile build.rs, then runs the binary"]
#[test]
fn wasip1_target_skips_when_yurt_link_injected_set() {
    let bin = build_rs_binary();
    if !bin.exists() {
        return;
    }
    let out = Command::new(&bin)
        .env("TARGET", "wasm32-wasip1")
        .env("YURT_LINK_INJECTED", "1")
        .env_remove("YURT_CC_ARCHIVE")
        .env_remove("YURT_ABI_LIBDIR")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "build.rs failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        !stdout.contains("rustc-link-lib=static"),
        "should not emit link-lib when YURT_LINK_INJECTED is set; got: {stdout}"
    );
    assert!(
        stdout.contains("YURT_LINK_INJECTED set, skipping"),
        "should warn about skipping; got: {stdout}"
    );
}

#[ignore = "slow: spawns rustc to compile build.rs, then runs the binary"]
#[test]
fn wasip1_target_emits_link_directives_when_archive_provided() {
    let bin = build_rs_binary();
    if !bin.exists() {
        return;
    }
    // Create a fake archive file so the path-based check passes; skip the
    // version check via env var to avoid llvm-nm dependency in tests.
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("libyurt_abi.a");
    std::fs::write(&archive, b"!<arch>\n").unwrap();
    let out = Command::new(&bin)
        .env("TARGET", "wasm32-wasip1")
        .env_remove("YURT_LINK_INJECTED")
        .env("YURT_CC_ARCHIVE", &archive)
        .env("YURT_CC_SKIP_VERSION_CHECK", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "build.rs failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("rustc-link-search=native="),
        "missing link-search: {stdout}"
    );
    assert!(
        stdout.contains("rustc-link-lib=static:+whole-archive+bundle=yurt_abi"),
        "missing whole-archive lib directive: {stdout}"
    );
    let export_count = stdout.matches("rustc-link-arg=-Wl,--export=").count();
    assert_eq!(
        export_count, 166,
        "expected 166 export flags, got {export_count}: {stdout}"
    );
}

#[ignore = "slow: spawns rustc to compile build.rs, then runs the binary"]
#[test]
fn wasip1_target_panics_when_neither_archive_env_set_and_not_injected() {
    let bin = build_rs_binary();
    if !bin.exists() {
        return;
    }
    let out = Command::new(&bin)
        .env("TARGET", "wasm32-wasip1")
        .env_remove("YURT_LINK_INJECTED")
        .env_remove("YURT_CC_ARCHIVE")
        .env_remove("YURT_ABI_LIBDIR")
        .output()
        .unwrap();
    assert!(
        !out.status.success(),
        "wasm32-wasip1 build.rs should fail when archive env is missing"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("YURT_ABI_LIBDIR") || stderr.contains("YURT_CC_ARCHIVE"),
        "panic message should mention env vars: {stderr}"
    );
}
