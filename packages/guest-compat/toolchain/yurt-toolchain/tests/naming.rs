use std::fs;
use std::path::Path;

#[test]
fn public_toolchain_names_are_yurt_names() {
    let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let manifest = fs::read_to_string(manifest_path).expect("read toolchain Cargo.toml");

    assert!(
        manifest.contains("name = \"yurt-toolchain\""),
        "toolchain package should use the yurt-toolchain package name",
    );

    for legacy in ["cpcc", "cpar", "cpranlib", "cpcheck", "cpconf"] {
        assert!(
            !manifest.contains(&format!("name = \"{legacy}\"")),
            "legacy public binary name {legacy} should not be declared",
        );
    }
}
