use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Resolve the target `-o` from a user argv with a `.wasm` extension.
/// Returns `None` for compile-only invocations (no `-o foo.wasm`) —
/// preservation only triggers when the user explicitly named a `.wasm`
/// output, which by convention is the final link artifact.  When
/// multiple `-o` appear, follows clang's "last one wins" convention.
pub fn output_wasm(user_args: &[String]) -> Option<PathBuf> {
    let mut iter = user_args.iter();
    let mut last = None;
    while let Some(arg) = iter.next() {
        if arg == "-o" {
            if let Some(v) = iter.next() {
                let p = PathBuf::from(v);
                if p.extension().and_then(|e| e.to_str()) == Some("wasm") {
                    last = Some(p);
                }
            }
        }
    }
    last
}

/// Resolve the target `-o` from a user argv, regardless of extension.
/// Used by the post-link wasm-opt pass: link output is wasm by virtue
/// of `--target=wasm32-wasip1`, not by file extension (BusyBox links
/// to `busybox_unstripped` with no extension; cargo-style builds use
/// `<crate>.wasm`; both are wasm and both want the asyncify pass).
pub fn output_path(user_args: &[String]) -> Option<PathBuf> {
    let mut iter = user_args.iter();
    let mut last = None;
    while let Some(arg) = iter.next() {
        if arg == "-o" {
            if let Some(v) = iter.next() {
                last = Some(PathBuf::from(v));
            }
        }
    }
    last
}

/// If the user asked for preservation, copy `src` to the preserve path.
/// Otherwise no-op.
pub fn copy_to_preserve(src: &Path, preserve: Option<&Path>) -> Result<()> {
    let Some(dst) = preserve else { return Ok(()) };
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::copy(src, dst)
        .with_context(|| format!("copying {} → {}", src.display(), dst.display()))?;
    Ok(())
}
