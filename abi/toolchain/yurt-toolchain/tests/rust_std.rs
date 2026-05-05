use yurt_toolchain::rust_std::{
    discover_built_std, discover_installed_std, discover_repo_std_from_cwd,
    package_metadata_opt_in, rustc_version_key,
};

#[test]
fn rustc_version_key_extracts_semver_prefix() {
    assert_eq!(
        rustc_version_key("rustc 1.93.0 (abcdef 2026-01-01)").as_deref(),
        Some("1.93.0")
    );
    assert_eq!(
        rustc_version_key("rustc 1.95.0-beta.1 (abcdef 2026-01-01)").as_deref(),
        Some("1.95.0")
    );
}

#[test]
fn discover_built_std_requires_target_libdir() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(discover_built_std(tmp.path(), "1.93.0").is_none());

    let lib = tmp
        .path()
        .join("abi/build/rust-std/1.93.0/lib/rustlib/wasm32-wasip1/lib");
    std::fs::create_dir_all(&lib).unwrap();

    let found = discover_built_std(tmp.path(), "1.93.0").unwrap();
    assert_eq!(
        found,
        tmp.path()
            .join("abi/build/rust-std/1.93.0")
    );
}

#[test]
fn discover_installed_std_uses_yurt_home_layout() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(discover_installed_std(tmp.path(), "1.93.0").is_none());

    let lib = tmp
        .path()
        .join("rust-std/1.93.0/lib/rustlib/wasm32-wasip1/lib");
    std::fs::create_dir_all(&lib).unwrap();

    let found = discover_installed_std(tmp.path(), "1.93.0").unwrap();
    assert_eq!(found, tmp.path().join("rust-std/1.93.0"));
}

#[test]
fn discover_repo_std_from_cwd_walks_up_to_repo_root() {
    let tmp = tempfile::tempdir().unwrap();
    let nested = tmp.path().join("a/b/c");
    let lib = tmp
        .path()
        .join("abi/build/rust-std/1.93.0/lib/rustlib/wasm32-wasip1/lib");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir_all(&lib).unwrap();

    let prev = std::env::current_dir().unwrap();
    std::env::set_current_dir(&nested).unwrap();
    let found = discover_repo_std_from_cwd("1.93.0");
    std::env::set_current_dir(prev).unwrap();

    assert_eq!(
        found.map(|p| p.canonicalize().unwrap()),
        Some(
            tmp.path()
                .join("abi/build/rust-std/1.93.0")
                .canonicalize()
                .unwrap()
        )
    );
}

#[test]
fn package_metadata_yurt_opt_in_is_detected() {
    let tmp = tempfile::tempdir().unwrap();
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

    assert!(package_metadata_opt_in(&manifest).unwrap());
}
