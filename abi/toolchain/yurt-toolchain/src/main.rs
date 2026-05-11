use anyhow::{bail, Context, Result};
use clap::Parser;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use yurt_toolchain::{
    archive,
    env::{self, InstrumentationMode},
    features, preserve, wasi_sdk, wasm_opt, TIER1, WRAPPED_WASI_LIBC_SYMBOLS,
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
    user_args.is_empty()
        || is_query_only_invocation(user_args)
        || user_args
            .iter()
            .any(|a| a == "-c" || a == "-E" || a == "-S" || a == "-r" || a == "--relocatable")
}

fn is_query_only_invocation(user_args: &[String]) -> bool {
    user_args.iter().any(|a| {
        matches!(
            a.as_str(),
            "-v" | "-###"
                | "--version"
                | "-dumpmachine"
                | "-dumpversion"
                | "-print-search-dirs"
                | "--print-search-dirs"
                | "-print-resource-dir"
                | "--print-resource-dir"
                | "-print-target-triple"
                | "-print-libgcc-file-name"
        ) || a.starts_with("-print-file-name=")
            || a.starts_with("-print-prog-name=")
    }) && !has_compile_or_link_input(user_args)
}

fn has_compile_or_link_input(user_args: &[String]) -> bool {
    let mut skip_next = false;
    for arg in user_args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if matches!(
            arg.as_str(),
            "-o" | "-I" | "-isystem" | "-iquote" | "-include" | "-L" | "-x"
        ) {
            skip_next = true;
            continue;
        }
        if arg == "-" || !arg.starts_with('-') {
            return true;
        }
    }
    false
}

fn is_final_yurt_link_invocation(env: &env::Env, user_args: &[String]) -> bool {
    !env.no_link_injection
        && !is_compile_or_probe_invocation(user_args)
        && !is_shared_link_invocation(user_args)
}

/// `yurt-cc -shared` produces a WASM side module per the Phase 1 shared-library
/// contract (§docs/superpowers/specs/2026-05-09-shared-libraries-design.md).
/// A side module is a final wasm-ld invocation but it must not bundle the
/// `libyurt_abi.a` static archive, force-export Tier 1 symbols, wrap WASI
/// libc, or pull in the WASI emulation libs / `__main_argc_argv` reference —
/// those are properties of the main module that loads the side module at
/// run time. The shared-link path keeps clang's normal `-shared` handling and
/// adds `-Wl,--experimental-pic` so wasm-ld emits a position-independent
/// `dylink.0`-bearing wasm.
fn is_shared_link_invocation(user_args: &[String]) -> bool {
    user_args.iter().any(|a| a == "-shared")
}

fn default_yurt_include_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bin_dir = exe.parent()?;
    let installed = bin_dir.join("yurt-include");
    if installed.join("stdio.h").is_file() {
        return Some(installed.canonicalize().unwrap_or(installed));
    }

    repo_include_from_manifest_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
}

fn repo_include_from_manifest_dir(manifest_dir: &Path) -> Option<PathBuf> {
    let include = manifest_dir.join("../..").join("include");
    if include.join("stdio.h").is_file() {
        Some(include.canonicalize().unwrap_or(include))
    } else {
        None
    }
}

fn contains_define_or_undef(user_args: &[String], name: &str) -> bool {
    let define = format!("-D{name}");
    let define_eq = format!("-D{name}=");
    let undef = format!("-U{name}");
    user_args
        .iter()
        .any(|a| a == &define || a.starts_with(&define_eq) || a == &undef)
}

fn contains_exact_arg(user_args: &[String], arg: &str) -> bool {
    user_args.iter().any(|a| a == arg)
}

fn is_user_library_arg(arg: &str) -> bool {
    arg.starts_with("-l") || arg.ends_with(".a")
}

/// Detect whether the invocation is compiling C++ source so we can
/// substitute a C++ standard for the default `-std=gnu23` (which clang
/// rejects in C++ mode). Heuristic: explicit `-x c++` / `-x cpp-output`
/// from the caller, or a `.cpp`/`.cc`/`.cxx`/`.C` source file in the
/// argument list. Skips operands to options like `-o`, `-include`, etc.
/// so `yurt-cc foo.c -o foo.cpp` isn't misclassified as C++.
fn is_cxx_invocation(user_args: &[String]) -> bool {
    let mut want_lang = false;
    let mut skip_next = false;
    for a in user_args {
        if want_lang {
            if a == "c++" || a == "cpp-output" || a == "c++-cpp-output" {
                return true;
            }
            want_lang = false;
            continue;
        }
        if skip_next {
            skip_next = false;
            continue;
        }
        if a == "-x" {
            want_lang = true;
            continue;
        }
        // Mirror has_compile_or_link_input: these options take a separate
        // operand which is NOT a source input — skip it so e.g.
        // `-o foo.cpp` doesn't trip the extension check below.
        if matches!(
            a.as_str(),
            "-o" | "-I" | "-isystem" | "-iquote" | "-include" | "-L" | "-MT" | "-MF" | "-MQ"
        ) {
            skip_next = true;
            continue;
        }
        if let Some(rest) = a.strip_prefix("-x") {
            if rest == "c++" || rest == "cpp-output" || rest == "c++-cpp-output" {
                return true;
            }
            continue;
        }
        // Anything else starting with `-` is a flag, not a source file.
        if a.starts_with('-') {
            continue;
        }
        let lower = a.to_ascii_lowercase();
        if lower.ends_with(".cpp")
            || lower.ends_with(".cc")
            || lower.ends_with(".cxx")
            || lower.ends_with(".c++")
            || a.ends_with(".C")
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod cxx_detection_tests {
    use super::is_cxx_invocation;

    fn args(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cpp_source_is_cxx() {
        assert!(is_cxx_invocation(&args(&["-c", "foo.cpp"])));
    }

    #[test]
    fn explicit_x_cxx_is_cxx() {
        assert!(is_cxx_invocation(&args(&["-x", "c++", "-c", "foo.c"])));
        assert!(is_cxx_invocation(&args(&["-xc++", "-c", "foo.c"])));
    }

    #[test]
    fn c_source_with_cpp_output_path_is_not_cxx() {
        assert!(!is_cxx_invocation(&args(&["foo.c", "-o", "foo.cpp"])));
        assert!(!is_cxx_invocation(&args(&["-o", "out.C", "foo.c"])));
        assert!(!is_cxx_invocation(&args(&["-include", "stub.cc", "foo.c"])));
    }

    #[test]
    fn flag_with_cpp_substring_is_not_cxx() {
        assert!(!is_cxx_invocation(&args(&["-DFOO=bar.cpp", "foo.c"])));
    }
}

fn build_clang_invocation(
    sdk: &wasi_sdk::WasiSdk,
    env: &env::Env,
    user_args: &[String],
    final_yurt_link: bool,
) -> Vec<OsString> {
    let mut argv: Vec<OsString> = Vec::new();
    argv.push(format!("--sysroot={}", sdk.sysroot().display()).into());
    argv.push("--target=wasm32-wasip1".into());
    if final_yurt_link {
        argv.push("-O2".into());
        // Default standard depends on language mode. C23 (gnu23) gives us
        // nullptr / unreachable() / <stddef.h> additions that gnulib code
        // paths in coreutils require. C23 is a near-pure superset of C11
        // (the one exception is `bool` becoming a real keyword; none of
        // our current ports rely on `typedef ... bool`).
        //
        // For C++ source, gnu23 is invalid ("not allowed with 'C++'") so
        // emit gnu++17 instead — current C++ baseline that all our
        // expected C++ ports (libzmq, etc.) target. Ports needing a
        // different standard can pass `-std=...` after; clang takes the
        // last `-std=` flag.
        if is_cxx_invocation(user_args) {
            argv.push("-std=gnu++17".into());
        } else {
            argv.push("-std=gnu23".into());
        }
        argv.push("-Wall".into());
        argv.push("-Wextra".into());
    }
    match env.instrumentation {
        InstrumentationMode::None => {}
        InstrumentationMode::UbsanTrap => {
            argv.push("-fsanitize=undefined".into());
            argv.push("-fsanitize-undefined-trap-on-error".into());
        }
        InstrumentationMode::Asan => {
            argv.push("-fsanitize=address".into());
        }
    }
    for name in [
        "__linux__",
        "__STDC_ISO_10646__=201706L",
        "_WASI_EMULATED_SIGNAL",
        "_WASI_EMULATED_MMAN",
        "_WASI_EMULATED_PROCESS_CLOCKS",
    ] {
        let define_name = name.split_once('=').map_or(name, |(name, _)| name);
        if !contains_define_or_undef(user_args, define_name) {
            argv.push(format!("-D{name}").into());
        }
    }

    let yurt_include = env
        .include
        .as_ref()
        .cloned()
        .or_else(default_yurt_include_dir);
    if let Some(include) = yurt_include.as_ref() {
        let preinclude = include.join("yurt_preinclude.h");
        if preinclude.is_file() {
            argv.push("-include".into());
            argv.push(preinclude.into_os_string());
        }
    }

    let mut deferred_user_libs: Vec<OsString> = Vec::new();
    for a in user_args {
        if let Some(filtered) = filter_unsupported_wasm_link_arg(a) {
            if final_yurt_link && is_user_library_arg(&filtered) {
                deferred_user_libs.push(filtered.into());
            } else {
                argv.push(filtered.into());
            }
        }
    }
    if let Some(inc) = env.include.as_ref() {
        argv.push("-I".into());
        argv.push(inc.clone().into_os_string());
    }
    if env.include.is_none() {
        if let Some(default_include) = yurt_include {
            argv.push("-I".into());
            argv.push(default_include.into_os_string());
        }
    }
    // Wrap directives must precede user libraries so an explicit `-lc` in
    // a port's LIBS cannot resolve a symbol before lld sees `--wrap`. The
    // whole-archive pair still follows user objects so those objects can
    // pull ABI implementations from libyurt.
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
            // Phase 1 shared-library contract: dlopen's loader calls
            // `__indirect_function_table.grow()` to reserve slots for
            // side-module function imports (see
            // packages/kernel/src/process/dynlink.ts line ~477 and the
            // spec at docs/superpowers/specs/2026-05-09-shared-
            // libraries-design.md §86). wasm-ld defaults to a non-
            // growable table; `--growable-table` emits the table with
            // no maximum so the host-side grow() succeeds. Cost is
            // zero on guests that never dlopen — the bigger limits
            // encoding is a handful of bytes.
            argv.push("-Wl,--growable-table".into());
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
    argv.extend(deferred_user_libs);
    if final_yurt_link {
        for arg in [
            "-lwasi-emulated-signal",
            "-lwasi-emulated-mman",
            "-lwasi-emulated-process-clocks",
            "-Wl,-u,__main_argc_argv",
        ] {
            if !contains_exact_arg(user_args, arg) {
                argv.push(arg.into());
            }
        }
    }
    if is_shared_link_invocation(user_args)
        && !contains_exact_arg(user_args, "-Wl,--experimental-pic")
    {
        // wasm-ld requires --experimental-pic to honor `-shared` and emit
        // the dylink.0 custom section that the Phase 1 loader reads.
        argv.push("-Wl,--experimental-pic".into());
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

fn filter_unsupported_wasm_link_arg(arg: &str) -> Option<String> {
    let Some(wl) = arg.strip_prefix("-Wl,") else {
        return Some(arg.to_string());
    };
    let filtered: Vec<&str> = wl
        .split(',')
        .filter(|part| {
            !matches!(
                *part,
                "--start-group"
                    | "--end-group"
                    | "--warn-common"
                    | "--sort-common"
                    | "--sort-section"
                    | "alignment"
            )
        })
        .collect();
    if filtered.is_empty() {
        None
    } else if filtered.len() == wl.split(',').count() {
        Some(arg.to_string())
    } else {
        Some(format!("-Wl,{}", filtered.join(",")))
    }
}

fn validate_instrumentation(env: &env::Env) -> Result<()> {
    if env.instrumentation == InstrumentationMode::Asan {
        bail!(
            "YURT_CC_INSTRUMENT=asan is not supported by this wasi-sdk install: \
             wasm ASan runtime libraries are not present. Use \
             YURT_CC_INSTRUMENT=ubsan-trap for runtime-free trap instrumentation."
        );
    }
    Ok(())
}

fn main() -> Result<ExitCode> {
    let cli = Cli::parse();
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let env = env::Env::from_process();
    validate_instrumentation(&env)?;

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

    // Side-module postlink: `yurt-cc -shared` produces a wasm with a
    // `dylink.0` custom section. Run yurt-wasi-postlink --side-module
    // automatically to validate the section and emit the
    // `<output>.yurtmeta.json` sidecar the Phase 1 loader consumes.
    // Skipped when the user opts out via YURT_CC_NO_SIDE_MODULE_POSTLINK
    // (e.g., a build system that runs postlink as a separate make rule
    // and does not want the redundant invocation).
    if is_shared_link_invocation(&cli.args)
        && std::env::var_os("YURT_CC_NO_SIDE_MODULE_POSTLINK").is_none()
    {
        if let Some(out_path) = preserve::output_path(&cli.args) {
            run_side_module_postlink(&out_path).with_context(|| {
                format!("yurt-wasi-postlink --side-module on {}", out_path.display())
            })?;
        }
    }

    Ok(ExitCode::SUCCESS)
}

/// Locate the `yurt-wasi-postlink` binary alongside `yurt-cc`.
/// The two ship as workspace siblings; once installed they live in the
/// same `bin/` directory. Falls back to `target/release/` when invoked
/// from the build tree.
fn locate_yurt_wasi_postlink() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("locating yurt-cc binary")?;
    let bin_dir = exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("yurt-cc has no parent directory"))?;
    let candidate = bin_dir.join(if cfg!(windows) {
        "yurt-wasi-postlink.exe"
    } else {
        "yurt-wasi-postlink"
    });
    if candidate.is_file() {
        return Ok(candidate);
    }
    bail!(
        "could not locate yurt-wasi-postlink next to yurt-cc at {} \
         (set YURT_CC_NO_SIDE_MODULE_POSTLINK=1 to skip auto-postlink)",
        candidate.display()
    );
}

fn run_side_module_postlink(wasm: &Path) -> Result<()> {
    let postlink = locate_yurt_wasi_postlink()?;
    let status = Command::new(&postlink)
        .arg("--side-module")
        .arg("--input")
        .arg(wasm)
        .arg("--output")
        .arg(wasm)
        .status()
        .with_context(|| format!("spawning {}", postlink.display()))?;
    if !status.success() {
        bail!(
            "{} --side-module exited with {}",
            postlink.display(),
            status.code().unwrap_or(-1)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fake_sdk() -> wasi_sdk::WasiSdk {
        wasi_sdk::WasiSdk {
            root: PathBuf::from("/opt/fake-wasi-sdk"),
        }
    }

    fn env_with_instrumentation(instrumentation: InstrumentationMode) -> env::Env {
        env::Env {
            archive: None,
            continuation_archive: None,
            include: None,
            skip_version_check: false,
            no_link_injection: false,
            preserve_pre_opt: None,
            wasm_opt: env::WasmOptMode::Default,
            use_continuation: false,
            markers_enabled: false,
            instrumentation,
        }
    }

    fn argv_strings(argv: Vec<OsString>) -> Vec<String> {
        argv.into_iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn ubsan_trap_instrumentation_adds_runtime_free_clang_flags() {
        let env = env_with_instrumentation(InstrumentationMode::UbsanTrap);
        let argv = argv_strings(build_clang_invocation(
            &fake_sdk(),
            &env,
            &["probe.c".into(), "-o".into(), "probe.wasm".into()],
            true,
        ));

        assert!(argv.contains(&"-fsanitize=undefined".to_string()));
        assert!(argv.contains(&"-fsanitize-undefined-trap-on-error".to_string()));
    }

    #[test]
    fn asan_instrumentation_is_rejected_until_wasm_runtime_is_available() {
        let env = env_with_instrumentation(InstrumentationMode::Asan);

        let err = validate_instrumentation(&env).unwrap_err().to_string();

        assert!(err.contains("YURT_CC_INSTRUMENT=asan is not supported"));
    }
}
