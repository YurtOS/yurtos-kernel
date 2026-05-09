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
    let mut mk = fresh_microkernel(0);
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
fn kernel_wasm_imports_only_documented_kh_namespace() {
    // Phase guard: when a new `kh_*` import lands without being added
    // to the microkernel Linker (or vice versa), this test catches it.
    let wasm = std::fs::read(ensure_kernel_wasm_built()).unwrap();
    let engine = Engine::default();
    let module = Module::new(&engine, &wasm).unwrap();
    let mut imports: Vec<(String, String)> = module
        .imports()
        .map(|i| (i.module().to_owned(), i.name().to_owned()))
        .collect();
    imports.sort();
    assert_eq!(
        imports,
        vec![
            ("kh".to_owned(), "kh_extension_invoke".to_owned()),
            ("kh".to_owned(), "kh_log".to_owned()),
            ("kh".to_owned(), "kh_now_realtime".to_owned()),
        ]
    );
}

#[test]
fn microkernel_round_trips_request_and_response_through_kernel_memory() {
    // Memory-mediated trampoline: ECHO copies request → response in
    // kernel memory; the microkernel reads it back. Architectural
    // primitive every variable-size syscall builds on.
    let mut mk = fresh_microkernel(0);
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
    let mut mk = fresh_microkernel(now_ns);
    let mut response = [0u8; 8];
    let rc = mk.syscall(METHOD_NOW_REALTIME, &[], &mut response).unwrap();
    assert_eq!(rc, 8);
    assert_eq!(u64::from_le_bytes(response), now_ns);
}

#[test]
fn microkernel_serves_fresh_kh_value_each_dispatch() {
    // The kernel must not cache the kh result. Mutating HostState
    // between dispatches changes the response.
    let mut mk = fresh_microkernel(100);
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
    let mut mk = Microkernel::load(
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
    let mut mk = Microkernel::load(
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
    let mut mk = fresh_microkernel(0);
    let mut response = [0u8; 64];
    let rc = mk
        .syscall(METHOD_SYS_EXTENSION_INVOKE, b"{}", &mut response)
        .unwrap();
    assert_eq!(rc, -2, "expected -ENOENT, got {rc}");
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
    let mut mk = fresh_microkernel(0);
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
