use anyhow::{Context, Result};
use cpcc_toolchain::wasi_sdk;
use std::process::{Command, ExitCode};

// Flags that are compiler-driver conventions but have no meaning for wasm-ld.
const STRIP_FLAGS: &[&str] = &["-nostdlib", "-nostartfiles", "-nodefaultlibs"];

fn main() -> Result<ExitCode> {
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !STRIP_FLAGS.contains(&a.as_str()))
        .collect();
    let wasm_ld = sdk.wasm_ld();
    let status = Command::new(&wasm_ld)
        .args(&args)
        .status()
        .with_context(|| format!("spawning {}", wasm_ld.display()))?;
    Ok(status
        .code()
        .map(|c| ExitCode::from(c as u8))
        .unwrap_or(ExitCode::FAILURE))
}
