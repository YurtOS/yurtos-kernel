//! Sandboxed-kernel microkernel skeleton.
//!
//! Loads `yurt-kernel-wasm` (compiled to `wasm32-wasip1`) into a
//! wasmtime engine, satisfies the documented `kh_*` import surface, and
//! forwards user-syscall requests into `kernel_dispatch`. This is the
//! rails-only version that future packages will sit on top of:
//!
//! - `packages/microkernel-wasmtime` (this code, eventually extracted)
//! - `packages/microkernel-browser` (JSPI/asyncify)
//! - `packages/microkernel-deno` (debug)
//!
//! Any wasm runtime that hosts the same `kh_*` imports and calls
//! `kernel_dispatch` is a supported backend — see
//! `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use wasmtime::{Caller, Engine, Linker, Memory, Module, Store, TypedFunc};

/// Fully-qualified path of the `kh_*` import namespace.
const KH_NAMESPACE: &str = "kh";

/// POSIX errno values referenced by the trampoline. Mirrors
/// `abi/contract/yurt_abi.toml`.
const EFAULT: i64 = 14;
const ENOENT: i64 = 2;

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

/// Default log sink — drops everything. Embedders that want output
/// supply their own (`StderrLogSink` works for native CLI hosts).
pub struct DiscardLogSink;

impl LogSink for DiscardLogSink {
    fn emit(&self, _severity: u32, _message: &str) {}
}

/// Stderr log sink. Suitable for the wasmtime-native microkernel.
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

/// State threaded through every wasmtime host callback.
///
/// `now_realtime_ns` is a deterministic clock value used by the test
/// microkernel and any embedder that wants to inject time. Real
/// production microkernels read the host clock instead.
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

/// A loaded kernel.wasm instance plus the typed handles the microkernel
/// uses to drive it.
pub struct Microkernel {
    store: Store<HostState>,
    memory: Memory,
    scratch_ptr: u32,
    scratch_len: u32,
    dispatch: TypedFunc<(u32, u32, u32, u32, u32), i64>,
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

        Ok(Self {
            store,
            memory,
            scratch_ptr,
            scratch_len,
            dispatch,
        })
    }

    /// Invoke a kernel syscall via the trampoline.
    ///
    /// `request` is staged into kernel-side scratch memory and passed
    /// to `kernel_dispatch`; the kernel writes its response into a
    /// disjoint slice of the same scratch region, which the
    /// microkernel reads back into `response`. Returns the syscall
    /// scalar (`>= 0` success / `< 0` negated POSIX errno).
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

    /// Mutable host state for tests / embedders that need to mutate
    /// values served back to the kernel between syscalls.
    pub fn host_state_mut(&mut self) -> &mut HostState {
        self.store.data_mut()
    }
}

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
            // Drop non-UTF8 silently — logging must never fail loudly.
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
            // Copy the request out of kernel memory so the host
            // handler doesn't borrow from the same Caller we need to
            // re-borrow for the response write.
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

/// Workspace-relative location of the built `yurt-kernel-wasm`
/// artifact. The microkernel doesn't build it — embedders that want a
/// build-on-demand should call [`build_kernel_wasm`] first.
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

/// Build `yurt-kernel-wasm` for `wasm32-wasip1` so [`default_kernel_wasm_path`]
/// resolves to a fresh artifact. Used by the integration tests.
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
