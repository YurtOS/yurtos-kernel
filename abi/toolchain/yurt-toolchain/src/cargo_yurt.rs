//! `cargo-yurt` cargo subcommand (§Toolchain Integration > Rust Toolchain).
//! Wraps real `cargo` with the wasm32-wasip1 target, the wasi-sdk linker,
//! the compat-archive RUSTFLAGS framing, the `YURT_LINK_INJECTED=1`
//! handshake with the optional `-sys` crate, version checking, pre-opt wasm
//! preservation, and post-link `wasm-opt`.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Subcommand {
    Build,
    Test,
    Run,
    DownloadToolchain,
}

impl Subcommand {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "build" => Ok(Self::Build),
            "test" => Ok(Self::Test),
            "run" => Ok(Self::Run),
            "download-toolchain" => Ok(Self::DownloadToolchain),
            other => Err(anyhow!(
                "unknown cargo-yurt subcommand {other:?} (expected build/test/run/download-toolchain)"
            )),
        }
    }
    pub fn cargo_verb(self) -> Option<&'static str> {
        match self {
            Self::Build => Some("build"),
            Self::Test => Some("test"),
            Self::Run => Some("run"),
            Self::DownloadToolchain => None,
        }
    }
}

/// What the wrapper plans to do. `execute_plan` consumes this; tests inspect
/// it without spawning cargo.
#[derive(Debug, Default)]
pub struct InvocationPlan {
    pub cargo_args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Compute the cargo invocation for `sub` plus `forwarded` user args.
/// Reads YURT_CC_ARCHIVE / YURT_CC_INCLUDE / YURT_CC_PRESERVE_PRE_OPT etc. from the
/// process environment via the existing `crate::env::Env`. RUSTFLAGS is only
/// injected when an archive is present — bare `cargo yurt build` with no
/// archive surfaces "missing archive" instead of a confusing link error.
pub fn plan_invocation(sub: Subcommand, forwarded: &[String]) -> Result<InvocationPlan> {
    plan_invocation_with_sdk(sub, forwarded, None)
}

/// Variant that takes an explicit clang path. `None` skips linker injection.
pub fn plan_invocation_with_sdk(
    sub: Subcommand,
    forwarded: &[String],
    clang: Option<&Path>,
) -> Result<InvocationPlan> {
    let env = crate::env::Env::from_process();
    let mut plan = InvocationPlan::default();

    let verb = sub
        .cargo_verb()
        .ok_or_else(|| anyhow!("subcommand {sub:?} does not correspond to a cargo verb"))?;
    for (name, path) in discover_yurt_crate_ports()? {
        plan.cargo_args.push("--config".to_string());
        plan.cargo_args.push(format!(
            "patch.crates-io.{name}.path=\"{}\"",
            path.display()
        ));
    }
    plan.cargo_args.push(verb.to_string());
    plan.cargo_args.push("--target=wasm32-wasip1".to_string());
    for arg in forwarded {
        plan.cargo_args.push(arg.clone());
    }

    plan.env
        .push(("YURT_LINK_INJECTED".to_string(), "1".to_string()));
    // Cargo build scripts and cc-rs dependencies may run link-shaped compiler
    // probes. Those probes must behave like wasi-sdk clang and must not inspect
    // or inject the Yurt ABI archive.
    plan.env
        .push(("YURT_CC_NO_LINK_INJECTION".to_string(), "1".to_string()));
    if let Some(existing) = std::env::var_os("RUSTC_WRAPPER").filter(|v| !v.is_empty()) {
        plan.env.push((
            "YURT_RUSTC_WRAPPER_INNER".to_string(),
            PathBuf::from(existing).display().to_string(),
        ));
    }
    plan.env.push((
        "RUSTC_WRAPPER".to_string(),
        rustc_wrapper_path()?.display().to_string(),
    ));

    // YURT_CC_NO_CLANG_LINKER skips the wasi-sdk clang linker injection so rust's
    // default rust-lld handles the link. Needed for ports whose dep tree
    // includes cdylib targets with wasm-bindgen (e.g. grex's wasm browser
    // entry point) — wasi-sdk's lld rejects these because `_initialize`
    // isn't defined. --whole-archive + --export flags injected via RUSTFLAGS
    // work identically under rust-lld and wasi-sdk's lld, so precedence
    // semantics (§Override And Link Precedence) are preserved either way.
    let skip_clang_linker = std::env::var_os("YURT_CC_NO_CLANG_LINKER").is_some();
    if let Some(c) = clang {
        if !skip_clang_linker {
            plan.env.push((
                "CARGO_TARGET_WASM32_WASIP1_LINKER".to_string(),
                c.display().to_string(),
            ));
        }
    }

    let mut rustflags = std::env::var("CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS").unwrap_or_default();
    let std_root = crate::rust_std::resolve_std_for_invocation(forwarded)?;
    if !rustflags.is_empty() {
        rustflags.push(' ');
    }
    rustflags.push_str(&format!(
        "--sysroot={} -Aexplicit-builtin-cfgs-in-flags --cfg yurt --cfg unix",
        std_root.display()
    ));

    if let Some(archive) = &env.archive {
        // §Override And Link Precedence: --whole-archive bracket the compat
        // archive, then per-Tier-1-symbol --export framing so the
        // implementation-signature check can find the markers in the pre-opt
        // wasm.
        //
        // When wasi-sdk clang is the linker, flags must be wrapped with
        // `-Wl,` so clang passes them through to lld. When rust-lld is used
        // directly (YURT_CC_NO_CLANG_LINKER=1), the `-Wl,` prefix must be
        // omitted — rust-lld receives -C link-arg values verbatim and doesn't
        // understand `-Wl,` itself.
        let (wa_open, wa_close, linker_flag_prefix, export_flag_prefix) = if skip_clang_linker {
            ("--whole-archive", "--no-whole-archive", "", "--export=")
        } else {
            (
                "-Wl,--whole-archive",
                "-Wl,--no-whole-archive",
                "-Wl,",
                "-Wl,--export=",
            )
        };

        if !rustflags.is_empty() {
            rustflags.push(' ');
        }
        // Some POSIX names are already present as strong wasi-libc stubs.
        // libyurt.a is deliberately whole-archived before libc so the
        // yurt definitions are the ones exported; allow the intentional
        // duplicate definitions instead of making Rust FFI users fail to link.
        rustflags.push_str(&format!(
            "-C link-arg={linker_flag_prefix}--allow-multiple-definition "
        ));
        rustflags.push_str(&format!("-C link-arg={linker_flag_prefix}--export-table "));
        rustflags.push_str(&format!(
            "-C link-arg={linker_flag_prefix}--growable-table "
        ));
        for sym in crate::WRAPPED_WASI_LIBC_SYMBOLS {
            rustflags.push_str(&format!("-C link-arg={linker_flag_prefix}--wrap={sym} "));
        }
        rustflags.push_str(&format!("-C link-arg={wa_open} "));
        rustflags.push_str(&format!("-C link-arg={} ", archive.display()));
        rustflags.push_str(&format!("-C link-arg={wa_close} "));
        for sym in crate::TIER1 {
            rustflags.push_str(&format!("-C link-arg={export_flag_prefix}{sym} "));
            rustflags.push_str(&format!(
                "-C link-arg={export_flag_prefix}__yurt_abi_marker_{sym} "
            ));
        }
    }

    if !rustflags.is_empty() {
        plan.env.push((
            "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS".to_string(),
            rustflags.trim_end().to_string(),
        ));
    }

    Ok(plan)
}

pub fn rustc_wrapper_path() -> Result<PathBuf> {
    let mut path = std::env::current_exe().context("locating current executable")?;
    path.set_file_name("yurt-rustc-wrapper");
    Ok(path)
}

pub fn discover_yurt_crate_ports() -> Result<Vec<(String, PathBuf)>> {
    let Some(root) = discover_yurt_crate_ports_root()? else {
        return Ok(Vec::new());
    };

    let mut ports = Vec::new();
    for entry in std::fs::read_dir(&root)
        .with_context(|| format!("reading Yurt crate ports from {}", root.display()))?
    {
        let entry = entry
            .with_context(|| format!("reading Yurt crate port entry in {}", root.display()))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("Cargo.toml");
        if !manifest.is_file() {
            continue;
        }
        let package_name = cargo_manifest_package_name(&manifest)?;
        ports.push((package_name, path));
    }

    ports.sort_by(|(left_name, left_path), (right_name, right_path)| {
        left_name
            .cmp(right_name)
            .then_with(|| left_path.cmp(right_path))
    });
    Ok(ports)
}

fn discover_yurt_crate_ports_root() -> Result<Option<PathBuf>> {
    if let Some(explicit) = std::env::var_os("YURT_RUST_CRATE_PORTS").filter(|v| !v.is_empty()) {
        let path = PathBuf::from(explicit);
        if path.is_dir() {
            return Ok(Some(path));
        }
        return Err(anyhow!(
            "YURT_RUST_CRATE_PORTS does not name a directory: {}",
            path.display()
        ));
    }

    let relative_path = "abi/rust/crate-ports";
    if let Some(root) = std::env::var_os("YURT_ROOT").filter(|v| !v.is_empty()) {
        let path = PathBuf::from(root).join(relative_path);
        if path.is_dir() {
            return Ok(Some(path));
        }
    }

    let exe = std::env::current_exe().context("locating current executable")?;
    for ancestor in exe.ancestors() {
        let path = ancestor.join(relative_path);
        if path.is_dir() {
            return Ok(Some(path));
        }
    }

    let mut dir = std::env::current_dir().context("locating current directory")?;
    loop {
        let path = dir.join(relative_path);
        if path.is_dir() {
            return Ok(Some(path));
        }
        if !dir.pop() {
            break;
        }
    }

    Ok(None)
}

fn cargo_manifest_package_name(manifest: &Path) -> Result<String> {
    let contents = std::fs::read_to_string(manifest)
        .with_context(|| format!("reading Yurt crate port manifest {}", manifest.display()))?;
    let manifest_value = contents
        .parse::<toml::Value>()
        .with_context(|| format!("parsing Yurt crate port manifest {}", manifest.display()))?;
    manifest_value
        .get("package")
        .and_then(|package| package.get("name"))
        .and_then(|name| name.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow!(
                "Yurt crate port manifest lacks package.name: {}",
                manifest.display()
            )
        })
}

/// Locate every top-level .wasm artifact under `target/wasm32-wasip1/<profile>/`.
/// Excludes `deps/` (intermediates) and `examples/` (not the user's bin).
/// Returns sorted paths so behavior is deterministic across runs.
pub fn locate_outputs(target_dir: &Path, profile: &str) -> Vec<PathBuf> {
    let dir = target_dir.join("wasm32-wasip1").join(profile);
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("wasm") && path.is_file() {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// Profile derived from the forwarded args (`--release` ⇒ "release",
/// otherwise "debug"). `cargo test` overrides this — those binaries land
/// under target/wasm32-wasip1/debug/deps and we don't preserve them.
pub fn profile_from_args(forwarded: &[String]) -> &'static str {
    if forwarded.iter().any(|a| a == "--release") {
        "release"
    } else {
        "debug"
    }
}

/// Phase A `download-toolchain`: ensures `wasm32-wasip1` is available via
/// rustup. Returns Ok with a status message; exits 0 on success even if
/// the target was already installed. §Phase B will replace this with a
/// yurt toolchain distribution download.
pub fn download_toolchain() -> Result<String> {
    // `rustup target list --installed` lists targets with no extra noise.
    let listing = Command::new("rustup")
        .args(["target", "list", "--installed"])
        .output()
        .map_err(|e| anyhow!("rustup not available: {e}"))?;
    if !listing.status.success() {
        return Err(anyhow!(
            "rustup target list failed: {}",
            String::from_utf8_lossy(&listing.stderr)
        ));
    }
    let installed = String::from_utf8_lossy(&listing.stdout);
    if installed.lines().any(|l| l.trim() == "wasm32-wasip1") {
        return Ok("wasm32-wasip1 is already installed".into());
    }
    let install = Command::new("rustup")
        .args(["target", "add", "wasm32-wasip1"])
        .status()
        .map_err(|e| anyhow!("rustup target add failed to spawn: {e}"))?;
    if !install.success() {
        return Err(anyhow!("rustup target add wasm32-wasip1 failed"));
    }
    Ok("installed wasm32-wasip1 via rustup".into())
}
