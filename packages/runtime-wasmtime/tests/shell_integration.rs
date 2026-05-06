//! Integration tests for WasmEngine + ShellInstance against the real
//! yurt-shell-exec.wasm binary.
//!
//! These are imported from the old runtime crate and intentionally ignored for
//! the first Yurt port slice. The active backend coverage lives in
//! `backend_scheduling.rs`; this file should be re-enabled when the Rust server
//! speaks the current Yurt shell/process semantics end to end.

use yurt_runtime_wasmtime::vfs::MemVfs;
use yurt_runtime_wasmtime::wasm::{ShellInstance, WasmEngine};

fn wasm_bytes() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm"),
    )
    .expect("yurt-shell-exec.wasm fixture should exist when shell integration tests are enabled")
}

async fn make_instance() -> anyhow::Result<ShellInstance> {
    let engine = WasmEngine::new()?;
    let vfs = MemVfs::new(None, None);
    let wasm = wasm_bytes();
    ShellInstance::new(&engine, &wasm, vfs, &[], 0).await
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn engine_creates_ok() {
    WasmEngine::new().expect("WasmEngine::new() should succeed");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn echo_hello() {
    let mut inst = make_instance().await.expect("ShellInstance::new");
    let result = inst.run_command("echo hello").await.expect("run_command");
    let exit_code = result["exit_code"].as_i64().unwrap_or(-1);
    assert_eq!(exit_code, 0, "exit_code should be 0, got: {result}");
    let stdout = inst.take_stdout();
    assert_eq!(stdout.as_ref(), b"hello\n", "stdout should be 'hello\\n', got: {stdout:?}");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn pwd_returns_home() {
    let mut inst = make_instance().await.expect("ShellInstance::new");
    let result = inst.run_command("pwd").await.expect("run_command");
    let exit_code = result["exit_code"].as_i64().unwrap_or(-1);
    assert_eq!(exit_code, 0, "exit_code should be 0, got: {result}");
    let stdout = inst.take_stdout();
    assert_eq!(
        stdout.as_ref(),
        b"/home/user\n",
        "pwd stdout should be '/home/user\\n', got: {stdout:?}"
    );
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn write_then_cat() {
    // Write a file into the VFS, then verify the shell can see it via input redirection.
    // (External `cat` is not available; use shell I/O redirection built-in behavior.)
    let mut inst = make_instance().await.expect("ShellInstance::new");
    inst.vfs_mut()
        .write_file("/tmp/test.txt", b"hello from vfs", false)
        .expect("write_file");
    // Verify the file is readable via VFS directly.
    let content = inst.vfs().read_file("/tmp/test.txt").expect("read_file");
    assert_eq!(content, b"hello from vfs", "VFS round-trip failed");
    // Verify the shell can stat the file (confirms host_stat sees VFS state).
    let result = inst
        .run_command("test -f /tmp/test.txt && echo ok")
        .await
        .expect("run_command");
    let exit_code = result["exit_code"].as_i64().unwrap_or(-1);
    assert_eq!(exit_code, 0, "exit_code should be 0, got: {result}");
    let stdout = inst.take_stdout();
    assert_eq!(stdout.as_ref(), b"ok\n", "test -f should confirm file exists, got: {stdout:?}");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn exit_code_propagated() {
    let mut inst = make_instance().await.expect("ShellInstance::new");
    let result = inst.run_command("false").await.expect("run_command");
    let exit_code = result["exit_code"].as_i64().unwrap_or(0);
    assert_ne!(exit_code, 0, "exit_code should be non-zero for 'false', got: {result}");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn stderr_captured() {
    // The shell binary routes all fd writes through WASI (both stdout and stderr
    // writes appear in the stdout_pipe / stderr_pipe based on the WASI fd used).
    // `echo err >&2` redirects output to the shell's fd 2.
    // Verify the command runs successfully and produces non-empty pipe output
    // (the exact pipe depends on WASI mapping, but the command must not hang).
    let mut inst = make_instance().await.expect("ShellInstance::new");
    let result = inst.run_command("echo err >&2").await.expect("run_command");
    let exit_code = result["exit_code"].as_i64().unwrap_or(-1);
    assert_eq!(exit_code, 0, "exit_code should be 0 for echo err >&2, got: {result}");
    // The redirected output lands in one of the two pipes; total bytes must be non-zero.
    let stdout = inst.take_stdout();
    let stderr = inst.take_stderr();
    let total_output = stdout.len() + stderr.len();
    assert!(
        total_output > 0,
        "expected non-empty output from echo err >&2, stdout={stdout:?} stderr={stderr:?}"
    );
}
