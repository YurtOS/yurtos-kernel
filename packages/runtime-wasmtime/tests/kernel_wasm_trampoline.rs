//! End-to-end smoke test for the sandboxed-kernel architecture.
//!
//! Builds `yurt-kernel-wasm` for `wasm32-wasip1`, loads the resulting
//! `.wasm` in a wasmtime engine, and invokes the `kernel_dispatch`
//! export across the wasm boundary. This is the minimum viable
//! microkernel: a host that instantiates kernel.wasm and forwards a
//! single user→kernel trampoline call. Until later phases wire real
//! `host_*` syscalls and `kh_*` host imports, this proves the
//! architectural shape works:
//!
//!   host process ──► wasmtime instance (kernel.wasm) ──► kernel_dispatch
//!                                                             │
//!                              -ENOSYS (-38) ◄───────────────┘
//!
//! See `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use wasmtime::{Caller, Config, Engine, Linker, Module, Store};

const ENOSYS: i64 = 38;

/// Build a Linker that satisfies the current `kh_*` import surface.
/// `now_realtime_ns` is the deterministic value the host serves to the
/// kernel for each `kh_now_realtime` call; the test asserts on it.
fn microkernel_linker(engine: &Engine, now_realtime_ns: u64) -> Linker<()> {
    let mut linker: Linker<()> = Linker::new(engine);
    linker
        .func_wrap(
            "kh",
            "kh_now_realtime",
            move |mut caller: Caller<'_, ()>, out_ptr: u32| -> i32 {
                let memory = caller.get_export("memory").unwrap().into_memory().unwrap();
                memory
                    .write(
                        &mut caller,
                        out_ptr as usize,
                        &now_realtime_ns.to_le_bytes(),
                    )
                    .unwrap();
                0
            },
        )
        .unwrap();
    linker
}

fn workspace_root() -> PathBuf {
    // packages/runtime-wasmtime → ../../ is workspace root.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("workspace root")
        .to_path_buf()
}

fn kernel_wasm_path() -> PathBuf {
    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root().join("target"));
    target_dir.join("wasm32-wasip1/release/yurt_kernel_wasm.wasm")
}

fn build_kernel_wasm() {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .args([
            "build",
            "--release",
            "-p",
            "yurt-kernel-wasm",
            "--target",
            "wasm32-wasip1",
        ])
        .current_dir(workspace_root())
        .status()
        .expect("spawn cargo");
    assert!(status.success(), "kernel-wasm build failed");
}

#[test]
fn microkernel_loads_kernel_wasm_and_unknown_method_returns_negated_enosys() {
    build_kernel_wasm();
    let wasm = std::fs::read(kernel_wasm_path()).expect("kernel.wasm exists after build");

    let mut config = Config::new();
    config.async_support(false);
    let engine = Engine::new(&config).unwrap();
    let module = Module::new(&engine, &wasm).expect("compile kernel.wasm");
    let linker = microkernel_linker(&engine, 0);
    let mut store = Store::new(&engine, ());
    let instance = linker
        .instantiate(&mut store, &module)
        .expect("instantiate kernel.wasm");

    let dispatch = instance
        .get_typed_func::<(u32, u32, u32, u32, u32), i64>(&mut store, "kernel_dispatch")
        .expect("kernel_dispatch export with expected (i32×5)->i64 signature");

    // Trampoline call from the microkernel side. No request bytes, no
    // out buffer — null pointers are valid per the kernel's contract.
    // A method id of 0xDEADBEEF is unregistered, so the kernel must
    // return -ENOSYS in negated-errno form.
    let rc = dispatch
        .call(&mut store, (0xDEAD_BEEF, 0, 0, 0, 0))
        .expect("dispatch call traps-free");

    assert_eq!(
        rc, -ENOSYS,
        "expected -ENOSYS through the wasm trampoline, got {rc}"
    );
}

#[test]
fn kernel_wasm_exports_only_memory_and_kernel_dispatch() {
    // Architectural invariant: kernel.wasm exposes one entry point to the
    // microkernel (`kernel_dispatch`) plus its linear memory. Anything
    // else creeping in is a regression.
    build_kernel_wasm();
    let wasm = std::fs::read(kernel_wasm_path()).expect("kernel.wasm exists after build");
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

const METHOD_ECHO: u32 = 1;

#[test]
fn microkernel_round_trips_request_and_response_through_kernel_memory() {
    // Memory-mediated trampoline: the microkernel writes a request into
    // kernel.wasm's linear memory at the kernel-published scratch
    // offset, calls kernel_dispatch with method=ECHO, then reads the
    // response back from kernel memory. This is the architectural
    // primitive that every real syscall in Phase 2+ will sit on top of.
    build_kernel_wasm();
    let wasm = std::fs::read(kernel_wasm_path()).expect("kernel.wasm exists after build");
    let engine = Engine::default();
    let module = Module::new(&engine, &wasm).unwrap();
    let linker = microkernel_linker(&engine, 0);
    let mut store = Store::new(&engine, ());
    let instance = linker.instantiate(&mut store, &module).unwrap();

    let memory = instance.get_memory(&mut store, "memory").unwrap();
    let scratch_ptr = instance
        .get_typed_func::<(), u32>(&mut store, "kernel_scratch_ptr")
        .unwrap()
        .call(&mut store, ())
        .unwrap();
    let scratch_len = instance
        .get_typed_func::<(), u32>(&mut store, "kernel_scratch_len")
        .unwrap()
        .call(&mut store, ())
        .unwrap();
    let dispatch = instance
        .get_typed_func::<(u32, u32, u32, u32, u32), i64>(&mut store, "kernel_dispatch")
        .unwrap();

    let request = b"trampoline-validates-the-architecture";
    let in_ptr = scratch_ptr;
    let out_ptr = scratch_ptr + 1024; // Disjoint region inside scratch.
    let out_cap = request.len() as u32;
    assert!(
        out_ptr + out_cap <= scratch_ptr + scratch_len,
        "test buffer fits in scratch"
    );

    // Microkernel writes the request into kernel memory.
    memory
        .write(&mut store, in_ptr as usize, request)
        .expect("write request into kernel scratch");
    // Pre-fill the response region so we can detect that the kernel
    // actually wrote into it (and didn't just leave whatever was
    // there before).
    memory
        .write(&mut store, out_ptr as usize, &vec![0xAA; request.len()])
        .unwrap();

    let rc = dispatch
        .call(
            &mut store,
            (METHOD_ECHO, in_ptr, request.len() as u32, out_ptr, out_cap),
        )
        .expect("echo dispatch");
    assert_eq!(rc, request.len() as i64);

    // Microkernel reads the response back out of kernel memory.
    let mut got = vec![0u8; request.len()];
    memory
        .read(&store, out_ptr as usize, &mut got)
        .expect("read response from kernel scratch");
    assert_eq!(&got, request, "round-trip preserved bytes");
}

#[test]
fn kernel_wasm_imports_only_documented_kh_namespace() {
    // Phase guard: every kernel→host import must live in the "kh"
    // namespace and match `abi/contract/kernel_host_abi.toml`. When a
    // new `kh_*` import lands without being added to the microkernel
    // Linker (or vice versa), this test is the early-warning system.
    build_kernel_wasm();
    let wasm = std::fs::read(kernel_wasm_path()).expect("kernel.wasm exists after build");
    let engine = Engine::default();
    let module = Module::new(&engine, &wasm).unwrap();

    let mut imports: Vec<(String, String)> = module
        .imports()
        .map(|i| (i.module().to_owned(), i.name().to_owned()))
        .collect();
    imports.sort();
    let expected = vec![("kh".to_owned(), "kh_now_realtime".to_owned())];
    assert_eq!(imports, expected);
}

#[test]
fn microkernel_serves_kh_call_during_kernel_dispatch() {
    // Kernel→host direction: kernel.wasm calls back into the microkernel
    // via a `kh_*` import while servicing a syscall. The microkernel's
    // host function writes the requested value into kernel memory; the
    // kernel reads it, copies it into the syscall response buffer, and
    // returns. This proves the second half of the architecture
    // (microkernel ◄── kernel.wasm) end-to-end.
    build_kernel_wasm();
    let wasm = std::fs::read(kernel_wasm_path()).expect("kernel.wasm exists after build");
    let engine = Engine::default();
    let module = Module::new(&engine, &wasm).unwrap();

    let now_ns: u64 = 1_715_000_000_000_000_000;
    let linker = microkernel_linker(&engine, now_ns);
    let mut store = Store::new(&engine, ());
    let instance = linker.instantiate(&mut store, &module).unwrap();

    let memory = instance.get_memory(&mut store, "memory").unwrap();
    let scratch_ptr = instance
        .get_typed_func::<(), u32>(&mut store, "kernel_scratch_ptr")
        .unwrap()
        .call(&mut store, ())
        .unwrap();
    let dispatch = instance
        .get_typed_func::<(u32, u32, u32, u32, u32), i64>(&mut store, "kernel_dispatch")
        .unwrap();

    const METHOD_NOW_REALTIME: u32 = 2;
    let out_ptr = scratch_ptr;
    let rc = dispatch
        .call(&mut store, (METHOD_NOW_REALTIME, 0, 0, out_ptr, 8))
        .expect("now_realtime dispatch");
    assert_eq!(rc, 8, "kernel returns the number of bytes written");

    let mut buf = [0u8; 8];
    memory.read(&store, out_ptr as usize, &mut buf).unwrap();
    assert_eq!(u64::from_le_bytes(buf), now_ns);
}

#[test]
fn credentials_syscalls_round_trip_through_trampoline() {
    // First user-facing syscall family. Each method returns the
    // process credential as a scalar via the dispatch return value —
    // no memory copies needed. With no process tree yet, all four
    // resolve to the TS kernel's USER_UID/USER_GID fallback (1000).
    build_kernel_wasm();
    let wasm = std::fs::read(kernel_wasm_path()).expect("kernel.wasm exists after build");
    let engine = Engine::default();
    let module = Module::new(&engine, &wasm).unwrap();
    let linker = microkernel_linker(&engine, 0);
    let mut store = Store::new(&engine, ());
    let instance = linker.instantiate(&mut store, &module).unwrap();
    let dispatch = instance
        .get_typed_func::<(u32, u32, u32, u32, u32), i64>(&mut store, "kernel_dispatch")
        .unwrap();

    const METHOD_HOST_GETUID: u32 = 0x1_0001;
    const METHOD_HOST_GETEUID: u32 = 0x1_0002;
    const METHOD_HOST_GETGID: u32 = 0x1_0003;
    const METHOD_HOST_GETEGID: u32 = 0x1_0004;

    for (name, method) in [
        ("getuid", METHOD_HOST_GETUID),
        ("geteuid", METHOD_HOST_GETEUID),
        ("getgid", METHOD_HOST_GETGID),
        ("getegid", METHOD_HOST_GETEGID),
    ] {
        let rc = dispatch.call(&mut store, (method, 0, 0, 0, 0)).unwrap();
        assert_eq!(rc, 1000, "{name} returns default 1000");
    }
}

#[test]
fn microkernel_kh_call_count_matches_dispatch_count() {
    // Each METHOD_NOW_REALTIME dispatch must trigger exactly one
    // kh_now_realtime call. Counting at the host side confirms the
    // kernel isn't silently caching or short-circuiting.
    build_kernel_wasm();
    let wasm = std::fs::read(kernel_wasm_path()).expect("kernel.wasm exists after build");
    let engine = Engine::default();
    let module = Module::new(&engine, &wasm).unwrap();

    let calls = Arc::new(Mutex::new(0u32));
    let mut linker: Linker<()> = Linker::new(&engine);
    let calls_for_host = calls.clone();
    linker
        .func_wrap(
            "kh",
            "kh_now_realtime",
            move |mut caller: Caller<'_, ()>, out_ptr: u32| -> i32 {
                *calls_for_host.lock().unwrap() += 1;
                let memory = caller.get_export("memory").unwrap().into_memory().unwrap();
                memory
                    .write(&mut caller, out_ptr as usize, &0u64.to_le_bytes())
                    .unwrap();
                0
            },
        )
        .unwrap();

    let mut store = Store::new(&engine, ());
    let instance = linker.instantiate(&mut store, &module).unwrap();
    let scratch_ptr = instance
        .get_typed_func::<(), u32>(&mut store, "kernel_scratch_ptr")
        .unwrap()
        .call(&mut store, ())
        .unwrap();
    let dispatch = instance
        .get_typed_func::<(u32, u32, u32, u32, u32), i64>(&mut store, "kernel_dispatch")
        .unwrap();

    const METHOD_NOW_REALTIME: u32 = 2;
    for _ in 0..3 {
        let rc = dispatch
            .call(&mut store, (METHOD_NOW_REALTIME, 0, 0, scratch_ptr, 8))
            .unwrap();
        assert_eq!(rc, 8);
    }

    assert_eq!(*calls.lock().unwrap(), 3);
}
