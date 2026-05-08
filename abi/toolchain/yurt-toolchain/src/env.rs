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
    pub use_continuation: bool,
    /// YURT_CC_MARKERS=1 enables instrumented mode: yurt-cc passes
    /// `-DYURT_ABI_MARKERS=1` to clang and forces
    /// `__yurt_abi_marker_*` exports at link time.
    /// Default off; structural verification via `yurt-check --mode=structural`
    /// (the default) doesn't require markers.
    pub markers_enabled: bool,
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
            // Off by default.  CI / production builds use structural
            // verification; flip to "1" while iterating on the compat
            // layer to enable marker-based per-symbol verification.
            markers_enabled: var_os(["YURT_CC_MARKERS", "YURT_CC_MARKERS"])
                .map(|v| v != "0" && !v.is_empty())
                .unwrap_or(false),
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
