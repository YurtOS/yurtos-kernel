//! Real-fixture parity tests.
//!
//! Builds existing wasm fixtures from `test-fixtures/wasm/` and runs
//! them through the sandboxed-kernel kernel_host_interface. Captures each
//! process's stdout/stderr from the kernel's per-pid buffer (drained
//! via `METHOD_KERNEL_DRAIN_STDOUT` after the run completes), so
//! tests assert on bytes the *kernel* observed, not on a host-side
//! shortcut.
//!
//! End-to-end byte path validated by every test below:
//!
//!   user wasm fd_write(1, ...)
//!     → kernel_host_interface WASI shim
//!         → trampoline_request(METHOD_SYS_WRITE, [fd|payload])
//!             → kernel.wasm sys_write on FdEntry::Stdout
//!                 → Process.stdout_buffer (per-pid)
//!                 ← UserProcess::captured_stdout() drain

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use yurt_runtime_wasmtime::kernel_host_interface::{
    build_kernel_wasm, default_kernel_wasm_path, HostState, KernelHostInterface,
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

/// Build a continuation fixture: plain cargo build, then wasm-opt
/// --asyncify in place (mirrors yurt-cc's continuation_args so the
/// Rust-crate fixtures match the C-canary asyncify build exactly).
fn ensure_fixture_built_asyncify(crate_name: &str) {
    ensure_fixture_built(crate_name);
    let wasm = fixture_wasm_path(crate_name);
    let wasm_opt = which::which("wasm-opt")
        .expect("wasm-opt on PATH (Binaryen) required for asyncify fixtures");
    let status = Command::new(wasm_opt)
        .args([
            "-O2",
            "--enable-bulk-memory",
            "--enable-sign-ext",
            "--enable-nontrapping-float-to-int",
            "--asyncify",
        ])
        .arg(&wasm)
        .arg("-o")
        .arg(&wasm)
        .status()
        .expect("spawn wasm-opt");
    assert!(
        status.success(),
        "wasm-opt --asyncify failed for {crate_name}"
    );
}

fn ensure_kernel_wasm() -> &'static PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        build_kernel_wasm().expect("build kernel.wasm");
        default_kernel_wasm_path()
    })
}

fn fresh_kernel_host_interface() -> KernelHostInterface {
    KernelHostInterface::load(ensure_kernel_wasm(), HostState::default()).unwrap()
}

fn sys_method_constant(method_name: &str) -> String {
    format!("METHOD_{}", method_name.to_ascii_uppercase())
}

fn sys_methods_from_contract() -> BTreeSet<String> {
    let path = workspace_root().join("abi/contract/yurt_abi_methods.toml");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!("read {}: {err}", path.display());
    });
    let value: toml::Value = toml::from_str(&text).unwrap_or_else(|err| {
        panic!("parse {}: {err}", path.display());
    });
    let methods = value
        .get("method")
        .and_then(toml::Value::as_table)
        .expect("method table");
    methods
        .keys()
        .filter(|name| name.starts_with("sys_"))
        .map(|name| sys_method_constant(name))
        .collect()
}

fn method_id_from_contract(method_name: &str) -> i64 {
    let path = workspace_root().join("abi/contract/yurt_abi_methods.toml");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!("read {}: {err}", path.display());
    });
    let value: toml::Value = toml::from_str(&text).unwrap_or_else(|err| {
        panic!("parse {}: {err}", path.display());
    });
    value
        .get("method")
        .and_then(toml::Value::as_table)
        .and_then(|methods| methods.get(method_name))
        .and_then(toml::Value::as_table)
        .and_then(|method| method.get("id"))
        .and_then(toml::Value::as_integer)
        .unwrap_or_else(|| panic!("missing integer id for method.{method_name}"))
}

fn dispatch_sys_arms() -> BTreeSet<String> {
    let mut constants = BTreeSet::new();
    let dispatch_dir = workspace_root().join("packages/kernel-wasm/src/dispatch");
    for entry in std::fs::read_dir(&dispatch_dir).unwrap_or_else(|err| {
        panic!("read {}: {err}", dispatch_dir.display());
    }) {
        let path = entry.expect("dispatch entry").path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap_or_else(|err| {
            panic!("read {}: {err}", path.display());
        });
        for line in text.lines().filter(|line| line.contains("=>")) {
            let Some(start) = line.find("METHOD_SYS_") else {
                continue;
            };
            let rest = &line[start..];
            let end = rest
                .find(|ch: char| !ch.is_ascii_uppercase() && !ch.is_ascii_digit() && ch != '_')
                .unwrap_or(rest.len());
            constants.insert(rest[..end].to_string());
        }
    }
    constants
}

fn intentionally_deferred_sys_methods() -> BTreeSet<String> {
    let path = workspace_root()
        .join("docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!("read {}: {err}", path.display());
    });
    text.lines()
        .filter(|line| {
            line.starts_with('|')
                && line.contains("intentionally deferred")
                && !line.contains("---")
        })
        .filter_map(|line| {
            line.split('|')
                .find_map(|cell| {
                    cell.split_whitespace()
                        .find(|word| word.starts_with("METHOD_SYS_"))
                })
                .map(|word| {
                    word.trim_matches(|ch: char| {
                        !(ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
                    })
                    .to_string()
                })
        })
        .collect()
}

#[test]
fn thread_syscall_method_ids_are_stable() {
    assert_eq!(method_id_from_contract("sys_thread_spawn"), 0x1_004D);
    assert_eq!(method_id_from_contract("sys_thread_self"), 0x1_004E);
    assert_eq!(method_id_from_contract("sys_thread_join"), 0x1_004F);
    assert_eq!(method_id_from_contract("sys_thread_detach"), 0x1_0050);
    assert_eq!(method_id_from_contract("sys_thread_exit"), 0x1_0051);
    assert_eq!(method_id_from_contract("sys_thread_yield"), 0x1_0052);
}

#[test]
fn every_sys_method_has_dispatch_or_documented_deferral() {
    let sys_methods = sys_methods_from_contract();
    let dispatch_arms = dispatch_sys_arms();
    let deferred = intentionally_deferred_sys_methods();
    let missing: Vec<_> = sys_methods
        .difference(&dispatch_arms)
        .filter(|method| !deferred.contains(*method))
        .cloned()
        .collect();
    assert!(
        missing.is_empty(),
        "sys methods missing from kernel-wasm dispatch and parity matrix deferrals: {missing:?}"
    );
}

#[test]
fn hello_wasm_prints_via_sys_write_through_kernel_wasm() {
    ensure_fixture_built("hello-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("hello-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    let _ = user.run_start(); // proc_exit traps; that's fine

    let stdout = String::from_utf8_lossy(&user.captured_stdout().unwrap()).to_string();
    assert_eq!(
        stdout, "hello from wasm\n",
        "hello-wasm wrote exactly its expected stdout via the kernel"
    );
}

#[test]
fn echo_args_fixture_emits_argv_one_per_line() {
    ensure_fixture_built("echo-args-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("echo-args-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let argv: Vec<&[u8]> = vec![b"echo-args", b"alpha", b"beta", b"gamma"];
    let mut user = mk.spawn_user_process_with_args(&wasm_bytes, &argv).unwrap();
    let _ = user.run_start();

    let stdout = String::from_utf8_lossy(&user.captured_stdout().unwrap()).to_string();
    assert_eq!(
        stdout, "alpha\nbeta\ngamma\n",
        "echo-args wrote argv[1..] one per line"
    );
}

#[test]
fn cat_stdin_fixture_echoes_stdin_to_stdout() {
    ensure_fixture_built("cat-stdin-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("cat-stdin-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let argv: Vec<&[u8]> = vec![b"cat-stdin"];
    let mut user = mk
        .spawn_user_process_with_args_and_stdin(
            &wasm_bytes,
            &argv,
            b"sandboxed kernel input\n",
            true,
        )
        .unwrap();
    let _ = user.run_start();

    let stdout = user.captured_stdout().unwrap();
    assert_eq!(stdout, b"sandboxed kernel input\n");
}

#[test]
fn wc_bytes_fixture_counts_stdin_bytes() {
    ensure_fixture_built("wc-bytes-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("wc-bytes-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let argv: Vec<&[u8]> = vec![b"wc-bytes"];
    let mut user = mk
        .spawn_user_process_with_args_and_stdin(&wasm_bytes, &argv, b"0123456789", true)
        .unwrap();
    let _ = user.run_start();

    let stdout = String::from_utf8_lossy(&user.captured_stdout().unwrap()).to_string();
    assert_eq!(stdout, "10\n");
}

#[test]
fn true_cmd_fixture_runs_and_proc_exits_zero() {
    ensure_fixture_built("true-cmd-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("true-cmd-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    let err = user.run_start().unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("proc_exit"),
        "expected proc_exit trap, got: {msg}"
    );
}

#[test]
fn cat_ramfs_fixture_reads_through_wasi_path_open() {
    // First fixture that exercises std::fs::File::open against the
    // in-memory ramfs. Drives the full WASI shim path:
    //
    //   user wasm  fs::read("/etc/motd")
    //     → wasi-libc fd_prestat_get walk → fd 3 = "/" preopen
    //     → wasi-libc path_open(dirfd=3, "etc/motd", …)
    //       → kernel_host_interface path_open shim → sys_open("/etc/motd")
    //         → kernel.wasm sys_open → FdEntry::File at fd 3
    //     → fd_read(fd=3, …) → sys_read → file bytes
    ensure_fixture_built("cat-ramfs-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("cat-ramfs-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    mk.register_ramfs_file(b"/etc/motd", b"hello ramfs\n")
        .unwrap();
    let argv: Vec<&[u8]> = vec![b"cat-ramfs"];
    let mut user = mk.spawn_user_process_with_args(&wasm_bytes, &argv).unwrap();
    let _ = user.run_start(); // proc_exit traps; that's fine
    let stdout = user.captured_stdout().unwrap();
    assert_eq!(
        stdout, b"hello ramfs\n",
        "cat-ramfs printed registered file via std::fs::read"
    );
}

#[test]
fn proc_cmdline_fixture_round_trips_argv() {
    // End-to-end: spawn a real wasm with argv → kernel_host_interface pushes
    // argv to kernel via kernel_set_argv → /proc/self/cmdline serves
    // it back NUL-separated → process prints it through fd_write.
    ensure_fixture_built("proc-cmdline-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("proc-cmdline-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let argv: Vec<&[u8]> = vec![b"/usr/bin/proc-cmdline", b"--flag", b"value"];
    let mut user = mk.spawn_user_process_with_args(&wasm_bytes, &argv).unwrap();
    let _ = user.run_start();

    let stdout = user.captured_stdout().unwrap();
    assert_eq!(
        stdout, b"/usr/bin/proc-cmdline\0--flag\0value\0",
        "/proc/self/cmdline should serve NUL-separated argv"
    );
}

#[test]
fn spawn_wait_fixture_reaps_child_exit_code_cross_host() {
    // Cross-host parity: a guest using `yurt_process::Command` (which
    // imports `yurt.host_spawn` / `yurt.host_wait`) must run on the
    // Rust `KernelHostInterface` host byte-identically to the JS E2E
    // (`packages/runner/src/__tests__/spawn_wait_test.ts`):
    //
    //   /spawn-wait.wasm  Command::new("/child-exit7.wasm").status()
    //     → yurt.host_spawn → SYS_SPAWN (kernel stages the child)
    //     → yurt.host_wait  → SYS_WAIT, EAGAIN → drain_and_run_pending_spawns
    //         → /child-exit7.wasm runs, proc_exit(7), record_exit
    //       → SYS_WAIT now reaps → {exitedPid, exit_code=7, signal=0}
    //     → parent prints "child exited 7" and proc_exit(0).
    //
    // The "child exited 7" literal MUST match the JS E2E byte-for-byte.
    ensure_fixture_built("spawn-wait-wasm");
    ensure_fixture_built("child-exit7-wasm");
    let parent_wasm = std::fs::read(fixture_wasm_path("spawn-wait-wasm")).unwrap();
    let child_wasm = std::fs::read(fixture_wasm_path("child-exit7-wasm")).unwrap();

    let mk = fresh_kernel_host_interface();
    // Stage the child into the kernel ramfs at the path the fixture
    // resolves (`Command::new("/child-exit7.wasm")`). The kernel's
    // `sys_spawn` reads the image straight out of the VFS by this path.
    mk.register_ramfs_file(b"/child-exit7.wasm", &child_wasm)
        .unwrap();

    let argv: Vec<&[u8]> = vec![b"/spawn-wait.wasm"];
    let mut user = mk
        .spawn_user_process_with_args(&parent_wasm, &argv)
        .unwrap();
    // The parent's `host_wait` drives the staged child to completion
    // itself (EAGAIN → drain_and_run_pending_spawns), so a single
    // run_start drives the whole tree. proc_exit(0) traps; the WASI
    // shim stashes the code in last_exit first (same as every other
    // proc_exit fixture above).
    let _ = user.run_start();

    let stdout = String::from_utf8_lossy(&user.captured_stdout().unwrap()).to_string();
    let exit_code = user.last_exit().unwrap_or(-1);
    assert_eq!(stdout.trim(), "child exited 7");
    assert_eq!(exit_code, 0);
}

#[test]
fn spawn_badreq_host_spawn_returns_einval_for_short_buffer() {
    // Negative test: a guest that passes a deliberately too-short buffer
    // (10 bytes, below the 88-byte yurt_spawn_request_v1 minimum) to the
    // raw `yurt.host_spawn` import must receive -22 (EINVAL) back — no
    // panic, no trap. The fixture exits with `abs(rc)` so we observe the
    // errno as the process exit code (22).
    ensure_fixture_built("spawn-badreq-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("spawn-badreq-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    let _ = user.run_start(); // proc_exit traps; that's fine
    let exit_code = user.last_exit().unwrap_or(-1);
    assert_eq!(
        exit_code, 22,
        "host_spawn must return -EINVAL(-22) for a too-short request buffer (got exit code {exit_code})"
    );
}

#[test]
fn false_cmd_fixture_runs_and_proc_exits_nonzero() {
    ensure_fixture_built("false-cmd-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("false-cmd-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    let err = user.run_start().unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("proc_exit"),
        "expected proc_exit trap, got: {msg}"
    );
    assert!(
        !msg.contains("proc_exit(0)"),
        "false-cmd should report a non-zero exit code; got: {msg}"
    );
}

#[test]
fn asyncify_fixture_exports_state_machine() {
    // T1: ensure_fixture_built must, for a continuation fixture, run
    // wasm-opt --asyncify so the artifact exports the asyncify_* state
    // machine and yurt_asyncify_buf_addr/size. fork-twice is built
    // through the continuation path (it imports yurt.host_fork).
    ensure_fixture_built_asyncify("fork-twice-wasm");
    let bytes = std::fs::read(fixture_wasm_path("fork-twice-wasm")).unwrap();
    let module = wasmtime::Module::new(&wasmtime::Engine::default(), &bytes).unwrap();
    let exports: Vec<&str> = module.exports().map(|e| e.name()).collect();
    for want in [
        "asyncify_start_unwind",
        "asyncify_stop_unwind",
        "asyncify_start_rewind",
        "asyncify_stop_rewind",
        "asyncify_get_state",
        "yurt_asyncify_buf_addr",
        "yurt_asyncify_buf_size",
    ] {
        assert!(
            exports.contains(&want),
            "asyncify fixture missing export {want}; exports={exports:?}"
        );
    }
}

/// CHARACTERIZING TEST (fork Task 0 capture spike). Pins the *current*
/// `runtime-wasmtime` `host_fork` behavior; it is NOT the eventual
/// correctness oracle. See
/// `docs/superpowers/plans/2026-05-17-fork-capture-notes.md` for the
/// full snapshot-vs-rebuild analysis this test backs.
///
/// The `fork-twice` fixture sets `FORK_SENTINEL = 42`, calls the raw
/// `yurt.host_fork` import, then prints `fork-twice <branch> rc=<rc>
/// sentinel=<n>`. A TRUE continuation snapshot would yield TWO lines —
/// a parent line (`rc>0`) AND a child line (`rc=0 sentinel=42`,
/// proving the child resumed at the fork() site with the parent's
/// post-sentinel memory). A REBUILD yields only the parent line: the
/// host (`kernel_host_interface.rs:3551` `host_fork` →
/// `snapshot_user_memory` copies linear memory bytes only →
/// `instantiate_fork_child:813` builds a FRESH instance with
/// `forced_fork_return: Some(0)` → child driven via `call_run()` which
/// looks for an exported `run` a standard wasm32-wasip1 binary does not
/// have, so the child never executes). The execution stack is never
/// captured, so this is not a continuation.
///
/// This test asserts the OBSERVED rebuild behavior so a future Task 2
/// that implements a real snapshot will *fail here loudly* and force
/// this characterization to be replaced with the real cross-host
/// oracle (Task 4).
#[test]
fn fork_twice_characterizes_current_host_fork() {
    ensure_fixture_built("fork-twice-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("fork-twice-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let mut user = mk.spawn_user_process(&wasm_bytes).unwrap();
    // The parent fixture proc_exit(0)s after host_fork returns the
    // child pid; that traps via the WASI shim (last_exit stashed
    // first), exactly like every other proc_exit fixture above.
    let _ = user.run_start();

    let stdout = String::from_utf8_lossy(&user.captured_stdout().unwrap()).to_string();
    let exit_code = user.last_exit().unwrap_or(-1);

    // CURRENT (rebuild) behavior, asserted explicitly so it cannot
    // silently regress and so Task 2 trips on it:
    //
    //  * Exactly ONE line — the parent's. NO `rc=0` child line, because
    //    the rebuilt child is driven via the absent `run` export and
    //    never runs (proving "not a continuation snapshot").
    //  * The parent's `host_fork` returned a positive child pid
    //    (`prepare_fork`/`commit_fork` allocated one), so the line is
    //    `fork-twice parent rc=<pid>0 sentinel=42`.
    //  * Parent proc_exit(0).
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "CHARACTERIZING: current host_fork is a rebuild (no continuation); \
         expected exactly the parent line, got stdout: {stdout:?}"
    );
    let line = lines[0];
    assert!(
        line.starts_with("fork-twice parent rc="),
        "CHARACTERIZING: expected the parent branch line, got: {line:?}"
    );
    assert!(
        line.ends_with("sentinel=42"),
        "CHARACTERIZING: parent keeps its own pre-fork sentinel, got: {line:?}"
    );
    let rc: i32 = line
        .strip_prefix("fork-twice parent rc=")
        .and_then(|s| s.strip_suffix(" sentinel=42"))
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("could not parse rc from {line:?}"));
    assert!(
        rc > 0,
        "CHARACTERIZING: parent host_fork returns the allocated child pid (>0), got rc={rc}"
    );
    assert!(
        !stdout.contains("rc=0"),
        "CHARACTERIZING: a `rc=0` child line would mean a real continuation \
         snapshot landed — replace this characterization with the Task 4 \
         oracle. stdout: {stdout:?}"
    );
    assert_eq!(
        exit_code, 0,
        "CHARACTERIZING: parent proc_exit(0) after host_fork"
    );
}

/// T1/M2 ORACLE (RED until T2a). The real continuation contract:
/// fork-twice must emit TWO lines — parent (sentinel=42) AND child
/// (`rc=0 sentinel=42`, proving the child resumed at the fork() site
/// with the parent's post-sentinel memory). Live target T2a iterates
/// against; T4 promotes it to the cross-host oracle. #[ignore] so it
/// does not break CI before T2a — run explicitly with `-- --ignored`.
#[test]
#[ignore = "RED until T2a lands real continuation; M2 live target"]
fn fork_twice_real_continuation_oracle() {
    ensure_fixture_built_asyncify("fork-twice-wasm");
    let wasm = std::fs::read(fixture_wasm_path("fork-twice-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let mut user = mk.spawn_user_process(&wasm).unwrap();
    let _ = user.run_start();
    let _ = mk.run_pending_spawns();
    let stdout = String::from_utf8_lossy(&user.captured_stdout().unwrap()).to_string();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(
        lines.len(),
        2,
        "expected parent+child lines, got {stdout:?}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("fork-twice parent") && l.ends_with("sentinel=42")),
        "missing parent line: {stdout:?}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l == &"fork-twice child rc=0 sentinel=42"),
        "missing child continuation line (rebuild, not continuation): {stdout:?}"
    );
}
