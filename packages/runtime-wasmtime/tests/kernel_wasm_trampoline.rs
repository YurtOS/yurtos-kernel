//! End-to-end smoke tests for the sandboxed-kernel architecture.
//!
//! Builds `yurt-kernel-wasm` for `wasm32-wasip1`, loads it through the
//! [`Microkernel`] skeleton, and exercises the trampoline in both
//! directions: user→kernel via `kernel_dispatch`, and kernel→host via
//! the `kh_*` import surface. See
//! `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use wasmtime::{Engine, Module};

use yurt_runtime_wasmtime::microkernel::{
    build_kernel_wasm, default_kernel_wasm_path, ExtensionRegistry, HostState, LogSink, Microkernel,
};

/// Build kernel.wasm exactly once across all parallel tests. Without
/// this, two tests can race the cargo invocation and read a missing or
/// half-written artifact.
fn ensure_kernel_wasm_built() -> &'static PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        build_kernel_wasm().expect("build kernel.wasm");
        default_kernel_wasm_path()
    })
}

const ENOSYS: i64 = 38;
const METHOD_ECHO: u32 = 1;
const METHOD_NOW_REALTIME: u32 = 2;
const METHOD_SYS_GETUID: u32 = 0x1_0001;
const METHOD_SYS_GETEUID: u32 = 0x1_0002;
const METHOD_SYS_GETGID: u32 = 0x1_0003;
const METHOD_SYS_GETEGID: u32 = 0x1_0004;
const METHOD_SYS_GETPID: u32 = 0x1_0005;
const METHOD_SYS_GETPPID: u32 = 0x1_0006;
const METHOD_SYS_UMASK: u32 = 0x1_0007;
const METHOD_SYS_SETRESUID: u32 = 0x1_0008;
const METHOD_SYS_SETRESGID: u32 = 0x1_0009;
const METHOD_SYS_CHDIR: u32 = 0x1_000A;
const METHOD_SYS_GETCWD: u32 = 0x1_000B;
const METHOD_SYS_GETRLIMIT: u32 = 0x1_000C;
const METHOD_SYS_SETRLIMIT: u32 = 0x1_000D;
const METHOD_SYS_CLOSE: u32 = 0x1_000E;
const METHOD_SYS_DUP: u32 = 0x1_000F;
const METHOD_SYS_DUP2: u32 = 0x1_0011;
const METHOD_KERNEL_LOG_TEST: u32 = 3;
const METHOD_SYS_EXTENSION_INVOKE: u32 = 0x1_0010;

fn fresh_microkernel(now_ns: u64) -> Microkernel {
    Microkernel::load(
        ensure_kernel_wasm_built(),
        HostState {
            now_realtime_ns: now_ns,
            ..Default::default()
        },
    )
    .unwrap()
}

#[test]
fn unknown_method_returns_negated_enosys() {
    let mk = fresh_microkernel(0);
    let rc = mk.syscall(0xDEAD_BEEF, &[], &mut []).unwrap();
    assert_eq!(rc, -ENOSYS);
}

#[test]
fn kernel_wasm_export_surface_is_locked() {
    // Architectural invariant: kernel.wasm exposes exactly the contract
    // the microkernel relies on, nothing more.
    let wasm = std::fs::read(ensure_kernel_wasm_built()).unwrap();
    let engine = Engine::default();
    let module = Module::new(&engine, &wasm).unwrap();
    let mut exports: Vec<&str> = module.exports().map(|e| e.name()).collect();
    exports.sort();
    assert_eq!(
        exports,
        vec![
            "kernel_dispatch",
            "kernel_scratch_len",
            "kernel_scratch_ptr",
            "memory",
        ]
    );
}

#[test]
fn kernel_wasm_imports_match_documented_namespaces() {
    // Phase guard. kernel.wasm imports come from two namespaces:
    //   * `kh.*`     — the documented kernel→host ABI we own.
    //   * `wasi_snapshot_preview1.*` — pulled in transitively by std on
    //     wasm32-wasip1 for panic / abort infrastructure (fd_write,
    //     proc_exit, environ_*). The kernel doesn't *use* WASI for
    //     real I/O — that goes through kh_log / kh_real_* — but std
    //     needs these symbols to resolve, so the microkernel's kernel
    //     linker satisfies them via wasmtime-wasi.
    //
    // When a new `kh_*` import lands without being added to the
    // microkernel Linker (or vice versa), this test catches it.
    let wasm = std::fs::read(ensure_kernel_wasm_built()).unwrap();
    let engine = Engine::default();
    let module = Module::new(&engine, &wasm).unwrap();
    let mut kh_imports: Vec<&str> = Vec::new();
    let mut wasi_imports: Vec<&str> = Vec::new();
    for import in module.imports() {
        match import.module() {
            "kh" => kh_imports.push(import.name()),
            "wasi_snapshot_preview1" => wasi_imports.push(import.name()),
            other => panic!("unexpected import namespace: {other}.{}", import.name()),
        }
    }
    kh_imports.sort();
    wasi_imports.sort();
    assert_eq!(
        kh_imports,
        vec!["kh_extension_invoke", "kh_log", "kh_now_realtime"],
        "documented kh_* surface"
    );
    // We don't pin the exact wasi import set (std internals can vary
    // between toolchains) — just assert that what's there is a subset
    // of the panic-related calls and contains nothing else.
    let wasi_allowed: &[&str] = &[
        "environ_get",
        "environ_sizes_get",
        "fd_write",
        "fd_close",
        "fd_seek",
        "fd_fdstat_get",
        "proc_exit",
    ];
    for w in &wasi_imports {
        assert!(
            wasi_allowed.contains(w),
            "unexpected WASI import: {w} (allowed: {wasi_allowed:?})"
        );
    }
}

#[test]
fn microkernel_round_trips_request_and_response_through_kernel_memory() {
    // Memory-mediated trampoline: ECHO copies request → response in
    // kernel memory; the microkernel reads it back. Architectural
    // primitive every variable-size syscall builds on.
    let mk = fresh_microkernel(0);
    let request = b"trampoline-validates-the-architecture";
    let mut response = vec![0xAA_u8; request.len()];
    let rc = mk.syscall(METHOD_ECHO, request, &mut response).unwrap();
    assert_eq!(rc, request.len() as i64);
    assert_eq!(&response, request);
}

#[test]
fn microkernel_serves_kh_call_during_kernel_dispatch() {
    // Kernel→host direction: NOW_REALTIME calls back into the
    // microkernel via kh_now_realtime; the host serves the value out
    // of HostState; the kernel writes it into the response.
    let now_ns: u64 = 1_715_000_000_000_000_000;
    let mk = fresh_microkernel(now_ns);
    let mut response = [0u8; 8];
    let rc = mk.syscall(METHOD_NOW_REALTIME, &[], &mut response).unwrap();
    assert_eq!(rc, 8);
    assert_eq!(u64::from_le_bytes(response), now_ns);
}

#[test]
fn microkernel_serves_fresh_kh_value_each_dispatch() {
    // The kernel must not cache the kh result. Mutating HostState
    // between dispatches changes the response.
    let mk = fresh_microkernel(100);
    let mut response = [0u8; 8];

    mk.syscall(METHOD_NOW_REALTIME, &[], &mut response).unwrap();
    assert_eq!(u64::from_le_bytes(response), 100);

    mk.host_state_mut().now_realtime_ns = 200;
    mk.syscall(METHOD_NOW_REALTIME, &[], &mut response).unwrap();
    assert_eq!(u64::from_le_bytes(response), 200);
}

/// Recording log sink — captures every message the kernel emits.
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

#[test]
fn kernel_log_test_emits_message_through_kh_log() {
    // Validates kh_log end-to-end: kernel.wasm calls kh_log via the
    // kernel-internal METHOD_KERNEL_LOG_TEST method; the microkernel
    // routes the bytes to the configured LogSink. Future kernel-side
    // diagnostics ride on this exact wire.
    let sink = Arc::new(RecordingLogSink {
        messages: Mutex::new(Vec::new()),
    });
    let mk = Microkernel::load(
        ensure_kernel_wasm_built(),
        HostState {
            log_sink: sink.clone(),
            ..Default::default()
        },
    )
    .unwrap();

    let rc = mk.syscall(METHOD_KERNEL_LOG_TEST, &[], &mut []).unwrap();
    assert_eq!(rc, 0);

    let messages = sink.messages.lock().unwrap();
    assert_eq!(messages.len(), 1);
    let (severity, msg) = &messages[0];
    assert_eq!(*severity, 1, "INFO severity"); // kh::LogSeverity::Info as u32
    assert_eq!(msg, "kernel.wasm hello via kh_log");
}

/// Test extension that records every request it sees and returns a
/// fixed response. Lets the test assert the kernel forwarded the
/// caller's bytes verbatim and wrote back what the host returned.
struct EchoExtension {
    last_request: Mutex<Vec<u8>>,
    response: Vec<u8>,
}

impl ExtensionRegistry for EchoExtension {
    fn invoke(&self, request: &[u8], response: &mut [u8]) -> i64 {
        *self.last_request.lock().unwrap() = request.to_vec();
        let n = self.response.len().min(response.len());
        response[..n].copy_from_slice(&self.response[..n]);
        n as i64
    }
}

#[test]
fn sys_extension_invoke_forwards_bytes_through_microkernel() {
    // Architectural test for the extension escape hatch:
    //   user → kernel.wasm (METHOD_SYS_EXTENSION_INVOKE) → kh_extension_invoke
    //                                                     → microkernel registry
    //                                                     → response back
    // The kernel is a byte courier; wire format (currently JSON) is
    // entirely the registry's concern.
    build_kernel_wasm().unwrap();
    let registry = Arc::new(EchoExtension {
        last_request: Mutex::new(Vec::new()),
        response: br#"{"exit_code":0,"stdout":"hello from extension\n","stderr":""}"#.to_vec(),
    });
    let mk = Microkernel::load(
        ensure_kernel_wasm_built(),
        HostState {
            extensions: registry.clone(),
            ..Default::default()
        },
    )
    .unwrap();

    let request = br#"{"name":"my_ext","args":["a","b"],"stdin":"","cwd":"/"}"#;
    let mut response = vec![0u8; 256];
    let written = mk
        .syscall(METHOD_SYS_EXTENSION_INVOKE, request, &mut response)
        .unwrap();
    assert!(written > 0, "extension wrote response: {written}");

    assert_eq!(
        registry.last_request.lock().unwrap().as_slice(),
        request as &[u8],
        "kernel forwarded request bytes verbatim"
    );
    let written_usize = written as usize;
    assert_eq!(
        &response[..written_usize],
        registry.response.as_slice(),
        "microkernel wrote registry response back into kernel memory"
    );
}

#[test]
fn sys_extension_invoke_returns_negated_enoent_when_no_registry() {
    // Default registry is empty; -ENOENT propagates back through the
    // trampoline as a negative scalar.
    let mk = fresh_microkernel(0);
    let mut response = [0u8; 64];
    let rc = mk
        .syscall(METHOD_SYS_EXTENSION_INVOKE, b"{}", &mut response)
        .unwrap();
    assert_eq!(rc, -2, "expected -ENOENT, got {rc}");
}

#[test]
fn user_process_calls_kernel_through_full_trampoline() {
    // The whole architecture, end to end, in one test:
    //
    //   user.wasm calls sys_getuid
    //     → microkernel forwards to kernel.wasm via kernel_dispatch
    //         → kernel handles METHOD_SYS_GETUID, returns 1000
    //     ← microkernel writes scalar back into user.wasm
    //   user.wasm receives 1000 and returns it from `run`
    //
    // No previous test actually instantiated a user-process wasm.
    // This is the missing architectural piece.
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();

    let user_wat = r#"
        (module
          (import "env" "sys_getuid" (func $sys_getuid (result i32)))
          (func (export "run") (result i32)
            (call $sys_getuid)))
    "#;
    let user_wasm = wat::parse_str(user_wat).unwrap();
    let mut user = mk.spawn_user_process(&user_wasm).unwrap();

    let rc = user.call_run().unwrap();
    assert_eq!(rc, 1000, "user-process saw uid 1000 from kernel.wasm");
}

#[test]
fn microkernel_direct_syscall_uses_kernel_pid_zero() {
    // Microkernel-owned syscalls (no user process in flight) see the
    // kernel as their caller — pid 0. sys_getpid via dispatch
    // therefore returns 0.
    let mk = fresh_microkernel(0);
    let rc = mk.syscall(METHOD_SYS_GETPID, &[], &mut []).unwrap();
    assert_eq!(rc, 0, "microkernel direct call sees KERNEL_PID");
}

#[test]
fn user_process_sees_its_assigned_pid() {
    // First spawned process is pid 1; getpid returns it through the
    // full trampoline. Validates caller_pid plumbing end-to-end.
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_getpid" (func $getpid (result i32)))
          (func (export "run") (result i32)
            (call $getpid)))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();
    assert_eq!(user.pid(), 1);
    assert_eq!(user.call_run().unwrap(), 1);
}

#[test]
fn each_spawned_process_gets_a_unique_pid() {
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_getpid" (func $getpid (result i32)))
          (func (export "run") (result i32)
            (call $getpid)))
    "#;
    let wasm = wat::parse_str(user_wat).unwrap();
    let mut a = mk.spawn_user_process(&wasm).unwrap();
    let mut b = mk.spawn_user_process(&wasm).unwrap();
    let mut c = mk.spawn_user_process(&wasm).unwrap();

    assert_eq!(a.pid(), 1);
    assert_eq!(b.pid(), 2);
    assert_eq!(c.pid(), 3);
    assert_eq!(a.call_run().unwrap(), 1);
    assert_eq!(b.call_run().unwrap(), 2);
    assert_eq!(c.call_run().unwrap(), 3);
}

#[test]
fn getppid_returns_kernel_pid_for_first_user_process() {
    // No process tree yet — until host_spawn lands, every process is
    // a direct child of the kernel.
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_getppid" (func $getppid (result i32)))
          (func (export "run") (result i32)
            (call $getppid)))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();
    assert_eq!(user.call_run().unwrap(), 0);
}

#[test]
fn user_process_umask_persists_across_calls_for_same_pid() {
    // Per-pid kernel state validation. The user process calls sys_umask
    // twice — first sets a new mask and reads back the default, second
    // call reads back what the first set. State lives in
    // kernel.wasm's static Mutex<Kernel>, keyed by caller_pid.
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    // 0o077 = 63, 0o007 = 7 (WAT i32.const doesn't accept octal).
    let user_wat = r#"
        (module
          (import "env" "sys_umask" (func $umask (param i32) (result i32)))
          (func (export "first") (result i32)
            (call $umask (i32.const 63)))
          (func (export "second") (result i32)
            (call $umask (i32.const 7))))
    "#;
    let wasm = wat::parse_str(user_wat).unwrap();
    let mut user = mk.spawn_user_process(&wasm).unwrap();
    let first = user.call_export_i32("first").unwrap();
    assert_eq!(first, 0o022, "default umask 022");
    let second = user.call_export_i32("second").unwrap();
    assert_eq!(second, 0o077, "previous mask from first call persisted");
}

#[test]
fn user_process_setresuid_changes_subsequent_getuid() {
    // Multi-arg syscall (3 u32s) marshalled into kernel scratch as
    // 12 bytes. Validates the multi-arg encoding plus per-pid
    // credential mutation visible across syscalls.
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_setresuid" (func $setresuid (param i32 i32 i32) (result i32)))
          (import "env" "sys_getuid" (func $getuid (result i32)))
          (func (export "set") (result i32)
            (call $setresuid (i32.const 4242) (i32.const 4242) (i32.const 4242)))
          (func (export "get") (result i32)
            (call $getuid)))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();
    assert_eq!(user.call_export_i32("get").unwrap(), 1000, "default uid");
    assert_eq!(user.call_export_i32("set").unwrap(), 0);
    assert_eq!(user.call_export_i32("get").unwrap(), 4242, "uid was set");
}

#[test]
fn user_process_chdir_then_getcwd_round_trip() {
    // Variable-size request (path bytes from user memory) + variable-
    // size response (cwd bytes back into user memory). Exercises
    // forward_user_ptr_len and forward_response_to_user.
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    // The WAT module hard-codes a path string at offset 16 in its
    // memory and a getcwd output buffer at offset 64. `chdir` reads
    // path bytes, `getcwd` writes the cwd to the buffer; the test
    // exports `read_byte(i32) -> i32` so we can inspect the buffer.
    let user_wat = r#"
        (module
          (import "env" "sys_chdir" (func $chdir (param i32 i32) (result i32)))
          (import "env" "sys_getcwd" (func $getcwd (param i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 16) "/srv/yurt")
          (func (export "set") (result i32)
            (call $chdir (i32.const 16) (i32.const 9)))
          (func (export "get") (result i32)
            (call $getcwd (i32.const 64) (i32.const 64)))
          (func (export "byte") (param $i i32) (result i32)
            (i32.load8_u (local.get $i))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();

    // Initial cwd = "/" → required size 2 (1 byte path + 1 NUL).
    let initial = user.call_export_i32("get").unwrap();
    assert_eq!(initial, 2);

    // chdir then getcwd.
    assert_eq!(user.call_export_i32("set").unwrap(), 0);
    let n = user.call_export_i32("get").unwrap();
    assert_eq!(n, 10, "/srv/yurt + NUL");

    // Read back bytes from the user-process buffer at offset 64.
    let got = user.read_memory(64, 10).unwrap();
    assert_eq!(&got, b"/srv/yurt\0");
}

#[test]
fn user_process_getrlimit_then_setrlimit_round_trip() {
    // Validates a per-pid table-state syscall that takes a u32 arg and
    // writes a 16-byte struct back into user memory, plus a 3-arg
    // setrlimit (u32 + 2*u64) round-trip.
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_getrlimit"
            (func $getrlimit (param i32 i32) (result i32)))
          (import "env" "sys_setrlimit"
            (func $setrlimit (param i32 i64 i64) (result i32)))
          (memory (export "memory") 1)
          ;; rlimit struct lands at offset 64 (16 bytes).
          (func (export "get_stack") (result i32)
            (call $getrlimit (i32.const 3) (i32.const 64)))
          ;; Lower RLIMIT_NOFILE (=7) to 256 / 512.
          (func (export "set_nofile_lo") (result i32)
            (call $setrlimit
              (i32.const 7) (i64.const 256) (i64.const 512)))
          (func (export "get_nofile") (result i32)
            (call $getrlimit (i32.const 7) (i32.const 64)))
          (func (export "load_u64_lo") (result i64) (i64.load (i32.const 64)))
          (func (export "load_u64_hi") (result i64) (i64.load (i32.const 72))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();

    // Default RLIMIT_STACK = 1 MB.
    assert_eq!(user.call_export_i32("get_stack").unwrap(), 0);
    let mem = user.read_memory(64, 16).unwrap();
    let soft = u64::from_le_bytes(mem[0..8].try_into().unwrap());
    let hard = u64::from_le_bytes(mem[8..16].try_into().unwrap());
    assert_eq!(soft, 1024 * 1024);
    assert_eq!(hard, 1024 * 1024);

    // Lower RLIMIT_NOFILE; read it back.
    assert_eq!(user.call_export_i32("set_nofile_lo").unwrap(), 0);
    assert_eq!(user.call_export_i32("get_nofile").unwrap(), 0);
    let mem = user.read_memory(64, 16).unwrap();
    assert_eq!(u64::from_le_bytes(mem[0..8].try_into().unwrap()), 256);
    assert_eq!(u64::from_le_bytes(mem[8..16].try_into().unwrap()), 512);
}

#[test]
fn user_process_fd_table_dup_close_lifecycle() {
    // Validates the complete fd-table mechanic through a single user
    // process: default fds 0/1/2 are open, dup() returns the next
    // free slot, dup2() can install at an arbitrary fd, and close()
    // frees the slot for re-allocation. Closing an already-closed fd
    // surfaces -EBADF (= -9).
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_dup"   (func $dup   (param i32) (result i32)))
          (import "env" "sys_dup2"  (func $dup2  (param i32 i32) (result i32)))
          (import "env" "sys_close" (func $close (param i32) (result i32)))
          (func (export "dup_stdout") (result i32) (call $dup (i32.const 1)))
          (func (export "dup_unopened") (result i32) (call $dup (i32.const 99)))
          (func (export "dup2_into_50") (result i32)
            (call $dup2 (i32.const 1) (i32.const 50)))
          (func (export "close_50") (result i32) (call $close (i32.const 50)))
          (func (export "close_50_again") (result i32) (call $close (i32.const 50)))
          (func (export "close_3") (result i32) (call $close (i32.const 3))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();

    // Default {0,1,2} → first dup returns 3.
    assert_eq!(user.call_export_i32("dup_stdout").unwrap(), 3);
    // Dup'ing a closed fd → -EBADF.
    assert_eq!(user.call_export_i32("dup_unopened").unwrap(), -9);
    // Dup2 to an arbitrary high fd.
    assert_eq!(user.call_export_i32("dup2_into_50").unwrap(), 50);
    // Close the high fd; second close fails -EBADF.
    assert_eq!(user.call_export_i32("close_50").unwrap(), 0);
    assert_eq!(user.call_export_i32("close_50_again").unwrap(), -9);
    // The fd 3 from dup_stdout is still open from earlier.
    assert_eq!(user.call_export_i32("close_3").unwrap(), 0);
}

#[test]
fn user_process_fd_table_is_per_process() {
    // Closing fd 0 in one process must not affect another process's
    // fd table.
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_close" (func $close (param i32) (result i32)))
          (func (export "close0") (result i32) (call $close (i32.const 0)))
          (func (export "close0_again") (result i32) (call $close (i32.const 0))))
    "#;
    let wasm = wat::parse_str(user_wat).unwrap();
    let mut a = mk.spawn_user_process(&wasm).unwrap();
    let mut b = mk.spawn_user_process(&wasm).unwrap();

    assert_eq!(a.call_export_i32("close0").unwrap(), 0);
    assert_eq!(a.call_export_i32("close0_again").unwrap(), -9);
    // Process B still has fd 0 open.
    assert_eq!(b.call_export_i32("close0").unwrap(), 0);
}

#[test]
fn user_process_setresgid_changes_subsequent_getgid() {
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_setresgid" (func $setresgid (param i32 i32 i32) (result i32)))
          (import "env" "sys_getgid" (func $getgid (result i32)))
          (func (export "set") (result i32)
            (call $setresgid (i32.const 99) (i32.const 99) (i32.const 99)))
          (func (export "get") (result i32)
            (call $getgid)))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();
    assert_eq!(user.call_export_i32("get").unwrap(), 1000);
    assert_eq!(user.call_export_i32("set").unwrap(), 0);
    assert_eq!(user.call_export_i32("get").unwrap(), 99);
}

#[test]
fn user_process_can_call_kernel_multiple_times() {
    // The Rc<RefCell<KernelInstance>> sharing pattern must support
    // repeated borrow_mut acquisitions without deadlock or panic.
    let mk = Microkernel::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_getuid" (func $sys_getuid (result i32)))
          (import "env" "sys_getgid" (func $sys_getgid (result i32)))
          (func (export "run") (result i32)
            (i32.add (call $sys_getuid) (call $sys_getgid))))
    "#;
    let user_wasm = wat::parse_str(user_wat).unwrap();
    let mut user = mk.spawn_user_process(&user_wasm).unwrap();
    assert_eq!(user.call_run().unwrap(), 2000, "uid + gid = 1000 + 1000");
}

#[test]
fn microkernel_method_ids_match_yurt_abi_methods_toml() {
    // Contract test: every method ID this test file hardcodes must
    // match the authoritative pinning in
    // `abi/contract/yurt_abi_methods.toml`. Catches drift in either
    // direction — if the TOML changes an ID, this test fails; if a new
    // syscall ID gets added in code without an entry, this test stays
    // silent (so methods.toml is the source of truth).
    let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap();
    let raw =
        std::fs::read_to_string(workspace_root.join("abi/contract/yurt_abi_methods.toml")).unwrap();
    let parsed: toml::Value = raw.parse().unwrap();
    let methods = parsed.get("method").and_then(|v| v.as_table()).unwrap();

    for (name, method, expected_id) in [
        ("kernel_echo", METHOD_ECHO, METHOD_ECHO as i64),
        (
            "kernel_now_realtime",
            METHOD_NOW_REALTIME,
            METHOD_NOW_REALTIME as i64,
        ),
        ("sys_getuid", METHOD_SYS_GETUID, METHOD_SYS_GETUID as i64),
        ("sys_geteuid", METHOD_SYS_GETEUID, METHOD_SYS_GETEUID as i64),
        ("sys_getgid", METHOD_SYS_GETGID, METHOD_SYS_GETGID as i64),
        ("sys_getegid", METHOD_SYS_GETEGID, METHOD_SYS_GETEGID as i64),
        ("sys_getpid", METHOD_SYS_GETPID, METHOD_SYS_GETPID as i64),
        ("sys_getppid", METHOD_SYS_GETPPID, METHOD_SYS_GETPPID as i64),
        ("sys_umask", METHOD_SYS_UMASK, METHOD_SYS_UMASK as i64),
        (
            "sys_setresuid",
            METHOD_SYS_SETRESUID,
            METHOD_SYS_SETRESUID as i64,
        ),
        (
            "sys_setresgid",
            METHOD_SYS_SETRESGID,
            METHOD_SYS_SETRESGID as i64,
        ),
        ("sys_chdir", METHOD_SYS_CHDIR, METHOD_SYS_CHDIR as i64),
        ("sys_getcwd", METHOD_SYS_GETCWD, METHOD_SYS_GETCWD as i64),
        (
            "sys_getrlimit",
            METHOD_SYS_GETRLIMIT,
            METHOD_SYS_GETRLIMIT as i64,
        ),
        (
            "sys_setrlimit",
            METHOD_SYS_SETRLIMIT,
            METHOD_SYS_SETRLIMIT as i64,
        ),
        ("sys_close", METHOD_SYS_CLOSE, METHOD_SYS_CLOSE as i64),
        ("sys_dup", METHOD_SYS_DUP, METHOD_SYS_DUP as i64),
        ("sys_dup2", METHOD_SYS_DUP2, METHOD_SYS_DUP2 as i64),
        (
            "sys_extension_invoke",
            METHOD_SYS_EXTENSION_INVOKE,
            METHOD_SYS_EXTENSION_INVOKE as i64,
        ),
    ] {
        let entry = methods
            .get(name)
            .unwrap_or_else(|| panic!("method.{name} missing from yurt_abi_methods.toml"));
        let id = entry.get("id").and_then(|v| v.as_integer()).unwrap();
        assert_eq!(
            id, expected_id,
            "method.{name}: TOML says id={id}, code says id={method:#x}"
        );
    }
}

#[test]
fn credentials_syscalls_round_trip_through_trampoline() {
    // First user-facing syscall family. Pure scalar return; no memory
    // copies. With no process kernel yet, all four resolve to the TS
    // kernel's USER_UID/USER_GID = 1000 fallback.
    let mk = fresh_microkernel(0);
    for (name, method) in [
        ("getuid", METHOD_SYS_GETUID),
        ("geteuid", METHOD_SYS_GETEUID),
        ("getgid", METHOD_SYS_GETGID),
        ("getegid", METHOD_SYS_GETEGID),
    ] {
        let rc = mk.syscall(method, &[], &mut []).unwrap();
        assert_eq!(rc, 1000, "{name} returns default 1000");
    }
}
