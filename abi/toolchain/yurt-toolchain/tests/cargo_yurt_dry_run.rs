use std::path::PathBuf;
use std::sync::Mutex;
use yurt_toolchain::cargo_yurt::{
    plan_invocation, plan_invocation_with_sdk, profile_from_args, Subcommand,
};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn with_yurt_std<T>(f: impl FnOnce() -> T) -> T {
    let prev = std::env::var_os("YURT_RUST_STD");
    std::env::set_var("YURT_RUST_STD", "/tmp/yurt-rust-std");
    let result = f();
    match prev {
        Some(v) => std::env::set_var("YURT_RUST_STD", v),
        None => std::env::remove_var("YURT_RUST_STD"),
    }
    result
}

#[test]
fn build_subcommand_uses_wasm32_wasip1_target() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation(Subcommand::Build, &["--release".into()])).unwrap();
    assert!(plan.cargo_args.iter().any(|a| a == "build"));
    assert!(plan
        .cargo_args
        .iter()
        .any(|a| a == "--target=wasm32-wasip1"));
    assert!(plan.cargo_args.iter().any(|a| a == "--release"));
}

#[test]
fn test_subcommand_uses_wasm32_wasip1_target() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation(Subcommand::Test, &[])).unwrap();
    assert!(plan.cargo_args.iter().any(|a| a == "test"));
    assert!(plan
        .cargo_args
        .iter()
        .any(|a| a == "--target=wasm32-wasip1"));
}

#[test]
fn run_subcommand_uses_wasm32_wasip1_target() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation(Subcommand::Run, &["--bin".into(), "foo".into()]))
        .unwrap();
    assert!(plan.cargo_args.iter().any(|a| a == "run"));
    assert!(plan
        .cargo_args
        .iter()
        .any(|a| a == "--target=wasm32-wasip1"));
    assert!(plan.cargo_args.iter().any(|a| a == "--bin"));
    assert!(plan.cargo_args.iter().any(|a| a == "foo"));
}

#[test]
fn injected_env_includes_yurt_link_injected() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation(Subcommand::Build, &[])).unwrap();
    assert_eq!(
        plan.env
            .iter()
            .find(|(k, _)| k == "YURT_LINK_INJECTED")
            .map(|(_, v)| v.as_str()),
        Some("1"),
    );
}

#[test]
fn cargo_yurt_disables_yurt_cc_link_injection_for_build_script_probes() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation(Subcommand::Build, &[])).unwrap();
    assert_eq!(
        plan.env
            .iter()
            .find(|(k, _)| k == "YURT_CC_NO_LINK_INJECTION")
            .map(|(_, v)| v.as_str()),
        Some("1"),
    );
}

#[test]
fn cargo_yurt_installs_rustc_wrapper() {
    let _guard = ENV_LOCK.lock().unwrap();
    let prev = std::env::var_os("RUSTC_WRAPPER");
    std::env::remove_var("RUSTC_WRAPPER");
    let plan = with_yurt_std(|| plan_invocation(Subcommand::Build, &[])).unwrap();
    match prev {
        Some(v) => std::env::set_var("RUSTC_WRAPPER", v),
        None => std::env::remove_var("RUSTC_WRAPPER"),
    }

    let wrapper = plan
        .env
        .iter()
        .find(|(k, _)| k == "RUSTC_WRAPPER")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    assert!(
        wrapper.ends_with("yurt-rustc-wrapper"),
        "wrapper: {wrapper}"
    );
}

#[test]
fn cargo_yurt_patches_yurt_compat_crates_when_available() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation(Subcommand::Build, &[])).unwrap();
    let configs: Vec<&str> = plan
        .cargo_args
        .windows(2)
        .filter(|pair| pair[0] == "--config")
        .map(|pair| pair[1].as_str())
        .collect();
    assert!(
        configs
            .iter()
            .any(|config| config.contains("patch.crates-io.fs2.path")),
        "cargo args: {:?}",
        plan.cargo_args
    );
    assert!(
        configs
            .iter()
            .any(|config| config.contains("patch.crates-io.libc.path")),
        "cargo args: {:?}",
        plan.cargo_args
    );
}

#[test]
fn cargo_yurt_chains_existing_rustc_wrapper() {
    let _guard = ENV_LOCK.lock().unwrap();
    let prev = std::env::var_os("RUSTC_WRAPPER");
    std::env::set_var("RUSTC_WRAPPER", "/tools/sccache");
    let plan = with_yurt_std(|| plan_invocation(Subcommand::Build, &[])).unwrap();
    match prev {
        Some(v) => std::env::set_var("RUSTC_WRAPPER", v),
        None => std::env::remove_var("RUSTC_WRAPPER"),
    }

    let inner = plan
        .env
        .iter()
        .find(|(k, _)| k == "YURT_RUSTC_WRAPPER_INNER")
        .map(|(_, v)| v.as_str());
    assert_eq!(inner, Some("/tools/sccache"));
}

#[test]
fn dry_run_sets_yurt_std_flags_without_archive_link_flags() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation(Subcommand::Build, &[])).unwrap();
    let rustflags = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    assert!(
        rustflags.contains("--sysroot=/tmp/yurt-rust-std"),
        "flags: {rustflags}"
    );
    assert!(rustflags.contains("--cfg yurt"), "flags: {rustflags}");
    assert!(rustflags.contains("--cfg unix"), "flags: {rustflags}");
    assert!(
        !rustflags.contains("--whole-archive"),
        "archive link flags should not be injected when archive is unset: {rustflags}"
    );
}

#[test]
fn linker_injected_when_clang_supplied() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| {
        plan_invocation_with_sdk(
            Subcommand::Build,
            &[],
            Some(&PathBuf::from("/wasi-sdk/bin/clang")),
        )
    })
    .unwrap();
    let linker = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_LINKER")
        .map(|(_, v)| v.as_str());
    assert_eq!(linker, Some("/wasi-sdk/bin/clang"));
}

#[test]
fn linker_omitted_when_clang_missing() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation_with_sdk(Subcommand::Build, &[], None)).unwrap();
    let linker = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_LINKER");
    assert!(linker.is_none());
}

#[test]
fn profile_release_when_release_flag_present() {
    assert_eq!(profile_from_args(&["--release".into()]), "release");
}

#[test]
fn profile_debug_when_release_flag_absent() {
    assert_eq!(profile_from_args(&[]), "debug");
}

#[test]
fn clang_linker_omitted_when_yurt_cc_no_clang_linker_set() {
    let _guard = ENV_LOCK.lock().unwrap();
    // Save and restore to avoid cross-test contamination.
    let prev = std::env::var_os("YURT_CC_NO_CLANG_LINKER");
    std::env::set_var("YURT_CC_NO_CLANG_LINKER", "1");
    let plan = with_yurt_std(|| {
        plan_invocation_with_sdk(
            Subcommand::Build,
            &[],
            Some(&PathBuf::from("/wasi-sdk/bin/clang")),
        )
    })
    .unwrap();
    match prev {
        Some(v) => std::env::set_var("YURT_CC_NO_CLANG_LINKER", v),
        None => std::env::remove_var("YURT_CC_NO_CLANG_LINKER"),
    }
    let linker = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_LINKER");
    assert!(
        linker.is_none(),
        "YURT_CC_NO_CLANG_LINKER=1 should skip linker injection even when clang is supplied"
    );
}

#[test]
fn built_std_env_is_composed_into_target_rustflags() {
    let _guard = ENV_LOCK.lock().unwrap();
    let prev = std::env::var_os("YURT_RUST_STD");
    std::env::set_var("YURT_RUST_STD", "/tmp/yurt-rust-std");

    let plan = plan_invocation(Subcommand::Build, &[]).unwrap();

    match prev {
        Some(v) => std::env::set_var("YURT_RUST_STD", v),
        None => std::env::remove_var("YURT_RUST_STD"),
    }

    let flags = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    assert!(
        flags.contains("--sysroot=/tmp/yurt-rust-std"),
        "flags: {flags}"
    );
    assert!(flags.contains("--cfg yurt"), "flags: {flags}");
    assert!(flags.contains("--cfg unix"), "flags: {flags}");
}

#[test]
fn yurt_home_std_is_composed_when_manifest_opts_in() {
    let _guard = ENV_LOCK.lock().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let yurt_home = tmp.path().join("home");
    let std_lib = yurt_home.join("rust-std/1.93.0/lib/rustlib/wasm32-wasip1/lib");
    std::fs::create_dir_all(&std_lib).unwrap();
    let manifest = tmp.path().join("Cargo.toml");
    std::fs::write(
        &manifest,
        r#"
[package]
name = "demo"
version = "0.1.0"
edition = "2021"

[package.metadata.yurt]
target = "wasm32-wasip1"
rust_std = "auto"
"#,
    )
    .unwrap();

    let prev_home = std::env::var_os("YURT_HOME");
    let prev_std = std::env::var_os("YURT_RUST_STD");
    let prev_rustc = std::env::var_os("YURT_RUSTC_VERSION");
    let prev_cwd = std::env::current_dir().unwrap();
    std::env::set_current_dir(tmp.path()).unwrap();
    std::env::set_var("YURT_HOME", &yurt_home);
    std::env::remove_var("YURT_RUST_STD");
    std::env::set_var("YURT_RUSTC_VERSION", "rustc 1.93.0 (abcdef 2026-01-01)");

    let plan = plan_invocation(
        Subcommand::Build,
        &["--manifest-path".into(), manifest.display().to_string()],
    )
    .unwrap();

    std::env::set_current_dir(prev_cwd).unwrap();
    match prev_home {
        Some(v) => std::env::set_var("YURT_HOME", v),
        None => std::env::remove_var("YURT_HOME"),
    }
    match prev_std {
        Some(v) => std::env::set_var("YURT_RUST_STD", v),
        None => std::env::remove_var("YURT_RUST_STD"),
    }
    match prev_rustc {
        Some(v) => std::env::set_var("YURT_RUSTC_VERSION", v),
        None => std::env::remove_var("YURT_RUSTC_VERSION"),
    }

    let flags = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    assert!(
        flags.contains(&format!(
            "--sysroot={}",
            yurt_home.join("rust-std/1.93.0").display()
        )),
        "flags: {flags}"
    );
}

#[test]
fn repo_local_std_is_composed_when_manifest_opts_in() {
    let _guard = ENV_LOCK.lock().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let nested = repo.join("nested/project");
    let std_lib = repo.join("abi/build/rust-std/1.93.0/lib/rustlib/wasm32-wasip1/lib");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir_all(&std_lib).unwrap();
    let manifest = nested.join("Cargo.toml");
    std::fs::write(
        &manifest,
        r#"
[package]
name = "demo"
version = "0.1.0"
edition = "2021"

[package.metadata.yurt]
target = "wasm32-wasip1"
rust_std = "auto"
"#,
    )
    .unwrap();

    let prev_cwd = std::env::current_dir().unwrap();
    let prev_home = std::env::var_os("YURT_HOME");
    let prev_root = std::env::var_os("YURT_ROOT");
    let prev_std = std::env::var_os("YURT_RUST_STD");
    let prev_rustc = std::env::var_os("YURT_RUSTC_VERSION");
    std::env::set_current_dir(&nested).unwrap();
    std::env::remove_var("YURT_HOME");
    std::env::remove_var("YURT_ROOT");
    std::env::remove_var("YURT_RUST_STD");
    std::env::set_var("YURT_RUSTC_VERSION", "rustc 1.93.0 (abcdef 2026-01-01)");

    let plan = plan_invocation(
        Subcommand::Build,
        &["--manifest-path".into(), manifest.display().to_string()],
    )
    .unwrap();

    std::env::set_current_dir(prev_cwd).unwrap();
    match prev_home {
        Some(v) => std::env::set_var("YURT_HOME", v),
        None => std::env::remove_var("YURT_HOME"),
    }
    match prev_root {
        Some(v) => std::env::set_var("YURT_ROOT", v),
        None => std::env::remove_var("YURT_ROOT"),
    }
    match prev_std {
        Some(v) => std::env::set_var("YURT_RUST_STD", v),
        None => std::env::remove_var("YURT_RUST_STD"),
    }
    match prev_rustc {
        Some(v) => std::env::set_var("YURT_RUSTC_VERSION", v),
        None => std::env::remove_var("YURT_RUSTC_VERSION"),
    }

    let flags = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    assert!(
        flags.contains(&format!(
            "--sysroot={}",
            repo.join("abi/build/rust-std/1.93.0")
                .canonicalize()
                .unwrap()
                .display()
        )),
        "flags: {flags}"
    );
}
