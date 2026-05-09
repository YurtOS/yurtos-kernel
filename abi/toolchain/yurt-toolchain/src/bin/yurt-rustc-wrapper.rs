use anyhow::{anyhow, Context, Result};
use std::ffi::OsString;
use std::process::{Command, ExitCode};

fn main() -> Result<ExitCode> {
    let mut argv = std::env::args_os().skip(1);
    let rustc = argv
        .next()
        .ok_or_else(|| anyhow!("yurt-rustc-wrapper: missing rustc path"))?;
    let args: Vec<OsString> = argv.collect();
    let crate_name = yurt_toolchain::rustc_wrapper::crate_name(&args);
    let args = yurt_toolchain::rustc_wrapper::filter_args(crate_name.as_deref(), args);

    let inner = std::env::var_os("YURT_RUSTC_WRAPPER_INNER");
    let mut cmd = match inner {
        Some(wrapper) if !wrapper.is_empty() => {
            let mut cmd = Command::new(wrapper);
            cmd.arg(rustc);
            cmd
        }
        _ => Command::new(rustc),
    };
    cmd.args(args);

    let status = cmd.status().context("spawning rustc")?;
    Ok(status
        .code()
        .map(|c| ExitCode::from(c as u8))
        .unwrap_or(ExitCode::FAILURE))
}
