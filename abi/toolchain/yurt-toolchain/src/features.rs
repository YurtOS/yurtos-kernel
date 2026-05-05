use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

const SECTION_ID_CUSTOM: u8 = 0;

pub const YURT_FEATURES_SECTION: &str = "yurt.features";
pub const SETJMP_FEATURES_JSON: &[u8] = br#"{"async":"asyncify","features":["setjmp"]}"#;

pub fn append_setjmp_features(path: &Path) -> Result<()> {
    append_custom_section(path, YURT_FEATURES_SECTION, SETJMP_FEATURES_JSON)
}

fn append_custom_section(path: &Path, name: &str, payload: &[u8]) -> Result<()> {
    let mut wasm = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let mut section = Vec::new();
    encode_u32(name.len() as u32, &mut section);
    section.extend_from_slice(name.as_bytes());
    section.extend_from_slice(payload);

    wasm.push(SECTION_ID_CUSTOM);
    encode_u32(section.len() as u32, &mut wasm);
    wasm.extend_from_slice(&section);

    fs::write(path, wasm).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn encode_u32(mut value: u32, out: &mut Vec<u8>) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_well_formed_custom_section() {
        let tmp = tempfile::tempdir().unwrap();
        let wasm = tmp.path().join("x.wasm");
        fs::write(&wasm, b"\0asm\x01\0\0\0").unwrap();

        append_setjmp_features(&wasm).unwrap();
        let bytes = fs::read(&wasm).unwrap();
        let mut found = false;
        for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
            if let wasmparser::Payload::CustomSection(section) = payload.unwrap() {
                if section.name() == YURT_FEATURES_SECTION {
                    found = true;
                    assert_eq!(section.data(), SETJMP_FEATURES_JSON);
                }
            }
        }
        assert!(found, "yurt.features section missing");
    }
}
