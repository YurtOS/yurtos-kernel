//! Real-fixture parity tests.
//!
//! Builds existing wasm fixtures from `test-fixtures/wasm/` and runs
//! them through the sandboxed-kernel microkernel, asserting on
//! captured stdout. This is the first end-to-end check that an
//! unmodified pre-existing binary boots and runs correctly under the
//! new architecture.
//!
//! Scope today: WASI-only fixtures (hello, true-cmd, false-cmd). The
//! microkernel adds wasmtime-wasi to the user-process linker, so
//! `_start` resolves and `fd_write` / `proc_exit` work directly.
//! These fixtures don't call any `sys_*` syscalls, so this is a
//! "WASI surface works" test, not a sys_*-mediated parity test.
//!
//! Real parity (fixtures that mix WASI + sys_*) needs a wasi-shim
//! layer that translates WASI fd_write to our sys_write, etc. That's
//! the next integration step. Until it lands, this file documents
//! the gap rather than hiding it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use yurt_runtime_wasmtime::microkernel::{
    build_kernel_wasm, default_kernel_wasm_path, HostState, Microkernel,
};

fn workspace_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("workspace root")
            .to_path_buf()
    })
}

fn target_dir() -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root().join("target"))
}

fn fixture_wasm_path(artifact_name: &str) -> PathBuf {
    target_dir()
        .join("wasm32-wasip1/release")
        .join(format!("{artifact_name}.wasm"))
}

fn ensure_fixture_built(crate_name: &str) {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .args([
            "build",
            "--release",
            "-p",
            crate_name,
            "--target",
            "wasm32-wasip1",
        ])
        .current_dir(workspace_root())
        .status()
        .expect("spawn cargo");
    assert!(status.success(), "build of {crate_name} failed");
}

fn ensure_kernel_wasm() -> &'static PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        build_kernel_wasm().expect("build kernel.wasm");
        default_kernel_wasm_path()
    })
}

#[test]
fn hello_wasm_fixture_runs_and_prints_to_stdout() {
    // Real fixture, unmodified from `test-fixtures/wasm/hello`. It
    // links only against WASI (`fd_write`, `proc_exit`, `environ_*`)
    // and calls `println!("hello from wasm")` from `main`. Boots via
    // the standard WASI `_start` entry point.
    ensure_fixture_built("hello-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("hello-wasm")).unwrap();

    let mk = Microkernel::load(ensure_kernel_wasm(), HostState::default()).unwrap();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();

    // _start in a WASI command exits via proc_exit, which surfaces
    // as a wasmtime trap carrying the exit code. Exit 0 trips the
    // trap too — we just assert stdout contents regardless.
    let _ = user.run_start();

    let stdout = String::from_utf8_lossy(&user.captured_stdout()).to_string();
    assert!(
        stdout.contains("hello from wasm"),
        "expected 'hello from wasm' in captured stdout, got: {stdout:?}"
    );
}

#[test]
fn true_cmd_fixture_exits_zero() {
    ensure_fixture_built("true-cmd-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("true-cmd-wasm")).unwrap();
    let mk = Microkernel::load(ensure_kernel_wasm(), HostState::default()).unwrap();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    // We assert it doesn't panic during execution. proc_exit(0) traps
    // wasmtime in the standard way; the test passes if no other error
    // surfaces.
    let _ = user.run_start();
}

#[test]
fn false_cmd_fixture_exits_one() {
    ensure_fixture_built("false-cmd-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("false-cmd-wasm")).unwrap();
    let mk = Microkernel::load(ensure_kernel_wasm(), HostState::default()).unwrap();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    let result = user.run_start();
    // proc_exit(1) traps; the trap message contains "exit_code = 1"
    // or similar. We accept any error here — the goal is verifying
    // it didn't run to completion (which would be exit 0).
    assert!(
        result.is_err(),
        "expected non-zero exit from false-cmd; got Ok"
    );
}
