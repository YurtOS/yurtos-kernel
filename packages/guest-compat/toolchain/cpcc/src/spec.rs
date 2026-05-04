//! TOML spec parser for the conformance harness (§Behavioral Spec). Closed
//! schema: unknown `expected.*` fields are a parse error so the spec
//! contract cannot drift silently.

use anyhow::{anyhow, Context as _, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// One symbol's behavioral spec, loaded from `<symbol>.spec.toml`.
#[derive(Debug, Clone)]
pub struct Spec {
    /// Symbol name derived from the file stem (e.g. `dup2.spec.toml` → `dup2`).
    pub symbol: String,
    /// Source file path. Used in failure messages.
    pub path: PathBuf,
    /// Canary executable name (no `.wasm` suffix).
    pub canary: String,
    /// Optional human summary; not diffed.
    pub summary: Option<String>,
    pub cases: Vec<Case>,
}

#[derive(Debug, Clone)]
pub struct Case {
    pub name: String,
    /// Optional documentation string; not diffed.
    pub inputs: Option<String>,
    pub expected: Expected,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Expected {
    pub exit: Option<i32>,
    pub stdout: Option<String>,
    pub errno: Option<i32>,
    /// Free-form, never diffed; surfaced in failure messages only.
    pub note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSpec {
    canary: String,
    summary: Option<String>,
    #[serde(rename = "case", default)]
    cases: Vec<RawCase>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCase {
    name: String,
    inputs: Option<String>,
    #[serde(default)]
    expected: RawExpected,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawExpected {
    exit: Option<i32>,
    stdout: Option<String>,
    errno: Option<i32>,
    note: Option<String>,
}

fn is_valid_case_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

impl Spec {
    /// Parse spec text without an associated file. `symbol` is set to "<inline>".
    pub fn from_str(text: &str) -> Result<Self> {
        Self::from_str_with_symbol(text, "<inline>", PathBuf::new())
    }

    fn from_str_with_symbol(text: &str, symbol: &str, path: PathBuf) -> Result<Self> {
        let raw: RawSpec = toml::from_str(text).map_err(|e| {
            anyhow!("parsing spec for {symbol}: {e}")
        })?;

        let mut seen = std::collections::HashSet::new();
        let mut cases = Vec::with_capacity(raw.cases.len());
        for rc in raw.cases {
            if !is_valid_case_name(&rc.name) {
                return Err(anyhow!(
                    "{symbol}: invalid case name {:?} (must match /^[a-z][a-z0-9_]*$/)",
                    rc.name
                ));
            }
            if !seen.insert(rc.name.clone()) {
                return Err(anyhow!("{symbol}: duplicate case name {:?}", rc.name));
            }
            let exp = rc.expected;
            let expected = Expected {
                exit: exp.exit,
                stdout: exp.stdout,
                errno: exp.errno,
                note: exp.note,
            };
            if expected.exit.is_none()
                && expected.stdout.is_none()
                && expected.errno.is_none()
            {
                return Err(anyhow!(
                    "{symbol}: case {:?} requires at least one expected.* field",
                    rc.name
                ));
            }
            cases.push(Case {
                name: rc.name,
                inputs: rc.inputs,
                expected,
            });
        }

        Ok(Self {
            symbol: symbol.to_string(),
            path,
            canary: raw.canary,
            summary: raw.summary,
            cases,
        })
    }

    /// Read every `<symbol>.spec.toml` file directly under `dir`. Sorted by
    /// symbol name so iteration order is deterministic.
    pub fn load_dir(dir: &Path) -> Result<Vec<Self>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir)
            .with_context(|| format!("reading {}", dir.display()))?
        {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let symbol = match name.strip_suffix(".spec.toml") {
                Some(s) => s,
                None => continue,
            };
            let path = entry.path();
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            out.push(Self::from_str_with_symbol(&text, symbol, path)?);
        }
        out.sort_by(|a, b| a.symbol.cmp(&b.symbol));
        Ok(out)
    }
}
