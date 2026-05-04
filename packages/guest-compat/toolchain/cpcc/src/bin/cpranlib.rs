use anyhow::{Context, Result};
use cpcc_toolchain::wasi_sdk;
use std::process::{Command, ExitCode};

fn main() -> Result<ExitCode> {
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ranlib = sdk.ranlib();
    let status = Command::new(&ranlib)
        .args(&args)
        .status()
        .with_context(|| format!("spawning {}", ranlib.display()))?;
    Ok(status
        .code()
        .map(|c| ExitCode::from(c as u8))
        .unwrap_or(ExitCode::FAILURE))
}
