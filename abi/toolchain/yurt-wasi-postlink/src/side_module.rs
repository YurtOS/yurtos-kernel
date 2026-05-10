//! Phase 1 shared-library side-module validation and metadata emission.
//!
//! Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md.
//!
//! When `yurt-wasi-postlink --side-module` is invoked, we read the input
//! wasm's `dylink.0` custom section (per the WebAssembly tool-conventions
//! DynamicLinking spec), collect its dynamic exports, and emit a JSON
//! sidecar manifest the runtime loader can read. The wasm itself is
//! round-tripped unchanged.
//!
//! The on-the-wire `dylink.0` format is a sequence of subsections, each:
//!
//! ```text
//! u8   subsection_kind
//! varuint32 length
//! u8   payload[length]
//! ```
//!
//! Subsection kinds we honor today:
//!   1 = WASM_DYLINK_MEM_INFO (mem_size, mem_align, table_size, table_align — all varuint32)
//!   2 = WASM_DYLINK_NEEDED   (varuint32 count + count×name)
//!
//! WASM_DYLINK_EXPORT_INFO (3) and WASM_DYLINK_IMPORT_INFO (4) carry
//! per-symbol flags (TLS, weak, etc.). Today we sniff the export *names*
//! from the wasm export section directly; we accept and skip kinds 3+
//! so future toolchains adding subsections do not break this validator.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use walrus::{ExportItem, Module};

/// Manifest sidecar emitted next to a side-module wasm.
///
/// Schema is intentionally narrow and stable. New optional fields may be
/// added; existing fields will not be removed without a contract bump.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub soname: String,
    pub exports: Vec<String>,
    pub deps: Vec<String>,
    pub mem_size: u32,
    pub mem_align: u32,
    pub table_size: u32,
    pub table_align: u32,
}

/// Parsed `dylink.0` subsection contents (only the fields we need today).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DylinkInfo {
    pub mem_size: u32,
    pub mem_align: u32,
    pub table_size: u32,
    pub table_align: u32,
    pub needed: Vec<String>,
}

const KIND_MEM_INFO: u8 = 1;
const KIND_NEEDED: u8 = 2;

pub fn parse_dylink_0(data: &[u8]) -> Result<DylinkInfo> {
    let mut info = DylinkInfo::default();
    let mut cursor = data;
    while !cursor.is_empty() {
        let kind = cursor[0];
        cursor = &cursor[1..];
        let len = read_varuint32(&mut cursor).context("subsection length")? as usize;
        if len > cursor.len() {
            bail!(
                "truncated dylink.0 subsection: kind={kind}, declared length {len}, only {} bytes remain",
                cursor.len()
            );
        }
        let (payload, rest) = cursor.split_at(len);
        cursor = rest;
        match kind {
            KIND_MEM_INFO => {
                let mut p = payload;
                info.mem_size = read_varuint32(&mut p).context("mem_info.mem_size")?;
                info.mem_align = read_varuint32(&mut p).context("mem_info.mem_align")?;
                info.table_size = read_varuint32(&mut p).context("mem_info.table_size")?;
                info.table_align = read_varuint32(&mut p).context("mem_info.table_align")?;
                if !p.is_empty() {
                    bail!("trailing bytes in WASM_DYLINK_MEM_INFO subsection");
                }
            }
            KIND_NEEDED => {
                let mut p = payload;
                let count = read_varuint32(&mut p).context("needed.count")?;
                for i in 0..count {
                    info.needed
                        .push(read_str(&mut p).with_context(|| format!("needed[{i}].name"))?);
                }
                if !p.is_empty() {
                    bail!("trailing bytes in WASM_DYLINK_NEEDED subsection");
                }
            }
            // Other documented subsections (export_info, import_info,
            // runtime_path) carry information we either source from
            // elsewhere or do not consume yet. Skip them, but require
            // the declared length to be honest so a malformed file
            // still fails loudly.
            _ => {}
        }
    }
    Ok(info)
}

/// Read a varuint32 (LEB128) and advance the cursor.
fn read_varuint32(buf: &mut &[u8]) -> Result<u32> {
    let mut result: u32 = 0;
    let mut shift: u32 = 0;
    loop {
        if buf.is_empty() {
            bail!("truncated LEB128");
        }
        let b = buf[0];
        *buf = &buf[1..];
        let chunk = (b & 0x7f) as u32;
        if shift >= 32 || (shift == 28 && chunk > 0x0f) {
            bail!("varuint32 too large");
        }
        result |= chunk << shift;
        if b & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
    }
}

fn read_str(buf: &mut &[u8]) -> Result<String> {
    let len = read_varuint32(buf).context("string length")? as usize;
    if buf.len() < len {
        bail!(
            "truncated string: declared {len}, only {} bytes remain",
            buf.len()
        );
    }
    let (s, rest) = buf.split_at(len);
    *buf = rest;
    Ok(std::str::from_utf8(s)
        .map_err(|e| anyhow!("invalid utf8 in dylink.0 string: {e}"))?
        .to_string())
}

/// Return all function and global exports declared by the side module,
/// sorted for deterministic output. These are the names callers can
/// resolve via `dlsym` per the Phase 1 spec.
pub fn collect_dynamic_exports(module: &Module) -> Vec<String> {
    let mut names: Vec<String> = module
        .exports
        .iter()
        .filter(|e| matches!(e.item, ExportItem::Function(_) | ExportItem::Global(_)))
        .map(|e| e.name.clone())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Derive a SONAME from a wasm file path: strip `lib` prefix and `.wasm`
/// suffix. `/lib/libfoo.wasm` → `foo`; `bar.wasm` → `bar`.
pub fn soname_from_path(p: &Path) -> String {
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    stem.strip_prefix("lib").map(str::to_owned).unwrap_or(stem)
}

pub fn write_manifest(manifest: &Manifest, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
    }
    let json = serde_json::to_string_pretty(manifest).context("serializing manifest")?;
    std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_varuint32(buf: &mut Vec<u8>, mut v: u32) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                buf.push(b);
                return;
            }
            buf.push(b | 0x80);
        }
    }

    fn write_str(buf: &mut Vec<u8>, s: &str) {
        write_varuint32(buf, s.len() as u32);
        buf.extend_from_slice(s.as_bytes());
    }

    fn make_subsection(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![kind];
        write_varuint32(&mut out, payload.len() as u32);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn parses_mem_info_and_needed() {
        let mut mem = Vec::new();
        write_varuint32(&mut mem, 1024); // mem_size
        write_varuint32(&mut mem, 4); // mem_align
        write_varuint32(&mut mem, 8); // table_size
        write_varuint32(&mut mem, 0); // table_align

        let mut needed = Vec::new();
        write_varuint32(&mut needed, 2); // count
        write_str(&mut needed, "libc.wasm");
        write_str(&mut needed, "libm.wasm");

        let mut data = Vec::new();
        data.extend(make_subsection(KIND_MEM_INFO, &mem));
        data.extend(make_subsection(KIND_NEEDED, &needed));

        let info = parse_dylink_0(&data).unwrap();
        assert_eq!(info.mem_size, 1024);
        assert_eq!(info.mem_align, 4);
        assert_eq!(info.table_size, 8);
        assert_eq!(info.table_align, 0);
        assert_eq!(
            info.needed,
            vec!["libc.wasm".to_string(), "libm.wasm".to_string()]
        );
    }

    #[test]
    fn skips_unknown_subsections() {
        let mut data = Vec::new();
        // Unknown kind 99 with a 3-byte payload.
        data.extend(make_subsection(99, &[0xde, 0xad, 0xbe]));
        // Followed by a real mem_info.
        let mut mem = Vec::new();
        write_varuint32(&mut mem, 16);
        write_varuint32(&mut mem, 0);
        write_varuint32(&mut mem, 0);
        write_varuint32(&mut mem, 0);
        data.extend(make_subsection(KIND_MEM_INFO, &mem));

        let info = parse_dylink_0(&data).unwrap();
        assert_eq!(info.mem_size, 16);
    }

    #[test]
    fn rejects_truncated_subsection() {
        // Declared length 10 but only 2 bytes follow.
        let data = vec![KIND_MEM_INFO, 10, 0x01, 0x02];
        let err = parse_dylink_0(&data).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("truncated"), "{msg}");
    }

    #[test]
    fn rejects_trailing_bytes_in_mem_info() {
        let mut payload = Vec::new();
        write_varuint32(&mut payload, 1);
        write_varuint32(&mut payload, 2);
        write_varuint32(&mut payload, 3);
        write_varuint32(&mut payload, 4);
        payload.push(0xff); // trailing junk
        let data = make_subsection(KIND_MEM_INFO, &payload);
        let err = parse_dylink_0(&data).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("trailing"), "{msg}");
    }

    #[test]
    fn rejects_invalid_utf8_in_needed() {
        let mut needed = Vec::new();
        write_varuint32(&mut needed, 1);
        write_varuint32(&mut needed, 2);
        needed.push(0xff);
        needed.push(0xfe);
        let data = make_subsection(KIND_NEEDED, &needed);
        let err = parse_dylink_0(&data).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("utf8"), "{msg}");
    }

    #[test]
    fn rejects_truncated_leb128() {
        // 0xff has the continuation bit set but the buffer ends.
        let data = vec![KIND_MEM_INFO, 1, 0xff];
        let err = parse_dylink_0(&data).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("LEB128") || msg.contains("truncated"), "{msg}");
    }

    #[test]
    fn soname_from_path_strips_lib_and_wasm() {
        assert_eq!(soname_from_path(Path::new("/lib/libfoo.wasm")), "foo");
        assert_eq!(
            soname_from_path(Path::new("libyurt_sched.wasm")),
            "yurt_sched"
        );
        assert_eq!(soname_from_path(Path::new("bar.wasm")), "bar");
        assert_eq!(soname_from_path(Path::new("plain")), "plain");
    }

    #[test]
    fn manifest_round_trips_through_json() {
        let m = Manifest {
            soname: "yurt_sched".into(),
            exports: vec!["sched_getaffinity".into(), "sched_getcpu".into()],
            deps: vec!["libyurt_abi.wasm".into()],
            mem_size: 64,
            mem_align: 4,
            table_size: 2,
            table_align: 0,
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
