use anyhow::Result;
use std::ffi::OsString;
use std::path::PathBuf;

/// User-facing environment variables (§Toolchain Integration — the
/// YURT_CC_* surface). Continuation is the opt-in runtime for POSIX
/// setjmp/longjmp and fork; legacy SETJMP names are accepted as fallback for
/// existing local scripts.
pub struct Env {
    pub archive: Option<PathBuf>,
    pub continuation_archive: Option<PathBuf>,
    pub include: Option<PathBuf>,
    pub skip_version_check: bool,
    pub no_link_injection: bool,
    pub preserve_pre_opt: Option<PathBuf>,
    pub wasm_opt: WasmOptMode,
    /// YURT_CC_USE_CONTINUATION=1 opts this linked module into the Asyncify
    /// continuation runtime used by setjmp/longjmp and fork. This flag makes
    /// yurt-cc asyncify the output and mark the wasm with yurt.features.
    ///
    /// Mutually exclusive with threads (the default build). Asyncify and the
    /// Worker/SAB threads backend cannot coexist in a single module — see
    /// packages/kernel/src/process/module-profile.ts.
    pub use_continuation: bool,
    /// YURT_CC_MARKERS=1 enables instrumented mode: yurt-cc passes
    /// `-DYURT_ABI_MARKERS=1` to clang and forces
    /// `__yurt_abi_marker_*` exports at link time.
    /// Default off; structural verification via `yurt-check --mode=structural`
    /// (the default) doesn't require markers.
    pub markers_enabled: bool,
    /// Optional compiler instrumentation for diagnostic builds.
    /// `ubsan-trap` uses clang's trap-only UBSan path, which does not require
    /// a sanitizer runtime in the WASI sysroot.
    pub instrumentation: InstrumentationMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstrumentationMode {
    None,
    UbsanTrap,
    Asan,
}

pub enum WasmOptMode {
    Disabled,
    Default,
    Explicit(Vec<OsString>),
}

impl Env {
    pub fn from_process() -> Self {
        Self {
            archive: var_os(["YURT_CC_ARCHIVE", "YURT_CC_ARCHIVE"])
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            continuation_archive: var_os([
                "YURT_CC_CONTINUATION_ARCHIVE",
                "YURT_CC_SETJMP_ARCHIVE",
            ])
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                let archive = var_os(["YURT_CC_ARCHIVE"])
                    .filter(|v| !v.is_empty())
                    .map(PathBuf::from)?;
                Some(archive.with_file_name("libyurt_continuation.a"))
            }),
            include: var_os(["YURT_CC_INCLUDE"])
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            // YURT_CC_SKIP_VERSION_CHECK and YURT_CC_NO_WASM_OPT are presence flags:
            // any set value (including empty) enables them.
            skip_version_check: has_var([
                "YURT_CC_SKIP_VERSION_CHECK",
                "YURT_CC_SKIP_VERSION_CHECK",
            ]),
            no_link_injection: has_var(["YURT_CC_NO_LINK_INJECTION"]),
            preserve_pre_opt: var_os(["YURT_CC_PRESERVE_PRE_OPT"]).map(PathBuf::from),
            wasm_opt: if has_var(["YURT_CC_NO_WASM_OPT"]) {
                WasmOptMode::Disabled
            } else if let Some(flags) = var_os(["YURT_CC_WASM_OPT_FLAGS"]) {
                let s = flags.to_string_lossy().to_string();
                WasmOptMode::Explicit(s.split_whitespace().map(OsString::from).collect())
            } else {
                WasmOptMode::Default
            },
            use_continuation: var_os(["YURT_CC_USE_CONTINUATION", "YURT_CC_USE_SETJMP"])
                .map(|v| v != "0" && !v.is_empty())
                .unwrap_or(false),
            // YURT_CC_USE_THREADS is intentionally NOT read: every yurt-cc
            // invocation now emits thread-capable wasm by default
            // (target=wasm32-wasip1-threads, -pthread, imported shared
            // memory, yurt.features:["threads"]). Build scripts that still
            // set `YURT_CC_USE_THREADS=1` are harmless no-ops.
            // Off by default.  CI / production builds use structural
            // verification; flip to "1" while iterating on the compat
            // layer to enable marker-based per-symbol verification.
            markers_enabled: var_os(["YURT_CC_MARKERS", "YURT_CC_MARKERS"])
                .map(|v| v != "0" && !v.is_empty())
                .unwrap_or(false),
            instrumentation: InstrumentationMode::from_env_value(var_os(["YURT_CC_INSTRUMENT"])),
        }
    }

    /// Feature-flag invariants. Threads are on by default and implicit
    /// (no `use_threads` field — see the doc comment on this struct).
    /// `use_continuation` is the only remaining feature toggle; it opts a
    /// build into the asyncify continuation runtime, which is mutually
    /// exclusive with the Worker/SAB threads backend. main.rs handles the
    /// mutual exclusion by suppressing the threads codegen path whenever
    /// `use_continuation` is set; no env-time validation is needed today.
    pub fn validate_feature_flags(&self) -> Result<()> {
        Ok(())
    }
}

impl InstrumentationMode {
    fn from_env_value(value: Option<OsString>) -> Self {
        match value
            .as_ref()
            .map(|v| v.to_string_lossy().to_ascii_lowercase())
            .as_deref()
        {
            Some("ubsan-trap" | "ubsan_trap" | "undefined-trap" | "undefined_trap") => {
                Self::UbsanTrap
            }
            Some("asan" | "address") => Self::Asan,
            _ => Self::None,
        }
    }
}

fn var_os<const N: usize>(names: [&str; N]) -> Option<OsString> {
    names.into_iter().find_map(std::env::var_os)
}

fn has_var<const N: usize>(names: [&str; N]) -> bool {
    names
        .into_iter()
        .any(|name| std::env::var_os(name).is_some())
}
