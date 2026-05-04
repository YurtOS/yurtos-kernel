use anyhow::{Context, Result};
use cpcc_toolchain::maturin_yurt::plan_invocation;
use std::process::{Command, ExitCode};

fn main() -> Result<ExitCode> {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    let mut dry_run = false;
    argv.retain(|arg| {
        if arg == "--dry-run" {
            dry_run = true;
            false
        } else {
            true
        }
    });

    let plan = plan_invocation(&argv)?;

    if dry_run {
        for (k, v) in &plan.env {
            println!("{k}={v}");
        }
        print!("maturin");
        for arg in &plan.args {
            print!(" {arg}");
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    let mut cmd = Command::new("maturin");
    cmd.args(&plan.args);
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    let status = cmd.status().context("spawning maturin")?;
    Ok(status
        .code()
        .map(|c| ExitCode::from(c as u8))
        .unwrap_or(ExitCode::FAILURE))
}
