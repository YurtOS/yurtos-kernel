//! End-to-end tests for `yurt-wasi-postlink --side-module`.
//!
//! Each test builds a tiny wasm with walrus, attaches a synthetic
//! `dylink.0` custom section, runs the binary, and inspects the
//! emitted `<output>.yurtmeta.json` sidecar.

use std::fs;
use std::path::Path;
use std::process::Command;

use serde_json::Value;
use walrus::{ConstExpr, FunctionBuilder, Module, RawCustomSection, ValType};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_yurt-wasi-postlink")
}

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

fn make_mem_info(mem_size: u32, mem_align: u32, table_size: u32, table_align: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_varuint32(&mut payload, mem_size);
    write_varuint32(&mut payload, mem_align);
    write_varuint32(&mut payload, table_size);
    write_varuint32(&mut payload, table_align);
    let mut out = vec![1u8];
    write_varuint32(&mut out, payload.len() as u32);
    out.extend(payload);
    out
}

fn make_needed(deps: &[&str]) -> Vec<u8> {
    let mut payload = Vec::new();
    write_varuint32(&mut payload, deps.len() as u32);
    for d in deps {
        write_str(&mut payload, d);
    }
    let mut out = vec![2u8];
    write_varuint32(&mut out, payload.len() as u32);
    out.extend(payload);
    out
}

/// Build a minimal valid side-module wasm: one exported function
/// `yurt_dlcanary_double` that returns 0, plus a `dylink.0` custom
/// section.
fn build_side_module(out: &Path, dylink_data: Vec<u8>, exports: &[&str]) {
    let mut m = Module::default();
    for name in exports {
        let mut builder = FunctionBuilder::new(&mut m.types, &[ValType::I32], &[ValType::I32]);
        let arg = m.locals.add(ValType::I32);
        builder.func_body().local_get(arg);
        let f = builder.finish(vec![arg], &mut m.funcs);
        m.exports.add(name, f);
    }
    // Add an exported global so `collect_dynamic_exports` covers both
    // function and global cases in real builds.
    let g = m.globals.add_local(
        ValType::I32,
        false,
        false,
        ConstExpr::Value(walrus::ir::Value::I32(0)),
    );
    m.exports.add("__yurt_canary_global", g);

    m.customs.add(RawCustomSection {
        name: "dylink.0".to_string(),
        data: dylink_data,
    });

    m.emit_wasm_file(out).unwrap();
}

#[test]
fn side_module_emits_manifest_with_parsed_dylink_0() {
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("libyurt_dlcanary.wasm");
    let output = tmp.path().join("libyurt_dlcanary.out.wasm");

    let mut dylink = make_mem_info(2048, 4, 16, 0);
    dylink.extend(make_needed(&["libc.wasm", "libm.wasm"]));

    build_side_module(&input, dylink, &["yurt_dlcanary_double"]);

    let status = Command::new(bin())
        .arg("--side-module")
        .arg("--input")
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .status()
        .unwrap();
    assert!(status.success(), "yurt-wasi-postlink --side-module failed");

    assert!(output.exists(), "output wasm missing");
    let meta_path = tmp.path().join("libyurt_dlcanary.out.wasm.yurtmeta.json");
    let meta_text = fs::read_to_string(&meta_path).expect("manifest written");

    let meta: Value = serde_json::from_str(&meta_text).unwrap();
    assert_eq!(meta["soname"], "yurt_dlcanary");
    assert_eq!(meta["mem_size"], 2048);
    assert_eq!(meta["mem_align"], 4);
    assert_eq!(meta["table_size"], 16);
    assert_eq!(meta["table_align"], 0);
    assert_eq!(meta["deps"], serde_json::json!(["libc.wasm", "libm.wasm"]));
    let exports = meta["exports"].as_array().unwrap();
    let names: Vec<&str> = exports.iter().filter_map(|v| v.as_str()).collect();
    assert!(names.contains(&"yurt_dlcanary_double"), "{names:?}");
    assert!(names.contains(&"__yurt_canary_global"), "{names:?}");
}

#[test]
fn side_module_soname_flag_overrides_basename() {
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("anything.wasm");
    let output = tmp.path().join("anything.out.wasm");
    build_side_module(&input, make_mem_info(0, 0, 0, 0), &["x"]);

    let status = Command::new(bin())
        .arg("--side-module")
        .arg("--input")
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .arg("--soname")
        .arg("custom_name")
        .status()
        .unwrap();
    assert!(status.success());

    let meta: Value = serde_json::from_str(
        &fs::read_to_string(tmp.path().join("anything.out.wasm.yurtmeta.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(meta["soname"], "custom_name");
}

#[test]
fn side_module_meta_out_flag_redirects_manifest() {
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("libfoo.wasm");
    let output = tmp.path().join("libfoo.out.wasm");
    let meta = tmp.path().join("elsewhere/foo.json");
    build_side_module(&input, make_mem_info(0, 0, 0, 0), &["foo"]);

    let status = Command::new(bin())
        .arg("--side-module")
        .arg("--input")
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .arg("--meta-out")
        .arg(&meta)
        .status()
        .unwrap();
    assert!(status.success());
    assert!(meta.exists(), "manifest at custom --meta-out path");
    assert!(
        !tmp.path().join("libfoo.out.wasm.yurtmeta.json").exists(),
        "default manifest path must not be written when --meta-out is set"
    );
}

#[test]
fn side_module_rejects_wasm_without_dylink_0() {
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("plain.wasm");
    let output = tmp.path().join("plain.out.wasm");

    // A plain wasm with no dylink.0 section.
    let mut m = Module::default();
    let mut builder = FunctionBuilder::new(&mut m.types, &[], &[]);
    builder.func_body();
    let f = builder.finish(vec![], &mut m.funcs);
    m.exports.add("noop", f);
    m.emit_wasm_file(&input).unwrap();

    let out = Command::new(bin())
        .arg("--side-module")
        .arg("--input")
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .output()
        .unwrap();
    assert!(!out.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("dylink.0"),
        "stderr should mention the missing section: {stderr}"
    );
}

#[test]
fn side_module_rejects_malformed_dylink_0() {
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("broken.wasm");
    let output = tmp.path().join("broken.out.wasm");

    // mem_info subsection declares 99 bytes but provides only 1.
    let bad_dylink = vec![1u8, 99, 0x00];
    build_side_module(&input, bad_dylink, &["x"]);

    let out = Command::new(bin())
        .arg("--side-module")
        .arg("--input")
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .output()
        .unwrap();
    assert!(!out.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("truncated") || stderr.contains("dylink.0"),
        "stderr should describe the malformed section: {stderr}"
    );
}
