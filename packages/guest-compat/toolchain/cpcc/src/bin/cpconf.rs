use anyhow::Result;
use clap::Parser;
use cpcc_toolchain::conform;
use std::process::{Command, ExitCode};

#[derive(Parser)]
#[command(
    name = "cpconf",
    version,
    about = "Guest compatibility conformance driver (§Conformance Testing)"
)]
struct Args {
    /// Skip rebuilding cpcc/cpar/cpcheck/cargo-yurt (assume up to date).
    #[arg(long)]
    skip_toolchain_build: bool,
    /// Skip the kernel behavioral canary suite.
    #[arg(long)]
    skip_behavioral: bool,
    /// Skip the spec.toml-driven trace diff.
    #[arg(long)]
    skip_spec_traces: bool,
    /// Also build and exercise Rust canaries via cargo-yurt.
    #[arg(long)]
    include_rust: bool,
    /// Skip `make rust-canaries` (assumes pre-opt wasms already exist under
    /// build/rust/). Used by negative tests that need to probe artifact-presence
    /// checks without triggering a rebuild.
    #[arg(long)]
    skip_rust_canaries_build: bool,
}

fn main() -> Result<ExitCode> {
    let args = Args::parse();
    let root = conform::detect_repo_root()?;
    let driver = conform::Driver::new(root.clone());

    if !args.skip_toolchain_build {
        driver.ensure_toolchain()?;
    }
    driver.build_archive_and_canaries()?;
    driver.run_signature_checks()?;

    if args.include_rust {
        if !args.skip_rust_canaries_build {
            let status = Command::new("make")
                .current_dir(root.join("packages/guest-compat"))
                .arg("rust-canaries")
                .status()?;
            if !status.success() {
                return Err(anyhow::anyhow!("make rust-canaries failed"));
            }
        }
        driver.run_rust_signature_checks()?;
    }

    if !args.skip_spec_traces {
        let results = driver.run_spec_traces(args.include_rust)?;
        let mut failures = 0usize;
        for r in &results {
            if !r.mismatches.is_empty() {
                failures += 1;
                eprintln!(
                    "FAIL [{}] {}::{}",
                    r.language, r.spec_symbol, r.case_name
                );
                for m in &r.mismatches {
                    eprintln!("  - {m:?}");
                }
                eprintln!("  raw stdout: {}", r.raw_stdout.trim_end());
            }
        }
        if failures > 0 {
            return Err(anyhow::anyhow!(
                "{failures} of {} spec/trace diffs failed",
                results.len()
            ));
        }
        println!("cpconf: spec/trace diffs OK ({} cases)", results.len());

        // §Conformance Driver: C and Rust traces must match each other for
        // each case. Pair them up and assert equality of stdout/exit/errno.
        if args.include_rust {
            let mut by_key: std::collections::HashMap<(String, String), Vec<&conform::CaseResult>> = Default::default();
            for r in &results {
                by_key.entry((r.spec_symbol.clone(), r.case_name.clone())).or_default().push(r);
            }
            let mut cross_failures = 0usize;
            for ((sym, case), pair) in &by_key {
                if pair.len() != 2 { continue; }
                let c = pair.iter().find(|p| p.language == "c");
                let r = pair.iter().find(|p| p.language == "rust");
                if let (Some(c), Some(r)) = (c, r) {
                    if c.raw_stdout != r.raw_stdout {
                        cross_failures += 1;
                        eprintln!("CROSS-LANG MISMATCH {sym}::{case}");
                        eprintln!("  c   : {}", c.raw_stdout.trim_end());
                        eprintln!("  rust: {}", r.raw_stdout.trim_end());
                    }
                }
            }
            if cross_failures > 0 {
                return Err(anyhow::anyhow!("{cross_failures} cross-language trace mismatches"));
            }
            println!("cpconf: C/Rust trace parity OK");
        }
    }

    if !args.skip_behavioral {
        driver.run_behavioral_suite()?;
    }
    println!("cpconf: OK");
    Ok(ExitCode::SUCCESS)
}
