use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use std::path::PathBuf;
use std::process::ExitCode;
use yurt_toolchain::{precheck, wasi_sdk, TIER1};

#[derive(Parser)]
#[command(about = "§Verifying Precedence: archive + pre-opt wasm implementation-signature check")]
struct Args {
    #[arg(long)]
    archive: PathBuf,
    #[arg(long = "pre-opt-wasm")]
    pre_opt_wasm: PathBuf,
    /// Subset of Tier 1 symbols to verify. If omitted, all of Tier 1.
    #[arg(long = "symbol")]
    symbols: Vec<String>,
    /// Verification mode.
    ///
    /// `structural` (default): verify each Tier 1 symbol is
    /// exported from the wasm and *not* in the import section.
    /// Combined with yurt-cc's `--whole-archive`, this is sufficient
    /// to know our compat impl wins the link.  Robust to LTO
    /// inlining.
    ///
    /// `markers`: legacy verification — every Tier 1 body must
    /// emit a `call` instruction to its companion marker function
    /// in the pre-opt wasm.  Requires the compat library to have
    /// been built with `-DYURT_GUEST_COMPAT_MARKERS=1`
    /// (i.e. `YURT_CC_MARKERS=1 make -C packages/guest-compat lib`).
    #[arg(long, value_enum, default_value_t = Mode::Structural)]
    mode: Mode,
}

#[derive(Clone, Copy, ValueEnum)]
enum Mode {
    Structural,
    Markers,
}

fn main() -> Result<ExitCode> {
    let args = Args::parse();
    let symbols: Vec<&str> = if args.symbols.is_empty() {
        TIER1.to_vec()
    } else {
        args.symbols.iter().map(String::as_str).collect()
    };
    match args.mode {
        Mode::Structural => {
            precheck::check_wasm_structural(&args.pre_opt_wasm, &symbols)?;
            println!("structural check: OK ({} symbols)", symbols.len());
        }
        Mode::Markers => {
            let sdk = wasi_sdk::discover().context("locating wasi-sdk for llvm-nm")?;
            precheck::check_archive(&sdk.nm(), &args.archive, &symbols)?;
            precheck::check_wasm(&args.pre_opt_wasm, &symbols)?;
            println!("marker check: OK ({} symbols)", symbols.len());
        }
    }
    Ok(ExitCode::SUCCESS)
}
