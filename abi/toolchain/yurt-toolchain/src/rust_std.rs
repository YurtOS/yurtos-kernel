use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub fn rustc_version_key(version_output: &str) -> Option<String> {
    let version = version_output.split_whitespace().nth(1)?;
    let mut parts = version.split('.');
    Some(format!(
        "{}.{}.{}",
        parts.next()?,
        parts.next()?,
        parts.next()?.split('-').next().unwrap_or("")
    ))
}

pub fn discover_built_std(repo_root: &Path, rust_key: &str) -> Option<PathBuf> {
    let root = repo_root.join("abi/build/rust-std").join(rust_key);
    let lib = root.join("lib/rustlib/wasm32-wasip1/lib");
    if lib.is_dir() {
        Some(root)
    } else {
        None
    }
}

pub fn discover_installed_std(yurt_home: &Path, rust_key: &str) -> Option<PathBuf> {
    let root = yurt_home.join("rust-std").join(rust_key);
    let lib = root.join("lib/rustlib/wasm32-wasip1/lib");
    if lib.is_dir() {
        Some(root)
    } else {
        None
    }
}

pub fn discover_repo_std_from_cwd(rust_key: &str) -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if let Some(found) = discover_built_std(&dir, rust_key) {
            return Some(found);
        }
        if !dir.pop() {
            return None;
        }
    }
}

pub fn manifest_path_from_args(forwarded: &[String]) -> PathBuf {
    let mut iter = forwarded.iter();
    while let Some(arg) = iter.next() {
        if arg == "--manifest-path" {
            if let Some(path) = iter.next() {
                return PathBuf::from(path);
            }
        } else if let Some(path) = arg.strip_prefix("--manifest-path=") {
            return PathBuf::from(path);
        }
    }
    PathBuf::from("Cargo.toml")
}

pub fn package_metadata_opt_in(manifest_path: &Path) -> Result<bool> {
    if !manifest_path.is_file() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(manifest_path)?;
    let parsed: Manifest = toml::from_str(&raw)?;
    Ok(parsed
        .package
        .and_then(|p| p.metadata)
        .and_then(|m| m.yurt)
        .is_some())
}

pub fn resolve_std_for_invocation(_forwarded: &[String]) -> Result<PathBuf> {
    if let Some(explicit) = std::env::var_os("YURT_RUST_STD").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(explicit));
    }

    let rust_version_output = if let Some(v) = std::env::var_os("YURT_RUSTC_VERSION") {
        v.to_string_lossy().into_owned()
    } else {
        let output = std::process::Command::new("rustc")
            .arg("--version")
            .output()
            .map_err(|e| anyhow!("failed to run rustc --version: {e}"))?;
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    let Some(rust_key) = rustc_version_key(&rust_version_output) else {
        return Err(anyhow!(
            "could not parse rustc version from {rust_version_output:?}"
        ));
    };

    if let Some(root) = std::env::var_os("YURT_ROOT").filter(|v| !v.is_empty()) {
        if let Some(found) = discover_built_std(&PathBuf::from(root), &rust_key) {
            return Ok(found);
        }
    }

    if let Some(found) = discover_repo_std_from_cwd(&rust_key) {
        return Ok(found);
    }

    let home = std::env::var_os("YURT_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(default_yurt_home);
    if let Some(home) = home {
        if let Some(found) = discover_installed_std(&home, &rust_key) {
            return Ok(found);
        }
    }

    Err(anyhow!(
        "missing Yurt Rust std for {rust_key}; set YURT_RUST_STD, build it under YURT_ROOT, or install it under YURT_HOME"
    ))
}

fn default_yurt_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .map(|home| home.join(".yurt"))
}

#[derive(Deserialize)]
struct Manifest {
    package: Option<Package>,
}

#[derive(Deserialize)]
struct Package {
    metadata: Option<PackageMetadata>,
}

#[derive(Deserialize)]
struct PackageMetadata {
    yurt: Option<toml::Value>,
}
