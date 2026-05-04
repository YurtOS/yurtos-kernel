use std::ffi::OsString;
use std::path::PathBuf;

/// User-facing environment variables (§Toolchain Integration — the
/// CPCC_* surface).
pub struct Env {
    pub archive: Option<PathBuf>,
    pub setjmp_archive: Option<PathBuf>,
    pub include: Option<PathBuf>,
    pub skip_version_check: bool,
    pub preserve_pre_opt: Option<PathBuf>,
    pub wasm_opt: WasmOptMode,
    /// CPCC_USE_SETJMP=1 opts this linked module into setjmp/longjmp support.
    /// Setjmp is implemented through Asyncify, so this flag also makes cpcc
    /// asyncify the output and mark the wasm with yurt.features.
    pub use_setjmp: bool,
    /// CPCC_MARKERS=1 enables instrumented mode: cpcc passes
    /// `-DYURT_GUEST_COMPAT_MARKERS=1` to clang and forces
    /// `__yurt_guest_compat_marker_*` exports at link time.
    /// Default off; structural verification via `cpcheck --mode=structural`
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
            archive: std::env::var_os("CPCC_ARCHIVE")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            setjmp_archive: std::env::var_os("CPCC_SETJMP_ARCHIVE")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    let archive = std::env::var_os("CPCC_ARCHIVE")
                        .filter(|v| !v.is_empty())
                        .map(PathBuf::from)?;
                    Some(archive.with_file_name("libyurt_setjmp.a"))
                }),
            include: std::env::var_os("CPCC_INCLUDE")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            // CPCC_SKIP_VERSION_CHECK and CPCC_NO_WASM_OPT are presence flags:
            // any set value (including empty) enables them.
            skip_version_check: std::env::var_os("CPCC_SKIP_VERSION_CHECK").is_some(),
            preserve_pre_opt: std::env::var_os("CPCC_PRESERVE_PRE_OPT").map(PathBuf::from),
            wasm_opt: if std::env::var_os("CPCC_NO_WASM_OPT").is_some() {
                WasmOptMode::Disabled
            } else if let Some(flags) = std::env::var_os("CPCC_WASM_OPT_FLAGS") {
                let s = flags.to_string_lossy().to_string();
                WasmOptMode::Explicit(s.split_whitespace().map(OsString::from).collect())
            } else {
                WasmOptMode::Default
            },
            use_setjmp: std::env::var_os("CPCC_USE_SETJMP")
                .map(|v| v != "0" && !v.is_empty())
                .unwrap_or(false),
            // Off by default.  CI / production builds use structural
            // verification; flip to "1" while iterating on the compat
            // layer to enable marker-based per-symbol verification.
            markers_enabled: std::env::var_os("CPCC_MARKERS")
                .map(|v| v != "0" && !v.is_empty())
                .unwrap_or(false),
        }
    }
}
