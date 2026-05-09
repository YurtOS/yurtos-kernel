use std::path::PathBuf;

#[test]
fn guest_compat_builds_yurt_rust_std_before_cargo_yurt_smoke() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .expect("yurt-toolchain should live under abi/toolchain/yurt-toolchain")
        .to_path_buf();
    let workflow = std::fs::read_to_string(repo_root.join(".github/workflows/guest-compat.yml"))
        .expect("guest compat workflow should be readable");

    let build_std = workflow
        .find("scripts/build-rust-std.sh")
        .expect("guest compat workflow should build the Yurt Rust std");
    let cargo_yurt_smoke = workflow
        .find("target/release/cargo-yurt build --release -p zstd-sys-smoke")
        .expect("guest compat workflow should build zstd-sys-smoke through cargo-yurt");

    assert!(
        build_std < cargo_yurt_smoke,
        "cargo-yurt needs the Yurt Rust std sysroot before zstd-sys-smoke runs"
    );
}
