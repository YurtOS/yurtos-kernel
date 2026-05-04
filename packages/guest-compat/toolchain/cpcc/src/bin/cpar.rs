use anyhow::{Context, Result};
use cpcc_toolchain::wasi_sdk;
use std::process::{Command, ExitCode};

fn main() -> Result<ExitCode> {
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ar = sdk.ar();
    let status = Command::new(&ar)
        .args(&args)
        .status()
        .with_context(|| format!("spawning {}", ar.display()))?;
    Ok(status
        .code()
        .map(|c| ExitCode::from(c as u8))
        .unwrap_or(ExitCode::FAILURE))
}
