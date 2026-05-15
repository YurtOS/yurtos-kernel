//! End-to-end smoke tests for the sandboxed-kernel architecture.
//!
//! Builds `yurt-kernel-wasm` for `wasm32-wasip1`, loads it through the
//! [`KernelHostInterface`] skeleton, and exercises the trampoline in both
//! directions: user→kernel via `kernel_dispatch`, and kernel→host via
//! the `kh_*` import surface. See
//! `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use wasmtime::{Engine, Module};

use yurt_runtime_wasmtime::kernel_host_interface::{
    build_kernel_wasm, default_kernel_wasm_path, ExtensionRegistry, HostState, InMemoryHostFs,
    InMemoryKv, KernelHostInterface, LogSink, NativeHostFs, NativeTcpSocket, RedbKv,
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
const METHOD_SYS_PIPE: u32 = 0x1_0012;
const METHOD_SYS_READ: u32 = 0x1_0013;
const METHOD_SYS_WRITE: u32 = 0x1_0014;
const METHOD_SYS_ISATTY: u32 = 0x1_0015;
const METHOD_SYS_CLOCK_GETTIME: u32 = 0x1_0016;
const METHOD_SYS_GETPGID: u32 = 0x1_0017;
const METHOD_SYS_SETPGID: u32 = 0x1_0018;
const METHOD_SYS_GETSID: u32 = 0x1_0019;
const METHOD_SYS_SETSID: u32 = 0x1_001A;
const METHOD_SYS_KILL: u32 = 0x1_001B;
const METHOD_SYS_SIGACTION: u32 = 0x1_001C;
const METHOD_SYS_SCHED_YIELD: u32 = 0x1_001D;
const METHOD_SYS_NANOSLEEP: u32 = 0x1_001E;
const METHOD_SYS_OPEN: u32 = 0x1_001F;
const METHOD_SYS_LSEEK: u32 = 0x1_0020;
const METHOD_SYS_FSTAT: u32 = 0x1_0021;
const METHOD_SYS_CHMOD: u32 = 0x1_0022;
const METHOD_SYS_CHOWN: u32 = 0x1_0023;
const METHOD_SYS_UTIMENS: u32 = 0x1_0024;
const METHOD_SYS_UNLINK: u32 = 0x1_0025;
const METHOD_SYS_STAT: u32 = 0x1_0026;
const METHOD_SYS_SYMLINK: u32 = 0x1_0027;
const METHOD_SYS_READLINK: u32 = 0x1_0028;
const METHOD_SYS_MKDIR: u32 = 0x1_0029;
const METHOD_SYS_RMDIR: u32 = 0x1_002A;
const METHOD_SYS_READDIR: u32 = 0x1_002B;
const METHOD_SYS_WAIT: u32 = 0x1_002C;
const METHOD_SYS_LINK: u32 = 0x1_002D;
const METHOD_SYS_RENAME: u32 = 0x1_002E;
const METHOD_SYS_SPAWN: u32 = 0x1_002F;
const METHOD_SYS_FETCH: u32 = 0x1_0030;
const METHOD_SYS_SOCKET_CONNECT: u32 = 0x1_0031;
const METHOD_SYS_SOCKET_SEND: u32 = 0x1_0032;
const METHOD_SYS_SOCKET_RECV: u32 = 0x1_0033;
const METHOD_SYS_SOCKET_CLOSE: u32 = 0x1_0034;
const METHOD_SYS_IDB_GET: u32 = 0x1_0035;
const METHOD_SYS_IDB_PUT: u32 = 0x1_0036;
const METHOD_SYS_IDB_DELETE: u32 = 0x1_0037;
const METHOD_SYS_IDB_LIST: u32 = 0x1_0038;
const METHOD_SYS_SOCKET_LISTEN: u32 = 0x1_0039;
const METHOD_SYS_SOCKET_ACCEPT: u32 = 0x1_003A;
const METHOD_SYS_SOCKET_ADDR: u32 = 0x1_003B;
const METHOD_SYS_GETPRIORITY: u32 = 0x1_003D;
const METHOD_SYS_SETPRIORITY: u32 = 0x1_003E;
const METHOD_SYS_SCHED_GETSCHEDULER: u32 = 0x1_003F;
const METHOD_SYS_SCHED_GETPARAM: u32 = 0x1_0040;
const METHOD_SYS_SCHED_SETSCHEDULER: u32 = 0x1_0041;
const METHOD_SYS_SCHED_SETPARAM: u32 = 0x1_0042;
const METHOD_SYS_POLL: u32 = 0x1_0043;
const METHOD_SYS_SOCKETPAIR: u32 = 0x1_0044;
const METHOD_SYS_SOCKET_OPEN: u32 = 0x1_0045;
const METHOD_SYS_SOCKET_BIND: u32 = 0x1_0046;
const METHOD_SYS_SOCKET_SENDTO: u32 = 0x1_0047;
const METHOD_SYS_SOCKET_SENDMSG: u32 = 0x1_0048;
const METHOD_SYS_SOCKET_RECVMSG: u32 = 0x1_0049;
const METHOD_SYS_SOCKET_INFO: u32 = 0x1_004A;
const METHOD_SYS_SOCKET_RECVFROM: u32 = 0x1_004B;
const METHOD_KERNEL_LOG_TEST: u32 = 3;
const METHOD_SYS_EXTENSION_INVOKE: u32 = 0x1_0010;

fn fresh_kernel_host_interface(now_ns: u64) -> KernelHostInterface {
    KernelHostInterface::load(
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
    let mk = fresh_kernel_host_interface(0);
    let rc = mk.syscall(0xDEAD_BEEF, &[], &mut []).unwrap();
    assert_eq!(rc, -ENOSYS);
}

#[test]
fn kernel_wasm_export_surface_is_locked() {
    // Architectural invariant: kernel.wasm exposes exactly the contract
    // the kernel_host_interface relies on, nothing more.
    let wasm = std::fs::read(ensure_kernel_wasm_built()).unwrap();
    let engine = Engine::default();
    let module = Module::new(&engine, &wasm).unwrap();
    let mut exports: Vec<&str> = module.exports().map(|e| e.name()).collect();
    exports.sort();
    assert_eq!(
        exports,
        vec![
            "kernel_block_thread",
            "kernel_detach_thread",
            "kernel_dispatch",
            "kernel_drain_spawn",
            "kernel_kill",
            "kernel_list_processes",
            "kernel_list_threads",
            "kernel_record_exit",
            "kernel_record_thread_exit",
            "kernel_schedule_next",
            "kernel_scratch_len",
            "kernel_scratch_ptr",
            "kernel_snapshot",
            "kernel_spawn_process",
            "kernel_spawn_thread",
            "kernel_unblock_thread",
            "kernel_wait",
            "memory",
        ]
    );
}

#[test]
fn wasmtime_adapter_lists_kernel_owned_process_snapshot() {
    let mk = fresh_kernel_host_interface(0);
    let module = wat::parse_str(
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (result i32)
            i32.const 7))
        "#,
    )
    .unwrap();

    let proc = mk
        .spawn_user_process_with_args(&module, &[b"/bin/demo".as_slice(), b"--flag".as_slice()])
        .unwrap();
    let snapshots = mk.list_processes().unwrap();
    let snapshot = snapshots.iter().find(|p| p.pid == proc.pid()).unwrap();

    assert_eq!(snapshot.ppid, 0);
    assert_eq!(snapshot.state, "running");
    assert_eq!(snapshot.exit_status, None);
    assert_eq!(snapshot.command, b"/bin/demo");
    assert!(snapshot.fds.contains(&0));
    assert!(snapshot.fds.contains(&1));
    assert!(snapshot.fds.contains(&2));
}

#[test]
fn wasmtime_adapter_lists_kernel_owned_thread_snapshot() {
    let mk = fresh_kernel_host_interface(0);
    let module = wat::parse_str(
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (result i32)
            i32.const 7))
        "#,
    )
    .unwrap();

    let proc = mk
        .spawn_user_process_with_args(&module, &[b"/bin/threaded".as_slice()])
        .unwrap();
    let threads = mk.list_threads(proc.pid()).unwrap();

    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].tid, 1);
    assert_eq!(threads[0].state, "runnable");
    assert!(!threads[0].detached);
    assert_eq!(threads[0].exit_value, None);
}

#[test]
fn wasmtime_adapter_mutates_kernel_owned_thread_lifecycle() {
    let mk = fresh_kernel_host_interface(0);
    let module = wat::parse_str(
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (result i32)
            i32.const 7))
        "#,
    )
    .unwrap();

    let proc = mk
        .spawn_user_process_with_args(&module, &[b"/bin/threaded".as_slice()])
        .unwrap();
    let tid = mk.spawn_thread(proc.pid(), 91).unwrap();
    assert_eq!(tid, 2);

    mk.block_thread(proc.pid(), tid).unwrap();
    let blocked = mk
        .list_threads(proc.pid())
        .unwrap()
        .into_iter()
        .find(|thread| thread.tid == tid)
        .unwrap();
    assert_eq!(blocked.state, "blocked");
    assert_eq!(blocked.host_thread_handle, Some(91));

    mk.unblock_thread(proc.pid(), tid).unwrap();
    mk.detach_thread(proc.pid(), tid).unwrap();
    mk.record_thread_exit(proc.pid(), tid, 123).unwrap();

    let exited = mk
        .list_threads(proc.pid())
        .unwrap()
        .into_iter()
        .find(|thread| thread.tid == tid)
        .unwrap();
    assert_eq!(exited.state, "exited");
    assert!(exited.detached);
    assert_eq!(exited.exit_value, Some(123));
}

#[test]
fn wasmtime_adapter_reads_kernel_scheduler_decisions() {
    let mk = fresh_kernel_host_interface(0);
    let module = wat::parse_str(
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (result i32)
            i32.const 7))
        "#,
    )
    .unwrap();

    let proc = mk
        .spawn_user_process_with_args(&module, &[b"/bin/threaded".as_slice()])
        .unwrap();
    let tid = mk.spawn_thread(proc.pid(), 91).unwrap();

    let first = mk.schedule_next().unwrap().unwrap();
    assert_eq!(first.pid, proc.pid());
    assert_eq!(first.tid, 1);
    assert_eq!(first.budget_ns, 20_000_000);

    let second = mk.schedule_next().unwrap().unwrap();
    assert_eq!(second.pid, proc.pid());
    assert_eq!(second.tid, tid);
    assert_eq!(second.host_thread_handle, Some(91));
    assert_eq!(second.flags, 0);
}

#[test]
fn wasmtime_user_process_applies_kernel_schedule_budget() {
    let mk = fresh_kernel_host_interface(0);
    let module = wat::parse_str(
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (result i32)
            i32.const 7))
        "#,
    )
    .unwrap();

    let mut proc = mk
        .spawn_user_process_with_args(&module, &[b"/bin/budgeted".as_slice()])
        .unwrap();
    let decision = mk.schedule_next().unwrap().unwrap();

    assert!(proc.apply_schedule_decision(decision).unwrap());
    assert_eq!(proc.last_scheduler_budget_ns(), Some(decision.budget_ns));
    assert_eq!(proc.last_scheduler_epoch_quantum(), Some(20));
}

#[test]
fn wasmtime_adapter_reads_binary_kernel_snapshot() {
    let mk = fresh_kernel_host_interface(0);
    let module = wat::parse_str(
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (result i32)
            i32.const 7))
        "#,
    )
    .unwrap();

    let proc = mk
        .spawn_user_process_with_args(&module, &[b"/bin/threaded".as_slice()])
        .unwrap();
    let tid = mk.spawn_thread(proc.pid(), 91).unwrap();
    mk.block_thread(proc.pid(), tid).unwrap();

    let snapshot = mk.snapshot_kernel_state().unwrap();
    assert_eq!(&snapshot[0..8], b"YURTSNP\0");
    assert_eq!(u16::from_le_bytes(snapshot[8..10].try_into().unwrap()), 1);
    assert_eq!(u16::from_le_bytes(snapshot[10..12].try_into().unwrap()), 4);
    assert_eq!(u32::from_le_bytes(snapshot[12..16].try_into().unwrap()), 0);
}

#[test]
fn wasmtime_adapter_waits_through_kernel_export() {
    let mk = fresh_kernel_host_interface(0);
    let module = wat::parse_str(
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (result i32)
            i32.const 0))
        "#,
    )
    .unwrap();

    let parent = mk
        .spawn_user_process_with_args(&module, &[b"/bin/parent".as_slice()])
        .unwrap();
    let child = mk
        .spawn_child(parent.pid(), &module, &[b"/bin/child".as_slice()])
        .unwrap();
    mk.record_exit(child.pid(), 17).unwrap();

    let waited = mk.wait_process(parent.pid(), child.pid(), 0).unwrap();

    assert_eq!(waited.pid, child.pid());
    assert_eq!(waited.status, 17);
}

#[test]
fn wasmtime_adapter_kills_through_kernel_export() {
    let mk = fresh_kernel_host_interface(0);
    let module = wat::parse_str(
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (result i32)
            i32.const 0))
        "#,
    )
    .unwrap();

    let proc = mk
        .spawn_user_process_with_args(&module, &[b"/bin/kill-target".as_slice()])
        .unwrap();

    assert_eq!(mk.kill_process(proc.pid(), 0).unwrap(), 0);
    assert_eq!(mk.kill_process(proc.pid(), 64).unwrap(), -22);
}

#[test]
fn wasmtime_adapter_spawns_cached_process_through_kernel_export() {
    let mk = fresh_kernel_host_interface(0);
    let module = wat::parse_str(
        r#"
        (module
          (import "env" "sys_getpid" (func $getpid (result i32)))
          (memory (export "memory") 1)
          (func (export "run") (result i32)
            call $getpid))
        "#,
    )
    .unwrap();

    mk.cache_process_module(b"demo-module", &module).unwrap();
    let mut proc = mk
        .spawn_cached_user_process(0, b"demo-module", &[b"/bin/demo".as_slice()])
        .unwrap();

    assert_eq!(proc.call_run().unwrap(), proc.pid() as i32);
    let snapshots = mk.list_processes().unwrap();
    let snapshot = snapshots.iter().find(|p| p.pid == proc.pid()).unwrap();
    assert_eq!(snapshot.ppid, 0);
    assert_eq!(snapshot.command, b"/bin/demo");
}

#[test]
fn kernel_wasm_imports_match_documented_namespaces() {
    // Phase guard. kernel.wasm imports come from two namespaces:
    //   * `kh.*`     — the documented kernel→host ABI we own.
    //   * `wasi_snapshot_preview1.*` — pulled in transitively by std on
    //     wasm32-wasip1 for panic / abort infrastructure (fd_write,
    //     proc_exit, environ_*). The kernel doesn't *use* WASI for
    //     real I/O — that goes through kh_log / kh_real_* — but std
    //     needs these symbols to resolve, so the kernel_host_interface's kernel
    //     linker satisfies them via wasmtime-wasi.
    //
    // When a new `kh_*` import lands without being added to the
    // kernel_host_interface Linker (or vice versa), this test catches it.
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
        vec![
            "kh_extension_invoke",
            "kh_fetch_blocking",
            "kh_idb_delete",
            "kh_idb_get",
            "kh_idb_list",
            "kh_idb_put",
            "kh_log",
            "kh_now_realtime",
            // kh_real_* land via the HostFsBackend mount at /host;
            // kernel.wasm imports them so the backend can open/
            // read/close real-disk files. Phase 5 surface — write
            // counterparts arrive when the OFD-backed write path
            // does.
            "kh_real_close",
            "kh_real_mkdir",
            "kh_real_open",
            "kh_real_read",
            "kh_real_rename",
            "kh_real_stat",
            "kh_real_symlink",
            "kh_real_unlink",
            "kh_real_write",
            "kh_socket_accept_blocking",
            "kh_socket_close",
            "kh_socket_connect",
            "kh_socket_listen_at",
            "kh_socket_local_addr",
            "kh_socket_peer_addr",
            "kh_socket_recv",
            "kh_socket_send",
            "kh_spawn_process",
        ],
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
fn kernel_host_interface_round_trips_request_and_response_through_kernel_memory() {
    // Memory-mediated trampoline: ECHO copies request → response in
    // kernel memory; the kernel_host_interface reads it back. Architectural
    // primitive every variable-size syscall builds on.
    let mk = fresh_kernel_host_interface(0);
    let request = b"trampoline-validates-the-architecture";
    let mut response = vec![0xAA_u8; request.len()];
    let rc = mk.syscall(METHOD_ECHO, request, &mut response).unwrap();
    assert_eq!(rc, request.len() as i64);
    assert_eq!(&response, request);
}

#[test]
fn kernel_host_interface_serves_kh_call_during_kernel_dispatch() {
    // Kernel→host direction: NOW_REALTIME calls back into the
    // kernel_host_interface via kh_now_realtime; the host serves the value out
    // of HostState; the kernel writes it into the response.
    let now_ns: u64 = 1_715_000_000_000_000_000;
    let mk = fresh_kernel_host_interface(now_ns);
    let mut response = [0u8; 8];
    let rc = mk.syscall(METHOD_NOW_REALTIME, &[], &mut response).unwrap();
    assert_eq!(rc, 8);
    assert_eq!(u64::from_le_bytes(response), now_ns);
}

#[test]
fn kernel_host_interface_serves_fresh_kh_value_each_dispatch() {
    // The kernel must not cache the kh result. Mutating HostState
    // between dispatches changes the response.
    let mk = fresh_kernel_host_interface(100);
    let mut response = [0u8; 8];

    mk.syscall(METHOD_NOW_REALTIME, &[], &mut response).unwrap();
    assert_eq!(u64::from_le_bytes(response), 100);

    mk.with_host_state_mut(|s| s.now_realtime_ns = 200);
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
    // kernel-internal METHOD_KERNEL_LOG_TEST method; the kernel_host_interface
    // routes the bytes to the configured LogSink. Future kernel-side
    // diagnostics ride on this exact wire.
    let sink = Arc::new(RecordingLogSink {
        messages: Mutex::new(Vec::new()),
    });
    let mk = KernelHostInterface::load(
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
fn sys_extension_invoke_forwards_bytes_through_kernel_host_interface() {
    // Architectural test for the extension escape hatch:
    //   user → kernel.wasm (METHOD_SYS_EXTENSION_INVOKE) → kh_extension_invoke
    //                                                     → kernel_host_interface registry
    //                                                     → response back
    // The kernel is a byte courier; wire format (currently JSON) is
    // entirely the registry's concern.
    build_kernel_wasm().unwrap();
    let registry = Arc::new(EchoExtension {
        last_request: Mutex::new(Vec::new()),
        response: br#"{"exit_code":0,"stdout":"hello from extension\n","stderr":""}"#.to_vec(),
    });
    let mk = KernelHostInterface::load(
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
        "kernel_host_interface wrote registry response back into kernel memory"
    );
}

#[test]
fn policy_can_deny_extension_invoke_at_kh_boundary() {
    use yurt_runtime_wasmtime::kernel_host_interface::{PolicyDecision, PolicyEnforcer};
    // Embedder rejects any extension request whose body contains
    // the literal "evil". The "ask the human" use-case slots in
    // here; this test stubs that with a string match for
    // determinism.
    struct BlockEvil;
    impl PolicyEnforcer for BlockEvil {
        fn may_invoke_extension(&self, request: &[u8]) -> PolicyDecision {
            if request.windows(4).any(|w| w == b"evil") {
                PolicyDecision::Deny
            } else {
                PolicyDecision::Allow
            }
        }
    }

    build_kernel_wasm().unwrap();
    // Echo registry that would happily handle anything — but the
    // policy sits in front and short-circuits.
    let registry = Arc::new(EchoExtension {
        last_request: Mutex::new(Vec::new()),
        response: b"{}".to_vec(),
    });
    let mk = KernelHostInterface::load(
        ensure_kernel_wasm_built(),
        HostState {
            extensions: registry.clone(),
            policy: Arc::new(BlockEvil),
            ..Default::default()
        },
    )
    .unwrap();

    // Allowed call goes through.
    let mut response = vec![0u8; 64];
    let rc = mk
        .syscall(
            METHOD_SYS_EXTENSION_INVOKE,
            b"benign request",
            &mut response,
        )
        .unwrap();
    assert!(rc > 0, "benign request: rc = {rc}");

    // Denied call returns -EACCES (-13). Critically, the registry
    // is *not* invoked — the gate is at the kh_* boundary, before
    // the embedder sees the bytes.
    let registry_calls_before = registry.last_request.lock().unwrap().len();
    let rc = mk
        .syscall(
            METHOD_SYS_EXTENSION_INVOKE,
            b"do something evil",
            &mut response,
        )
        .unwrap();
    assert_eq!(rc, -13, "expected -EACCES, got {rc}");
    let registry_calls_after = registry.last_request.lock().unwrap().len();
    // The previous "benign request" updated the recorded request;
    // the denied call must NOT have updated it.
    assert_eq!(
        registry_calls_before, registry_calls_after,
        "denied request must not reach the registry"
    );
}

#[test]
fn host_fs_backend_reads_real_file_via_kh_real_open() {
    // End-to-end: write a tempdir + file on disk; configure
    // HostState.host_fs_root; sys_open /host/<rel> goes through
    // HostFsBackend → kh_real_open → kh_real_read → returns bytes.
    use std::fs;
    use std::io::Write;
    build_kernel_wasm().unwrap();

    let dir = std::env::temp_dir().join(format!("yurt-host-fs-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let file_path = dir.join("greeting.txt");
    {
        let mut f = fs::File::create(&file_path).unwrap();
        f.write_all(b"hello from real disk\n").unwrap();
    }

    let host = HostState {
        host_fs: Some(Arc::new(NativeHostFs::new(dir.clone()))),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();

    mk.mount_host_fs(b"/host").unwrap();

    // Open /host/greeting.txt — HostFsBackend strips /host and
    // asks the host for /greeting.txt under the configured root.
    let mut req = 0_u32.to_le_bytes().to_vec();
    req.extend_from_slice(b"/host/greeting.txt");
    let fd = mk.syscall(METHOD_SYS_OPEN, &req, &mut []).unwrap();
    assert!(fd >= 0, "open succeeded: fd = {fd}");

    // Read its content back.
    let mut buf = vec![0u8; 64];
    let n = mk
        .syscall(METHOD_SYS_READ, &(fd as u32).to_le_bytes(), &mut buf)
        .unwrap();
    assert!(n > 0, "read returned bytes: n = {n}");
    assert_eq!(&buf[..n as usize], b"hello from real disk\n");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn host_fs_in_memory_impl_round_trips_without_real_disk() {
    // Same kernel.wasm, different host_fs impl. The InMemoryHostFs
    // is the shape browser kernel-host interfaces use while OPFS isn't yet
    // wired (it satisfies HostFsImpl without touching real disk):
    // sandbox tests can exercise the full kh_real_* surface here
    // and the browser kernel_host_interface can later swap in OPFS without
    // changing kernel.wasm.
    build_kernel_wasm().unwrap();
    let memfs = Arc::new(InMemoryHostFs::new());
    memfs.install_file(b"/seed.txt", b"hello memfs".to_vec());

    let host = HostState {
        host_fs: Some(memfs.clone()),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();
    mk.mount_host_fs(b"/host").unwrap();

    // Read the pre-installed file via the user-facing sys_open +
    // sys_read path.
    let mut req = 0_u32.to_le_bytes().to_vec();
    req.extend_from_slice(b"/host/seed.txt");
    let fd = mk.syscall(METHOD_SYS_OPEN, &req, &mut []).unwrap();
    assert!(fd >= 0, "open: {fd}");
    let mut buf = vec![0u8; 32];
    let n = mk
        .syscall(METHOD_SYS_READ, &(fd as u32).to_le_bytes(), &mut buf)
        .unwrap();
    assert_eq!(&buf[..n as usize], b"hello memfs");

    // Mutating ops also work — mkdir, rename, unlink — against the
    // same in-memory store, with no disk I/O at all.
    assert_eq!(
        mk.syscall(METHOD_SYS_MKDIR, b"/host/sub", &mut []).unwrap(),
        0,
    );
    let old: &[u8] = b"/host/seed.txt";
    let new: &[u8] = b"/host/moved.txt";
    let mut req = (old.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(old);
    req.extend_from_slice(new);
    assert_eq!(mk.syscall(METHOD_SYS_RENAME, &req, &mut []).unwrap(), 0);
    assert_eq!(
        mk.syscall(METHOD_SYS_UNLINK, b"/host/moved.txt", &mut [])
            .unwrap(),
        0,
    );
}

#[test]
fn host_fs_traversal_outside_root_is_eacces() {
    // Embedder gives the sandbox a single directory as host_fs_root.
    // Userland tries to escape with `..` segments — every kh_real_*
    // call that reaches the canonicalize-and-contain check must
    // refuse with -EACCES, not silently resolve to a sibling.
    use std::fs;
    use std::io::Write;
    build_kernel_wasm().unwrap();

    // Build /tmp/yurt-escape-<pid>/inner as the sandbox root, with
    // a sibling /tmp/yurt-escape-<pid>/outside that the sandbox
    // must not be able to read or mutate.
    let parent = std::env::temp_dir().join(format!("yurt-escape-{}", std::process::id()));
    let _ = fs::remove_dir_all(&parent);
    fs::create_dir_all(parent.join("inner")).unwrap();
    fs::create_dir_all(parent.join("outside")).unwrap();
    {
        let mut f = fs::File::create(parent.join("outside/secret.txt")).unwrap();
        f.write_all(b"don't leak me").unwrap();
    }

    let host = HostState {
        host_fs: Some(Arc::new(NativeHostFs::new(parent.join("inner")))),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();
    mk.mount_host_fs(b"/host").unwrap();

    // Read attempt: /host/../outside/secret.txt — should miss.
    let mut req = 0_u32.to_le_bytes().to_vec();
    req.extend_from_slice(b"/host/../outside/secret.txt");
    let rc = mk.syscall(METHOD_SYS_OPEN, &req, &mut []).unwrap();
    assert!(rc < 0, "open of escape path must fail, got {rc}");

    // Write attempts: mkdir/unlink/rename outside the root must
    // also refuse with a negative errno (the exact code depends
    // on whether the path canonicalizes through the parent or
    // misses; -EACCES or -ENOENT both indicate the request was
    // refused before touching the host fs).
    let escape: &[u8] = b"/host/../outside/newdir";
    let rc = mk.syscall(METHOD_SYS_MKDIR, escape, &mut []).unwrap();
    assert!(rc < 0, "mkdir escape: {rc}");
    assert!(
        !parent.join("outside/newdir").exists(),
        "host fs must not have been mutated"
    );
    let rc = mk
        .syscall(METHOD_SYS_UNLINK, b"/host/../outside/secret.txt", &mut [])
        .unwrap();
    assert!(rc < 0, "unlink escape: {rc}");
    assert!(
        parent.join("outside/secret.txt").exists(),
        "real file must still be present after refused unlink"
    );

    let _ = fs::remove_dir_all(&parent);
}

#[test]
fn host_fs_writable_ops_create_then_rename_then_unlink() {
    // End-to-end: through HostFsBackend, mkdir creates a real
    // directory, rename moves a real file, unlink removes it.
    // Containment: paths outside host_fs_root return -EACCES.
    use std::fs;
    use std::io::Write;
    build_kernel_wasm().unwrap();

    let dir = std::env::temp_dir().join(format!("yurt-host-fs-mutate-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    {
        let mut f = fs::File::create(dir.join("a.txt")).unwrap();
        f.write_all(b"hi").unwrap();
    }

    let host = HostState {
        host_fs: Some(Arc::new(NativeHostFs::new(dir.clone()))),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();
    mk.mount_host_fs(b"/host").unwrap();

    // mkdir /host/sub
    assert_eq!(
        mk.syscall(METHOD_SYS_MKDIR, b"/host/sub", &mut []).unwrap(),
        0,
    );
    assert!(dir.join("sub").is_dir(), "real mkdir landed on disk");

    // rename /host/a.txt -> /host/sub/b.txt
    let old: &[u8] = b"/host/a.txt";
    let new: &[u8] = b"/host/sub/b.txt";
    let mut req = (old.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(old);
    req.extend_from_slice(new);
    assert_eq!(mk.syscall(METHOD_SYS_RENAME, &req, &mut []).unwrap(), 0,);
    assert!(!dir.join("a.txt").exists());
    assert!(dir.join("sub/b.txt").exists());

    // unlink /host/sub/b.txt
    assert_eq!(
        mk.syscall(METHOD_SYS_UNLINK, b"/host/sub/b.txt", &mut [])
            .unwrap(),
        0,
    );
    assert!(!dir.join("sub/b.txt").exists());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn host_fs_fstat_reports_real_file_size() {
    // sys_fstat on a host-fs fd should return the actual size that
    // kh_real_stat reported at open time, not 0. This drives
    // std::fs::read's precise-allocation path.
    use std::fs;
    use std::io::Write;
    build_kernel_wasm().unwrap();

    let dir = std::env::temp_dir().join(format!("yurt-host-fs-stat-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let payload: &[u8] = b"abcdefghij"; // 10 bytes
    {
        let mut f = fs::File::create(dir.join("ten.txt")).unwrap();
        f.write_all(payload).unwrap();
    }

    let host = HostState {
        host_fs: Some(Arc::new(NativeHostFs::new(dir.clone()))),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();

    mk.mount_host_fs(b"/host").unwrap();

    let mut req = 0_u32.to_le_bytes().to_vec();
    req.extend_from_slice(b"/host/ten.txt");
    let fd = mk.syscall(METHOD_SYS_OPEN, &req, &mut []).unwrap();
    assert!(fd >= 0);

    let mut stat = [0u8; 16];
    let n = mk
        .syscall(METHOD_SYS_FSTAT, &(fd as u32).to_le_bytes(), &mut stat)
        .unwrap();
    assert_eq!(n, 16);
    let size = u64::from_le_bytes(stat[0..8].try_into().unwrap());
    assert_eq!(size, payload.len() as u64);
    let filetype = u32::from_le_bytes(stat[8..12].try_into().unwrap());
    assert_eq!(filetype, 4, "regular file"); // 4 = REGULAR_FILE in WASI

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn host_fs_writes_create_a_real_file() {
    // Open with O_WRITE | O_CREAT under a fresh tempdir; sys_write
    // bytes; close; verify the host now has the file with the
    // expected content.
    use std::fs;
    build_kernel_wasm().unwrap();

    let dir = std::env::temp_dir().join(format!("yurt-host-fs-write-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    let host = HostState {
        host_fs: Some(Arc::new(NativeHostFs::new(dir.clone()))),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();

    mk.mount_host_fs(b"/host").unwrap();

    // sys_open with flags: writable (1) + create-if-missing (2) = 3.
    let mut req = 3_u32.to_le_bytes().to_vec();
    req.extend_from_slice(b"/host/note.txt");
    let fd = mk.syscall(METHOD_SYS_OPEN, &req, &mut []).unwrap();
    assert!(fd >= 0, "open succeeded: fd = {fd}");

    // sys_write payload.
    let mut wreq = (fd as u32).to_le_bytes().to_vec();
    wreq.extend_from_slice(b"hello from sandbox\n");
    let n = mk.syscall(METHOD_SYS_WRITE, &wreq, &mut []).unwrap();
    assert_eq!(n as usize, "hello from sandbox\n".len());

    // sys_close so the file is flushed (Drop on the host File closes).
    let _ = mk.syscall(
        0x1_000E, /* sys_close */
        &(fd as u32).to_le_bytes(),
        &mut [],
    );

    // Verify the host disk content.
    let on_disk = fs::read(dir.join("note.txt")).unwrap();
    assert_eq!(on_disk, b"hello from sandbox\n");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn host_fs_mount_prefix_is_arbitrary() {
    // Embedders pick the mount prefix. Mount the same root at
    // /users/user instead of /host and verify both that /users/user
    // works AND that /host (the previous default) does not exist
    // anymore unless explicitly mounted.
    use std::fs;
    use std::io::Write;
    build_kernel_wasm().unwrap();

    let dir = std::env::temp_dir().join(format!("yurt-host-fs-prefix-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    {
        let mut f = fs::File::create(dir.join("hello.txt")).unwrap();
        f.write_all(b"alt prefix").unwrap();
    }

    let host = HostState {
        host_fs: Some(Arc::new(NativeHostFs::new(dir.clone()))),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();
    mk.mount_host_fs(b"/users/user").unwrap();

    // /host is no longer auto-mounted — open returns -ENOENT.
    let mut req = 0_u32.to_le_bytes().to_vec();
    req.extend_from_slice(b"/host/hello.txt");
    assert_eq!(
        mk.syscall(METHOD_SYS_OPEN, &req, &mut []).unwrap(),
        -2,
        "/host without explicit mount → ENOENT"
    );

    // /users/user/hello.txt opens fine and reads the host bytes.
    let mut req = 0_u32.to_le_bytes().to_vec();
    req.extend_from_slice(b"/users/user/hello.txt");
    let fd = mk.syscall(METHOD_SYS_OPEN, &req, &mut []).unwrap();
    assert!(fd >= 0);
    let mut buf = [0u8; 32];
    let n = mk
        .syscall(METHOD_SYS_READ, &(fd as u32).to_le_bytes(), &mut buf)
        .unwrap();
    assert_eq!(&buf[..n as usize], b"alt prefix");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn yurtfs_mount_overlays_image_with_writable_upper() {
    // The user's canonical example: /bin/python is in the image
    // (lower); a process with permissions overwrites it (upper).
    // Verifies the full L1+L2 + copy-up flow through the
    // kernel_host_interface's `mount_yurtfs` API.
    use std::process::Command;
    build_kernel_wasm().unwrap();

    // Build a tiny tar archive in-memory with /bin/python.
    let tar_bytes = {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut buf);
            let content: &[u8] = b"#!/usr/bin/env python\nprint('image python')\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "bin/python", content)
                .unwrap();
            builder.finish().unwrap();
        }
        buf
    };

    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    mk.mount_yurtfs(b"/img", &tar_bytes).unwrap();

    // Read /img/bin/python — content comes from the lower (tar).
    let mut req = 0_u32.to_le_bytes().to_vec();
    req.extend_from_slice(b"/img/bin/python");
    let fd = mk.syscall(METHOD_SYS_OPEN, &req, &mut []).unwrap();
    assert!(fd >= 0);
    let mut buf = [0u8; 128];
    let n = mk
        .syscall(METHOD_SYS_READ, &(fd as u32).to_le_bytes(), &mut buf)
        .unwrap();
    assert!(
        std::str::from_utf8(&buf[..n as usize])
            .unwrap()
            .contains("image python"),
        "lower content visible: {:?}",
        &buf[..n as usize]
    );

    // Writable open of the same path triggers copy-up.
    let mut wreq = 1_u32.to_le_bytes().to_vec(); // WRITE
    wreq.extend_from_slice(b"/img/bin/python");
    let wfd = mk.syscall(METHOD_SYS_OPEN, &wreq, &mut []).unwrap();
    assert!(wfd >= 0);

    // Truncate first so we don't leave lower bytes after our write.
    let mut sreq = (wfd as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(&0_i64.to_le_bytes());
    sreq.extend_from_slice(&0_u32.to_le_bytes()); // SEEK_SET
    let mut soff = [0u8; 8];
    let _ = mk.syscall(METHOD_SYS_LSEEK, &sreq, &mut soff);

    // Write replacement content.
    let mut wbytes = (wfd as u32).to_le_bytes().to_vec();
    wbytes.extend_from_slice(b"#!/usr/bin/env python\nprint('overlay python')\n");
    let written = mk.syscall(METHOD_SYS_WRITE, &wbytes, &mut []).unwrap();
    assert!(written > 0);

    // Suppress the unused-variable warning from the tar import path.
    let _ = Command::new("true");

    // Re-open read-only — copy-up means we now see overlay content.
    let mut req2 = 0_u32.to_le_bytes().to_vec();
    req2.extend_from_slice(b"/img/bin/python");
    let fd2 = mk.syscall(METHOD_SYS_OPEN, &req2, &mut []).unwrap();
    let mut buf2 = [0u8; 128];
    let n2 = mk
        .syscall(METHOD_SYS_READ, &(fd2 as u32).to_le_bytes(), &mut buf2)
        .unwrap();
    let text2 = std::str::from_utf8(&buf2[..n2 as usize]).unwrap();
    assert!(
        text2.contains("overlay python"),
        "after copy-up + write, reads see upper: {text2:?}"
    );
}

#[test]
fn host_fs_returns_enoent_without_a_root_configured() {
    // Default HostState has host_fs_root = None → kh_real_open
    // returns -EACCES → HostFsBackend.lookup returns None → sys_open
    // sees -ENOENT.
    let mk = fresh_kernel_host_interface(0);
    let mut req = 0_u32.to_le_bytes().to_vec();
    req.extend_from_slice(b"/host/anywhere");
    let rc = mk.syscall(METHOD_SYS_OPEN, &req, &mut []).unwrap();
    assert_eq!(rc, -2, "no host_fs_root → -ENOENT, got {rc}");
}

#[test]
fn host_fs_policy_can_deny_specific_paths() {
    use yurt_runtime_wasmtime::kernel_host_interface::{PolicyDecision, PolicyEnforcer};
    // Policy that says yes to "greeting.txt" and no to "secret.txt".
    struct Allowlist;
    impl PolicyEnforcer for Allowlist {
        fn may_open_path(&self, path: &[u8], _write: bool) -> PolicyDecision {
            if path == b"/greeting.txt" {
                PolicyDecision::Allow
            } else {
                PolicyDecision::Deny
            }
        }
    }
    use std::fs;
    use std::io::Write;
    build_kernel_wasm().unwrap();

    let dir = std::env::temp_dir().join(format!("yurt-host-fs-policy-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    {
        let mut f = fs::File::create(dir.join("greeting.txt")).unwrap();
        f.write_all(b"ok").unwrap();
    }
    {
        let mut f = fs::File::create(dir.join("secret.txt")).unwrap();
        f.write_all(b"nope").unwrap();
    }

    let host = HostState {
        host_fs: Some(Arc::new(NativeHostFs::new(dir.clone()))),
        policy: Arc::new(Allowlist),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();

    mk.mount_host_fs(b"/host").unwrap();

    // Allowed.
    let mut ok = 0_u32.to_le_bytes().to_vec();
    ok.extend_from_slice(b"/host/greeting.txt");
    let fd = mk.syscall(METHOD_SYS_OPEN, &ok, &mut []).unwrap();
    assert!(fd >= 0);

    // Denied → policy returns -EACCES at kh_real_open and the
    // kernel preserves the host errno.
    let mut deny = 0_u32.to_le_bytes().to_vec();
    deny.extend_from_slice(b"/host/secret.txt");
    let rc = mk.syscall(METHOD_SYS_OPEN, &deny, &mut []).unwrap();
    assert_eq!(rc, -13, "policy-denied path → -EACCES, got {rc}");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn deny_all_policy_blocks_realtime_clock() {
    use yurt_runtime_wasmtime::kernel_host_interface::DenyAllPolicy;
    // When a policy denies kh_now_realtime, kernel.wasm sees
    // -EACCES from kh_now_realtime, which sys_clock_gettime
    // forwards back to the caller. (Constant for ergonomic
    // matching: -13 = -EACCES.)
    build_kernel_wasm().unwrap();
    let mk = KernelHostInterface::load(
        ensure_kernel_wasm_built(),
        HostState {
            policy: Arc::new(DenyAllPolicy),
            ..Default::default()
        },
    )
    .unwrap();
    // sys_clock_gettime(REALTIME=0) goes through kh_now_realtime,
    // which the deny-all policy refuses.
    let mut buf = [0u8; 8];
    let rc = mk
        .syscall(METHOD_SYS_CLOCK_GETTIME, &0_u32.to_le_bytes(), &mut buf)
        .unwrap();
    assert!(
        rc < 0,
        "deny-all policy should block clock_gettime: got {rc}"
    );
}

#[test]
fn sys_spawn_stages_child_and_drain_pending_returns_it() {
    // End-to-end: register a "wasm" file in ramfs, parent (pid 1)
    // calls sys_spawn, host drains the staged record, then records
    // exit and the parent's sys_wait reaps. Doesn't actually
    // instantiate the wasm — that's the next slice; this validates
    // the full kernel-stage / host-drain / record-exit / wait loop.
    let mk = fresh_kernel_host_interface(0);
    let body = b"\0asm\x01\x00\x00\x00fake".to_vec();
    let path: &[u8] = b"/bin/echo";
    mk.register_ramfs_file(path, &body).unwrap();

    // Build sys_spawn request: u32 path_len + path + (u32 alen + arg)*
    let mut sreq = (path.len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(path);
    for arg in [b"echo".as_slice(), b"hi".as_slice()] {
        sreq.extend_from_slice(&(arg.len() as u32).to_le_bytes());
        sreq.extend_from_slice(arg);
    }
    let child_pid = mk.syscall_as(1, METHOD_SYS_SPAWN, &sreq, &mut []).unwrap();
    assert!(
        child_pid >= 1000,
        "kernel-allocated pid expected, got {child_pid}"
    );

    // Host drains the staged spawn.
    let pending = mk.drain_pending_spawn().unwrap().expect("staged spawn");
    assert_eq!(pending.child_pid as i64, child_pid);
    assert_eq!(pending.wasm, body);
    assert_eq!(pending.argv, vec![b"echo".to_vec(), b"hi".to_vec()]);

    // Queue is now empty.
    assert!(mk.drain_pending_spawn().unwrap().is_none());

    // Pretend the host ran the child and it exited with 7.
    mk.record_exit(pending.child_pid, 7).unwrap();

    // Need the parent (pid 1) to exist for sys_wait. Spawn it via
    // the regular path so the kernel has its Process record.
    // (sys_spawn already created the parent's children entry.)
    // Parent's sys_wait reaps the child.
    let mut wreq = 0_u32.to_le_bytes().to_vec(); // wait for any
    wreq.extend_from_slice(&0_u32.to_le_bytes()); // no flags
    let mut wresp = [0u8; 8];
    // Use kernel-internal caller_pid path: syscall() defaults to
    // KERNEL_PID; sys_wait resolves children on caller_pid. Need
    // a per-pid syscall API; the trampoline-test scaffold has
    // direct syscall() with implicit caller_pid 0. The parent we
    // want to reap from is pid 1 — use pid_syscall if available.
    let n = mk
        .syscall_as(1, METHOD_SYS_WAIT, &wreq, &mut wresp)
        .unwrap();
    assert_eq!(n, 8, "sys_wait failed: rc={n}");
    assert_eq!(
        u32::from_le_bytes(wresp[0..4].try_into().unwrap()),
        pending.child_pid
    );
    assert_eq!(i32::from_le_bytes(wresp[4..8].try_into().unwrap()), 7);
}

#[test]
fn drain_pending_spawn_handles_wasm_larger_than_legacy_buffer() {
    let mk = fresh_kernel_host_interface(0);
    let body = vec![0x61; 800 * 1024];
    let path: &[u8] = b"/bin/large";
    mk.register_ramfs_file(path, &body).unwrap();

    let mut sreq = (path.len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(path);
    sreq.extend_from_slice(&5_u32.to_le_bytes());
    sreq.extend_from_slice(b"large");

    let child_pid = mk.syscall_as(1, METHOD_SYS_SPAWN, &sreq, &mut []).unwrap();
    let pending = mk.drain_pending_spawn().unwrap().expect("staged spawn");

    assert_eq!(pending.child_pid as i64, child_pid);
    assert_eq!(pending.wasm.len(), body.len());
    assert_eq!(pending.wasm, body);
    assert_eq!(pending.argv, vec![b"large".to_vec()]);
    assert!(mk.drain_pending_spawn().unwrap().is_none());
}

#[test]
fn run_pending_spawns_runs_real_wasm_child_and_parent_reaps() {
    // Full loop: register a real wasm fixture (false-cmd, exits 1)
    // in ramfs, parent calls sys_spawn, run_pending_spawns
    // instantiates + runs + record_exits, parent's sys_wait reaps
    // the actual exit code from the child's proc_exit.
    let mk = fresh_kernel_host_interface(0);
    let target_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap()
        .join("target/wasm32-wasip1/release");
    let body = std::fs::read(target_dir.join("false-cmd-wasm.wasm"))
        .expect("false-cmd-wasm.wasm must be built");
    let path: &[u8] = b"/bin/false";
    mk.register_ramfs_file(path, &body).unwrap();

    let mut sreq = (path.len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(path);
    let arg = b"false".as_slice();
    sreq.extend_from_slice(&(arg.len() as u32).to_le_bytes());
    sreq.extend_from_slice(arg);

    let parent_pid: u32 = 1;
    let child_pid = mk
        .syscall_as(parent_pid, METHOD_SYS_SPAWN, &sreq, &mut [])
        .unwrap() as u32;
    assert!(child_pid >= 1000, "kernel pid range, got {child_pid}");

    let ran = mk.run_pending_spawns().unwrap();
    assert_eq!(ran, 1);

    // Parent's sys_wait must reap the child with the real exit code.
    let mut wreq = 0_u32.to_le_bytes().to_vec();
    wreq.extend_from_slice(&0_u32.to_le_bytes());
    let mut wresp = [0u8; 8];
    let n = mk
        .syscall_as(parent_pid, METHOD_SYS_WAIT, &wreq, &mut wresp)
        .unwrap();
    assert_eq!(n, 8);
    assert_eq!(
        u32::from_le_bytes(wresp[0..4].try_into().unwrap()),
        child_pid
    );
    let status = i32::from_le_bytes(wresp[4..8].try_into().unwrap());
    assert_eq!(status, 1, "false-cmd exits with 1, got {status}");
}

#[test]
fn run_pending_spawns_preserves_spawned_child_fd_inheritance() {
    let mk = fresh_kernel_host_interface(0);
    let child = wat::parse_str(
        r#"
        (module
          (import "env" "sys_write" (func $write (param i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 16) "child\n")
          (func (export "_start")
            (drop (call $write (i32.const 1) (i32.const 16) (i32.const 6)))))
        "#,
    )
    .unwrap();
    let child_path = b"/bin/write-child";
    mk.register_ramfs_file(child_path, &child).unwrap();

    let parent_pid = 1;
    let mut open_req = (0b001_u32 | 0b010 | 0b100).to_le_bytes().to_vec();
    open_req.extend_from_slice(b"/tmp/spawn-out");
    let out_fd = mk
        .syscall_as(parent_pid, METHOD_SYS_OPEN, &open_req, &mut [])
        .unwrap();
    assert_eq!(out_fd, 3);

    let mut dup2_req = (out_fd as u32).to_le_bytes().to_vec();
    dup2_req.extend_from_slice(&1_u32.to_le_bytes());
    assert_eq!(
        mk.syscall_as(parent_pid, METHOD_SYS_DUP2, &dup2_req, &mut [])
            .unwrap(),
        1
    );
    assert_eq!(
        mk.syscall_as(
            parent_pid,
            METHOD_SYS_CLOSE,
            &(out_fd as u32).to_le_bytes(),
            &mut [],
        )
        .unwrap(),
        0
    );

    let mut spawn_req = (child_path.len() as u32).to_le_bytes().to_vec();
    spawn_req.extend_from_slice(child_path);
    spawn_req.extend_from_slice(&5_u32.to_le_bytes());
    spawn_req.extend_from_slice(b"child");
    let child_pid = mk
        .syscall_as(parent_pid, METHOD_SYS_SPAWN, &spawn_req, &mut [])
        .unwrap();
    assert!(child_pid >= 1000, "kernel child pid expected: {child_pid}");

    assert_eq!(mk.run_pending_spawns().unwrap(), 1);

    let mut read_open = 0_u32.to_le_bytes().to_vec();
    read_open.extend_from_slice(b"/tmp/spawn-out");
    let read_fd = mk
        .syscall_as(parent_pid, METHOD_SYS_OPEN, &read_open, &mut [])
        .unwrap();
    assert!(read_fd >= 3, "read fd expected, got {read_fd}");

    let mut out = [0u8; 16];
    assert_eq!(
        mk.syscall_as(
            parent_pid,
            METHOD_SYS_READ,
            &(read_fd as u32).to_le_bytes(),
            &mut out,
        )
        .unwrap(),
        6
    );
    assert_eq!(&out[..6], b"child\n");
}

#[test]
fn redb_kv_persists_across_kernel_host_interface_restarts() {
    // RedbKv is one concrete impl behind the pluggable KvBackend
    // trait. Embedders may swap in sled / rocksdb / SQLite / S3
    // by writing their own KvBackend impl — this test just
    // exercises the in-tree redb-backed one.
    //
    // Phase 1: write entries through one KernelHostInterface instance.
    // Phase 2: drop it, build a fresh KernelHostInterface pointing at the
    // same redb file, and confirm the entries are still readable.
    use std::fs;
    let dir = std::env::temp_dir().join(format!("yurt-redb-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("kv.redb");
    build_kernel_wasm().unwrap();

    {
        let kv = Arc::new(RedbKv::open(db_path.clone()).unwrap());
        let host = HostState {
            kv: Some(kv),
            ..Default::default()
        };
        let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();

        let mut put_req = vec![5_u8];
        put_req.extend_from_slice(b"users");
        put_req.extend_from_slice(&3_u32.to_le_bytes());
        put_req.extend_from_slice(b"abc");
        put_req.extend_from_slice(b"alice");
        assert_eq!(
            mk.syscall(METHOD_SYS_IDB_PUT, &put_req, &mut []).unwrap(),
            0,
        );
    }

    {
        let kv = Arc::new(RedbKv::open(db_path.clone()).unwrap());
        let host = HostState {
            kv: Some(kv),
            ..Default::default()
        };
        let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();

        let mut get_req = vec![5_u8];
        get_req.extend_from_slice(b"users");
        get_req.extend_from_slice(b"abc");
        let mut buf = vec![0u8; 32];
        let n = mk.syscall(METHOD_SYS_IDB_GET, &get_req, &mut buf).unwrap();
        assert_eq!(n, 5);
        assert_eq!(&buf[..n as usize], b"alice");
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn sys_idb_put_get_delete_list_round_trips() {
    // Full kv loop through the trampoline. InMemoryKv satisfies
    // KvBackend without disk I/O — same shape browser
    // kernel-host interfaces will use against IndexedDB.
    build_kernel_wasm().unwrap();
    let host = HostState {
        kv: Some(Arc::new(InMemoryKv::new())),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();

    let store: &[u8] = b"sessions";
    // put: u8 store_len + store + u32 key_len LE + key + value
    let put_req = |store: &[u8], key: &[u8], value: &[u8]| -> Vec<u8> {
        let mut r = vec![store.len() as u8];
        r.extend_from_slice(store);
        r.extend_from_slice(&(key.len() as u32).to_le_bytes());
        r.extend_from_slice(key);
        r.extend_from_slice(value);
        r
    };
    let store_key = |store: &[u8], key: &[u8]| -> Vec<u8> {
        let mut r = vec![store.len() as u8];
        r.extend_from_slice(store);
        r.extend_from_slice(key);
        r
    };

    // put a couple entries.
    assert_eq!(
        mk.syscall(
            METHOD_SYS_IDB_PUT,
            &put_req(store, b"alice", b"AAA"),
            &mut []
        )
        .unwrap(),
        0,
    );
    assert_eq!(
        mk.syscall(METHOD_SYS_IDB_PUT, &put_req(store, b"bob", b"BBB"), &mut [])
            .unwrap(),
        0,
    );

    // get one back.
    let mut buf = vec![0u8; 32];
    let n = mk
        .syscall(METHOD_SYS_IDB_GET, &store_key(store, b"alice"), &mut buf)
        .unwrap();
    assert_eq!(n, 3);
    assert_eq!(&buf[..n as usize], b"AAA");

    // list keys with prefix.
    let mut buf = vec![0u8; 256];
    let n = mk
        .syscall(METHOD_SYS_IDB_LIST, &store_key(store, b""), &mut buf)
        .unwrap();
    assert!(n >= 4);
    let count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    assert_eq!(count, 2);

    // delete + miss.
    assert_eq!(
        mk.syscall(METHOD_SYS_IDB_DELETE, &store_key(store, b"alice"), &mut [])
            .unwrap(),
        0,
    );
    let rc = mk
        .syscall(METHOD_SYS_IDB_GET, &store_key(store, b"alice"), &mut buf)
        .unwrap();
    assert_eq!(rc, -2, "deleted key should miss with -ENOENT, got {rc}");
}

#[test]
fn sys_idb_denied_by_policy_returns_eacces() {
    use yurt_runtime_wasmtime::kernel_host_interface::DenyAllPolicy;
    build_kernel_wasm().unwrap();
    let mk = KernelHostInterface::load(
        ensure_kernel_wasm_built(),
        HostState {
            policy: Arc::new(DenyAllPolicy),
            kv: Some(Arc::new(InMemoryKv::new())),
            ..Default::default()
        },
    )
    .unwrap();
    let mut req = vec![1u8, b's'];
    req.extend_from_slice(b"k");
    let rc = mk.syscall(METHOD_SYS_IDB_GET, &req, &mut [0u8; 8]).unwrap();
    assert_eq!(rc, -13, "deny → -EACCES, got {rc}");
}

#[test]
fn sys_socket_listen_accept_round_trips_through_kernel() {
    // Userland inside the sandbox listens on 127.0.0.1:0 (host-
    // chosen port), retrieves the actual port via sys_socket_addr,
    // and accepts an incoming connection. A test thread plays the
    // remote dialer and writes a payload; the listener accepts,
    // recv's the bytes, validates them.
    use std::io::Write;
    use std::net::TcpStream;

    build_kernel_wasm().unwrap();
    let host = HostState {
        tcp: Some(Arc::new(NativeTcpSocket::new())),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();

    let listener = mk
        .syscall(
            METHOD_SYS_SOCKET_OPEN,
            &[
                2, /* AF_INET */
                1, /* SOCK_STREAM */
                0, 0, 0, 0, 0, 0,
            ],
            &mut [],
        )
        .unwrap();
    assert!(listener >= 0, "socket failed: {listener}");
    let listener_handle = listener as i32;
    let mut bind_req = listener_handle.to_le_bytes().to_vec();
    bind_req.extend_from_slice(b"127.0.0.1:0");
    assert_eq!(
        mk.syscall(METHOD_SYS_SOCKET_BIND, &bind_req, &mut [])
            .unwrap(),
        0
    );
    let mut listen_req = listener_handle.to_le_bytes().to_vec();
    listen_req.extend_from_slice(&16_u32.to_le_bytes());
    assert_eq!(
        mk.syscall(METHOD_SYS_SOCKET_LISTEN, &listen_req, &mut [])
            .unwrap(),
        0
    );

    // Discover the actually-bound port.
    let mut addr_buf = [0u8; 64];
    let n = mk
        .syscall(
            METHOD_SYS_SOCKET_ADDR,
            &listener_handle.to_le_bytes(),
            &mut addr_buf,
        )
        .unwrap();
    assert!(n > 2, "addr response: {n}");
    let port = u16::from_le_bytes(addr_buf[0..2].try_into().unwrap());
    assert!(port > 0, "kernel-chosen port must be non-zero");

    // Dial from a separate thread so accept() can complete.
    let dialer = std::thread::spawn(move || {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(b"incoming").unwrap();
    });

    // Accept (blocks until the dialer connects).
    let mut acc_req = listener_handle.to_le_bytes().to_vec();
    acc_req.extend_from_slice(&0_u32.to_le_bytes()); // flags=0 (blocking)
    let conn = mk
        .syscall(METHOD_SYS_SOCKET_ACCEPT, &acc_req, &mut [])
        .unwrap();
    assert!(conn >= 0, "accept failed: {conn}");
    let conn_handle = conn as i32;

    // recv on the connection.
    let mut recv_req = conn_handle.to_le_bytes().to_vec();
    recv_req.extend_from_slice(&0_u32.to_le_bytes());
    let mut buf = vec![0u8; 64];
    let n = mk
        .syscall(METHOD_SYS_SOCKET_RECV, &recv_req, &mut buf)
        .unwrap();
    assert!(n > 0, "recv failed: {n}");
    assert_eq!(&buf[..n as usize], b"incoming");

    let _ = dialer.join();
    assert_eq!(
        mk.syscall(METHOD_SYS_SOCKET_CLOSE, &conn_handle.to_le_bytes(), &mut [])
            .unwrap(),
        0,
    );
    assert_eq!(
        mk.syscall(
            METHOD_SYS_SOCKET_CLOSE,
            &listener_handle.to_le_bytes(),
            &mut []
        )
        .unwrap(),
        0,
    );
}

#[test]
fn sys_socket_listen_denied_by_policy_returns_eacces() {
    use yurt_runtime_wasmtime::kernel_host_interface::DenyAllPolicy;
    build_kernel_wasm().unwrap();
    let mk = KernelHostInterface::load(
        ensure_kernel_wasm_built(),
        HostState {
            policy: Arc::new(DenyAllPolicy),
            tcp: Some(Arc::new(NativeTcpSocket::new())),
            ..Default::default()
        },
    )
    .unwrap();
    let socket = mk
        .syscall(
            METHOD_SYS_SOCKET_OPEN,
            &[
                2, /* AF_INET */
                1, /* SOCK_STREAM */
                0, 0, 0, 0, 0, 0,
            ],
            &mut [],
        )
        .unwrap();
    let mut bind_req = (socket as i32).to_le_bytes().to_vec();
    bind_req.extend_from_slice(b"127.0.0.1:0");
    assert_eq!(
        mk.syscall(METHOD_SYS_SOCKET_BIND, &bind_req, &mut [])
            .unwrap(),
        0
    );
    let mut req = (socket as i32).to_le_bytes().to_vec();
    req.extend_from_slice(&16_u32.to_le_bytes());
    let rc = mk.syscall(METHOD_SYS_SOCKET_LISTEN, &req, &mut []).unwrap();
    assert_eq!(rc, -13, "deny → -EACCES, got {rc}");
}

#[test]
fn sys_socket_connect_send_recv_through_local_echo_server() {
    // Spin up a one-shot TCP echo server on 127.0.0.1, dial it
    // through sys_socket_connect, send a payload, recv it back,
    // verify byte-for-byte. The server thread shuts down as soon
    // as the connection closes — keeps the test self-contained.
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 64];
            if let Ok(n) = stream.read(&mut buf) {
                let _ = stream.write_all(&buf[..n]);
            }
        }
    });

    build_kernel_wasm().unwrap();
    let host = HostState {
        tcp: Some(Arc::new(NativeTcpSocket::new())),
        ..Default::default()
    };
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), host).unwrap();

    let handle = mk
        .syscall(
            METHOD_SYS_SOCKET_OPEN,
            &[
                2, /* AF_INET */
                1, /* SOCK_STREAM */
                0, 0, 0, 0, 0, 0,
            ],
            &mut [],
        )
        .unwrap();
    assert!(handle >= 0, "socket failed: {handle}");

    // sys_socket_connect request: u32 fd + addr ("host:port" UTF-8).
    let addr = format!("127.0.0.1:{port}");
    let mut req = (handle as i32).to_le_bytes().to_vec();
    req.extend_from_slice(addr.as_bytes());
    let rc = mk
        .syscall(METHOD_SYS_SOCKET_CONNECT, &req, &mut [])
        .unwrap();
    assert_eq!(rc, 0, "connect failed: {rc}");

    // Send a payload.
    let payload = b"hello tcp";
    let mut send_req = (handle as i32).to_le_bytes().to_vec();
    send_req.extend_from_slice(payload);
    let n = mk
        .syscall(METHOD_SYS_SOCKET_SEND, &send_req, &mut [])
        .unwrap();
    assert_eq!(n as usize, payload.len());

    // Receive it back.
    let mut recv_req = (handle as i32).to_le_bytes().to_vec();
    recv_req.extend_from_slice(&0_u32.to_le_bytes()); // flags=0 (blocking)
    let mut buf = vec![0u8; 64];
    let n = mk
        .syscall(METHOD_SYS_SOCKET_RECV, &recv_req, &mut buf)
        .unwrap();
    assert!(n > 0, "recv failed: {n}");
    assert_eq!(&buf[..n as usize], payload);

    // Close.
    let close_req = (handle as i32).to_le_bytes();
    assert_eq!(
        mk.syscall(METHOD_SYS_SOCKET_CLOSE, &close_req, &mut [])
            .unwrap(),
        0,
    );
    let _ = server.join();
}

#[test]
fn sys_socket_connect_denied_by_policy_returns_eacces() {
    use yurt_runtime_wasmtime::kernel_host_interface::DenyAllPolicy;
    build_kernel_wasm().unwrap();
    let mk = KernelHostInterface::load(
        ensure_kernel_wasm_built(),
        HostState {
            policy: Arc::new(DenyAllPolicy),
            tcp: Some(Arc::new(NativeTcpSocket::new())),
            ..Default::default()
        },
    )
    .unwrap();
    let socket = mk
        .syscall(METHOD_SYS_SOCKET_OPEN, &[2, 1, 0, 0, 0, 0, 0, 0], &mut [])
        .unwrap();
    let mut req = (socket as i32).to_le_bytes().to_vec();
    req.extend_from_slice(b"127.0.0.1:1");
    let rc = mk
        .syscall(METHOD_SYS_SOCKET_CONNECT, &req, &mut [])
        .unwrap();
    assert_eq!(rc, -13, "deny → -EACCES, got {rc}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sys_fetch_round_trips_through_kh_fetch_blocking() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hello"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"world"))
        .mount(&server)
        .await;

    // The kh handler builds its own current-thread runtime via
    // OnceLock and `block_on`s the future; calling that from inside
    // a multi-thread tokio context is fine because we're not inside
    // the runtime itself when the kernel syscall fires.
    let mk = fresh_kernel_host_interface(0);
    let req = serde_json::json!({
        "url": format!("{}/hello", server.uri()),
        "method": "GET",
    });
    let req_bytes = req.to_string().into_bytes();
    let mut resp = vec![0u8; 8 * 1024];
    let n = mk.syscall(METHOD_SYS_FETCH, &req_bytes, &mut resp).unwrap();
    assert!(n > 0, "sys_fetch returned {n}");
    let body = std::str::from_utf8(&resp[..n as usize]).unwrap();
    let v: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["status"], 200);
    assert_eq!(v["body"], "world");
}

#[test]
fn sys_fetch_denied_by_policy_returns_eacces() {
    use yurt_runtime_wasmtime::kernel_host_interface::DenyAllPolicy;
    build_kernel_wasm().unwrap();
    let mk = KernelHostInterface::load(
        ensure_kernel_wasm_built(),
        HostState {
            policy: Arc::new(DenyAllPolicy),
            ..Default::default()
        },
    )
    .unwrap();
    let req = br#"{"url":"http://example.invalid","method":"GET"}"#;
    let mut resp = [0u8; 64];
    let rc = mk.syscall(METHOD_SYS_FETCH, req, &mut resp).unwrap();
    assert_eq!(rc, -13, "deny policy should return -EACCES, got {rc}");
}

#[test]
fn sys_extension_invoke_returns_negated_enoent_when_no_registry() {
    // Default registry is empty; -ENOENT propagates back through the
    // trampoline as a negative scalar.
    let mk = fresh_kernel_host_interface(0);
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
    //     → kernel_host_interface forwards to kernel.wasm via kernel_dispatch
    //         → kernel handles METHOD_SYS_GETUID, returns 1000
    //     ← kernel_host_interface writes scalar back into user.wasm
    //   user.wasm receives 1000 and returns it from `run`
    //
    // No previous test actually instantiated a user-process wasm.
    // This is the missing architectural piece.
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();

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
fn kernel_host_interface_direct_syscall_uses_kernel_pid_zero() {
    // KernelHostInterface-owned syscalls (no user process in flight) see the
    // kernel as their caller — pid 0. sys_getpid via dispatch
    // therefore returns 0.
    let mk = fresh_kernel_host_interface(0);
    let rc = mk.syscall(METHOD_SYS_GETPID, &[], &mut []).unwrap();
    assert_eq!(rc, 0, "kernel_host_interface direct call sees KERNEL_PID");
}

#[test]
fn user_process_sees_its_assigned_pid() {
    // First spawned process is pid 1; getpid returns it through the
    // full trampoline. Validates caller_pid plumbing end-to-end.
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
fn user_process_pipe_round_trip_within_one_process() {
    // The full single-process pipe lifecycle through the trampoline:
    // pipe() returns two fds, write() to the writer end, read() from
    // the reader end, close both, second read returns -EBADF.
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_pipe"  (func $pipe  (param i32) (result i32)))
          (import "env" "sys_read"  (func $read  (param i32 i32 i32) (result i32)))
          (import "env" "sys_write" (func $write (param i32 i32 i32) (result i32)))
          (import "env" "sys_close" (func $close (param i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 64) "hello pipe")
          ;; pipe() writes (read_fd, write_fd) to offset 16 (8 bytes).
          (func (export "do_pipe") (result i32) (call $pipe (i32.const 16)))
          (func (export "read_fd")  (result i32) (i32.load (i32.const 16)))
          (func (export "write_fd") (result i32) (i32.load (i32.const 20)))
          ;; write 10 bytes from offset 64 to write_fd loaded from mem[20].
          (func (export "do_write") (result i32)
            (call $write (i32.load (i32.const 20)) (i32.const 64) (i32.const 10)))
          ;; read up to 16 bytes from read_fd into offset 128.
          (func (export "do_read") (result i32)
            (call $read (i32.load (i32.const 16)) (i32.const 128) (i32.const 16)))
          (func (export "close_writer") (result i32)
            (call $close (i32.load (i32.const 20))))
          (func (export "close_reader") (result i32)
            (call $close (i32.load (i32.const 16)))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();

    assert_eq!(user.call_export_i32("do_pipe").unwrap(), 0);
    assert_eq!(user.call_export_i32("read_fd").unwrap(), 3);
    assert_eq!(user.call_export_i32("write_fd").unwrap(), 4);

    assert_eq!(user.call_export_i32("do_write").unwrap(), 10);
    assert_eq!(user.call_export_i32("do_read").unwrap(), 10);
    let got = user.read_memory(128, 10).unwrap();
    assert_eq!(&got, b"hello pipe");

    // After draining, with writer still open, another read returns
    // -EAGAIN (Phase 2 nonblocking semantics — kh_yield comes later).
    assert_eq!(user.call_export_i32("do_read").unwrap(), -11);

    // Close writer; subsequent read sees EOF (0).
    assert_eq!(user.call_export_i32("close_writer").unwrap(), 0);
    assert_eq!(user.call_export_i32("do_read").unwrap(), 0);

    // Closing the reader frees the buffer.
    assert_eq!(user.call_export_i32("close_reader").unwrap(), 0);
}

#[test]
fn user_process_poll_reports_pipe_write_readiness() {
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_pipe" (func $pipe (param i32) (result i32)))
          (import "env" "sys_poll" (func $poll (param i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (func (export "setup") (result i32)
            (call $pipe (i32.const 16)))
          (func (export "poll_writer") (result i32)
            (i32.store (i32.const 32) (i32.load (i32.const 20)))
            (i32.store16 (i32.const 36) (i32.const 2))
            (i32.store16 (i32.const 38) (i32.const 0))
            (call $poll (i32.const 32) (i32.const 1) (i32.const 0)))
          (func (export "writer_revents") (result i32)
            (i32.load16_u (i32.const 38))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();

    assert_eq!(user.call_export_i32("setup").unwrap(), 0);
    assert_eq!(user.call_export_i32("poll_writer").unwrap(), 1);
    assert_eq!(user.call_export_i32("writer_revents").unwrap(), 2);
}

#[test]
fn user_process_socketpair_round_trips_bytes_through_kernel() {
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_socketpair" (func $socketpair (param i32 i32 i32 i32) (result i32)))
          (import "env" "sys_socket_send" (func $send (param i32 i32 i32) (result i64)))
          (import "env" "sys_socket_recv" (func $recv (param i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 1)
          (data (i32.const 64) "hello unix")
          (func (export "setup") (result i32)
            (call $socketpair (i32.const 1) (i32.const 1) (i32.const 0) (i32.const 16)))
          (func (export "left_fd") (result i32)
            (i32.load (i32.const 16)))
          (func (export "right_fd") (result i32)
            (i32.load (i32.const 20)))
          (func (export "send_left") (result i32)
            (i32.wrap_i64
              (call $send (i32.load (i32.const 16)) (i32.const 64) (i32.const 10))))
          (func (export "recv_right") (result i32)
            (i32.wrap_i64
              (call $recv (i32.load (i32.const 20)) (i32.const 128) (i32.const 16) (i32.const 0)))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();

    assert_eq!(user.call_export_i32("setup").unwrap(), 8);
    assert_eq!(user.call_export_i32("left_fd").unwrap(), 3);
    assert_eq!(user.call_export_i32("right_fd").unwrap(), 4);
    assert_eq!(user.call_export_i32("send_left").unwrap(), 10);
    assert_eq!(user.call_export_i32("recv_right").unwrap(), 10);
    let got = user.read_memory(128, 10).unwrap();
    assert_eq!(&got, b"hello unix");
}

#[test]
fn user_process_socketpair_datagram_preserves_message_boundaries() {
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_socketpair" (func $socketpair (param i32 i32 i32 i32) (result i32)))
          (import "env" "sys_socket_send" (func $send (param i32 i32 i32) (result i64)))
          (import "env" "sys_socket_recv" (func $recv (param i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 1)
          (data (i32.const 64) "first")
          (data (i32.const 80) "second")
          (func (export "setup") (result i32)
            (call $socketpair (i32.const 3) (i32.const 5) (i32.const 0) (i32.const 16)))
          (func (export "send_messages") (result i32)
            (drop (call $send (i32.load (i32.const 16)) (i32.const 64) (i32.const 5)))
            (i32.wrap_i64
              (call $send (i32.load (i32.const 16)) (i32.const 80) (i32.const 6))))
          (func (export "recv_short") (result i32)
            (i32.wrap_i64
              (call $recv (i32.load (i32.const 20)) (i32.const 128) (i32.const 3) (i32.const 0))))
          (func (export "recv_next") (result i32)
            (i32.wrap_i64
              (call $recv (i32.load (i32.const 20)) (i32.const 144) (i32.const 16) (i32.const 0)))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();

    assert_eq!(user.call_export_i32("setup").unwrap(), 8);
    assert_eq!(user.call_export_i32("send_messages").unwrap(), 6);
    assert_eq!(user.call_export_i32("recv_short").unwrap(), 3);
    assert_eq!(&user.read_memory(128, 3).unwrap(), b"fir");
    assert_eq!(user.call_export_i32("recv_next").unwrap(), 6);
    assert_eq!(&user.read_memory(144, 6).unwrap(), b"second");
}

#[test]
fn user_process_af_unix_path_stream_round_trips_through_kernel() {
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_socket_open" (func $open (param i32 i32 i32) (result i32)))
          (import "env" "sys_socket_bind" (func $bind (param i32 i32 i32) (result i32)))
          (import "env" "sys_socket_listen" (func $listen (param i32 i32) (result i32)))
          (import "env" "sys_socket_connect" (func $connect (param i32 i32 i32) (result i32)))
          (import "env" "sys_socket_accept" (func $accept (param i32 i32) (result i32)))
          (import "env" "sys_socket_send" (func $send (param i32 i32 i32) (result i64)))
          (import "env" "sys_socket_recv" (func $recv (param i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 1)
          (data (i32.const 64) "unix:/tmp/trampoline.sock")
          (data (i32.const 96) "from client")
          (data (i32.const 128) "from server")
          (global $listener (mut i32) (i32.const -1))
          (global $client (mut i32) (i32.const -1))
          (global $server (mut i32) (i32.const -1))
          (func (export "setup") (result i32)
            (global.set $listener (call $open (i32.const 3) (i32.const 6) (i32.const 0)))
            (drop (call $bind (global.get $listener) (i32.const 64) (i32.const 25)))
            (drop (call $listen (global.get $listener) (i32.const 4)))
            (global.set $client (call $open (i32.const 3) (i32.const 6) (i32.const 0)))
            (drop (call $connect (global.get $client) (i32.const 64) (i32.const 25)))
            (global.set $server (call $accept (global.get $listener) (i32.const 0)))
            (i32.add
              (i32.add (global.get $listener) (global.get $client))
              (global.get $server)))
          (func (export "send_client") (result i32)
            (i32.wrap_i64
              (call $send (global.get $client) (i32.const 96) (i32.const 11))))
          (func (export "recv_server") (result i32)
            (i32.wrap_i64
              (call $recv (global.get $server) (i32.const 160) (i32.const 16) (i32.const 0))))
          (func (export "send_server") (result i32)
            (i32.wrap_i64
              (call $send (global.get $server) (i32.const 128) (i32.const 11))))
          (func (export "recv_client") (result i32)
            (i32.wrap_i64
              (call $recv (global.get $client) (i32.const 192) (i32.const 16) (i32.const 0)))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();

    assert_eq!(user.call_export_i32("setup").unwrap(), 12);
    assert_eq!(user.call_export_i32("send_client").unwrap(), 11);
    assert_eq!(user.call_export_i32("recv_server").unwrap(), 11);
    assert_eq!(&user.read_memory(160, 11).unwrap(), b"from client");
    assert_eq!(user.call_export_i32("send_server").unwrap(), 11);
    assert_eq!(user.call_export_i32("recv_client").unwrap(), 11);
    assert_eq!(&user.read_memory(192, 11).unwrap(), b"from server");
}

#[test]
fn wasmtime_registers_new_af_unix_socket_syscalls() {
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_socket_info" (func $socket_info (param i32 i32) (result i64)))
          (import "env" "sys_socket_recvfrom"
            (func $recvfrom (param i32 i32 i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 1)
          (func (export "info") (result i32)
            (i32.wrap_i64 (call $socket_info (i32.const 404) (i32.const 0))))
          (func (export "recvfrom") (result i32)
            (i32.wrap_i64
              (call $recvfrom
                (i32.const 404)
                (i32.const 32)
                (i32.const 8)
                (i32.const 64)
                (i32.const 108)
                (i32.const 108)))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();
    assert_eq!(user.call_export_i32("info").unwrap(), -9);
    assert_eq!(user.call_export_i32("recvfrom").unwrap(), -9);
}

#[test]
fn wasmtime_registers_all_vfs_process_syscall_imports() {
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_chmod" (func $chmod (param i32 i32 i32) (result i32)))
          (import "env" "sys_chown" (func $chown (param i32 i32 i32 i32) (result i32)))
          (import "env" "sys_utimens" (func $utimens (param i64 i32 i32) (result i32)))
          (import "env" "sys_unlink" (func $unlink (param i32 i32) (result i32)))
          (import "env" "sys_stat" (func $stat (param i32 i32 i32) (result i32)))
          (import "env" "sys_symlink" (func $symlink (param i32 i32 i32 i32) (result i32)))
          (import "env" "sys_readlink" (func $readlink (param i32 i32 i32 i32) (result i32)))
          (import "env" "sys_mkdir" (func $mkdir (param i32 i32) (result i32)))
          (import "env" "sys_rmdir" (func $rmdir (param i32 i32) (result i32)))
          (import "env" "sys_readdir" (func $readdir (param i32 i32 i32 i32) (result i32)))
          (import "env" "sys_wait" (func $wait (param i32 i32 i32) (result i32)))
          (import "env" "sys_link" (func $link (param i32 i32 i32 i32) (result i32)))
          (import "env" "sys_rename" (func $rename (param i32 i32 i32 i32) (result i32)))
          (import "env" "sys_spawn" (func $spawn (param i32 i32) (result i32)))
          (import "env" "sys_extension_invoke"
            (func $extension_invoke (param i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 1)
          (data (i32.const 32) "/missing")
          (func (export "missing_stat") (result i32)
            (call $stat (i32.const 32) (i32.const 8) (i32.const 64))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();
    assert_eq!(user.call_export_i32("missing_stat").unwrap(), -2);
}

#[test]
fn user_process_pipe_dup_keeps_writer_alive() {
    // dup() on a pipe end must increment the kernel-side refcount;
    // closing the original fd should not collapse the buffer.
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_pipe"  (func $pipe  (param i32) (result i32)))
          (import "env" "sys_dup"   (func $dup   (param i32) (result i32)))
          (import "env" "sys_read"  (func $read  (param i32 i32 i32) (result i32)))
          (import "env" "sys_close" (func $close (param i32) (result i32)))
          (memory (export "memory") 1)
          (func (export "setup") (result i32)
            (call $pipe (i32.const 16)))
          (func (export "dup_writer") (result i32)
            (call $dup (i32.load (i32.const 20))))
          (func (export "close_orig_writer") (result i32)
            (call $close (i32.load (i32.const 20))))
          (func (export "read_one") (result i32)
            (call $read (i32.load (i32.const 16)) (i32.const 128) (i32.const 16))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();
    assert_eq!(user.call_export_i32("setup").unwrap(), 0);
    let dup_fd = user.call_export_i32("dup_writer").unwrap();
    assert!(dup_fd > 0, "dup returned a positive fd");
    // Close original writer; reader still has one writer attached.
    assert_eq!(user.call_export_i32("close_orig_writer").unwrap(), 0);
    // Read should be -EAGAIN (writers attached, no data) — not EOF.
    assert_eq!(user.call_export_i32("read_one").unwrap(), -11);
}

#[test]
fn user_process_fd_table_dup_close_lifecycle() {
    // Validates the complete fd-table mechanic through a single user
    // process: default fds 0/1/2 are open, dup() returns the next
    // free slot, dup2() can install at an arbitrary fd, and close()
    // frees the slot for re-allocation. Closing an already-closed fd
    // surfaces -EBADF (= -9).
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
fn user_process_scheduler_imports_route_through_kernel_state() {
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
    let user_wat = r#"
        (module
          (import "env" "sys_sched_getscheduler" (func $getscheduler (param i32) (result i32)))
          (import "env" "sys_sched_getparam" (func $getparam (param i32) (result i32)))
          (import "env" "sys_sched_setscheduler" (func $setscheduler (param i32 i32 i32) (result i32)))
          (import "env" "sys_sched_setparam" (func $setparam (param i32 i32) (result i32)))
          (func (export "get_policy") (result i32)
            (call $getscheduler (i32.const 0)))
          (func (export "get_param") (result i32)
            (call $getparam (i32.const 0)))
          (func (export "setscheduler_other") (result i32)
            (call $setscheduler (i32.const 0) (i32.const 0) (i32.const 0)))
          (func (export "setparam_zero") (result i32)
            (call $setparam (i32.const 0) (i32.const 0)))
          (func (export "setparam_nonzero") (result i32)
            (call $setparam (i32.const 0) (i32.const 1)))
          (func (export "setscheduler_fifo") (result i32)
            (call $setscheduler (i32.const 0) (i32.const 1) (i32.const 1))))
    "#;
    let mut user = mk
        .spawn_user_process(&wat::parse_str(user_wat).unwrap())
        .unwrap();

    assert_eq!(user.call_export_i32("get_policy").unwrap(), 0);
    assert_eq!(user.call_export_i32("get_param").unwrap(), 0);
    assert_eq!(user.call_export_i32("setscheduler_other").unwrap(), 0);
    assert_eq!(user.call_export_i32("setparam_zero").unwrap(), 0);
    assert_eq!(user.call_export_i32("setparam_nonzero").unwrap(), -22);
    assert_eq!(user.call_export_i32("setscheduler_fifo").unwrap(), -1);
}

#[test]
fn user_process_can_call_kernel_multiple_times() {
    // The Rc<RefCell<KernelInstance>> sharing pattern must support
    // repeated borrow_mut acquisitions without deadlock or panic.
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();
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
fn kernel_host_interface_method_ids_match_yurt_abi_methods_toml() {
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
        (
            "sys_getpriority",
            METHOD_SYS_GETPRIORITY,
            METHOD_SYS_GETPRIORITY as i64,
        ),
        (
            "sys_setpriority",
            METHOD_SYS_SETPRIORITY,
            METHOD_SYS_SETPRIORITY as i64,
        ),
        (
            "sys_sched_getscheduler",
            METHOD_SYS_SCHED_GETSCHEDULER,
            METHOD_SYS_SCHED_GETSCHEDULER as i64,
        ),
        (
            "sys_sched_getparam",
            METHOD_SYS_SCHED_GETPARAM,
            METHOD_SYS_SCHED_GETPARAM as i64,
        ),
        (
            "sys_sched_setscheduler",
            METHOD_SYS_SCHED_SETSCHEDULER,
            METHOD_SYS_SCHED_SETSCHEDULER as i64,
        ),
        (
            "sys_sched_setparam",
            METHOD_SYS_SCHED_SETPARAM,
            METHOD_SYS_SCHED_SETPARAM as i64,
        ),
        ("sys_poll", METHOD_SYS_POLL, METHOD_SYS_POLL as i64),
        ("sys_close", METHOD_SYS_CLOSE, METHOD_SYS_CLOSE as i64),
        ("sys_dup", METHOD_SYS_DUP, METHOD_SYS_DUP as i64),
        ("sys_dup2", METHOD_SYS_DUP2, METHOD_SYS_DUP2 as i64),
        ("sys_pipe", METHOD_SYS_PIPE, METHOD_SYS_PIPE as i64),
        ("sys_read", METHOD_SYS_READ, METHOD_SYS_READ as i64),
        ("sys_write", METHOD_SYS_WRITE, METHOD_SYS_WRITE as i64),
        ("sys_isatty", METHOD_SYS_ISATTY, METHOD_SYS_ISATTY as i64),
        (
            "sys_clock_gettime",
            METHOD_SYS_CLOCK_GETTIME,
            METHOD_SYS_CLOCK_GETTIME as i64,
        ),
        (
            "sys_extension_invoke",
            METHOD_SYS_EXTENSION_INVOKE,
            METHOD_SYS_EXTENSION_INVOKE as i64,
        ),
        ("sys_getpgid", METHOD_SYS_GETPGID, METHOD_SYS_GETPGID as i64),
        ("sys_setpgid", METHOD_SYS_SETPGID, METHOD_SYS_SETPGID as i64),
        ("sys_getsid", METHOD_SYS_GETSID, METHOD_SYS_GETSID as i64),
        ("sys_setsid", METHOD_SYS_SETSID, METHOD_SYS_SETSID as i64),
        ("sys_kill", METHOD_SYS_KILL, METHOD_SYS_KILL as i64),
        (
            "sys_sigaction",
            METHOD_SYS_SIGACTION,
            METHOD_SYS_SIGACTION as i64,
        ),
        (
            "sys_sched_yield",
            METHOD_SYS_SCHED_YIELD,
            METHOD_SYS_SCHED_YIELD as i64,
        ),
        (
            "sys_nanosleep",
            METHOD_SYS_NANOSLEEP,
            METHOD_SYS_NANOSLEEP as i64,
        ),
        ("sys_open", METHOD_SYS_OPEN, METHOD_SYS_OPEN as i64),
        ("sys_lseek", METHOD_SYS_LSEEK, METHOD_SYS_LSEEK as i64),
        ("sys_fstat", METHOD_SYS_FSTAT, METHOD_SYS_FSTAT as i64),
        ("sys_chmod", METHOD_SYS_CHMOD, METHOD_SYS_CHMOD as i64),
        ("sys_chown", METHOD_SYS_CHOWN, METHOD_SYS_CHOWN as i64),
        ("sys_utimens", METHOD_SYS_UTIMENS, METHOD_SYS_UTIMENS as i64),
        ("sys_unlink", METHOD_SYS_UNLINK, METHOD_SYS_UNLINK as i64),
        ("sys_stat", METHOD_SYS_STAT, METHOD_SYS_STAT as i64),
        ("sys_symlink", METHOD_SYS_SYMLINK, METHOD_SYS_SYMLINK as i64),
        (
            "sys_readlink",
            METHOD_SYS_READLINK,
            METHOD_SYS_READLINK as i64,
        ),
        ("sys_mkdir", METHOD_SYS_MKDIR, METHOD_SYS_MKDIR as i64),
        ("sys_rmdir", METHOD_SYS_RMDIR, METHOD_SYS_RMDIR as i64),
        ("sys_readdir", METHOD_SYS_READDIR, METHOD_SYS_READDIR as i64),
        ("sys_wait", METHOD_SYS_WAIT, METHOD_SYS_WAIT as i64),
        ("sys_link", METHOD_SYS_LINK, METHOD_SYS_LINK as i64),
        ("sys_rename", METHOD_SYS_RENAME, METHOD_SYS_RENAME as i64),
        ("sys_spawn", METHOD_SYS_SPAWN, METHOD_SYS_SPAWN as i64),
        ("sys_fetch", METHOD_SYS_FETCH, METHOD_SYS_FETCH as i64),
        (
            "sys_socket_connect",
            METHOD_SYS_SOCKET_CONNECT,
            METHOD_SYS_SOCKET_CONNECT as i64,
        ),
        (
            "sys_socket_send",
            METHOD_SYS_SOCKET_SEND,
            METHOD_SYS_SOCKET_SEND as i64,
        ),
        (
            "sys_socket_recv",
            METHOD_SYS_SOCKET_RECV,
            METHOD_SYS_SOCKET_RECV as i64,
        ),
        (
            "sys_socket_close",
            METHOD_SYS_SOCKET_CLOSE,
            METHOD_SYS_SOCKET_CLOSE as i64,
        ),
        ("sys_idb_get", METHOD_SYS_IDB_GET, METHOD_SYS_IDB_GET as i64),
        ("sys_idb_put", METHOD_SYS_IDB_PUT, METHOD_SYS_IDB_PUT as i64),
        (
            "sys_idb_delete",
            METHOD_SYS_IDB_DELETE,
            METHOD_SYS_IDB_DELETE as i64,
        ),
        (
            "sys_idb_list",
            METHOD_SYS_IDB_LIST,
            METHOD_SYS_IDB_LIST as i64,
        ),
        (
            "sys_socket_listen",
            METHOD_SYS_SOCKET_LISTEN,
            METHOD_SYS_SOCKET_LISTEN as i64,
        ),
        (
            "sys_socket_accept",
            METHOD_SYS_SOCKET_ACCEPT,
            METHOD_SYS_SOCKET_ACCEPT as i64,
        ),
        (
            "sys_socket_addr",
            METHOD_SYS_SOCKET_ADDR,
            METHOD_SYS_SOCKET_ADDR as i64,
        ),
        (
            "sys_socket_sendto",
            METHOD_SYS_SOCKET_SENDTO,
            METHOD_SYS_SOCKET_SENDTO as i64,
        ),
        (
            "sys_socket_sendmsg",
            METHOD_SYS_SOCKET_SENDMSG,
            METHOD_SYS_SOCKET_SENDMSG as i64,
        ),
        (
            "sys_socket_recvmsg",
            METHOD_SYS_SOCKET_RECVMSG,
            METHOD_SYS_SOCKET_RECVMSG as i64,
        ),
        (
            "sys_socket_info",
            METHOD_SYS_SOCKET_INFO,
            METHOD_SYS_SOCKET_INFO as i64,
        ),
        (
            "sys_socket_recvfrom",
            METHOD_SYS_SOCKET_RECVFROM,
            METHOD_SYS_SOCKET_RECVFROM as i64,
        ),
        (
            "sys_socketpair",
            METHOD_SYS_SOCKETPAIR,
            METHOD_SYS_SOCKETPAIR as i64,
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
fn process_group_and_session_round_trip_through_trampoline() {
    // Exercises the pgid/sid family end-to-end:
    //   (1) getpgid(target=42) lazily primes pgid to the target pid,
    //   (2) setpgid(target=42, pgid=99) reassigns,
    //   (3) getsid(target=42) lazily primes sid to the target pid.
    // KERNEL_PID is the caller for direct .syscall() calls, so we use
    // an explicit non-zero target pid throughout.
    let mk = fresh_kernel_host_interface(0);

    // Default getpgid(42) → 42.
    let rc = mk
        .syscall(METHOD_SYS_GETPGID, &42_u32.to_le_bytes(), &mut [])
        .unwrap();
    assert_eq!(rc, 42, "lazy getpgid primes to target pid");

    // setpgid(42, 99).
    let mut req = Vec::new();
    req.extend_from_slice(&42_u32.to_le_bytes());
    req.extend_from_slice(&99_u32.to_le_bytes());
    let rc = mk.syscall(METHOD_SYS_SETPGID, &req, &mut []).unwrap();
    assert_eq!(rc, 0, "setpgid succeeds");

    // getpgid now reflects 99.
    let rc = mk
        .syscall(METHOD_SYS_GETPGID, &42_u32.to_le_bytes(), &mut [])
        .unwrap();
    assert_eq!(rc, 99, "setpgid took effect across the trampoline");

    // getsid(42) lazily primes to 42 (separate from pgid).
    let rc = mk
        .syscall(METHOD_SYS_GETSID, &42_u32.to_le_bytes(), &mut [])
        .unwrap();
    assert_eq!(rc, 42, "getsid lazy-primes independently of pgid");
}

#[test]
fn signal_storage_round_trips_through_trampoline() {
    // Phase 2 stubs: sys_kill records pending bits, sys_sigaction
    // returns the previous disposition. Actual delivery requires
    // asyncify/JSPI unwind and lands with the AsyncBridge integration.
    let mk = fresh_kernel_host_interface(0);

    // sigaction(SIGTERM=15, SIG_IGN=1) → previous SIG_DFL=0.
    let mut req = Vec::new();
    req.extend_from_slice(&15_u32.to_le_bytes());
    req.extend_from_slice(&1_u32.to_le_bytes());
    let rc = mk.syscall(METHOD_SYS_SIGACTION, &req, &mut []).unwrap();
    assert_eq!(rc, 0, "previous disposition was SIG_DFL");

    // Replace with a user handler value; previous should be SIG_IGN=1.
    let mut req2 = Vec::new();
    req2.extend_from_slice(&15_u32.to_le_bytes());
    req2.extend_from_slice(&0xDEAD_u32.to_le_bytes());
    let rc = mk.syscall(METHOD_SYS_SIGACTION, &req2, &mut []).unwrap();
    assert_eq!(rc, 1, "previous disposition was SIG_IGN");

    // kill(target=7, sig=0) is the alive-probe; nonexistent
    // processes return -ESRCH.
    let mut req3 = Vec::new();
    req3.extend_from_slice(&7_u32.to_le_bytes());
    req3.extend_from_slice(&0_u32.to_le_bytes());
    let rc = mk.syscall(METHOD_SYS_KILL, &req3, &mut []).unwrap();
    assert_eq!(rc, -3, "sig 0 on a missing process returns -ESRCH");

    // kill out-of-range → -EINVAL.
    let mut req4 = Vec::new();
    req4.extend_from_slice(&7_u32.to_le_bytes());
    req4.extend_from_slice(&64_u32.to_le_bytes());
    let rc = mk.syscall(METHOD_SYS_KILL, &req4, &mut []).unwrap();
    assert_eq!(rc, -22, "EINVAL for sig out of 1..=63");
}

#[test]
fn sched_yield_and_nanosleep_round_trip_through_trampoline() {
    // Phase 2 acknowledge-and-return stubs. We can't observe per-pid
    // counters from outside the kernel.wasm sandbox, so this test
    // just asserts the trampoline paths work end-to-end and return 0.
    let mk = fresh_kernel_host_interface(0);
    let rc = mk.syscall(METHOD_SYS_SCHED_YIELD, &[], &mut []).unwrap();
    assert_eq!(rc, 0);
    let req = 1_500_000_u64.to_le_bytes(); // 1.5ms
    let rc = mk.syscall(METHOD_SYS_NANOSLEEP, &req, &mut []).unwrap();
    assert_eq!(rc, 0);
    // Short request → -EINVAL.
    let rc = mk
        .syscall(METHOD_SYS_NANOSLEEP, &[1, 2, 3], &mut [])
        .unwrap();
    assert_eq!(rc, -22);
}

#[test]
fn ramfs_open_then_read_round_trips_content_through_trampoline() {
    // End-to-end: kernel_host_interface → kernel_register_file → kernel.wasm
    // ramfs → kernel_host_interface.syscall(SYS_OPEN, …) → fd → SYS_READ.
    let mk = fresh_kernel_host_interface(0);
    mk.register_ramfs_file(b"/etc/motd", b"hello ramfs\n")
        .unwrap();

    // Open the file as KERNEL_PID. Returns fd 0 (kernel pid has no
    // pre-installed stdio because direct syscalls aren't a real
    // process — the fd_table is only auto-populated when a Process
    // record is first observed; previous direct calls to KERNEL_PID
    // already touched it via the credentials calls upstream of us in
    // the test runner, so the lowest free fd is 3).
    // sys_open wire format: u32 flags + path bytes. flags=0 = read-only.
    let mut open_req = 0_u32.to_le_bytes().to_vec();
    open_req.extend_from_slice(b"/etc/motd");
    let fd = mk.syscall(METHOD_SYS_OPEN, &open_req, &mut []).unwrap();
    assert!(fd >= 0, "open succeeded: fd = {fd}");

    // Read the content into a buffer.
    let mut buf = [0u8; 64];
    let n = mk
        .syscall(METHOD_SYS_READ, &(fd as u32).to_le_bytes(), &mut buf)
        .unwrap();
    assert_eq!(n as usize, b"hello ramfs\n".len());
    assert_eq!(&buf[..n as usize], b"hello ramfs\n");

    // Open of an unknown path → -ENOENT (-2).
    let mut miss_req = 0_u32.to_le_bytes().to_vec();
    miss_req.extend_from_slice(b"/no/such");
    let rc = mk.syscall(METHOD_SYS_OPEN, &miss_req, &mut []).unwrap();
    assert_eq!(rc, -2);
}

#[test]
fn credentials_syscalls_round_trip_through_trampoline() {
    // First user-facing syscall family. Pure scalar return; no memory
    // copies. With no process kernel yet, all four resolve to the TS
    // kernel's USER_UID/USER_GID = 1000 fallback.
    let mk = fresh_kernel_host_interface(0);
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
