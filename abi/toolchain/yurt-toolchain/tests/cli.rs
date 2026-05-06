use std::fs;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_yurt-cc")
}

#[test]
fn help_prints_usage() {
    let out = Command::new(bin())
        .arg("--help")
        .output()
        .expect("run yurt-cc --help");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("yurt-cc"), "help output: {stdout}");
    assert!(stdout.contains("Usage"), "help output: {stdout}");
}

#[test]
fn version_prints_version() {
    let out = Command::new(bin())
        .arg("--version")
        .output()
        .expect("run yurt-cc --version");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.contains(env!("CARGO_PKG_VERSION")),
        "version output: {stdout}"
    );
}

#[test]
fn invoking_clang_respects_env_sdk() {
    // Build a fake wasi-sdk layout in a temp dir and point WASI_SDK_PATH at
    // it. yurt-cc --dry-run must print the clang path it would exec,
    // which should be <fake>/bin/clang.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot")).unwrap();
    let clang = root.join("bin/clang");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", root)
        .arg("--dry-run")
        .arg("foo.c")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.contains(clang.to_str().unwrap()),
        "dry-run stdout: {stdout}"
    );
    assert!(
        stdout.contains("--target=wasm32-wasip1"),
        "dry-run stdout: {stdout}"
    );
    assert!(stdout.contains("--sysroot="), "dry-run stdout: {stdout}");
}

#[test]
fn dry_run_injects_compat_archive_and_include_first() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot")).unwrap();
    let clang = root.join("bin/clang");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", root)
        .env("YURT_CC_ARCHIVE", "/fake/libyurt_abi.a")
        .env("YURT_CC_INCLUDE", "/fake/include")
        .env("YURT_CC_SKIP_VERSION_CHECK", "1")
        .arg("--dry-run")
        .arg("foo.c")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("-I /fake/include"), "{stdout}");
    assert!(
        stdout.find("-I /fake/include").unwrap() < stdout.find("--sysroot=").unwrap(),
        "compat headers must precede the WASI sysroot headers: {stdout}",
    );
    assert!(stdout.contains("-Wl,--whole-archive"), "{stdout}");
    assert!(stdout.contains("/fake/libyurt_abi.a"), "{stdout}");
    assert!(stdout.contains("-Wl,--no-whole-archive"), "{stdout}");
    // Structural verification requires the pre-opt .wasm to expose the
    // implementation symbol. Marker exports are opt-in via YURT_CC_MARKERS.
    assert!(stdout.contains("--no-wasm-opt"), "{stdout}");
    assert!(stdout.contains("-Wl,--export=dup2"), "{stdout}");
    assert!(
        !stdout.contains("-Wl,--export=__yurt_abi_marker_dup2"),
        "{stdout}",
    );
    let whole_idx = stdout.find("--whole-archive").unwrap();
    let no_whole_idx = stdout.find("--no-whole-archive").unwrap();
    assert!(
        whole_idx < no_whole_idx,
        "whole_archive must precede no_whole_archive"
    );
}

#[test]
fn dry_run_marks_setjmp_opt_in_builds() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot")).unwrap();
    let clang = root.join("bin/clang");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", root)
        .env("YURT_CC_ARCHIVE", "/fake/libyurt.a")
        .env("YURT_CC_SETJMP_ARCHIVE", "/fake/libyurt_setjmp.a")
        .env("YURT_CC_INCLUDE", "/fake/include")
        .env("YURT_CC_SKIP_VERSION_CHECK", "1")
        .env("YURT_CC_USE_SETJMP", "1")
        .arg("--dry-run")
        .arg("foo.c")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("-DYURT_USE_SETJMP=1"), "{stdout}");
    assert!(stdout.contains("/fake/libyurt_setjmp.a"), "{stdout}");
}

#[test]
fn dry_run_marks_continuation_opt_in_builds() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot")).unwrap();
    let clang = root.join("bin/clang");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", root)
        .env("YURT_CC_ARCHIVE", "/fake/libyurt.a")
        .env("YURT_CC_CONTINUATION_ARCHIVE", "/fake/libyurt_continuation.a")
        .env("YURT_CC_INCLUDE", "/fake/include")
        .env("YURT_CC_SKIP_VERSION_CHECK", "1")
        .env("YURT_CC_USE_CONTINUATION", "1")
        .arg("--dry-run")
        .arg("foo.c")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("-DYURT_USE_CONTINUATION=1"), "{stdout}");
    assert!(stdout.contains("/fake/libyurt_continuation.a"), "{stdout}");
}

#[test]
fn missing_version_sentinel_is_a_hard_error() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let clang = root.join("bin/clang");
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();
        let nm = root.join("bin/llvm-nm");
        fs::write(&nm, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&nm, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let archive = root.join("libyurt_abi.a");
    fs::write(&archive, b"not really an archive").unwrap();

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", root)
        .env("YURT_CC_ARCHIVE", &archive)
        .arg("foo.c")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    assert!(!out.status.success(), "expected failure");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("yurt_abi_version"),
        "stderr: {stderr}"
    );
}

#[test]
fn preserves_pre_opt_artifact_at_stable_path() {
    // Real clang+wasi-sdk build. Skip if WASI_SDK_PATH is not set in CI env.
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skipping — WASI_SDK_PATH not set");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("hello.c");
    fs::write(&src, b"int main(void) { return 0; }").unwrap();
    let out_wasm = tmp.path().join("hello.wasm");
    let preserved = tmp.path().join("hello.pre-opt.wasm");

    let st = Command::new(bin())
        .env("YURT_CC_PRESERVE_PRE_OPT", &preserved)
        .env("YURT_CC_NO_WASM_OPT", "1")
        .arg(&src)
        .arg("-o")
        .arg(&out_wasm)
        .status()
        .unwrap();
    assert!(st.success());
    assert!(
        preserved.exists(),
        "pre-opt wasm not preserved at {}",
        preserved.display()
    );
    assert!(out_wasm.exists(), "linked wasm missing");
}

#[test]
fn yurt_ar_exists_and_forwards_help() {
    let ar = env!("CARGO_BIN_EXE_yurt-ar");
    let out = Command::new(ar).arg("--help").output().unwrap();
    // llvm-ar's --help is not consistent across versions; accept any run
    // that did not fail to spawn.
    assert!(out.status.code().is_some(), "yurt-ar failed to execute");
}
