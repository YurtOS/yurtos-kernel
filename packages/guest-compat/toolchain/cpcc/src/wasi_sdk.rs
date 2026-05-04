use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

/// Locate a wasi-sdk installation. Mirrors the logic in
/// scripts/build-c-port.sh::find_wasi_sdk.
pub fn discover() -> Result<WasiSdk> {
    let candidates = candidate_roots();
    for root in candidates {
        if is_valid_root(&root) {
            return Ok(WasiSdk::new(root));
        }
    }
    Err(anyhow!(
        "wasi-sdk not found; set WASI_SDK_PATH to the installation root"
    ))
}

fn candidate_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(env) = std::env::var_os("WASI_SDK_PATH") {
        out.push(PathBuf::from(env));
    }
    if let Some(home) = dirs_home() {
        out.push(home.join(".local/share/wasi-sdk"));
        out.extend(glob_versioned(home.join(".local/share"), "wasi-sdk-"));
        out.push(home.join("wasi-sdk"));
        out.extend(glob_versioned(home.clone(), "wasi-sdk-"));
    }
    out.push(PathBuf::from("/opt/homebrew/opt/wasi-sdk/share/wasi-sdk"));
    out.push(PathBuf::from("/usr/local/opt/wasi-sdk/share/wasi-sdk"));
    out.push(PathBuf::from("/opt/wasi-sdk"));
    out.extend(glob_versioned(PathBuf::from("/opt"), "wasi-sdk-"));
    out.push(PathBuf::from("/usr/local/share/wasi-sdk"));
    out.extend(glob_versioned(
        PathBuf::from("/usr/local/share"),
        "wasi-sdk-",
    ));
    out
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn glob_versioned(parent: PathBuf, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(&parent) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .map(|e| e.path())
        .collect()
}

fn is_valid_root(path: &Path) -> bool {
    path.join("bin/clang").is_file() && path.join("share/wasi-sysroot").is_dir()
}

#[derive(Clone, Debug)]
pub struct WasiSdk {
    pub root: PathBuf,
}

impl WasiSdk {
    fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn clang(&self) -> PathBuf {
        self.root.join("bin/clang")
    }
    pub fn ar(&self) -> PathBuf {
        self.root.join("bin/llvm-ar")
    }
    pub fn ranlib(&self) -> PathBuf {
        self.root.join("bin/llvm-ranlib")
    }
    pub fn nm(&self) -> PathBuf {
        self.root.join("bin/llvm-nm")
    }
    pub fn sysroot(&self) -> PathBuf {
        self.root.join("share/wasi-sysroot")
    }
}
