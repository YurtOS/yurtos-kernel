use anyhow::{Context, Result};
use clap::Parser;
use std::ffi::OsString;
use std::process::{Command, ExitCode};

use yurt_toolchain::{
    archive, env, features, preserve, wasi_sdk, wasm_opt, TIER1, WRAPPED_WASI_LIBC_SYMBOLS,
    YURT_INTERNAL_EXPORTS,
};

#[derive(Parser, Debug)]
#[command(name = "yurt-cc", version, about = "Clang wrapper for the yurt kernel ABI runtime", long_about = None)]
struct Cli {
    #[arg(long)]
    dry_run: bool,

    #[arg(long = "print-sdk-path")]
    print_sdk_path: bool,

    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn is_compile_or_probe_invocation(user_args: &[String]) -> bool {
    // Relocatable (-r / --relocatable) and partial links must NOT receive the
    // --whole-archive compat injection: the archive symbols would end up in
    // intermediate .o files and cause duplicate-symbol errors when the final
    // link re-injects the archive. Only the final executable link step gets
    // the injection.
    user_args
        .iter()
        .any(|a| a == "-c" || a == "-E" || a == "-S" || a == "-r" || a == "--relocatable")
}

fn is_final_yurt_link_invocation(env: &env::Env, user_args: &[String]) -> bool {
    !env.no_link_injection && !is_compile_or_probe_invocation(user_args)
}

fn build_clang_invocation(
    sdk: &wasi_sdk::WasiSdk,
    env: &env::Env,
    user_args: &[String],
    final_yurt_link: bool,
) -> Vec<OsString> {
    let mut argv: Vec<OsString> = Vec::new();
    if let Some(inc) = env.include.as_ref() {
        argv.push("-I".into());
        argv.push(inc.clone().into_os_string());
    }
    argv.push(format!("--sysroot={}", sdk.sysroot().display()).into());
    argv.push("--target=wasm32-wasip1".into());
    argv.push("-O2".into());
    // Default to C23 (gnu23): gives us nullptr keyword and the
    // unreachable()/byteswap/etc. additions to <stddef.h>, both of
    // which gnulib code paths in coreutils require.  Backward-compat:
    // C23 is a near-pure superset of C11 that mostly adds new
    // keywords; the exception is `bool` becoming a real keyword.
    // Pre-C23 code that used a `typedef ... bool` would break, but
    // none of our current ports do so (BusyBox uses smallint, jq /
    // file use int).  Ports that need an older standard can pass
    // `-std=...` after; clang takes the last -std= flag.
    argv.push("-std=gnu23".into());
    argv.push("-Wall".into());
    argv.push("-Wextra".into());
    for a in user_args {
        argv.push(a.into());
    }
    // Link-arg framing must come after the user's objects so it is last in
    // the link line. The whole-archive pair must bracket only the compat
    // archive, and the whole thing must precede `-lc`. clang's default is
    // to insert `-lc` at the very end, so appending these three args is
    // sufficient.
    //
    // When the archive is present:
    // - Pass --no-wasm-opt so that clang's automatic wasm-opt invocation
    //   is suppressed. yurt-cc captures the linker output as the "pre-opt"
    //   artifact (§Verifying Precedence) and runs wasm-opt separately via
    //   YURT_CC_WASM_OPT_FLAGS / YURT_CC_NO_WASM_OPT. Without this flag the
    //   clang driver runs wasm-opt itself before yurt-cc can preserve the
    //   pre-opt wasm, which makes stage 3 of yurt-check unverifiable.
    // - Export each Tier 1 symbol and its marker so that yurt-check's
    //   §Verifying Precedence stages 2 and 3 can locate them by name in
    //   the export section of the pre-opt .wasm.
    if let Some(archive) = env.archive.as_ref() {
        if final_yurt_link {
            argv.push("--no-wasm-opt".into());
            argv.push("-Wl,--allow-multiple-definition".into());
            argv.push("-Wl,--export-table".into());
            for sym in WRAPPED_WASI_LIBC_SYMBOLS {
                argv.push(format!("-Wl,--wrap={sym}").into());
            }
            argv.push("-Wl,--whole-archive".into());
            argv.push(archive.clone().into_os_string());
            argv.push("-Wl,--no-whole-archive".into());
            if env.use_continuation {
                if let Some(continuation_archive) = env.continuation_archive.as_ref() {
                    argv.push("-Wl,--whole-archive".into());
                    argv.push(continuation_archive.clone().into_os_string());
                    argv.push("-Wl,--no-whole-archive".into());
                }
            }
            for sym in TIER1 {
                // Always force-export the Tier 1 symbol itself.  This
                // is what structural verification (default) checks
                // for in the wasm export section, and it's what guest
                // tooling expects.
                argv.push(format!("-Wl,--export={sym}").into());
                if env.markers_enabled {
                    // Instrumented mode also force-exports the marker
                    // function so yurt-check's --mode=markers can locate
                    // it in stage 2.
                    argv.push(format!("-Wl,--export=__yurt_abi_marker_{sym}").into());
                }
            }
            for sym in YURT_INTERNAL_EXPORTS {
                argv.push(format!("-Wl,--export={sym}").into());
            }
        }
    }
    // -DYURT_ABI_MARKERS=1 expands the marker macros into
    // their real bodies in yurt_markers.h.  Without it, the macros
    // compile to nothing (no marker functions emitted, marker-call
    // sites are no-ops) — the production / default mode.
    if env.markers_enabled {
        argv.push("-DYURT_ABI_MARKERS=1".into());
    }
    if env.use_continuation {
        argv.push("-DYURT_USE_CONTINUATION=1".into());
        argv.push("-DYURT_USE_SETJMP=1".into());
    }
    argv
}

fn main() -> Result<ExitCode> {
    let cli = Cli::parse();
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let env = env::Env::from_process();

    if cli.print_sdk_path {
        println!("{}", sdk.root.display());
        return Ok(ExitCode::SUCCESS);
    }

    let final_yurt_link = is_final_yurt_link_invocation(&env, &cli.args);

    if final_yurt_link {
        if let Some(archive) = env.archive.as_ref() {
            if !env.skip_version_check {
                archive::check_version(&sdk.nm(), archive).context("version check")?;
            }
        }
    }

    let argv = build_clang_invocation(&sdk, &env, &cli.args, final_yurt_link);

    if cli.dry_run {
        print!("{}", sdk.clang().display());
        for a in &argv {
            print!(" {}", a.to_string_lossy());
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    let status = Command::new(sdk.clang())
        .args(&argv)
        .status()
        .with_context(|| format!("spawning {}", sdk.clang().display()))?;
    if !status.success() {
        return Ok(status
            .code()
            .map(|c| ExitCode::from(c as u8))
            .unwrap_or(ExitCode::FAILURE));
    }

    // Post-link: pre-opt preservation is gated on the user naming a
    // `.wasm` output (canary/test builds), but wasm-opt runs against
    // any link output — BusyBox links to `busybox_unstripped` with no
    // extension, and that binary is still wasm by virtue of
    // --target=wasm32-wasip1 and still wants the --asyncify pass.
    if final_yurt_link {
        if let Some(out_wasm) = preserve::output_wasm(&cli.args) {
            preserve::copy_to_preserve(&out_wasm, env.preserve_pre_opt.as_deref())?;
        }
        if let Some(out_path) = preserve::output_path(&cli.args) {
            wasm_opt::maybe_run(&out_path, &env.wasm_opt, env.use_continuation)?;
            if env.use_continuation {
                features::append_continuation_features(&out_path)?;
            }
        }
    }

    Ok(ExitCode::SUCCESS)
}
