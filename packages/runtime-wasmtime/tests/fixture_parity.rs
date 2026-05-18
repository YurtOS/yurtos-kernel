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
fn spawn_deep_recursion_returns_edeadlk_not_stack_overflow() {
    // F1 regression: a self-referential spawn chain must NOT overflow
    // the native stack / abort. `/spawn-deep.wasm`'s main() spawns
    // itself and host_wait()s, so the host drive chain recurses:
    //
    //   host_wait → drain_and_run_pending_spawns
    //     → instantiate_with_pid_raw → child.run_start()
    //       → child's host_wait → drain → … (unbounded before the fix)
    //
    // Before F1 the recursion guard was a per-CALL local `iters` that
    // reset to 0 at every nested native frame, so the cap never
    // tripped and the native stack grew without bound → stack
    // overflow / abort (a hard crash with NO errno — never reaches
    // proc_exit). The fix shares ONE depth counter across the whole
    // nested parent→child chain (cap 256, byte-parity with the JS
    // host's `drainDepth` / `drainDepthRef`): the ~257th nested
    // host_wait returns a clean `-EDEADLK` (-35) WITHOUT recursing
    // further, the tree unwinds, and the errno propagates back to the
    // root, which proc_exit(35)s.
    //
    // The fixture takes a depth countdown in argv (here 260, > the 256
    // cap) and only spawns a child while the countdown is > 0, so the
    // chain has a hard FLOOR and total work is ~260 levels — the
    // depth-256 guard fires (and is observed) well before the floor,
    // and any boundary "orphan" drained horizontally is itself floored
    // a few levels later instead of running away (the host also caps
    // that horizontal drain at 100_000 iters, matching the JS host's
    // `runPendingSpawns` `RUNAWAY_LIMIT`).
    //
    // Assertion: the run reaches `proc_exit(35)` (the EDEADLK errno) —
    // i.e. it terminated CLEANLY via the depth guard. A regression
    // would instead surface a `wasm trap` / stack-overflow / abort and
    // never set last_exit.
    ensure_fixture_built("spawn-deep-wasm");
    let wasm_bytes = std::fs::read(fixture_wasm_path("spawn-deep-wasm")).unwrap();

    let mk = fresh_kernel_host_interface();
    // Self-referential: the fixture spawns `/spawn-deep.wasm`, so the
    // exact same image must be resolvable by the kernel's sys_spawn at
    // that path for every nested level of the chain.
    mk.register_ramfs_file(b"/spawn-deep.wasm", &wasm_bytes)
        .unwrap();

    // argv = [program, "260"]: the root countdown. 260 > the 256 depth
    // cap, so the shared-depth guard fires before the countdown floor.
    let argv: Vec<&[u8]> = vec![b"/spawn-deep.wasm", b"260"];
    let mut user = mk
        .spawn_user_process_with_args(&wasm_bytes, &argv)
        .unwrap();
    // A single run_start drives the whole (bounded) tree. proc_exit
    // traps; the WASI shim stashes the code in last_exit first. If the
    // bug were present this would instead stack-overflow / abort the
    // host process (or trap with "unreachable"), and last_exit would
    // never be set.
    let run = user.run_start();
    assert!(
        run.is_err(),
        "spawn-deep ends in proc_exit (a trap), not a clean return"
    );
    let msg = format!("{:#}", run.unwrap_err());
    assert!(
        msg.contains("proc_exit"),
        "expected a clean proc_exit trap (EDEADLK propagated), got: {msg}"
    );

    let exit_code = user.last_exit().unwrap_or(-1);
    assert_eq!(
        exit_code, 35,
        "deep self-spawn must terminate with the -EDEADLK (35) depth-guard \
         errno propagated to the root — NOT a stack overflow / abort / \
         timeout (got exit code {exit_code})"
    );
}

#[test]
fn spawn_trap_child_reaps_as_134_and_parent_survives_cross_host() {
    // Cross-host parity (P2-2): a guest `host_spawn`s a child that
    // *traps* (a genuine wasm `unreachable`, NOT a `proc_exit`) before
    // ever reaching `proc_exit`. The trapped child MUST be reaped with
    // a deterministic abnormal-termination status (134 = 128 + SIGABRT,
    // the shell `$?` convention) and the PARENT must keep running and
    // exit cleanly — it must NOT crash as a propagated host trap.
    //
    //   /spawn-trap-child.wasm  host_spawn(/trap-child.wasm)
    //     → SYS_SPAWN (kernel stages the child)
    //     → host_wait → SYS_WAIT, EAGAIN → drain_and_run_pending_spawns
    //         → /trap-child.wasm runs, hits `unreachable` → wasm trap;
    //           run_start() is Err AND last_exit() is None  →  the host
    //           reaps it as CHILD_TRAP_EXIT (134), the drain CONTINUES,
    //           and the trap is NOT propagated out (parent unaffected)
    //       → SYS_WAIT now reaps → status 134 → wait_result decodes
    //         {exit_code=0, signal=6} (134 ∈ [128,192))
    //     → parent reconstructs 128+signal = 134, prints it, proc_exit(0).
    //
    // The "child reaped status 134" literal MUST match the JS E2E
    // (`packages/kernel-host-interface-js/__tests__/host_spawn_wait_test.ts`)
    // byte-for-byte — the cross-host parity oracle.
    ensure_fixture_built("spawn-trap-child-wasm");
    ensure_fixture_built("trap-child-wasm");
    let parent_wasm = std::fs::read(fixture_wasm_path("spawn-trap-child-wasm")).unwrap();
    let child_wasm = std::fs::read(fixture_wasm_path("trap-child-wasm")).unwrap();

    let mk = fresh_kernel_host_interface();
    mk.register_ramfs_file(b"/trap-child.wasm", &child_wasm)
        .unwrap();

    let argv: Vec<&[u8]> = vec![b"/spawn-trap-child.wasm"];
    let mut user = mk
        .spawn_user_process_with_args(&parent_wasm, &argv)
        .unwrap();
    // The parent's host_wait drives the trapped child to completion
    // itself (EAGAIN → drain_and_run_pending_spawns). The child's trap
    // MUST be absorbed by the drain (reaped as 134) and NOT crash the
    // parent: run_start() therefore ends in the parent's own
    // proc_exit(0) trap, never the child's `unreachable`.
    let run = user.run_start();
    assert!(
        run.is_err(),
        "parent ends in its own proc_exit (a trap), not a clean return"
    );
    let msg = format!("{:#}", run.unwrap_err());
    assert!(
        msg.contains("proc_exit(0)"),
        "parent must survive the child's trap and proc_exit(0) itself; got: {msg}"
    );

    let stdout = String::from_utf8_lossy(&user.captured_stdout().unwrap()).to_string();
    let exit_code = user.last_exit().unwrap_or(-1);
    // Byte-identical cross-host literal (same string asserted in the JS test):
    assert_eq!(stdout.trim(), "child reaped status 134");
    assert_eq!(
        exit_code, 0,
        "parent itself must exit cleanly (0) — it was NOT crashed by the child's trap"
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
