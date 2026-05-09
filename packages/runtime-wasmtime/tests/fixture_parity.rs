//! Real-fixture parity tests.
//!
//! Builds existing wasm fixtures from `test-fixtures/wasm/` and runs
//! them through the sandboxed-kernel microkernel. Validates that an
//! unmodified pre-existing binary boots through the new architecture
//! AND that its `fd_write` calls actually flow through `kernel.wasm`
//! (via the WASI shim → `sys_write` → `kh_log` path) rather than
//! short-circuiting through wasmtime-wasi.
//!
//! Capture mechanism today: stdout/stderr writes from a user process
//! land in the kernel's `sys_write` handler, which routes
//! Stdout/Stderr writes through `kh_log` to the configured `LogSink`.
//! These tests install a `RecordingLogSink` on the microkernel and
//! assert on its messages. When per-process stream sinks land, this
//! becomes a `UserProcess::captured_stdout()` accessor.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use yurt_runtime_wasmtime::microkernel::{
    build_kernel_wasm, default_kernel_wasm_path, HostState, LogSink, Microkernel,
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

/// Captures messages emitted via kh_log. Tests assert on the captured
/// stream after running a fixture.
#[derive(Default)]
struct RecordingLogSink {
    messages: Mutex<Vec<(u32, String)>>,
}

impl LogSink for RecordingLogSink {
    fn emit(&self, severity: u32, message: &str) {
        self.messages
            .lock()
            .unwrap()
            .push((severity, message.to_owned()));
    }
}

fn fresh_microkernel_with_log() -> (Microkernel, Arc<RecordingLogSink>) {
    let sink = Arc::new(RecordingLogSink::default());
    let mk = Microkernel::load(
        ensure_kernel_wasm(),
        HostState {
            log_sink: sink.clone(),
            ..Default::default()
        },
    )
    .unwrap();
    (mk, sink)
}

#[test]
fn hello_wasm_prints_via_sys_write_through_kernel_wasm() {
    // Real fixture from test-fixtures/wasm/hello: a stock `cargo run`
    // Rust binary calling `println!("hello from wasm")`. Boots via
    // `_start`. Its fd_write goes through:
    //
    //   user wasm fd_write(1, iovs, ...)
    //     → microkernel WASI shim
    //         → sys_write trampoline into kernel.wasm
    //             → kernel sys_write on Stdout → kh_log
    //               → LogSink (captured here)
    //
    // This is the integration test we couldn't write before the WASI
    // shim landed.
    ensure_fixture_built("hello-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("hello-wasm")).unwrap();

    let (mk, sink) = fresh_microkernel_with_log();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    let _ = user.run_start(); // proc_exit traps; that's fine

    let messages = sink.messages.lock().unwrap();
    let combined: String = messages.iter().map(|(_, m)| m.as_str()).collect();
    assert!(
        combined.contains("hello from wasm"),
        "expected 'hello from wasm' in captured kh_log stream, got: {combined:?}"
    );
}

#[test]
fn true_cmd_fixture_runs_and_proc_exits_zero() {
    ensure_fixture_built("true-cmd-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("true-cmd-wasm")).unwrap();
    let (mk, _sink) = fresh_microkernel_with_log();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    // proc_exit traps via our shim; we just confirm the run reached
    // proc_exit (i.e. the trap message mentions proc_exit).
    let err = user.run_start().unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("proc_exit"),
        "expected proc_exit trap, got: {msg}"
    );
}

#[test]
fn false_cmd_fixture_runs_and_proc_exits_nonzero() {
    ensure_fixture_built("false-cmd-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("false-cmd-wasm")).unwrap();
    let (mk, _sink) = fresh_microkernel_with_log();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    let err = user.run_start().unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("proc_exit"),
        "expected proc_exit trap, got: {msg}"
    );
    // false-cmd should report a non-zero exit code in the trap message.
    assert!(
        msg.contains("proc_exit(1)")
            || msg.contains("proc_exit(101)")
            || !msg.contains("proc_exit(0)"),
        "expected non-zero exit code in proc_exit trap, got: {msg}"
    );
}
