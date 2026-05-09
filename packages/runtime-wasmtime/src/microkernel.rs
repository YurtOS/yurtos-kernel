//! Sandboxed-kernel microkernel skeleton.
//!
//! Loads `yurt-kernel-wasm` (compiled to `wasm32-wasip1`) into a
//! wasmtime engine, satisfies the documented `kh_*` import surface,
//! and forwards user-syscall requests into `kernel_dispatch`. Also
//! spawns user processes into separate stores whose `sys_*` imports
//! are wired back through the kernel.
//!
//! Sibling backends sharing this contract:
//! - `packages/microkernel-wasmtime` (this code; native perf path).
//! - `packages/microkernel-js` (portable JS+wasm; runs in Deno,
//!   browsers, Node, Bun unchanged).
//! - `packages/microkernel-deno` (Deno-only extensions: real fs,
//!   real sockets, subprocess).
//!
//! Any wasm runtime that hosts the same `kh_*` imports and calls
//! `kernel_dispatch` is a supported backend — see
//! `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use wasmtime::{Caller, Engine, Linker, Memory, Module, Store, TypedFunc};
use wasmtime_wasi::preview1::WasiP1Ctx;
use wasmtime_wasi::WasiCtxBuilder;

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
    pub const GETPID: u32 = 0x1_0005;
    pub const GETPPID: u32 = 0x1_0006;
    pub const UMASK: u32 = 0x1_0007;
    pub const SETRESUID: u32 = 0x1_0008;
    pub const SETRESGID: u32 = 0x1_0009;
    pub const CHDIR: u32 = 0x1_000A;
    pub const GETCWD: u32 = 0x1_000B;
    pub const GETRLIMIT: u32 = 0x1_000C;
    pub const SETRLIMIT: u32 = 0x1_000D;
    pub const CLOSE: u32 = 0x1_000E;
    pub const DUP: u32 = 0x1_000F;
    pub const DUP2: u32 = 0x1_0011;
    pub const PIPE: u32 = 0x1_0012;
    pub const READ: u32 = 0x1_0013;
    pub const WRITE: u32 = 0x1_0014;
    pub const ISATTY: u32 = 0x1_0015;
    pub const CLOCK_GETTIME: u32 = 0x1_0016;
    pub const GETPGID: u32 = 0x1_0017;
    pub const SETPGID: u32 = 0x1_0018;
    pub const GETSID: u32 = 0x1_0019;
    pub const SETSID: u32 = 0x1_001A;
}

/// Reserved pid for direct calls from outside any user process — the
/// microkernel itself driving the kernel for tests, bootstrapping, or
/// internal bookkeeping. Real user processes start at `1`.
pub const KERNEL_PID: u32 = 0;

/// Kernel-internal method ids the microkernel calls during process
/// setup (mirrors `abi/contract/yurt_abi_methods.toml`).
const METHOD_KERNEL_PROVIDE_STDIN: u32 = 4;
const METHOD_KERNEL_CLOSE_STDIN: u32 = 5;
const METHOD_KERNEL_DRAIN_STDOUT: u32 = 6;
const METHOD_KERNEL_DRAIN_STDERR: u32 = 7;

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

/// What lives in the kernel-wasm wasmtime Store. Bundles the
/// embedder-supplied [`HostState`] with a `WasiP1Ctx` so that
/// `std`-on-wasi panic infrastructure (`fd_write`, `proc_exit`,
/// `environ_*`) can resolve. The kernel doesn't *use* WASI for I/O —
/// real I/O goes through `kh_*` — but std pulls a few WASI imports
/// for panic/abort. We satisfy them with a stub-friendly WasiCtx
/// (no preopened dirs, no inherited stdio); kh_log handles real
/// diagnostic output.
pub struct KernelStoreData {
    pub host: HostState,
    pub wasi: WasiP1Ctx,
}

// ── Kernel instance: the loaded kernel.wasm + its wasmtime handles ─────────

/// The loaded kernel.wasm plus the typed handles needed to drive it.
/// Kept behind `Arc<Mutex<…>>` so that both the [`Microkernel`] and
/// any spawned [`UserProcess`] can call into it. (`Arc<Mutex<…>>`
/// rather than `Rc<RefCell<…>>` so the type satisfies `Send`, which
/// `wasmtime_wasi::preview1::add_to_linker_sync` requires for the
/// per-process Linker data.)
pub struct KernelInstance {
    pub(crate) store: Store<KernelStoreData>,
    pub(crate) memory: Memory,
    pub(crate) scratch_ptr: u32,
    pub(crate) scratch_len: u32,
    pub(crate) dispatch: TypedFunc<(u32, u32, u32, u32, u32, u32), i64>,
}

impl KernelInstance {
    /// Run a syscall. Stages `request` in the kernel scratch buffer,
    /// invokes `kernel_dispatch`, copies the response back out.
    /// `caller_pid` identifies the originating user process (or
    /// [`KERNEL_PID`] for direct microkernel-internal calls).
    pub fn syscall(
        &mut self,
        method_id: u32,
        caller_pid: u32,
        request: &[u8],
        response: &mut [u8],
    ) -> Result<i64> {
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
                (method_id, caller_pid, in_ptr, in_len, out_ptr, out_cap),
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
    kernel: Arc<Mutex<KernelInstance>>,
    next_pid: RefCell<u32>,
}

impl Microkernel {
    /// Load `kernel.wasm` from `path` into a fresh wasmtime engine and
    /// instantiate it with the documented `kh_*` import surface.
    pub fn load(path: &Path, host_state: HostState) -> Result<Self> {
        let wasm = std::fs::read(path)
            .with_context(|| format!("read kernel.wasm at {}", path.display()))?;
        let engine = Engine::default();
        let module = Module::new(&engine, &wasm).context("compile kernel.wasm")?;

        let mut linker: Linker<KernelStoreData> = Linker::new(&engine);
        wasmtime_wasi::preview1::add_to_linker_sync(&mut linker, |d| &mut d.wasi)
            .context("add WASI preview1 to kernel linker (panic/abort support)")?;
        register_kh_imports(&mut linker)?;

        let wasi = WasiCtxBuilder::new().build_p1();
        let store_data = KernelStoreData {
            host: host_state,
            wasi,
        };
        let mut store = Store::new(&engine, store_data);
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
            .get_typed_func::<(u32, u32, u32, u32, u32, u32), i64>(&mut store, "kernel_dispatch")?;

        let kernel = KernelInstance {
            store,
            memory,
            scratch_ptr,
            scratch_len,
            dispatch,
        };
        Ok(Self {
            engine,
            kernel: Arc::new(Mutex::new(kernel)),
            next_pid: RefCell::new(1),
        })
    }

    /// Invoke a kernel syscall directly (no user process). The kernel
    /// sees `KERNEL_PID` (0) as the caller. Useful for tests and for
    /// operations that originate inside the microkernel itself.
    pub fn syscall(&self, method_id: u32, request: &[u8], response: &mut [u8]) -> Result<i64> {
        self.kernel
            .lock()
            .unwrap()
            .syscall(method_id, KERNEL_PID, request, response)
    }

    /// Mutate the host state served to kernel.wasm via a closure.
    /// (`std::sync::MutexGuard` doesn't have `map`, so we expose a
    /// closure-based API rather than returning a guard. Tests that
    /// want to mutate `now_realtime_ns` between dispatches use
    /// `mk.with_host_state_mut(|s| s.now_realtime_ns = …)`.)
    pub fn with_host_state_mut<R>(&self, f: impl FnOnce(&mut HostState) -> R) -> R {
        let mut guard = self.kernel.lock().unwrap();
        f(&mut guard.store.data_mut().host)
    }

    /// Compile and instantiate a user process whose `sys_*` imports
    /// are forwarded back into the kernel via the trampoline. The
    /// process is assigned a fresh pid (starting at `1`); future
    /// spawns increment.
    pub fn spawn_user_process(&self, wasm: &[u8]) -> Result<UserProcess> {
        self.spawn_user_process_with_args::<&[u8]>(wasm, &[])
    }

    /// Spawn with both argv and stdin bytes. Stdin is fed to the
    /// process's stdin buffer in the kernel via the
    /// `kernel_provide_stdin` / `kernel_close_stdin` internal
    /// methods. `eof` controls whether the buffer is sealed
    /// immediately (no further bytes coming) — set to false if you
    /// intend to feed more bytes later via [`UserProcess::feed_stdin`].
    pub fn spawn_user_process_with_args_and_stdin<S: AsRef<[u8]>>(
        &self,
        wasm: &[u8],
        argv: &[S],
        stdin: &[u8],
        eof: bool,
    ) -> Result<UserProcess> {
        let user = self.spawn_user_process_with_args(wasm, argv)?;
        if !stdin.is_empty() {
            let mut req = Vec::with_capacity(4 + stdin.len());
            req.extend_from_slice(&user.pid.to_le_bytes());
            req.extend_from_slice(stdin);
            self.kernel.lock().unwrap().syscall(
                METHOD_KERNEL_PROVIDE_STDIN,
                KERNEL_PID,
                &req,
                &mut [],
            )?;
        }
        if eof {
            self.kernel.lock().unwrap().syscall(
                METHOD_KERNEL_CLOSE_STDIN,
                KERNEL_PID,
                &user.pid.to_le_bytes(),
                &mut [],
            )?;
        }
        Ok(user)
    }

    /// Spawn a user process with the given argv (each arg is opaque
    /// bytes — no UTF-8 guarantee, matching POSIX). The argv lands in
    /// `UserState.argv`; the WASI shim's `args_get` /
    /// `args_sizes_get` serves it to the user wasm.
    pub fn spawn_user_process_with_args<S: AsRef<[u8]>>(
        &self,
        wasm: &[u8],
        argv: &[S],
    ) -> Result<UserProcess> {
        let module = Module::new(&self.engine, wasm).context("compile user-process wasm")?;
        let mut linker: Linker<UserState> = Linker::new(&self.engine);
        register_sys_imports(&mut linker)?;
        crate::wasi_shim::add_to_linker(&mut linker)
            .context("install WASI preview1 shim on user-process linker")?;

        let mut next = self.next_pid.borrow_mut();
        let pid = *next;
        *next += 1;
        drop(next);

        let argv: Vec<Vec<u8>> = argv.iter().map(|s| s.as_ref().to_vec()).collect();
        let user_state = UserState {
            kernel: self.kernel.clone(),
            pid,
            argv,
        };
        let mut store = Store::new(&self.engine, user_state);
        let instance = linker
            .instantiate(&mut store, &module)
            .context("instantiate user-process wasm")?;
        Ok(UserProcess {
            store,
            instance,
            pid,
        })
    }

    /// Reserved alias for [`spawn_user_process`]. The WASI preview1
    /// shim routes user `fd_write` through `sys_write` and out via
    /// `kh_log` to the configured `LogSink`, so per-process I/O
    /// capture is best done through the `LogSink` for now. A future
    /// revision plumbs per-process stream sinks here.
    pub fn spawn_user_process_with_io(&self, wasm: &[u8], _io: ProcessIo) -> Result<UserProcess> {
        self.spawn_user_process(wasm)
    }
}

/// Placeholder I/O config — kept for backwards compatibility with the
/// initial fixture parity tests. Capture currently happens via
/// `HostState.log_sink`; this struct will gain per-process sinks
/// when the kernel-side stream registry lands.
#[derive(Default)]
pub struct ProcessIo;

// ── User process ─────────────────────────────────────────────────────────────

/// State threaded through every host callback during a user-process
/// call. Holds (a) a shared reference to kernel.wasm so `sys_*` and
/// the WASI shim can forward into `kernel_dispatch`, (b) the pid the
/// kernel sees as the caller, and (c) the argv this process was
/// spawned with (read by the WASI shim's `args_get` /
/// `args_sizes_get`).
///
/// User processes do *not* get a `WasiP1Ctx`. WASI preview1 imports
/// are satisfied by [`crate::wasi_shim`], which routes them through
/// the kernel's `sys_*` syscalls. fd_write therefore lands in
/// `kernel.wasm` rather than wasmtime-wasi, and once cross-process
/// pipes work, `cmd1 | cmd2` is the same pipe object on both sides.
///
/// Note on argv: keeping it in microkernel-side state for now is
/// fine — the kernel's process tree is not tracking argv yet. Once
/// `sys_spawn` lands and the kernel allocates pids itself, argv
/// migrates into `Process` so it's preserved across exec.
pub struct UserState {
    pub kernel: Arc<Mutex<KernelInstance>>,
    pub pid: u32,
    pub argv: Vec<Vec<u8>>,
}

/// A spawned user-process instance.
pub struct UserProcess {
    store: Store<UserState>,
    instance: wasmtime::Instance,
    pid: u32,
}

impl UserProcess {
    /// Pid the kernel sees as this process's caller_pid.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Invoke the exported `run() -> i32` function. Convention for
    /// the trampoline tests; richer entry points come later.
    pub fn call_run(&mut self) -> Result<i32> {
        self.call_export_i32("run")
    }

    /// Invoke any exported `() -> i32` function by name.
    pub fn call_export_i32(&mut self, name: &str) -> Result<i32> {
        let f = self
            .instance
            .get_typed_func::<(), i32>(&mut self.store, name)
            .with_context(|| format!("user-process missing '{name}() -> i32' export"))?;
        f.call(&mut self.store, ())
            .with_context(|| format!("user-process {name}()"))
    }

    /// Run the standard WASI entry point (`_start`). Returns Ok(()) on
    /// normal exit; a `proc_exit` from the user surfaces as an error
    /// (our shim traps via `anyhow!` from the `proc_exit` import).
    pub fn run_start(&mut self) -> Result<()> {
        let f = self
            .instance
            .get_typed_func::<(), ()>(&mut self.store, "_start")
            .context("user-process missing '_start' (not a WASI command)")?;
        f.call(&mut self.store, ()).context("user-process _start()")
    }

    /// Drain bytes the process has written to its stdout buffer
    /// (kernel side). Returns the bytes; the buffer is emptied.
    pub fn captured_stdout(&mut self) -> Result<Vec<u8>> {
        self.drain_stream(METHOD_KERNEL_DRAIN_STDOUT)
    }

    /// Drain bytes the process has written to its stderr buffer.
    pub fn captured_stderr(&mut self) -> Result<Vec<u8>> {
        self.drain_stream(METHOD_KERNEL_DRAIN_STDERR)
    }

    fn drain_stream(&mut self, method_id: u32) -> Result<Vec<u8>> {
        // Chunk size is bounded by `scratch_len - 4` (request carries
        // the 4-byte pid; response shares the same scratch buffer).
        // Loop until the kernel reports an empty drain.
        let mut out = Vec::new();
        let kernel = self.store.data().kernel.clone();
        let chunk_cap = {
            let k = kernel.lock().unwrap();
            (k.scratch_len.saturating_sub(4)) as usize
        };
        loop {
            let mut chunk = vec![0u8; chunk_cap];
            let n = kernel.lock().unwrap().syscall(
                method_id,
                KERNEL_PID,
                &self.pid.to_le_bytes(),
                &mut chunk,
            )?;
            if n <= 0 {
                break;
            }
            chunk.truncate(n as usize);
            let was_full = chunk.len() == chunk_cap;
            out.extend_from_slice(&chunk);
            if !was_full {
                break;
            }
        }
        Ok(out)
    }

    /// Append `bytes` to this process's stdin buffer (kernel side).
    /// Useful for incremental input feeding from a test driver.
    pub fn feed_stdin(&mut self, bytes: &[u8]) -> Result<()> {
        let mut req = Vec::with_capacity(4 + bytes.len());
        req.extend_from_slice(&self.pid.to_le_bytes());
        req.extend_from_slice(bytes);
        let kernel = self.store.data().kernel.clone();
        kernel
            .lock()
            .unwrap()
            .syscall(METHOD_KERNEL_PROVIDE_STDIN, KERNEL_PID, &req, &mut [])?;
        Ok(())
    }

    /// Mark this process's stdin as EOF.
    pub fn close_stdin(&mut self) -> Result<()> {
        let kernel = self.store.data().kernel.clone();
        kernel.lock().unwrap().syscall(
            METHOD_KERNEL_CLOSE_STDIN,
            KERNEL_PID,
            &self.pid.to_le_bytes(),
            &mut [],
        )?;
        Ok(())
    }

    /// Read `len` bytes from this user-process's exported `memory` at
    /// `addr`. Useful for tests that want to inspect what a syscall
    /// wrote back.
    pub fn read_memory(&mut self, addr: u32, len: u32) -> Result<Vec<u8>> {
        let memory = self
            .instance
            .get_memory(&mut self.store, "memory")
            .ok_or_else(|| anyhow!("user-process missing 'memory' export"))?;
        let mut buf = vec![0u8; len as usize];
        memory
            .read(&self.store, addr as usize, &mut buf)
            .context("read user-process memory")?;
        Ok(buf)
    }
}

// ── Module-level trampoline helpers (used by both register_sys_imports
//    and wasi_shim::add_to_linker) ──────────────────────────────────────────

/// Forward a syscall whose request is `req_bytes` and which returns
/// only a scalar (no response buffer to fill).
///
/// Used by:
/// - `register_sys_imports` for the `sys_*` shims
/// - `wasi_shim::add_to_linker` for `fd_write` / `fd_close`
pub fn trampoline_request(
    caller: &mut Caller<'_, UserState>,
    method_id: u32,
    req_bytes: &[u8],
) -> i64 {
    let pid = caller.data().pid;
    let kernel = caller.data().kernel.clone();
    let mut k = kernel.lock().unwrap();
    let scratch_ptr = k.scratch_ptr;
    let memory = k.memory;
    let dispatch = k.dispatch.clone();
    if !req_bytes.is_empty()
        && memory
            .write(&mut k.store, scratch_ptr as usize, req_bytes)
            .is_err()
    {
        return -EFAULT;
    }
    match dispatch.call(
        &mut k.store,
        (method_id, pid, scratch_ptr, req_bytes.len() as u32, 0, 0),
    ) {
        Ok(rc) => rc,
        Err(_) => -EFAULT,
    }
}

/// Forward a syscall and copy the kernel's response into `response`.
/// Returns the syscall scalar (e.g. bytes written by the kernel).
pub fn trampoline_request_with_response(
    caller: &mut Caller<'_, UserState>,
    method_id: u32,
    req_bytes: &[u8],
    response: &mut [u8],
) -> i64 {
    let pid = caller.data().pid;
    let kernel = caller.data().kernel.clone();
    let mut k = kernel.lock().unwrap();
    let scratch_ptr = k.scratch_ptr;
    let scratch_len = k.scratch_len;
    let kernel_memory = k.memory;
    let dispatch = k.dispatch.clone();
    let in_ptr = scratch_ptr;
    let in_len = req_bytes.len() as u32;
    let out_ptr = scratch_ptr + in_len;
    let out_cap = (response.len() as u32).min(scratch_len.saturating_sub(in_len));

    if !req_bytes.is_empty()
        && kernel_memory
            .write(&mut k.store, in_ptr as usize, req_bytes)
            .is_err()
    {
        return -EFAULT;
    }
    let rc = match dispatch.call(
        &mut k.store,
        (method_id, pid, in_ptr, in_len, out_ptr, out_cap),
    ) {
        Ok(rc) => rc,
        Err(_) => return -EFAULT,
    };
    if rc <= 0 {
        return rc;
    }
    let to_copy = (rc as u32).min(out_cap) as usize;
    if to_copy > 0
        && kernel_memory
            .read(&k.store, out_ptr as usize, &mut response[..to_copy])
            .is_err()
    {
        return -EFAULT;
    }
    rc
}

// ── Linker registration ──────────────────────────────────────────────────────

fn register_kh_imports(linker: &mut Linker<KernelStoreData>) -> Result<()> {
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_now_realtime",
        |mut caller: Caller<'_, KernelStoreData>, out_ptr: u32| -> i32 {
            let now = caller.data().host.now_realtime_ns;
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
        |mut caller: Caller<'_, KernelStoreData>,
         severity: u32,
         msg_ptr: u32,
         msg_len: u32|
         -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -(EFAULT as i32),
            };
            let mut buf = vec![0u8; msg_len as usize];
            if memory.read(&caller, msg_ptr as usize, &mut buf).is_err() {
                return -(EFAULT as i32);
            }
            let sink = caller.data().host.log_sink.clone();
            if let Ok(s) = std::str::from_utf8(&buf) {
                sink.emit(severity, s);
            }
            0
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_extension_invoke",
        |mut caller: Caller<'_, KernelStoreData>,
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
            let registry = caller.data().host.extensions.clone();
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

/// Wires the `sys_*` import surface user processes link against. Each
/// import forwards into `kernel_dispatch` with the appropriate method
/// id from `yurt_abi_methods.toml`. The wasm import names match the architectural reality: these are syscalls.
fn register_sys_imports(linker: &mut Linker<UserState>) -> Result<()> {
    fn forward_scalar(caller: &Caller<'_, UserState>, method_id: u32) -> i32 {
        let pid = caller.data().pid;
        let kernel = caller.data().kernel.clone();
        let mut k = kernel.lock().unwrap();
        let dispatch = k.dispatch.clone();
        match dispatch.call(&mut k.store, (method_id, pid, 0, 0, 0, 0)) {
            Ok(rc) => rc as i32,
            Err(_) => -(EFAULT as i32),
        }
    }

    /// Forward a syscall whose only argument is a single `u32`. The
    /// argument is staged as 4 little-endian bytes in kernel scratch.
    fn forward_u32_arg(caller: &mut Caller<'_, UserState>, method_id: u32, arg: u32) -> i32 {
        forward_request_bytes(caller, method_id, &arg.to_le_bytes()) as i32
    }

    /// Forward a syscall whose request is `request_bytes`; no response
    /// buffer. Returns the syscall scalar (i64 to preserve sign /
    /// negative-errno semantics; callers that want i32 can cast).
    fn forward_request_bytes(
        caller: &mut Caller<'_, UserState>,
        method_id: u32,
        request_bytes: &[u8],
    ) -> i64 {
        let pid = caller.data().pid;
        let kernel = caller.data().kernel.clone();
        let mut k = kernel.lock().unwrap();
        let scratch_ptr = k.scratch_ptr;
        let memory = k.memory;
        let dispatch = k.dispatch.clone();
        if !request_bytes.is_empty()
            && memory
                .write(&mut k.store, scratch_ptr as usize, request_bytes)
                .is_err()
        {
            return -EFAULT;
        }
        match dispatch.call(
            &mut k.store,
            (
                method_id,
                pid,
                scratch_ptr,
                request_bytes.len() as u32,
                0,
                0,
            ),
        ) {
            Ok(rc) => rc,
            Err(_) => -EFAULT,
        }
    }

    /// Forward a syscall that reads bytes from the *user-process* wasm
    /// at `(user_ptr, user_len)`, copies them into kernel scratch, and
    /// invokes `kernel_dispatch`. Used by syscalls like `sys_chdir`
    /// where the user-process supplies a pointer + length to its own
    /// memory.
    fn forward_user_ptr_len(
        caller: &mut Caller<'_, UserState>,
        method_id: u32,
        user_ptr: u32,
        user_len: u32,
    ) -> i32 {
        let user_memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
            Some(m) => m,
            None => return -(EFAULT as i32),
        };
        let mut buf = vec![0u8; user_len as usize];
        if user_memory
            .read(&caller, user_ptr as usize, &mut buf)
            .is_err()
        {
            return -(EFAULT as i32);
        }
        forward_request_bytes(caller, method_id, &buf) as i32
    }

    /// Forward a syscall whose request is `req_bytes` (already
    /// encoded by the caller) and whose response goes into a user-
    /// memory buffer `(user_out_ptr, user_out_cap)`. The kernel writes
    /// into kernel scratch, then we copy from there into user memory.
    /// Returns the syscall scalar verbatim — callers that want POSIX
    /// "0 on success" can collapse a positive `rc` themselves.
    fn forward_request_with_user_response(
        caller: &mut Caller<'_, UserState>,
        method_id: u32,
        req_bytes: &[u8],
        user_out_ptr: u32,
        user_out_cap: u32,
    ) -> i64 {
        let pid = caller.data().pid;
        let kernel = caller.data().kernel.clone();
        let mut k = kernel.lock().unwrap();
        let scratch_ptr = k.scratch_ptr;
        let scratch_len = k.scratch_len;
        let kernel_memory = k.memory;
        let dispatch = k.dispatch.clone();
        let in_ptr = scratch_ptr;
        let in_len = req_bytes.len() as u32;
        let out_ptr = scratch_ptr + in_len;
        let out_cap = user_out_cap.min(scratch_len.saturating_sub(in_len));

        if !req_bytes.is_empty()
            && kernel_memory
                .write(&mut k.store, in_ptr as usize, req_bytes)
                .is_err()
        {
            return -EFAULT;
        }
        let rc = match dispatch.call(
            &mut k.store,
            (method_id, pid, in_ptr, in_len, out_ptr, out_cap),
        ) {
            Ok(rc) => rc,
            Err(_) => return -EFAULT,
        };
        if rc <= 0 {
            return rc;
        }
        let to_copy = (rc as u32).min(out_cap) as usize;
        if to_copy > 0 {
            let mut tmp = vec![0u8; to_copy];
            if kernel_memory
                .read(&k.store, out_ptr as usize, &mut tmp)
                .is_err()
            {
                return -EFAULT;
            }
            drop(k);
            let user_memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            if user_memory
                .write(&mut *caller, user_out_ptr as usize, &tmp)
                .is_err()
            {
                return -EFAULT;
            }
        }
        rc
    }

    /// Forward a syscall that fills a response buffer in *user-process*
    /// memory at `(user_out_ptr, user_out_cap)`. The kernel writes the
    /// response into kernel scratch, which we then copy out into user
    /// memory.
    fn forward_response_to_user(
        caller: &mut Caller<'_, UserState>,
        method_id: u32,
        user_out_ptr: u32,
        user_out_cap: u32,
    ) -> i32 {
        let pid = caller.data().pid;
        let kernel = caller.data().kernel.clone();
        let mut k = kernel.lock().unwrap();
        let scratch_ptr = k.scratch_ptr;
        let kernel_memory = k.memory;
        let dispatch = k.dispatch.clone();
        let cap = user_out_cap.min(k.scratch_len);
        let rc = match dispatch.call(&mut k.store, (method_id, pid, 0, 0, scratch_ptr, cap)) {
            Ok(rc) => rc,
            Err(_) => return -(EFAULT as i32),
        };
        // The kernel-side convention for "buffer too small" varies per
        // syscall (e.g. getcwd returns required size as a positive
        // value). We copy out at most cap bytes regardless so the user
        // sees what fit.
        if rc <= 0 {
            return rc as i32;
        }
        let to_copy = (rc as u32).min(cap) as usize;
        if to_copy > 0 {
            let mut tmp = vec![0u8; to_copy];
            if kernel_memory
                .read(&k.store, scratch_ptr as usize, &mut tmp)
                .is_err()
            {
                return -(EFAULT as i32);
            }
            // Drop the kernel borrow before touching user memory.
            drop(k);
            let user_memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -(EFAULT as i32),
            };
            if user_memory
                .write(&mut *caller, user_out_ptr as usize, &tmp)
                .is_err()
            {
                return -(EFAULT as i32);
            }
        }
        rc as i32
    }

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getuid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETUID) },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_geteuid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETEUID) },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getgid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETGID) },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getegid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETEGID) },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getpid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETPID) },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getppid",
        |caller: Caller<'_, UserState>| -> i32 { forward_scalar(&caller, sys_method_id::GETPPID) },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_umask",
        |mut caller: Caller<'_, UserState>, mask: i32| -> i32 {
            forward_u32_arg(&mut caller, sys_method_id::UMASK, mask as u32)
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_setresuid",
        |mut caller: Caller<'_, UserState>, ruid: i32, euid: i32, suid: i32| -> i32 {
            let mut req = Vec::with_capacity(12);
            req.extend_from_slice(&(ruid as u32).to_le_bytes());
            req.extend_from_slice(&(euid as u32).to_le_bytes());
            req.extend_from_slice(&(suid as u32).to_le_bytes());
            forward_request_bytes(&mut caller, sys_method_id::SETRESUID, &req) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_setresgid",
        |mut caller: Caller<'_, UserState>, rgid: i32, egid: i32, sgid: i32| -> i32 {
            let mut req = Vec::with_capacity(12);
            req.extend_from_slice(&(rgid as u32).to_le_bytes());
            req.extend_from_slice(&(egid as u32).to_le_bytes());
            req.extend_from_slice(&(sgid as u32).to_le_bytes());
            forward_request_bytes(&mut caller, sys_method_id::SETRESGID, &req) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_chdir",
        |mut caller: Caller<'_, UserState>, path_ptr: u32, path_len: u32| -> i32 {
            forward_user_ptr_len(&mut caller, sys_method_id::CHDIR, path_ptr, path_len)
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getcwd",
        |mut caller: Caller<'_, UserState>, out_ptr: u32, out_cap: u32| -> i32 {
            forward_response_to_user(&mut caller, sys_method_id::GETCWD, out_ptr, out_cap)
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getrlimit",
        |mut caller: Caller<'_, UserState>, resource: i32, out_ptr: u32| -> i32 {
            let req = (resource as u32).to_le_bytes();
            let rc = forward_request_with_user_response(
                &mut caller,
                sys_method_id::GETRLIMIT,
                &req,
                out_ptr,
                16,
            );
            // Kernel returns bytes-written (16) on success; POSIX
            // contract is 0 on success / negative on error.
            if rc == 16 {
                0
            } else {
                rc as i32
            }
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_setrlimit",
        |mut caller: Caller<'_, UserState>, resource: i32, soft: i64, hard: i64| -> i32 {
            let mut req = Vec::with_capacity(20);
            req.extend_from_slice(&(resource as u32).to_le_bytes());
            req.extend_from_slice(&(soft as u64).to_le_bytes());
            req.extend_from_slice(&(hard as u64).to_le_bytes());
            forward_request_bytes(&mut caller, sys_method_id::SETRLIMIT, &req) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_close",
        |mut caller: Caller<'_, UserState>, fd: i32| -> i32 {
            forward_u32_arg(&mut caller, sys_method_id::CLOSE, fd as u32)
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_dup",
        |mut caller: Caller<'_, UserState>, oldfd: i32| -> i32 {
            forward_u32_arg(&mut caller, sys_method_id::DUP, oldfd as u32)
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_dup2",
        |mut caller: Caller<'_, UserState>, oldfd: i32, newfd: i32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(oldfd as u32).to_le_bytes());
            req.extend_from_slice(&(newfd as u32).to_le_bytes());
            forward_request_bytes(&mut caller, sys_method_id::DUP2, &req) as i32
        },
    )?;
    // POSIX `pipe(int fd[2])`: caller provides a 2-int buffer, kernel
    // fills (read_fd, write_fd). Returns 0 on success / negated errno.
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_pipe",
        |mut caller: Caller<'_, UserState>, out_ptr: u32| -> i32 {
            let rc = forward_request_with_user_response(
                &mut caller,
                sys_method_id::PIPE,
                &[],
                out_ptr,
                8,
            );
            if rc == 8 {
                0
            } else {
                rc as i32
            }
        },
    )?;
    // POSIX `read(fd, buf, count)`: write up to count bytes from fd
    // into user buffer at out_ptr. Returns bytes read or negated errno.
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_read",
        |mut caller: Caller<'_, UserState>, fd: i32, out_ptr: u32, count: u32| -> i32 {
            let req = (fd as u32).to_le_bytes();
            forward_request_with_user_response(
                &mut caller,
                sys_method_id::READ,
                &req,
                out_ptr,
                count,
            ) as i32
        },
    )?;
    // POSIX `write(fd, buf, count)`: read count bytes from user_buf,
    // write them to fd. Returns bytes written or negated errno.
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_write",
        |mut caller: Caller<'_, UserState>, fd: i32, buf_ptr: u32, count: u32| -> i32 {
            // Stage `(u32 fd LE | payload bytes)` in kernel scratch.
            let user_memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -(EFAULT as i32),
            };
            let mut payload = vec![0u8; count as usize];
            if user_memory
                .read(&caller, buf_ptr as usize, &mut payload)
                .is_err()
            {
                return -(EFAULT as i32);
            }
            let mut req = Vec::with_capacity(4 + payload.len());
            req.extend_from_slice(&(fd as u32).to_le_bytes());
            req.extend_from_slice(&payload);
            forward_request_bytes(&mut caller, sys_method_id::WRITE, &req) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_isatty",
        |mut caller: Caller<'_, UserState>, fd: i32| -> i32 {
            forward_u32_arg(&mut caller, sys_method_id::ISATTY, fd as u32)
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_clock_gettime",
        |mut caller: Caller<'_, UserState>, clock_id: i32, out_ptr: u32| -> i32 {
            let req = (clock_id as u32).to_le_bytes();
            let rc = forward_request_with_user_response(
                &mut caller,
                sys_method_id::CLOCK_GETTIME,
                &req,
                out_ptr,
                8,
            );
            if rc == 8 {
                0
            } else {
                rc as i32
            }
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getpgid",
        |mut caller: Caller<'_, UserState>, pid: i32| -> i32 {
            forward_u32_arg(&mut caller, sys_method_id::GETPGID, pid as u32)
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_setpgid",
        |mut caller: Caller<'_, UserState>, pid: i32, pgid: i32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(pid as u32).to_le_bytes());
            req.extend_from_slice(&(pgid as u32).to_le_bytes());
            forward_request_bytes(&mut caller, sys_method_id::SETPGID, &req) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getsid",
        |mut caller: Caller<'_, UserState>, pid: i32| -> i32 {
            forward_u32_arg(&mut caller, sys_method_id::GETSID, pid as u32)
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_setsid",
        |mut caller: Caller<'_, UserState>| -> i32 {
            forward_request_bytes(&mut caller, sys_method_id::SETSID, &[]) as i32
        },
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
