use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

/// Assert the `yurt_abi_version` sentinel symbol is defined in
/// the archive (via `llvm-nm`). Step 1 check is presence-only; value
/// parsing against the header's major/minor constants is deferred to
/// Step 3 when cargo-yurt lands. Implements §Versioning (presence).
pub fn check_version(nm: &Path, archive: &Path) -> Result<()> {
    let out = Command::new(nm)
        .arg("--defined-only")
        .arg(archive)
        .output()
        .with_context(|| format!("running {} on {}", nm.display(), archive.display()))?;
    if !out.status.success() {
        return Err(anyhow!(
            "llvm-nm failed on {}: {}",
            archive.display(),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let present = stdout.lines().any(|line| {
        line.split_whitespace()
            .last()
            .map(|s| s == "yurt_abi_version")
            .unwrap_or(false)
    });
    if !present {
        return Err(anyhow!(
            "archive {} does not define yurt_abi_version (§Versioning)",
            archive.display()
        ));
    }
    // We do not yet read the archive's encoded value (that would require
    // extracting the data section). The sentinel's presence plus the
    // archive's provenance from the repo build are sufficient for Step 1.
    // Step 3 (cargo-yurt lands) tightens this to an exact value match.
    Ok(())
}
