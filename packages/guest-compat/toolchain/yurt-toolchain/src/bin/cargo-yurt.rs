use anyhow::{anyhow, Context, Result};
use std::process::{Command, ExitCode};
use yurt_toolchain::cargo_yurt::{plan_invocation_with_sdk, Subcommand};
use yurt_toolchain::{archive, env as yurt_cc_env, wasi_sdk};

fn main() -> Result<ExitCode> {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(|s| s.as_str()) == Some("yurt") {
        argv.remove(0);
    }
    if argv.is_empty() {
        return Err(anyhow!(
            "cargo-yurt: expected a subcommand (build, test, run, download-toolchain)"
        ));
    }
    let sub_name = argv.remove(0);
    let sub = Subcommand::parse(&sub_name)?;

    if sub == Subcommand::DownloadToolchain {
        let msg = yurt_toolchain::cargo_yurt::download_toolchain()?;
        println!("cargo-yurt: {msg}");
        return Ok(ExitCode::SUCCESS);
    }

    let mut dry_run = false;
    argv.retain(|a| {
        if a == "--dry-run" {
            dry_run = true;
            false
        } else {
            true
        }
    });

    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let process_env = yurt_cc_env::Env::from_process();

    // §Versioning: the version check runs against the same llvm-nm the C
    // wrapper uses. It is presence-only at Step 1; future tightening to an
    // exact major/minor match is owned by archive::check_version.
    if let Some(archive_path) = &process_env.archive {
        if !process_env.skip_version_check {
            archive::check_version(&sdk.nm(), archive_path)
                .context("cargo-yurt: archive version check")?;
        }
    }

    let clang = sdk.clang();
    let plan = plan_invocation_with_sdk(sub, &argv, Some(&clang))?;

    if dry_run {
        for (k, v) in &plan.env {
            println!("{k}={v}");
        }
        print!("cargo");
        for a in &plan.cargo_args {
            print!(" {a}");
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    // Spawn real cargo with the planned args and env additions. Inherits
    // stdio so cargo's own progress shows through.
    let mut cmd = Command::new("cargo");
    cmd.args(&plan.cargo_args);
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    let status = cmd.status().context("spawning cargo")?;
    if !status.success() {
        return Ok(status
            .code()
            .map(|c| ExitCode::from(c as u8))
            .unwrap_or(ExitCode::FAILURE));
    }

    // §Verifying Precedence: preserve a pre-opt copy of every produced
    // .wasm so the signature check has an unoptimized artifact, then run
    // wasm-opt on the original.
    use yurt_toolchain::cargo_yurt::{locate_outputs, profile_from_args};
    use yurt_toolchain::{preserve, wasm_opt};

    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("target"));
    let profile = profile_from_args(&argv);
    let outputs = locate_outputs(&target_dir, profile);

    for out in &outputs {
        if let Some(preserve_path) = process_env.preserve_pre_opt.as_deref() {
            let stem = out.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
            // If the user pointed at an existing directory, or there are
            // multiple outputs, treat the env var as a directory; otherwise
            // treat it as a single-file destination (yurt-cc's behavior).
            let dst = if preserve_path.is_dir() || outputs.len() > 1 {
                preserve_path.join(format!("{stem}.pre-opt.wasm"))
            } else {
                preserve_path.to_path_buf()
            };
            preserve::copy_to_preserve(out, Some(&dst))?;
        }
        wasm_opt::maybe_run(out, &process_env.wasm_opt, false)?;
    }

    Ok(ExitCode::SUCCESS)
}
