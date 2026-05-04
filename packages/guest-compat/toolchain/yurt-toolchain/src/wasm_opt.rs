use crate::env::WasmOptMode;
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

fn default_args() -> Vec<std::ffi::OsString> {
    vec![
        "-O2".into(),
        "--enable-bulk-memory".into(),
        "--enable-sign-ext".into(),
        "--enable-nontrapping-float-to-int".into(),
    ]
}

fn setjmp_args() -> Vec<std::ffi::OsString> {
    let mut args = default_args();
    args.push("--asyncify".into());
    args
}

/// Run wasm-opt on `path` in place, according to `mode`.
///
/// The default mode applies wasm feature flags and optimizations without
/// Asyncify. Setjmp/longjmp is an explicit opt-in because it taints the
/// process execution strategy: those modules run under the Asyncify adapter
/// while normal modules remain free to use JSPI or another backend.
pub fn maybe_run(path: &Path, mode: &WasmOptMode, use_setjmp: bool) -> Result<()> {
    let args: Vec<std::ffi::OsString> = match mode {
        WasmOptMode::Disabled => return Ok(()),
        WasmOptMode::Default => {
            if use_setjmp {
                setjmp_args()
            } else {
                default_args()
            }
        }
        WasmOptMode::Explicit(v) => v.clone(),
    };
    let wasm_opt = which::which("wasm-opt").map_err(|_| {
        anyhow!("wasm-opt requested but not on PATH (YURT_CC_NO_WASM_OPT=1 to skip)")
    })?;
    let status = Command::new(wasm_opt)
        .args(&args)
        .arg(path)
        .arg("-o")
        .arg(path)
        .status()
        .with_context(|| format!("running wasm-opt on {}", path.display()))?;
    if !status.success() {
        return Err(anyhow!("wasm-opt failed on {}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_wasm_opt_flags_enable_rust_wasm_features() {
        let args = super::default_args()
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.contains(&"--enable-nontrapping-float-to-int".to_string()));
        assert!(
            !args.contains(&"--asyncify".to_string()),
            "default yurt-cc output must not be asyncify/setjmp-tainted",
        );
    }

    #[test]
    fn setjmp_wasm_opt_flags_enable_asyncify() {
        let args = super::setjmp_args()
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.contains(&"--asyncify".to_string()));
    }
}
