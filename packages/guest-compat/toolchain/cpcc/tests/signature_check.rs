use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .unwrap()
}

fn check_bin() -> &'static str {
    env!("CARGO_BIN_EXE_cpcheck")
}

#[test]
fn signature_check_passes_on_canary_built_via_cpcc() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skip — WASI_SDK_PATH not set");
        return;
    }
    let root = repo_root();
    // Build the archive.
    let st = Command::new("make")
        .current_dir(root.join("packages/guest-compat"))
        .arg("lib")
        .status()
        .unwrap();
    assert!(st.success(), "make lib failed");

    let archive = root.join("packages/guest-compat/build/libyurt_guest_compat.a");
    let tmp = tempfile::tempdir().unwrap();
    let out_wasm = tmp.path().join("dup2-canary.wasm");
    let preserved = tmp.path().join("dup2-canary.pre-opt.wasm");

    // Build dup2 canary via cpcc with preservation.
    let cc = env!("CARGO_BIN_EXE_cpcc");
    let st = Command::new(cc)
        .env("CPCC_ARCHIVE", &archive)
        .env("CPCC_INCLUDE", root.join("packages/guest-compat/include"))
        .env("CPCC_PRESERVE_PRE_OPT", &preserved)
        .env("CPCC_NO_WASM_OPT", "1")
        .arg(root.join("packages/guest-compat/conformance/c/dup2-canary.c"))
        .arg("-o")
        .arg(&out_wasm)
        .status()
        .unwrap();
    assert!(st.success(), "cpcc failed");

    // Run the check.
    let st = Command::new(check_bin())
        .arg("--archive")
        .arg(&archive)
        .arg("--pre-opt-wasm")
        .arg(&preserved)
        .arg("--symbol")
        .arg("dup2")
        .status()
        .unwrap();
    assert!(st.success(), "signature check failed on well-formed input");
}

#[test]
fn signature_check_fails_when_symbol_body_does_not_call_marker() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skip — WASI_SDK_PATH not set");
        return;
    }
    // Compile a Tier 1 impl that omits the marker call — link without the
    // compat archive. The check must fail.
    let root = repo_root();
    let tmp = tempfile::tempdir().unwrap();
    let stub_src = tmp.path().join("stub_dup2.c");
    std::fs::write(
        &stub_src,
        b"#include <unistd.h>\nint dup2(int a, int b) { (void)a; (void)b; return -1; }\nint main(void){return 0;}",
    )
    .unwrap();
    let out_wasm = tmp.path().join("stub.wasm");

    let cc = env!("CARGO_BIN_EXE_cpcc");
    let st = Command::new(cc)
        .env("CPCC_NO_WASM_OPT", "1")
        .env("CPCC_PRESERVE_PRE_OPT", &out_wasm)
        .arg(&stub_src)
        .arg("-o")
        .arg(tmp.path().join("stub.out.wasm"))
        .status()
        .unwrap();
    assert!(st.success());

    let archive = root.join("packages/guest-compat/build/libyurt_guest_compat.a");
    let st = Command::new(check_bin())
        .arg("--archive")
        .arg(&archive)
        .arg("--pre-opt-wasm")
        .arg(&out_wasm)
        .arg("--symbol")
        .arg("dup2")
        .status()
        .unwrap();
    assert!(!st.success(), "signature check should have failed on stub");
}
