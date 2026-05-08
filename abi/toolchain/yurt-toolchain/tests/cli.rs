use std::fs;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_yurt-cc")
}

fn fake_sdk() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot/include")).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let clang = root.join("bin/clang");
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();

        let nm = root.join("bin/llvm-nm");
        fs::write(&nm, b"#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(&nm, fs::Permissions::from_mode(0o755)).unwrap();
    }

    tmp
}

fn stdout_string(out: std::process::Output) -> String {
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn stdout_tokens(stdout: &str) -> Vec<&str> {
    stdout.split_whitespace().collect()
}

fn expected_repo_yurt_include() -> String {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("include");
    p.canonicalize().unwrap_or(p).display().to_string()
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
    let first = stdout.lines().next().unwrap_or("");
    assert!(first.starts_with("yurt-cc "), "version output: {stdout}");
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
fn dry_run_does_not_force_compile_policy_flags() {
    let sdk = fake_sdk();

    let stdout = stdout_string(
        Command::new(bin())
            .env("WASI_SDK_PATH", sdk.path())
            .arg("--dry-run")
            .arg("-c")
            .arg("foo.c")
            .output()
            .unwrap(),
    );

    assert!(stdout.contains("--target=wasm32-wasip1"), "{stdout}");
    assert!(stdout.contains("--sysroot="), "{stdout}");
    let tokens = stdout_tokens(&stdout);
    assert!(!tokens.contains(&"-O2"), "{stdout}");
    assert!(!tokens.contains(&"-std=gnu23"), "{stdout}");
    assert!(!tokens.contains(&"-Wall"), "{stdout}");
    assert!(!tokens.contains(&"-Wextra"), "{stdout}");
}

#[test]
fn dry_run_strips_elf_linker_flags_that_wasm_ld_rejects() {
    let sdk = fake_sdk();

    let stdout = stdout_string(
        Command::new(bin())
            .env("WASI_SDK_PATH", sdk.path())
            .arg("--dry-run")
            .arg("foo.o")
            .arg("-Wl,--start-group")
            .arg("-Wl,--warn-common,-Map,foo.map,--verbose")
            .arg("-Wl,--sort-common")
            .arg("-Wl,--sort-section,alignment")
            .arg("-Wl,--end-group")
            .arg("-o")
            .arg("foo.wasm")
            .output()
            .unwrap(),
    );

    assert!(stdout.contains("foo.o"), "{stdout}");
    assert!(stdout.contains("-o foo.wasm"), "{stdout}");
    assert!(stdout.contains("-Wl,-Map,foo.map,--verbose"), "{stdout}");
    assert!(!stdout.contains("--start-group"), "{stdout}");
    assert!(!stdout.contains("--end-group"), "{stdout}");
    assert!(!stdout.contains("--warn-common"), "{stdout}");
    assert!(!stdout.contains("--sort-common"), "{stdout}");
    assert!(!stdout.contains("--sort-section"), "{stdout}");
}

#[test]
fn dry_run_discovers_default_yurt_include_after_user_includes() {
    let sdk = fake_sdk();

    let stdout = stdout_string(
        Command::new(bin())
            .env("WASI_SDK_PATH", sdk.path())
            .env_remove("YURT_CC_INCLUDE")
            .arg("--dry-run")
            .arg("-c")
            .arg("-I")
            .arg("package/include")
            .arg("foo.c")
            .output()
            .unwrap(),
    );

    let user_idx = stdout.find("-I package/include").unwrap();
    let expected_include = expected_repo_yurt_include();
    let yurt_idx = stdout
        .find("yurt-include")
        .or_else(|| stdout.find(&expected_include))
        .unwrap_or_else(|| panic!("missing default Yurt include {expected_include}: {stdout}"));
    assert!(user_idx < yurt_idx, "{stdout}");
    assert!(stdout.contains("--sysroot="), "{stdout}");
}

#[test]
fn dry_run_injects_archive_and_preserves_include_order() {
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
        .arg("-I")
        .arg("package/include")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("-I package/include"), "{stdout}");
    assert!(stdout.contains("-I /fake/include"), "{stdout}");
    assert!(
        stdout.find("-I package/include").unwrap() < stdout.find("-I /fake/include").unwrap(),
        "user include must precede explicit Yurt include: {stdout}",
    );
    assert!(stdout.contains("--sysroot="), "{stdout}");
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
        .env(
            "YURT_CC_CONTINUATION_ARCHIVE",
            "/fake/libyurt_continuation.a",
        )
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
    assert!(stderr.contains("yurt_abi_version"), "stderr: {stderr}");
}

#[test]
fn compile_only_skips_archive_validation_even_when_archive_is_invalid() {
    let sdk = fake_sdk();

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", sdk.path())
        .env("YURT_CC_ARCHIVE", sdk.path().join("missing-libyurt_abi.a"))
        .arg("-c")
        .arg("foo.c")
        .output()
        .unwrap();

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(!stdout.contains("missing-libyurt_abi.a"), "{stdout}");
    assert!(!stdout.contains("--whole-archive"), "{stdout}");
}

#[test]
fn preprocess_only_skips_archive_validation_even_when_archive_is_invalid() {
    let sdk = fake_sdk();

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", sdk.path())
        .env("YURT_CC_ARCHIVE", sdk.path().join("missing-libyurt_abi.a"))
        .arg("-E")
        .arg("foo.c")
        .output()
        .unwrap();

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(!stdout.contains("missing-libyurt_abi.a"), "{stdout}");
    assert!(!stdout.contains("--whole-archive"), "{stdout}");
}

#[test]
fn clang_query_invocations_skip_archive_validation_even_when_archive_is_invalid() {
    let sdk = fake_sdk();

    for arg in ["-print-search-dirs", "-v"] {
        let out = Command::new(bin())
            .env("WASI_SDK_PATH", sdk.path())
            .env("YURT_CC_ARCHIVE", sdk.path().join("missing-libyurt_abi.a"))
            .arg(arg)
            .output()
            .unwrap();

        assert!(
            out.status.success(),
            "{arg} stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
fn link_shaped_probe_can_disable_yurt_link_injection() {
    let sdk = fake_sdk();

    let without_opt_out = Command::new(bin())
        .env("WASI_SDK_PATH", sdk.path())
        .env("YURT_CC_ARCHIVE", sdk.path().join("missing-libyurt_abi.a"))
        .arg("probe.c")
        .arg("-o")
        .arg("probe")
        .output()
        .unwrap();
    assert!(
        !without_opt_out.status.success(),
        "expected invalid archive failure"
    );
    let stderr = String::from_utf8_lossy(&without_opt_out.stderr);
    assert!(
        stderr.contains("version check") || stderr.contains("missing-libyurt_abi"),
        "{stderr}"
    );

    let with_opt_out = Command::new(bin())
        .env("WASI_SDK_PATH", sdk.path())
        .env("YURT_CC_ARCHIVE", sdk.path().join("missing-libyurt_abi.a"))
        .env("YURT_CC_NO_LINK_INJECTION", "1")
        .arg("probe.c")
        .arg("-o")
        .arg("probe")
        .output()
        .unwrap();
    assert!(
        with_opt_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&with_opt_out.stderr)
    );
}

#[ignore = "slow: invokes real clang via yurt-cc to compile a C file"]
#[test]
fn standard_headers_expose_yurt_compat_declarations() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skipping - WASI_SDK_PATH not set");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("headers.c");
    fs::write(
        &src,
        br#"
#include <stdio.h>
#include <time.h>
int main(void) {
    FILE *f = stdout;
    clock_t c = 0;
    tzset();
    flockfile(f);
    funlockfile(f);
    return f == 0 || c != 0;
}
"#,
    )
    .unwrap();
    let obj = tmp.path().join("headers.o");

    let st = Command::new(bin())
        .arg("-c")
        .arg(&src)
        .arg("-o")
        .arg(&obj)
        .status()
        .unwrap();
    assert!(st.success());
    assert!(obj.exists());
}

#[ignore = "slow: invokes real clang via yurt-cc to compile C fixtures"]
#[test]
fn zstd_like_shim_include_order_composes_with_yurt_headers() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skipping - WASI_SDK_PATH not set");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let shim = tmp.path().join("wasm-shim");
    fs::create_dir_all(&shim).unwrap();
    fs::write(
        shim.join("time.h"),
        b"#ifndef ZSTD_WASM_SHIM_TIME_H\n#define ZSTD_WASM_SHIM_TIME_H\n#include_next <time.h>\n#endif\n",
    )
    .unwrap();
    let src = tmp.path().join("shim.c");
    fs::write(
        &src,
        br#"
#include <time.h>
#include <stdio.h>
int main(void) {
    clock_t c = 0;
    FILE *f = stdout;
    tzset();
    return f == 0 || c != 0;
}
"#,
    )
    .unwrap();
    let obj = tmp.path().join("shim.o");

    let st = Command::new(bin())
        .env_remove("YURT_CC_INCLUDE")
        .arg("-c")
        .arg("-I")
        .arg(&shim)
        .arg(&src)
        .arg("-o")
        .arg(&obj)
        .status()
        .unwrap();
    assert!(st.success());
}

#[ignore = "slow: invokes real clang via yurt-cc to compile a C file"]
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
