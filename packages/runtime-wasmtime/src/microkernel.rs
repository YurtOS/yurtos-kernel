//! Sandboxed-kernel microkernel skeleton.
//!
//! Loads `yurt-kernel-wasm` (compiled to `wasm32-wasip1`) into a
//! wasmtime engine, satisfies the documented `kh_*` import surface,
//! and forwards user-syscall requests into `kernel_dispatch`. Also
//! spawns user processes into separate stores whose `host_*` imports
//! are wired back through the kernel.
//!
//! Eventually extracted into:
//! - `packages/microkernel-wasmtime` (this code)
//! - `packages/microkernel-browser` (JSPI/asyncify)
//! - `packages/microkernel-deno` (debug)
//!
//! Any wasm runtime that hosts the same `kh_*` imports and calls
//! `kernel_dispatch` is a supported backend — see
//! `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.

use std::cell::{RefCell, RefMut};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use wasmtime::{Caller, Engine, Linker, Memory, Module, Store, TypedFunc};

/// Fully-qualified path of the `kh_*` import namespace.
const KH_NAMESPACE: &str = "kh";

/// Module name user processes import their syscalls from. Default for
/// C / Rust `extern "C"` declarations without an explicit
/// `#[link(wasm_import_module = …)]`.
const SYS_NAMESPACE: &str = "env";

/// POSIX errno values referenced by the trampoline. Mirrors
/// `abi/contract/yurt_abi.toml`.
const EFAULT: i64 = 14;
const ENOENT: i64 = 2;

/// Method ids that the user-process linker forwards. Generated
/// constants live inside `yurt-kernel-wasm`'s build artifact, not in
/// the host crate, so we mirror the ones we forward here. Drift is
/// caught by the `microkernel_method_ids_match_yurt_abi_methods_toml`
/// trampoline test.
mod sys_method_id {
    pub const GETUID: u32 = 0x1_0001;
    pub const GETEUID: u32 = 0x1_0002;
    pub const GETGID: u32 = 0x1_0003;
    pub const GETEGID: u32 = 0x1_0004;
}

// ── Host-side traits embedders implement ─────────────────────────────────────

/// Microkernel-side handler for `sys_extension_invoke`. Receives the
/// opaque request bytes the calling process supplied; writes the
/// response bytes into `response`. Returns bytes written or negated
/// POSIX errno (e.g. `-ENOENT` if no handler matches).
pub trait ExtensionRegistry: Send + Sync {
    fn invoke(&self, request: &[u8], response: &mut [u8]) -> i64;
}

/// Empty registry — all extension calls return `-ENOENT`. Useful as a
/// safe default for embedders that don't expose extensions.
pub struct EmptyExtensionRegistry;

impl ExtensionRegistry for EmptyExtensionRegistry {
    fn invoke(&self, _request: &[u8], _response: &mut [u8]) -> i64 {
        -ENOENT
    }
}

/// Microkernel-side sink for `kh_log` messages from kernel.wasm.
/// Severity values mirror `LogSeverity` in the kernel: 0 = debug,
/// 1 = info, 2 = warn, 3 = error.
pub trait LogSink: Send + Sync {
    fn emit(&self, severity: u32, message: &str);
}

pub struct DiscardLogSink;

impl LogSink for DiscardLogSink {
    fn emit(&self, _severity: u32, _message: &str) {}
}

pub struct StderrLogSink;

impl LogSink for StderrLogSink {
    fn emit(&self, severity: u32, message: &str) {
        let label = match severity {
            0 => "debug",
            1 => "info",
            2 => "warn",
            _ => "error",
        };
        eprintln!("[kernel.wasm {label}] {message}");
    }
}

/// State threaded through every wasmtime host callback that runs
/// during kernel.wasm execution.
pub struct HostState {
    pub now_realtime_ns: u64,
    pub extensions: Arc<dyn ExtensionRegistry>,
    pub log_sink: Arc<dyn LogSink>,
}

impl Default for HostState {
    fn default() -> Self {
        Self {
            now_realtime_ns: 0,
            extensions: Arc::new(EmptyExtensionRegistry),
            log_sink: Arc::new(DiscardLogSink),
        }
    }
}

// ── Kernel instance: the loaded kernel.wasm + its wasmtime handles ─────────

/// The loaded kernel.wasm plus the typed handles needed to drive it.
/// Kept behind `Rc<RefCell<…>>` so that both the [`Microkernel`] and
/// any spawned [`UserProcess`] can call into it.
pub struct KernelInstance {
    store: Store<HostState>,
    memory: Memory,
    scratch_ptr: u32,
    scratch_len: u32,
    dispatch: TypedFunc<(u32, u32, u32, u32, u32), i64>,
}

impl KernelInstance {
    /// Run a syscall. Stages `request` in the kernel scratch buffer,
    /// invokes `kernel_dispatch`, copies the response back out.
    pub fn syscall(&mut self, method_id: u32, request: &[u8], response: &mut [u8]) -> Result<i64> {
        if request.len() + response.len() > self.scratch_len as usize {
            return Err(anyhow!(
                "request+response ({} bytes) exceeds scratch capacity ({} bytes)",
                request.len() + response.len(),
                self.scratch_len
            ));
        }
        let in_ptr = self.scratch_ptr;
        let in_len = request.len() as u32;
        let out_ptr = self.scratch_ptr + in_len;
        let out_cap = response.len() as u32;

        if !request.is_empty() {
            self.memory
                .write(&mut self.store, in_ptr as usize, request)
                .context("write syscall request into kernel scratch")?;
        }
        let rc = self
            .dispatch
            .call(
                &mut self.store,
                (method_id, in_ptr, in_len, out_ptr, out_cap),
            )
            .context("kernel_dispatch")?;
        if !response.is_empty() {
            self.memory
                .read(&self.store, out_ptr as usize, response)
                .context("read syscall response from kernel scratch")?;
        }
        Ok(rc)
    }
}

// ── Microkernel: orchestrates the kernel and user processes ───────────────

pub struct Microkernel {
    engine: Engine,
    kernel: Rc<RefCell<KernelInstance>>,
}

impl Microkernel {
    /// Load `kernel.wasm` from `path` into a fresh wasmtime engine and
    /// instantiate it with the documented `kh_*` import surface.
    pub fn load(path: &Path, host_state: HostState) -> Result<Self> {
        let wasm = std::fs::read(path)
            .with_context(|| format!("read kernel.wasm at {}", path.display()))?;
        let engine = Engine::default();
        let module = Module::new(&engine, &wasm).context("compile kernel.wasm")?;

        let mut linker: Linker<HostState> = Linker::new(&engine);
        register_kh_imports(&mut linker)?;

        let mut store = Store::new(&engine, host_state);
        let instance = linker
            .instantiate(&mut store, &module)
            .context("instantiate kernel.wasm")?;

        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| anyhow!("kernel.wasm missing 'memory' export"))?;
        let scratch_ptr = instance
            .get_typed_func::<(), u32>(&mut store, "kernel_scratch_ptr")?
            .call(&mut store, ())?;
        let scratch_len = instance
            .get_typed_func::<(), u32>(&mut store, "kernel_scratch_len")?
            .call(&mut store, ())?;
        let dispatch = instance
            .get_typed_func::<(u32, u32, u32, u32, u32), i64>(&mut store, "kernel_dispatch")?;

        let kernel = KernelInstance {
            store,
            memory,
            scratch_ptr,
            scratch_len,
            dispatch,
        };
        Ok(Self {
            engine,
            kernel: Rc::new(RefCell::new(kernel)),
        })
    }

    /// Invoke a kernel syscall directly (no user process). Useful for
    /// tests and for operations that originate inside the microkernel
    /// itself.
    pub fn syscall(&self, method_id: u32, request: &[u8], response: &mut [u8]) -> Result<i64> {
        self.kernel
            .borrow_mut()
            .syscall(method_id, request, response)
    }

    /// Mutable view of the host state served to kernel.wasm. Returns a
    /// `RefMut` that derefs to `&mut HostState`.
    pub fn host_state_mut(&self) -> RefMut<'_, HostState> {
        RefMut::map(self.kernel.borrow_mut(), |k| k.store.data_mut())
    }

    /// Compile and instantiate a user process whose `host_*` imports
    /// are forwarded back into the kernel via the trampoline.
    pub fn spawn_user_process(&self, wasm: &[u8]) -> Result<UserProcess> {
        let module = Module::new(&self.engine, wasm).context("compile user-process wasm")?;
        let mut linker: Linker<UserState> = Linker::new(&self.engine);
        register_sys_imports(&mut linker)?;

        let user_state = UserState {
            kernel: self.kernel.clone(),
        };
        let mut store = Store::new(&self.engine, user_state);
        let instance = linker
            .instantiate(&mut store, &module)
            .context("instantiate user-process wasm")?;
        Ok(UserProcess { store, instance })
    }
}

// ── User process ─────────────────────────────────────────────────────────────

/// State threaded through every host callback that runs during a
/// user-process call. Holds a shared reference to the kernel so
/// `host_*` imports can forward into `kernel_dispatch`.
pub struct UserState {
    kernel: Rc<RefCell<KernelInstance>>,
}

/// A spawned user-process instance.
pub struct UserProcess {
    store: Store<UserState>,
    instance: wasmtime::Instance,
}

impl UserProcess {
    /// Invoke an exported `() -> i32` function. The convention for
    /// trampoline tests is a `run() -> i32` export that returns the
    /// scalar result of a single syscall; richer entry points come
    /// later.
    pub fn call_run(&mut self) -> Result<i32> {
        let f = self
            .instance
            .get_typed_func::<(), i32>(&mut self.store, "run")
            .context("user-process missing 'run() -> i32' export")?;
        f.call(&mut self.store, ()).context("user-process run()")
    }
}

// ── Linker registration ──────────────────────────────────────────────────────

fn register_kh_imports(linker: &mut Linker<HostState>) -> Result<()> {
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_now_realtime",
        |mut caller: Caller<'_, HostState>, out_ptr: u32| -> i32 {
            let now = caller.data().now_realtime_ns;
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -(EFAULT as i32),
            };
            if memory
                .write(&mut caller, out_ptr as usize, &now.to_le_bytes())
                .is_err()
            {
                return -(EFAULT as i32);
            }
            0
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_log",
        |mut caller: Caller<'_, HostState>, severity: u32, msg_ptr: u32, msg_len: u32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -(EFAULT as i32),
            };
            let mut buf = vec![0u8; msg_len as usize];
            if memory.read(&caller, msg_ptr as usize, &mut buf).is_err() {
                return -(EFAULT as i32);
            }
            let sink = caller.data().log_sink.clone();
            if let Ok(s) = std::str::from_utf8(&buf) {
                sink.emit(severity, s);
            }
            0
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_extension_invoke",
        |mut caller: Caller<'_, HostState>,
         req_ptr: u32,
         req_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i64 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            let mut request = vec![0u8; req_len as usize];
            if memory
                .read(&caller, req_ptr as usize, &mut request)
                .is_err()
            {
                return -EFAULT;
            }
            let mut response = vec![0u8; out_cap as usize];
            let registry = caller.data().extensions.clone();
            let written = registry.invoke(&request, &mut response);
            if written < 0 {
                return written;
            }
            let written_usize = written as usize;
            if written_usize > response.len() {
                return -EFAULT;
            }
            if memory
                .write(&mut caller, out_ptr as usize, &response[..written_usize])
                .is_err()
            {
                return -EFAULT;
            }
            written
        },
    )?;
    Ok(())
}

/// Wires the `host_*` import surface user processes link against. Each
/// import forwards into `kernel_dispatch` with the appropriate method
/// id from `yurt_abi_methods.toml`. The legacy `host_*` namespace
/// remains during the transition; userland is recompiled against
/// `sys_*` symbols when the migration completes.
fn register_sys_imports(linker: &mut Linker<UserState>) -> Result<()> {
    fn forward_scalar(caller: &Caller<'_, UserState>, method_id: u32) -> i32 {
        let kernel = caller.data().kernel.clone();
        let mut k = kernel.borrow_mut();
        let dispatch = k.dispatch.clone();
        match dispatch.call(&mut k.store, (method_id, 0, 0, 0, 0)) {
            Ok(rc) => rc as i32,
            Err(_) => -(EFAULT as i32),
        }
    }

    linker.func_wrap(
        SYS_NAMESPACE,
        "host_getuid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETUID) },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "host_geteuid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETEUID) },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "host_getgid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETGID) },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "host_getegid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETEGID) },
    )?;
    Ok(())
}

// ── Build / path helpers ─────────────────────────────────────────────────────

pub fn default_kernel_wasm_path() -> PathBuf {
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("workspace root")
        .to_path_buf();
    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.join("target"));
    target_dir.join("wasm32-wasip1/release/yurt_kernel_wasm.wasm")
}

pub fn build_kernel_wasm() -> Result<()> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("workspace root");
    let status = Command::new(cargo)
        .args([
            "build",
            "--release",
            "-p",
            "yurt-kernel-wasm",
            "--target",
            "wasm32-wasip1",
        ])
        .current_dir(workspace_root)
        .status()
        .context("spawn cargo to build yurt-kernel-wasm")?;
    if !status.success() {
        return Err(anyhow!("cargo build of yurt-kernel-wasm failed"));
    }
    Ok(())
}
