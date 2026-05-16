//! Sandboxed-kernel kernel-host interface skeleton.
//!
//! Loads `yurt-kernel-wasm` (compiled to `wasm32-wasip1`) into a
//! wasmtime engine, satisfies the documented `kh_*` import surface,
//! and forwards user-syscall requests into `kernel_dispatch`. Also
//! spawns user processes into separate stores whose `sys_*` imports
//! are wired back through the kernel.
//!
//! Sibling backends sharing this contract:
//! - `packages/kernel-host-interface-wasmtime` (this code; native perf path).
//! - `packages/kernel-host-interface-js` (portable JS+wasm; runs in Deno,
//!   browsers, Node, Bun unchanged).
//! - `packages/kernel-host-interface-deno` (Deno-only extensions: real fs,
//!   real sockets, subprocess).
//!
//! Any wasm runtime that hosts the same `kh_*` imports and calls
//! `kernel_dispatch` is a supported backend — see
//! `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{anyhow, Context, Result};
use wasmtime::{
    Caller, Config, Engine, ExternType, Linker, Memory, MemoryType, Module, SharedMemory, Store,
    TypedFunc,
};
use wasmtime_wasi::preview1::WasiP1Ctx;
use wasmtime_wasi::WasiCtxBuilder;
use yurt_kernel_host_interface_core::{
    checked_guest_buffer_len, checked_guest_buffer_sum, MAX_GUEST_BUFFER_LEN,
};

/// Fully-qualified path of the `kh_*` import namespace.
const KH_NAMESPACE: &str = "kh";

/// Module name user processes import their syscalls from. Default for
/// C / Rust `extern "C"` declarations without an explicit
/// `#[link(wasm_import_module = …)]`.
const SYS_NAMESPACE: &str = "env";
const YURT_NAMESPACE: &str = "yurt";

/// POSIX errno values referenced by the trampoline. Mirrors
/// `abi/contract/yurt_abi.toml`.
const EFAULT: i64 = 14;
const ENOENT: i64 = 2;
const EACCES: i64 = 13;
const EBADF: i64 = 9;
const EAGAIN: i64 = 11;
const EINVAL: i64 = 22;
const EBUSY: i64 = 16;
const E2BIG: i64 = 7;
const EIO: i64 = 5;
const ENOSYS: i64 = 38;
const DEFAULT_EPOCH_DEADLINE: u64 = u64::MAX / 2;
const FETCH_EXECUTOR_QUEUE_CAP: usize = 64;

/// Public re-export so the engine adapter (`engine::WasmtimeCtx`)
/// can return the same EFAULT value our trampoline uses internally.
pub(crate) const EFAULT_PUB: i64 = EFAULT;

struct FetchJob {
    request: Vec<u8>,
    response: mpsc::Sender<Vec<u8>>,
}

struct FetchExecutor {
    queue: mpsc::SyncSender<FetchJob>,
}

static FETCH_EXECUTOR: std::sync::OnceLock<std::result::Result<FetchExecutor, String>> =
    std::sync::OnceLock::new();

fn fetch_executor() -> std::result::Result<&'static FetchExecutor, i64> {
    match FETCH_EXECUTOR.get_or_init(start_fetch_executor) {
        Ok(executor) => Ok(executor),
        Err(_) => Err(-EIO),
    }
}

fn start_fetch_executor() -> std::result::Result<FetchExecutor, String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("kh_fetch_blocking: build current-thread tokio runtime: {e}"))?;
    let (queue, jobs) = mpsc::sync_channel::<FetchJob>(FETCH_EXECUTOR_QUEUE_CAP);
    thread::Builder::new()
        .name("yurt-kh-fetch".to_owned())
        .spawn(move || {
            while let Ok(job) = jobs.recv() {
                let response = rt.block_on(crate::wasm::network::fetch(&job.request));
                let _ = job.response.send(response);
            }
        })
        .map_err(|e| format!("kh_fetch_blocking: spawn fetch worker: {e}"))?;
    Ok(FetchExecutor { queue })
}

fn run_fetch_blocking(request: Vec<u8>) -> std::result::Result<Vec<u8>, i64> {
    let executor = fetch_executor()?;
    let (response_tx, response_rx) = mpsc::channel();
    let job = FetchJob {
        request,
        response: response_tx,
    };
    match executor.queue.try_send(job) {
        Ok(()) => response_rx.recv().map_err(|_| -EIO),
        Err(mpsc::TrySendError::Full(_)) => Err(-EAGAIN),
        Err(mpsc::TrySendError::Disconnected(_)) => Err(-EIO),
    }
}

#[cfg(test)]
fn fetch_executor_queue_capacity_for_tests() -> usize {
    FETCH_EXECUTOR_QUEUE_CAP
}

fn kernel_memory(caller: &mut Caller<'_, KernelStoreData>) -> std::result::Result<Memory, i64> {
    caller
        .get_export("memory")
        .and_then(|e| e.into_memory())
        .ok_or(-EFAULT)
}

fn user_memory(caller: &mut Caller<'_, UserState>) -> std::result::Result<Memory, i64> {
    caller
        .get_export("memory")
        .and_then(|e| e.into_memory())
        .ok_or(-EFAULT)
}

fn user_shared_memory(
    caller: &mut Caller<'_, UserState>,
) -> std::result::Result<SharedMemory, i64> {
    caller
        .get_export("memory")
        .and_then(|e| e.into_shared_memory())
        .ok_or(-EFAULT)
}

fn read_kernel_guest_bytes(
    caller: &mut Caller<'_, KernelStoreData>,
    ptr: u32,
    len: u32,
) -> std::result::Result<Vec<u8>, i64> {
    let memory = kernel_memory(caller)?;
    let len = checked_guest_buffer_len(len)?;
    let mut buf = vec![0u8; len];
    if len > 0 && memory.read(&*caller, ptr as usize, &mut buf).is_err() {
        return Err(-EFAULT);
    }
    Ok(buf)
}

fn read_user_guest_bytes(
    caller: &mut Caller<'_, UserState>,
    ptr: u32,
    len: u32,
) -> std::result::Result<Vec<u8>, i64> {
    let len = checked_guest_buffer_len(len)?;
    if let Ok(memory) = user_memory(caller) {
        let mut buf = vec![0u8; len];
        if len > 0 && memory.read(&*caller, ptr as usize, &mut buf).is_err() {
            return Err(-EFAULT);
        }
        return Ok(buf);
    }
    let memory = user_shared_memory(caller)?;
    read_shared_memory(memory, ptr, len).map_err(|_| -EFAULT)
}

fn write_user_guest_bytes(
    caller: &mut Caller<'_, UserState>,
    ptr: u32,
    bytes: &[u8],
) -> std::result::Result<(), i64> {
    if let Ok(memory) = user_memory(caller) {
        if !bytes.is_empty() && memory.write(caller, ptr as usize, bytes).is_err() {
            return Err(-EFAULT);
        }
        return Ok(());
    }
    let memory = user_shared_memory(caller)?;
    let data = memory.data();
    let start = ptr as usize;
    let end = start.checked_add(bytes.len()).ok_or(-EFAULT)?;
    let cells = data.get(start..end).ok_or(-EFAULT)?;
    for (cell, byte) in cells.iter().zip(bytes) {
        let ptr = cell.get().cast::<AtomicU8>();
        // SAFETY: Wasmtime shared memory bytes must be accessed atomically by
        // embedders. AtomicU8 has the same layout as the underlying u8 cell.
        unsafe { (*ptr).store(*byte, Ordering::SeqCst) };
    }
    Ok(())
}

/// Method ids that the user-process linker forwards. Generated
/// constants live inside `yurt-kernel-wasm`'s build artifact, not in
/// the host crate, so we mirror the ones we forward here. Drift is
/// caught by the `kernel_host_interface_method_ids_match_yurt_abi_methods_toml`
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
    pub const EXTENSION_INVOKE: u32 = 0x1_0010;
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
    pub const KILL: u32 = 0x1_001B;
    pub const KILLPG: u32 = 0x1_0053;
    pub const SIGACTION: u32 = 0x1_001C;
    pub const SCHED_YIELD: u32 = 0x1_001D;
    pub const NANOSLEEP: u32 = 0x1_001E;
    pub const OPEN: u32 = 0x1_001F;
    pub const LSEEK: u32 = 0x1_0020;
    pub const FSTAT: u32 = 0x1_0021;
    pub const CHMOD: u32 = 0x1_0022;
    pub const CHOWN: u32 = 0x1_0023;
    pub const UTIMENS: u32 = 0x1_0024;
    pub const UNLINK: u32 = 0x1_0025;
    pub const STAT: u32 = 0x1_0026;
    pub const SYMLINK: u32 = 0x1_0027;
    pub const READLINK: u32 = 0x1_0028;
    pub const MKDIR: u32 = 0x1_0029;
    pub const RMDIR: u32 = 0x1_002A;
    pub const READDIR: u32 = 0x1_002B;
    pub const WAIT: u32 = 0x1_002C;
    pub const LINK: u32 = 0x1_002D;
    pub const RENAME: u32 = 0x1_002E;
    pub const SPAWN: u32 = 0x1_002F;
    pub const FETCH: u32 = 0x1_0030;
    pub const SOCKET_CONNECT: u32 = 0x1_0031;
    pub const SOCKET_SEND: u32 = 0x1_0032;
    pub const SOCKET_RECV: u32 = 0x1_0033;
    pub const SOCKET_CLOSE: u32 = 0x1_0034;
    pub const IDB_GET: u32 = 0x1_0035;
    pub const IDB_PUT: u32 = 0x1_0036;
    pub const IDB_DELETE: u32 = 0x1_0037;
    pub const IDB_LIST: u32 = 0x1_0038;
    pub const SOCKET_LISTEN: u32 = 0x1_0039;
    pub const SOCKET_ACCEPT: u32 = 0x1_003A;
    pub const SOCKET_ADDR: u32 = 0x1_003B;
    pub const GETPRIORITY: u32 = 0x1_003D;
    pub const SETPRIORITY: u32 = 0x1_003E;
    pub const SCHED_GETSCHEDULER: u32 = 0x1_003F;
    pub const SCHED_GETPARAM: u32 = 0x1_0040;
    pub const SCHED_SETSCHEDULER: u32 = 0x1_0041;
    pub const SCHED_SETPARAM: u32 = 0x1_0042;
    pub const POLL: u32 = 0x1_0043;
    pub const SOCKETPAIR: u32 = 0x1_0044;
    pub const SOCKET_OPEN: u32 = 0x1_0045;
    pub const SOCKET_BIND: u32 = 0x1_0046;
    pub const SOCKET_SENDTO: u32 = 0x1_0047;
    pub const SOCKET_SENDMSG: u32 = 0x1_0048;
    pub const SOCKET_RECVMSG: u32 = 0x1_0049;
    pub const SOCKET_INFO: u32 = 0x1_004A;
    pub const SOCKET_RECVFROM: u32 = 0x1_004B;
    pub const SOCKET_OPTION: u32 = 0x1_004C;
    pub const THREAD_SPAWN: u32 = 0x1_004D;
    pub const THREAD_SELF: u32 = 0x1_004E;
    pub const THREAD_JOIN: u32 = 0x1_004F;
    pub const THREAD_DETACH: u32 = 0x1_0050;
    pub const THREAD_EXIT: u32 = 0x1_0051;
    pub const THREAD_YIELD: u32 = 0x1_0052;
}

/// Reserved pid for direct calls from outside any user process — the
/// kernel-host interface itself driving the kernel for tests, bootstrapping, or
/// internal bookkeeping. Real user processes start at `1`.
pub const KERNEL_PID: u32 = 0;

/// Kernel-internal method ids the kernel-host interface calls during process
/// setup (mirrors `abi/contract/yurt_abi_methods.toml`).
const METHOD_KERNEL_PROVIDE_STDIN: u32 = 4;
const METHOD_KERNEL_CLOSE_STDIN: u32 = 5;
const METHOD_KERNEL_DRAIN_STDOUT: u32 = 6;
const METHOD_KERNEL_DRAIN_STDERR: u32 = 7;
const METHOD_KERNEL_REGISTER_FILE: u32 = 8;
const METHOD_KERNEL_INSTALL_HOST_FS_MOUNT: u32 = 11;
const METHOD_KERNEL_INSTALL_YURTFS: u32 = 12;

// ── Host-side traits embedders implement ─────────────────────────────────────

/// Host-interface-side handler for `sys_extension_invoke`. Receives the
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

/// Host-interface-side sink for `kh_log` messages from kernel.wasm.
/// Severity values mirror `LogSeverity` in the kernel: 0 = debug,
/// 1 = info, 2 = warn, 3 = error.
pub trait LogSink: Send + Sync {
    fn emit(&self, severity: u32, message: &str);
}

/// Policy decisions. Synchronous so the host can plug in any
/// blocking prompt (CLI, GUI, "ask the human") behind a single
/// trait method. Embedders that want fully non-interactive
/// behavior pre-commit to Allow / Deny in their impl.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    Deny,
}

/// Embedder-supplied gate that sits at every `kh_*` crossing where
/// kernel.wasm is about to reach the outside world. The kernel-host interface
/// consults the policy before invoking real I/O; a Deny decision
/// turns into a kernel-side `-EACCES`.
///
/// Granularity is per-action, with the action's salient parameters
/// (path bytes, target host+port, signal number, …) so policies can
/// be precise — the canonical "ask me before connecting to evil.com"
/// reads `may_connect("www.evil.com", 443)` and prompts the human.
///
/// Defaults to Allow on every hook so embedders that don't care
/// about policy don't have to implement it. Embedders that do care
/// override the relevant methods.
///
/// All hooks are synchronous. Interactive impls block the calling
/// kernel-host thread; long blocks should be avoided for hooks that
/// fire on hot paths (today only `may_invoke_extension` does, and
/// even that is a host-only call from the kernel — never user code).
pub trait PolicyEnforcer: Send + Sync {
    /// Gate `kh_extension_invoke` — the kernel forwards an opaque
    /// extension-registry request to the host. Embedders that
    /// trust everything inside their own extensions can leave this
    /// as the default Allow.
    fn may_invoke_extension(&self, _request: &[u8]) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate file-system access from kernel.wasm to the real host fs
    /// (via the eventual `kh_real_fs_*` ABI; not wired yet). `write`
    /// distinguishes read-only opens from writable opens.
    fn may_open_path(&self, _path: &[u8], _write: bool) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate outbound network connections (eventual `kh_socket_connect`).
    /// `host` is the resolved hostname / IP literal the connection is
    /// targeting; `port` is the TCP/UDP port. The embedder can match
    /// domain suffixes, port ranges, or ask the user.
    fn may_connect(&self, _host: &str, _port: u16) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate inbound listeners (eventual `kh_socket_listen`).
    fn may_listen(&self, _port: u16) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate socket data transfer on already-created host socket handles.
    /// Connect/listen decide whether a handle can be created; this hook
    /// decides whether the kernel may use that handle for host I/O.
    fn may_socket_io(&self, _handle: i32, _write: bool) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate accepting a connection from a host listener handle.
    fn may_accept_socket(&self, _handle: i32) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate host socket address queries. `peer` distinguishes
    /// `getpeername` from `getsockname`.
    fn may_socket_addr(&self, _handle: i32, _peer: bool) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate `kh_log` emissions. Most embedders Allow these; some
    /// (e.g. embedded contexts that have no log sink) may Deny to
    /// drop noise without paying for the message format.
    fn may_log(&self, _severity: u32, _message: &str) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate `kh_now_realtime`. Privacy-sensitive embedders may
    /// quantize or refuse access to wall-clock; the kernel sees
    /// Deny as `-EACCES`.
    fn may_get_realtime(&self) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate outbound HTTP fetches. `request` is the binary fetch record the
    /// kernel forwarded; embedders inspect the URL, method, or headers and
    /// Allow/Deny. Default: Allow.
    fn may_fetch(&self, _request: &[u8]) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate durable KV access. `store` is the store name, `write`
    /// distinguishes mutating ops (put/delete) from read-only
    /// (get/list). Embedders enforce per-store namespacing.
    fn may_idb(&self, _store: &[u8], _write: bool) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate process instantiation requested by kernel.wasm.
    fn may_spawn_process(&self, _module_id: &[u8], _context: &[u8]) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate host process memory access. `write` distinguishes
    /// `kh_process_mem_write` from `kh_process_mem_read`.
    fn may_process_memory(&self, _handle: i32, _write: bool) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate resuming a host process instance.
    fn may_resume_process(&self, _handle: i32) -> PolicyDecision {
        PolicyDecision::Allow
    }
}

/// Default policy: every hook returns Allow. Equivalent to having
/// no policy enforcer at all; useful as the safe default for
/// embedders that don't need gating.
pub struct AllowAllPolicy;

impl PolicyEnforcer for AllowAllPolicy {}

/// Strict policy: every hook returns Deny. Tests and "no I/O at all"
/// embedders use this. Combined with extension hooks, it produces a
/// kernel that can only read its own ramfs and talk to itself.
pub struct DenyAllPolicy;

impl PolicyEnforcer for DenyAllPolicy {
    fn may_invoke_extension(&self, _request: &[u8]) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_open_path(&self, _path: &[u8], _write: bool) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_connect(&self, _host: &str, _port: u16) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_listen(&self, _port: u16) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_socket_io(&self, _handle: i32, _write: bool) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_accept_socket(&self, _handle: i32) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_socket_addr(&self, _handle: i32, _peer: bool) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_log(&self, _severity: u32, _message: &str) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_get_realtime(&self) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_fetch(&self, _request: &[u8]) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_idb(&self, _store: &[u8], _write: bool) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_spawn_process(&self, _module_id: &[u8], _context: &[u8]) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_process_memory(&self, _handle: i32, _write: bool) -> PolicyDecision {
        PolicyDecision::Deny
    }
    fn may_resume_process(&self, _handle: i32) -> PolicyDecision {
        PolicyDecision::Deny
    }
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

pub trait ThreadHost: Send + Sync {
    fn register_process(
        &self,
        _pid: u32,
        _wasm: Arc<[u8]>,
        _argv: Vec<Vec<u8>>,
        _shared_memory: Option<SharedMemory>,
    ) {
    }
    fn spawn(&self, pid: u32, tid: u32, fn_ptr: u32, arg: u32) -> i32;
    fn release(&self, host_thread_handle: i32) -> i32;
    fn cancel(&self, host_thread_handle: i32) -> i32;
}

struct WasmtimeThreadProcess {
    wasm: Arc<[u8]>,
    argv: Vec<Vec<u8>>,
    shared_memory: Option<SharedMemory>,
}

struct WasmtimeThreadHost {
    engine: Engine,
    kernel: Arc<Mutex<KernelInstance>>,
    processes: Mutex<std::collections::BTreeMap<u32, WasmtimeThreadProcess>>,
    threads: Mutex<std::collections::BTreeMap<i32, thread::JoinHandle<()>>>,
    next_handle: Mutex<i32>,
}

impl WasmtimeThreadHost {
    fn new(engine: Engine, kernel: Arc<Mutex<KernelInstance>>) -> Self {
        Self {
            engine,
            kernel,
            processes: Mutex::new(std::collections::BTreeMap::new()),
            threads: Mutex::new(std::collections::BTreeMap::new()),
            next_handle: Mutex::new(1),
        }
    }
}

impl ThreadHost for WasmtimeThreadHost {
    fn register_process(
        &self,
        pid: u32,
        wasm: Arc<[u8]>,
        argv: Vec<Vec<u8>>,
        shared_memory: Option<SharedMemory>,
    ) {
        self.processes.lock().unwrap().insert(
            pid,
            WasmtimeThreadProcess {
                wasm,
                argv,
                shared_memory,
            },
        );
    }

    fn spawn(&self, pid: u32, tid: u32, fn_ptr: u32, arg: u32) -> i32 {
        let process = {
            let processes = self.processes.lock().unwrap();
            let Some(process) = processes.get(&pid) else {
                return -(ENOENT as i32);
            };
            WasmtimeThreadProcess {
                wasm: process.wasm.clone(),
                argv: process.argv.clone(),
                shared_memory: process.shared_memory.clone(),
            }
        };
        let handle = {
            let mut next = self.next_handle.lock().unwrap();
            let handle = *next;
            *next = next.saturating_add(1);
            handle
        };
        let engine = self.engine.clone();
        let kernel = self.kernel.clone();
        let join = thread::Builder::new()
            .name(format!("yurt-wasmtime-thread-{pid}-{tid}"))
            .spawn(move || {
                let retval =
                    run_wasmtime_thread(engine, kernel.clone(), pid, tid, process, fn_ptr, arg)
                        .unwrap_or(u32::MAX);
                let _ = kernel
                    .lock()
                    .unwrap()
                    .record_thread_exit_authenticated(pid, tid, handle, retval);
            });
        match join {
            Ok(join) => {
                self.threads.lock().unwrap().insert(handle, join);
                handle
            }
            Err(_) => -(EAGAIN as i32),
        }
    }

    fn release(&self, host_thread_handle: i32) -> i32 {
        if let Some(join) = self.threads.lock().unwrap().remove(&host_thread_handle) {
            let _ = join.join();
        }
        0
    }

    fn cancel(&self, host_thread_handle: i32) -> i32 {
        self.threads.lock().unwrap().remove(&host_thread_handle);
        0
    }
}

fn run_wasmtime_thread(
    engine: Engine,
    kernel: Arc<Mutex<KernelInstance>>,
    pid: u32,
    tid: u32,
    process: WasmtimeThreadProcess,
    fn_ptr: u32,
    arg: u32,
) -> Result<u32> {
    let module = Module::new(&engine, process.wasm.as_ref()).context("compile thread wasm")?;
    let mut linker: Linker<UserState> = Linker::new(&engine);
    register_sys_imports(&mut linker)?;
    register_yurt_thread_imports(&mut linker)?;
    crate::wasi_shim::add_to_linker(&mut linker)
        .context("install WASI preview1 shim on thread linker")?;
    let user_state = UserState {
        kernel,
        pid,
        caller_tid: tid,
        argv: process.argv,
        dir_fds: std::collections::BTreeMap::new(),
        last_exit: None,
        last_scheduler_budget_ns: None,
        last_scheduler_epoch_quantum: None,
    };
    let mut store = Store::new(&engine, user_state);
    store.set_epoch_deadline(DEFAULT_EPOCH_DEADLINE);
    if let Some(memory) = process.shared_memory.clone() {
        define_imported_shared_memory(&module, &mut linker, &store, memory)?;
    }
    let instance = linker
        .instantiate(&mut store, &module)
        .context("instantiate thread wasm")?;
    let table = instance
        .get_table(&mut store, "__indirect_function_table")
        .ok_or_else(|| anyhow!("thread wasm missing __indirect_function_table"))?;
    let func = match table.get(&mut store, fn_ptr.into()) {
        Some(wasmtime::Ref::Func(Some(func))) => func,
        _ => anyhow::bail!("thread function pointer {fn_ptr} not found"),
    };
    let typed = func
        .typed::<i32, i32>(&store)
        .context("thread entry has wrong type")?;
    let retval = typed
        .call(&mut store, arg as i32)
        .context("thread entry call")?;
    Ok(retval as u32)
}

fn imported_shared_memory_type(module: &Module) -> Option<MemoryType> {
    module.imports().find_map(|import| {
        if import.module() != SYS_NAMESPACE || import.name() != "memory" {
            return None;
        }
        match import.ty() {
            ExternType::Memory(ty) if ty.is_shared() => Some(ty),
            _ => None,
        }
    })
}

fn define_imported_shared_memory<T>(
    module: &Module,
    linker: &mut Linker<T>,
    store: &Store<T>,
    memory: SharedMemory,
) -> Result<()> {
    if imported_shared_memory_type(module).is_some() {
        linker
            .define(store, SYS_NAMESPACE, "memory", memory)
            .context("define imported shared memory")?;
    }
    Ok(())
}

fn read_shared_memory(memory: SharedMemory, addr: u32, len: usize) -> Result<Vec<u8>> {
    let data = memory.data();
    let start = addr as usize;
    let end = start
        .checked_add(len)
        .ok_or_else(|| anyhow!("read user-process shared memory out of bounds"))?;
    let cells = data
        .get(start..end)
        .ok_or_else(|| anyhow!("read user-process shared memory out of bounds"))?;
    let mut out = Vec::with_capacity(len);
    for cell in cells {
        let byte = {
            let ptr = cell.get().cast::<AtomicU8>();
            // SAFETY: Wasmtime exposes shared memory as UnsafeCell<u8> because
            // concurrent wasm threads may access it. AtomicU8 has the same
            // layout as u8 and gives the host a data-race-free byte load.
            unsafe { (*ptr).load(Ordering::SeqCst) }
        };
        out.push(byte);
    }
    Ok(out)
}

/// State threaded through every wasmtime host callback that runs
/// during kernel.wasm execution.
pub struct HostState {
    pub now_realtime_ns: u64,
    pub extensions: Arc<dyn ExtensionRegistry>,
    pub log_sink: Arc<dyn LogSink>,
    /// Policy gate consulted at every `kh_*` boundary that touches
    /// the outside world. Defaults to AllowAllPolicy; embedders
    /// override via `KernelHostInterface::with_host_state_mut` or by
    /// constructing a custom HostState.
    pub policy: Arc<dyn PolicyEnforcer>,
    /// The host filesystem the `kh_real_*` imports route to. *All*
    /// host-fs access — local disk, S3, OPFS, in-memory — goes
    /// through this trait; the embedder picks an implementation.
    /// `None` means "no host fs at all" and every `kh_real_*` call
    /// returns -EACCES (the safe default for sandboxes that don't
    /// need it).
    ///
    /// Common choices:
    /// - [`NativeHostFs::new(root)`] — local disk under `root`
    ///   with canonicalize-and-contain protection.
    /// - [`InMemoryHostFs::new()`] — in-process map, useful for
    ///   tests and for browser kernel-host interfaces that haven't wired up
    ///   OPFS yet.
    /// - Embedder-provided impls for S3, OPFS, IndexedDB, etc.
    pub host_fs: Option<Arc<dyn HostFsImpl>>,
    /// Outbound TCP backend the `kh_socket_*` imports route to.
    /// Pluggable like [`host_fs`]; the trait is the contract.
    /// `None` means no socket access — every connect returns
    /// -EACCES.
    ///
    /// In-tree implementations:
    /// - [`NativeTcpSocket::new`] — std::net::TcpStream, blocking,
    ///   subject to the embedder's `may_connect` policy gate.
    /// - Browser kernel-host interfaces plug in a WebSocket-backed impl
    ///   here (browsers can't open raw TCP).
    pub tcp: Option<Arc<dyn TcpSocketImpl>>,
    /// Durable key-value backend for the `kh_idb_*` imports.
    /// `None` denies every access. Browser kernel-host interfaces back
    /// this with IndexedDB; native deployments use a disk-backed
    /// store or [`InMemoryKv`] for tests.
    pub kv: Option<Arc<dyn KvBackend>>,
    /// Host thread executor for Rust-owned `kh_thread_*` calls.
    /// The kernel owns thread ids, join/detach/reap semantics, and
    /// stores the opaque handle this adapter returns.
    pub thread_host: Option<Arc<dyn ThreadHost>>,
    /// Kernel-host process engine state for cached wasm modules.
    /// The kernel owns pid allocation and process records; this
    /// table is only the wasmtime adapter's module/handle storage.
    pub process_engine: Arc<Mutex<CachedProcessEngine>>,
}

impl Default for HostState {
    fn default() -> Self {
        Self {
            now_realtime_ns: 0,
            extensions: Arc::new(EmptyExtensionRegistry),
            log_sink: Arc::new(DiscardLogSink),
            policy: Arc::new(AllowAllPolicy),
            host_fs: None,
            tcp: None,
            kv: None,
            thread_host: None,
            process_engine: Arc::new(Mutex::new(CachedProcessEngine::default())),
        }
    }
}

#[derive(Default)]
pub struct CachedProcessEngine {
    modules: std::collections::BTreeMap<Vec<u8>, Vec<u8>>,
    pending: std::collections::BTreeMap<u32, CachedSpawn>,
    live_handles: std::collections::BTreeSet<i32>,
    next_handle: i32,
}

struct CachedSpawn {
    handle: i32,
    wasm: Vec<u8>,
    argv: Vec<Vec<u8>>,
}

impl CachedProcessEngine {
    fn cache_module(&mut self, module_id: &[u8], wasm: &[u8]) {
        self.modules.insert(module_id.to_vec(), wasm.to_vec());
    }

    fn spawn(&mut self, module_id: &[u8], context: &[u8]) -> i32 {
        let Some(wasm) = self.modules.get(module_id).cloned() else {
            return -(ENOENT as i32);
        };
        let (pid, argv) = match decode_spawn_context(context) {
            Ok(parsed) => parsed,
            Err(rc) => return rc,
        };
        let handle = self.next_handle;
        self.next_handle = self.next_handle.saturating_add(1);
        self.pending.insert(pid, CachedSpawn { handle, wasm, argv });
        handle
    }

    fn take_pending(&mut self, pid: u32) -> Option<CachedSpawn> {
        let spawn = self.pending.remove(&pid)?;
        self.live_handles.insert(spawn.handle);
        Some(spawn)
    }

    fn destroy(&mut self, handle: i32) -> i32 {
        if self.live_handles.remove(&handle) {
            return 0;
        }
        let pending_pid = self
            .pending
            .iter()
            .find_map(|(pid, spawn)| (spawn.handle == handle).then_some(*pid));
        if let Some(pid) = pending_pid {
            self.pending.remove(&pid);
            return 0;
        }
        -EBADF as i32
    }
}

fn decode_spawn_context(context: &[u8]) -> std::result::Result<(u32, Vec<Vec<u8>>), i32> {
    if context.len() < 12 {
        return Err(-EINVAL as i32);
    }
    let version = u16::from_le_bytes(context[0..2].try_into().expect("2 bytes"));
    if version != 1 {
        return Err(-EINVAL as i32);
    }
    let pid = u32::from_le_bytes(context[4..8].try_into().expect("4 bytes"));
    let argv_len = u32::from_le_bytes(context[8..12].try_into().expect("4 bytes")) as usize;
    if context.len() != 12 + argv_len {
        return Err(-EINVAL as i32);
    }
    let mut offset = 12usize;
    let mut argv = Vec::new();
    while offset < context.len() {
        if context.len() < offset + 4 {
            return Err(-EINVAL as i32);
        }
        let len =
            u32::from_le_bytes(context[offset..offset + 4].try_into().expect("4 bytes")) as usize;
        offset += 4;
        if context.len() < offset + len {
            return Err(-EINVAL as i32);
        }
        argv.push(context[offset..offset + len].to_vec());
        offset += len;
    }
    Ok((pid, argv))
}

/// Pluggable durable key-value store. Browser kernel-host interfaces back
/// this with IndexedDB (one IDB store per `store` name); native
/// deployments use an on-disk store or [`InMemoryKv`].
pub trait KvBackend: Send + Sync {
    fn get(&self, store: &[u8], key: &[u8]) -> Result<Vec<u8>, i32>;
    fn put(&self, store: &[u8], key: &[u8], value: &[u8]) -> i32;
    fn delete(&self, store: &[u8], key: &[u8]) -> i32;
    fn list(&self, store: &[u8], prefix: &[u8]) -> Vec<Vec<u8>>;
}

/// `redb`-backed [`KvBackend`] — single-file, all-Rust embedded
/// store, suitable for native deployments that want real disk
/// persistence without bringing FFI. Each logical "store" maps
/// to a redb table; keys/values are byte slices verbatim. Fully
/// transactional inside each call (per-call read/write txns).
///
/// For deployments that need a different backing (sled, rocksdb,
/// SQLite, S3) the embedder writes its own [`KvBackend`] impl
/// and wires it onto `HostState.kv` — same surface, different
/// store.
pub struct RedbKv {
    db: redb::Database,
}

impl RedbKv {
    pub fn open(path: PathBuf) -> Result<Self, Box<redb::DatabaseError>> {
        let db = redb::Database::create(path)?;
        Ok(Self { db })
    }

    fn table_def<'a>(
        store: &'a [u8],
    ) -> Result<redb::TableDefinition<'a, &'static [u8], &'static [u8]>, i32> {
        // redb table names are UTF-8. Reject invalid names instead of
        // collapsing unrelated byte stores into a shared fallback table.
        let name = std::str::from_utf8(store).map_err(|_| -EINVAL as i32)?;
        Ok(redb::TableDefinition::new(name))
    }
}

impl KvBackend for RedbKv {
    fn get(&self, store: &[u8], key: &[u8]) -> Result<Vec<u8>, i32> {
        let table_def = Self::table_def(store)?;
        let txn = self.db.begin_read().map_err(|_| -5_i32)?;
        let table = match txn.open_table(table_def) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Err(-2_i32),
            Err(_) => return Err(-5_i32),
        };
        match table.get(key) {
            Ok(Some(v)) => Ok(v.value().to_vec()),
            Ok(None) => Err(-2_i32),
            Err(_) => Err(-5_i32),
        }
    }

    fn put(&self, store: &[u8], key: &[u8], value: &[u8]) -> i32 {
        let table_def = match Self::table_def(store) {
            Ok(def) => def,
            Err(rc) => return rc,
        };
        let txn = match self.db.begin_write() {
            Ok(t) => t,
            Err(_) => return -5_i32,
        };
        {
            let mut table = match txn.open_table(table_def) {
                Ok(t) => t,
                Err(_) => return -5_i32,
            };
            if table.insert(key, value).is_err() {
                return -5_i32;
            }
        }
        match txn.commit() {
            Ok(()) => 0,
            Err(_) => -5_i32,
        }
    }

    fn delete(&self, store: &[u8], key: &[u8]) -> i32 {
        let table_def = match Self::table_def(store) {
            Ok(def) => def,
            Err(rc) => return rc,
        };
        let txn = match self.db.begin_write() {
            Ok(t) => t,
            Err(_) => return -5_i32,
        };
        {
            let mut table = match txn.open_table(table_def) {
                Ok(t) => t,
                Err(redb::TableError::TableDoesNotExist(_)) => return 0,
                Err(_) => return -5_i32,
            };
            let _ = table.remove(key);
        }
        match txn.commit() {
            Ok(()) => 0,
            Err(_) => -5_i32,
        }
    }

    fn list(&self, store: &[u8], prefix: &[u8]) -> Vec<Vec<u8>> {
        use redb::ReadableTable;
        let table_def = match Self::table_def(store) {
            Ok(def) => def,
            Err(_) => return Vec::new(),
        };
        let txn = match self.db.begin_read() {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        let table = match txn.open_table(table_def) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        let iter = match table.iter() {
            Ok(it) => it,
            Err(_) => return Vec::new(),
        };
        let mut keys = Vec::new();
        for entry in iter.flatten() {
            let k = entry.0.value().to_vec();
            if k.starts_with(prefix) {
                keys.push(k);
            }
        }
        keys
    }
}

/// In-process [`KvBackend`] implementation. Map of
/// (store, key) → bytes. Useful for tests and as the placeholder
/// browser kernel-host interfaces point at while IndexedDB wiring is in
/// flight.
pub struct InMemoryKv {
    inner: std::sync::Mutex<KvMap>,
}

type KvMap = std::collections::BTreeMap<(Vec<u8>, Vec<u8>), Vec<u8>>;

impl InMemoryKv {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(std::collections::BTreeMap::new()),
        }
    }
}

impl Default for InMemoryKv {
    fn default() -> Self {
        Self::new()
    }
}

impl KvBackend for InMemoryKv {
    fn get(&self, store: &[u8], key: &[u8]) -> Result<Vec<u8>, i32> {
        self.inner
            .lock()
            .unwrap()
            .get(&(store.to_vec(), key.to_vec()))
            .cloned()
            .ok_or(-2_i32) // -ENOENT
    }

    fn put(&self, store: &[u8], key: &[u8], value: &[u8]) -> i32 {
        self.inner
            .lock()
            .unwrap()
            .insert((store.to_vec(), key.to_vec()), value.to_vec());
        0
    }

    fn delete(&self, store: &[u8], key: &[u8]) -> i32 {
        self.inner
            .lock()
            .unwrap()
            .remove(&(store.to_vec(), key.to_vec()));
        0
    }

    fn list(&self, store: &[u8], prefix: &[u8]) -> Vec<Vec<u8>> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .filter(|((s, k), _)| s == store && k.starts_with(prefix))
            .map(|((_, k), _)| k.clone())
            .collect()
    }
}

/// Pluggable outbound TCP backend. The embedder picks an
/// implementation; kernel.wasm's `kh_socket_*` imports route here.
/// Browser kernel-host interfaces plug in a WebSocket-backed impl since
/// browsers can't open raw TCP; native deployments use
/// [`NativeTcpSocket`]. Containment is the embedder's job — the
/// `may_connect` policy gate fires before this trait sees any
/// request.
pub trait TcpSocketImpl: Send + Sync {
    /// Connect to `host`/`port` and return a non-negative socket
    /// handle, or a negated POSIX errno.
    fn connect(&self, host: &str, port: u16, flags: u32) -> i32;
    /// Send up to `data.len()` bytes. Returns bytes sent or
    /// negated errno.
    fn send(&self, handle: i32, data: &[u8]) -> i64;
    /// Receive into `buf`. Returns bytes-read (0 = peer closed)
    /// or negated errno (-EAGAIN with KH_SOCK_NONBLOCK).
    fn recv(&self, handle: i32, buf: &mut [u8], flags: u32) -> i64;
    /// Close the handle (listener or connection).
    fn close(&self, handle: i32) -> i32;
    /// Bind to `host`/`port` (port=0 lets the host pick) and start
    /// accepting. Returns a listener handle or negated errno.
    /// Default: -ENOSYS — embedders that want listen wire it up
    /// in their TcpSocketImpl. (Browser kernel-host interfaces typically
    /// implement this via Service Worker / WebSocket relay; see
    /// the project_listen_port_mapping memory note.)
    fn listen(&self, _host: &str, _port: u16, _backlog: u32) -> i32 {
        -38 // -ENOSYS
    }
    /// Block until an incoming connection arrives on `handle`.
    /// Returns a connection handle (usable with send/recv/close)
    /// or negated errno. -EAGAIN with KH_SOCK_NONBLOCK.
    fn accept(&self, _handle: i32, _flags: u32) -> i32 {
        -38
    }
    /// Return the locally-bound (host, port) of `handle`. Used
    /// after listen with port=0 to discover the kernel-chosen
    /// port.
    fn local_addr(&self, _handle: i32) -> Option<(String, u16)> {
        None
    }
    /// Return the connected peer (host, port) of `handle`.
    fn peer_addr(&self, _handle: i32) -> Option<(String, u16)> {
        None
    }
}

/// std::net::TcpStream-backed [`TcpSocketImpl`]. Blocking I/O;
/// each `connect` issues a fresh DNS resolve + TCP handshake with
/// a configurable timeout. Suitable for native CLI / server
/// embedders. Browser kernel-host interfaces need their own impl.
pub struct NativeTcpSocket {
    connect_timeout: std::time::Duration,
    inner: std::sync::Mutex<NativeTcpState>,
}

#[derive(Default)]
struct NativeTcpState {
    sockets: std::collections::BTreeMap<i32, std::net::TcpStream>,
    listeners: std::collections::BTreeMap<i32, std::net::TcpListener>,
    next_handle: i32,
}

impl NativeTcpSocket {
    pub fn new() -> Self {
        Self::with_connect_timeout(std::time::Duration::from_secs(30))
    }

    pub fn with_connect_timeout(connect_timeout: std::time::Duration) -> Self {
        Self {
            connect_timeout,
            inner: std::sync::Mutex::new(NativeTcpState {
                next_handle: 1,
                ..Default::default()
            }),
        }
    }
}

impl Default for NativeTcpSocket {
    fn default() -> Self {
        Self::new()
    }
}

impl TcpSocketImpl for NativeTcpSocket {
    fn connect(&self, host: &str, port: u16, _flags: u32) -> i32 {
        use std::net::ToSocketAddrs;
        // Resolve every address the host name maps to and try
        // them in turn — first-success wins. POSIX-shaped: the
        // kernel never sees the IP, just the resulting handle.
        let addrs: Vec<std::net::SocketAddr> = match (host, port).to_socket_addrs() {
            Ok(it) => it.collect(),
            Err(_) => return -2_i32, // -ENOENT (DNS miss)
        };
        let mut last_err: i32 = -111_i32; // -ECONNREFUSED default
        for addr in addrs {
            match std::net::TcpStream::connect_timeout(&addr, self.connect_timeout) {
                Ok(stream) => {
                    let mut s = self.inner.lock().unwrap();
                    let handle = s.next_handle;
                    s.next_handle = s.next_handle.saturating_add(1);
                    s.sockets.insert(handle, stream);
                    return handle;
                }
                Err(e) => last_err = tcp_io_errno(e),
            }
        }
        last_err
    }

    fn send(&self, handle: i32, data: &[u8]) -> i64 {
        use std::io::Write;
        let mut s = self.inner.lock().unwrap();
        let Some(stream) = s.sockets.get_mut(&handle) else {
            return -9_i64; // -EBADF
        };
        match stream.write(data) {
            Ok(n) => n as i64,
            Err(e) => tcp_io_errno(e) as i64,
        }
    }

    fn recv(&self, handle: i32, buf: &mut [u8], _flags: u32) -> i64 {
        use std::io::Read;
        let mut s = self.inner.lock().unwrap();
        let Some(stream) = s.sockets.get_mut(&handle) else {
            return -9_i64;
        };
        match stream.read(buf) {
            Ok(n) => n as i64,
            Err(e) => tcp_io_errno(e) as i64,
        }
    }

    fn close(&self, handle: i32) -> i32 {
        let mut s = self.inner.lock().unwrap();
        // A handle may be either a connected stream or a listener;
        // close releases whichever side it is.
        s.sockets.remove(&handle);
        s.listeners.remove(&handle);
        0
    }

    fn listen(&self, host: &str, port: u16, _backlog: u32) -> i32 {
        let bind_host = if host == "0.0.0.0" || host.is_empty() {
            "0.0.0.0"
        } else if host == "localhost" {
            "127.0.0.1"
        } else {
            host
        };
        let listener = match std::net::TcpListener::bind((bind_host, port)) {
            Ok(l) => l,
            Err(e) => return tcp_io_errno(e),
        };
        let mut s = self.inner.lock().unwrap();
        let handle = s.next_handle;
        s.next_handle = s.next_handle.saturating_add(1);
        s.listeners.insert(handle, listener);
        handle
    }

    fn accept(&self, handle: i32, _flags: u32) -> i32 {
        // Take ownership of the listener temporarily so the lock
        // is released across the (potentially-blocking) accept.
        // We don't dup the listener — pulling it out then putting
        // it back is single-threaded and good enough for this
        // slice. (A future slice with multiple concurrent accepts
        // can use Arc<TcpListener>.)
        let listener = {
            let mut s = self.inner.lock().unwrap();
            match s.listeners.remove(&handle) {
                Some(l) => l,
                None => return -EBADF as i32,
            }
        };
        let result = listener.accept();
        // Restore the listener so subsequent accepts work.
        {
            let mut s = self.inner.lock().unwrap();
            s.listeners.insert(handle, listener);
        }
        match result {
            Ok((stream, _peer)) => {
                let mut s = self.inner.lock().unwrap();
                let conn = s.next_handle;
                s.next_handle = s.next_handle.saturating_add(1);
                s.sockets.insert(conn, stream);
                conn
            }
            Err(e) => tcp_io_errno(e),
        }
    }

    fn local_addr(&self, handle: i32) -> Option<(String, u16)> {
        let s = self.inner.lock().unwrap();
        if let Some(l) = s.listeners.get(&handle) {
            return l.local_addr().ok().map(|a| (a.ip().to_string(), a.port()));
        }
        if let Some(stream) = s.sockets.get(&handle) {
            return stream
                .local_addr()
                .ok()
                .map(|a| (a.ip().to_string(), a.port()));
        }
        None
    }

    fn peer_addr(&self, handle: i32) -> Option<(String, u16)> {
        let s = self.inner.lock().unwrap();
        s.sockets
            .get(&handle)
            .and_then(|stream| stream.peer_addr().ok())
            .map(|a| (a.ip().to_string(), a.port()))
    }
}

fn tcp_io_errno(e: std::io::Error) -> i32 {
    use std::io::ErrorKind::*;
    match e.kind() {
        ConnectionRefused => -111_i32,
        ConnectionReset => -104_i32,
        ConnectionAborted => -103_i32,
        TimedOut => -110_i32,
        BrokenPipe => -32_i32, // -EPIPE
        WouldBlock => -11_i32, // -EAGAIN
        NotFound => -2_i32,
        PermissionDenied => -13_i32,
        _ => -5_i32, // -EIO
    }
}

fn socket_addr_record(host: &str, port: u16) -> [u8; 8] {
    let mut out = [0_u8; 8];
    if let Ok(addr) = host.parse::<std::net::Ipv4Addr>() {
        out[0..4].copy_from_slice(&addr.octets());
    }
    out[4..6].copy_from_slice(&port.to_be_bytes());
    out
}

fn decode_ipv4_sockaddr(addr: &[u8]) -> std::result::Result<(String, u16), i32> {
    if addr.len() < 16 {
        return Err(-EINVAL as i32);
    }
    let family = u16::from_le_bytes(addr[0..2].try_into().map_err(|_| -EINVAL as i32)?);
    if family != 2 {
        return Err(-EINVAL as i32);
    }
    let port = u16::from_be_bytes(addr[2..4].try_into().map_err(|_| -EINVAL as i32)?);
    let host = std::net::Ipv4Addr::new(addr[4], addr[5], addr[6], addr[7]).to_string();
    Ok((host, port))
}

/// Pluggable host-fs backend. *Every* host-fs access goes through
/// this trait — local disk, OPFS, S3, in-memory, all the same
/// surface. The kernel-host interface calls these methods from inside each
/// `kh_real_*` import after the policy gate has Allowed the call;
/// implementations are responsible for their own rooting/
/// containment (e.g. [`NativeHostFs`] canonicalizes against its
/// configured root and rejects escapes; [`InMemoryHostFs`] keys
/// directly off the path bytes; an S3 impl would map paths to
/// object keys under a configured bucket prefix).
pub trait HostFsImpl: Send + Sync {
    fn open(&self, path: &[u8], flags: u32) -> i32;
    fn read(&self, fd: i32, buf: &mut [u8]) -> i64;
    fn write(&self, fd: i32, data: &[u8]) -> i64;
    fn close(&self, fd: i32) -> i32;
    fn stat(&self, path: &[u8]) -> Result<HostFsStat, i32>;
    fn unlink(&self, path: &[u8]) -> i32;
    fn mkdir(&self, path: &[u8], mode: u32) -> i32;
    fn symlink(&self, target: &[u8], link_path: &[u8]) -> i32;
    fn rename(&self, old_path: &[u8], new_path: &[u8]) -> i32;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct HostFsStat {
    pub size: u64,
    pub mode: u32,
    pub mtime_ns: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// Real-disk implementation of [`HostFsImpl`]. Wraps `std::fs`
/// with a configured root directory and canonicalize-and-contain
/// path resolution: every absolute path the kernel sends (e.g.
/// `/etc/hosts`) is joined against the root, canonicalized, and
/// rejected if the result climbs above the root via `..`. Open
/// fds are stored in an internal map keyed by the i32 handle the
/// kernel sees.
pub struct NativeHostFs {
    root: PathBuf,
    inner: std::sync::Mutex<NativeFsState>,
}

#[derive(Default)]
struct NativeFsState {
    fds: std::collections::BTreeMap<i32, std::fs::File>,
    next_fd: i32,
}

impl NativeHostFs {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            inner: std::sync::Mutex::new(NativeFsState {
                next_fd: 1,
                ..Default::default()
            }),
        }
    }

    /// Canonicalize `path` (kernel-supplied absolute) against the
    /// root. Returns the resolved absolute path on success or a
    /// negated POSIX errno (-EACCES on escape, -ENOENT when the
    /// leaf is missing and `allow_missing` is false). The leaf-
    /// missing case is allowed for create/mkdir/symlink/rename
    /// destinations and falls back to canonicalizing the parent.
    fn resolve(&self, path: &[u8], allow_missing: bool) -> std::result::Result<PathBuf, i32> {
        let rel: &[u8] = if path.starts_with(b"/") {
            &path[1..]
        } else {
            path
        };
        let rel_str = std::str::from_utf8(rel).map_err(|_| -EINVAL as i32)?;
        let candidate = self.root.join(rel_str);
        let root_canon = self.root.canonicalize().map_err(|_| -EACCES as i32)?;
        match candidate.canonicalize() {
            Ok(p) if p.starts_with(&root_canon) => Ok(p),
            Ok(_) => Err(-EACCES as i32),
            Err(_) if allow_missing => {
                let parent = candidate.parent().ok_or(-EINVAL as i32)?;
                let parent_canon = parent.canonicalize().map_err(|_| -ENOENT as i32)?;
                if !parent_canon.starts_with(&root_canon) {
                    return Err(-EACCES as i32);
                }
                Ok(parent_canon.join(candidate.file_name().unwrap_or_default()))
            }
            Err(_) => Err(-ENOENT as i32),
        }
    }

    fn map_io(e: std::io::Error) -> i32 {
        host_io_errno(e)
    }
}

impl HostFsImpl for NativeHostFs {
    fn open(&self, path: &[u8], flags: u32) -> i32 {
        let writable = flags & 0b001 != 0;
        let create = flags & 0b010 != 0;
        let trunc = flags & 0b100 != 0;
        let resolved = match self.resolve(path, writable && create) {
            Ok(p) => p,
            Err(rc) => return rc,
        };
        let mut opts = std::fs::OpenOptions::new();
        opts.read(true);
        if writable {
            opts.write(true);
        }
        if create {
            opts.create(true);
        }
        if trunc && writable {
            opts.truncate(true);
        }
        let file = match opts.open(&resolved) {
            Ok(f) => f,
            Err(e) => return Self::map_io(e),
        };
        let mut s = self.inner.lock().unwrap();
        let fd = s.next_fd;
        s.next_fd = s.next_fd.saturating_add(1);
        s.fds.insert(fd, file);
        fd
    }

    fn read(&self, fd: i32, buf: &mut [u8]) -> i64 {
        use std::io::Read;
        let mut s = self.inner.lock().unwrap();
        let Some(file) = s.fds.get_mut(&fd) else {
            return -9_i64;
        };
        match file.read(buf) {
            Ok(n) => n as i64,
            Err(e) => Self::map_io(e) as i64,
        }
    }

    fn write(&self, fd: i32, data: &[u8]) -> i64 {
        use std::io::Write;
        let mut s = self.inner.lock().unwrap();
        let Some(file) = s.fds.get_mut(&fd) else {
            return -9_i64;
        };
        match file.write(data) {
            Ok(n) => n as i64,
            Err(e) => Self::map_io(e) as i64,
        }
    }

    fn close(&self, fd: i32) -> i32 {
        self.inner.lock().unwrap().fds.remove(&fd);
        0
    }

    fn stat(&self, path: &[u8]) -> Result<HostFsStat, i32> {
        let resolved = self.resolve(path, false)?;
        let meta = std::fs::metadata(&resolved).map_err(Self::map_io)?;
        let mode: u32 = if meta.is_dir() { 0o040_755 } else { 0o100_644 };
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        Ok(HostFsStat {
            size: meta.len(),
            mode,
            mtime_ns,
            is_dir: meta.is_dir(),
            is_symlink: false,
        })
    }

    fn unlink(&self, path: &[u8]) -> i32 {
        let resolved = match self.resolve(path, false) {
            Ok(p) => p,
            Err(rc) => return rc,
        };
        match std::fs::remove_file(&resolved) {
            Ok(()) => 0,
            Err(e) => Self::map_io(e),
        }
    }

    fn mkdir(&self, path: &[u8], _mode: u32) -> i32 {
        let resolved = match self.resolve(path, true) {
            Ok(p) => p,
            Err(rc) => return rc,
        };
        match std::fs::create_dir(&resolved) {
            Ok(()) => 0,
            Err(e) => Self::map_io(e),
        }
    }

    fn symlink(&self, target: &[u8], link_path: &[u8]) -> i32 {
        let link_resolved = match self.resolve(link_path, true) {
            Ok(p) => p,
            Err(rc) => return rc,
        };
        let target_str = match std::str::from_utf8(target) {
            Ok(s) => s,
            Err(_) => return -EINVAL as i32,
        };
        #[cfg(unix)]
        let res = std::os::unix::fs::symlink(target_str, &link_resolved);
        #[cfg(not(unix))]
        let res: std::io::Result<()> = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "symlink",
        ));
        match res {
            Ok(()) => 0,
            Err(e) => Self::map_io(e),
        }
    }

    fn rename(&self, old_path: &[u8], new_path: &[u8]) -> i32 {
        let old_resolved = match self.resolve(old_path, false) {
            Ok(p) => p,
            Err(rc) => return rc,
        };
        let new_resolved = match self.resolve(new_path, true) {
            Ok(p) => p,
            Err(rc) => return rc,
        };
        match std::fs::rename(&old_resolved, &new_resolved) {
            Ok(()) => 0,
            Err(e) => Self::map_io(e),
        }
    }
}

/// Minimal in-memory implementation of [`HostFsImpl`]. Files are
/// `Vec<u8>` blobs keyed by absolute path; symlinks are a
/// separate map of target bytes; directories track only
/// existence. Reads use a per-fd cursor. No size cap, no
/// pagination, no concurrent-handle edge cases — this is here so
/// browser kernel-host interfaces (and tests that don't want a temp dir)
/// have a working backend to point at while OPFS is being wired
/// up.
pub struct InMemoryHostFs {
    inner: std::sync::Mutex<InMemoryFsState>,
}

#[derive(Default)]
struct InMemoryFsState {
    files: std::collections::BTreeMap<Vec<u8>, Vec<u8>>,
    dirs: std::collections::BTreeSet<Vec<u8>>,
    symlinks: std::collections::BTreeMap<Vec<u8>, Vec<u8>>,
    /// fd → (path, cursor). The path is the canonical key into
    /// `files`; cursor is a byte offset advanced by read/write.
    fds: std::collections::BTreeMap<i32, (Vec<u8>, u64)>,
    next_fd: i32,
}

impl InMemoryHostFs {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(InMemoryFsState {
                next_fd: 1,
                ..Default::default()
            }),
        }
    }

    /// Pre-populate a regular file. Useful for tests: install
    /// fixtures before the kernel_host_interface touches them.
    pub fn install_file(&self, path: &[u8], content: Vec<u8>) {
        let mut s = self.inner.lock().unwrap();
        s.files.insert(path.to_vec(), content);
    }
}

impl Default for InMemoryHostFs {
    fn default() -> Self {
        Self::new()
    }
}

impl HostFsImpl for InMemoryHostFs {
    fn open(&self, path: &[u8], flags: u32) -> i32 {
        let writable = flags & 0b001 != 0;
        let create = flags & 0b010 != 0;
        let trunc = flags & 0b100 != 0;
        let mut s = self.inner.lock().unwrap();
        if !s.files.contains_key(path) {
            if !create {
                return -2_i32; // -ENOENT
            }
            if !writable {
                return -13_i32; // -EACCES (create requires write)
            }
            s.files.insert(path.to_vec(), Vec::new());
        } else if trunc && writable {
            s.files.get_mut(path).unwrap().clear();
        }
        let fd = s.next_fd;
        s.next_fd = s.next_fd.saturating_add(1);
        s.fds.insert(fd, (path.to_vec(), 0));
        fd
    }

    fn read(&self, fd: i32, buf: &mut [u8]) -> i64 {
        let mut s = self.inner.lock().unwrap();
        let Some((path, cursor)) = s.fds.get(&fd).cloned() else {
            return -9_i64; // -EBADF
        };
        let Some(content) = s.files.get(&path) else {
            return -9_i64;
        };
        let start = (cursor as usize).min(content.len());
        let avail = content.len() - start;
        let n = avail.min(buf.len());
        if n > 0 {
            buf[..n].copy_from_slice(&content[start..start + n]);
        }
        if let Some(entry) = s.fds.get_mut(&fd) {
            entry.1 = entry.1.saturating_add(n as u64);
        }
        n as i64
    }

    fn write(&self, fd: i32, data: &[u8]) -> i64 {
        let mut s = self.inner.lock().unwrap();
        let Some((path, cursor)) = s.fds.get(&fd).cloned() else {
            return -9_i64;
        };
        let Some(content) = s.files.get_mut(&path) else {
            return -9_i64;
        };
        let start = cursor as usize;
        let end = start + data.len();
        if end > content.len() {
            content.resize(end, 0);
        }
        content[start..end].copy_from_slice(data);
        if let Some(entry) = s.fds.get_mut(&fd) {
            entry.1 = entry.1.saturating_add(data.len() as u64);
        }
        data.len() as i64
    }

    fn close(&self, fd: i32) -> i32 {
        self.inner.lock().unwrap().fds.remove(&fd);
        0
    }

    fn stat(&self, path: &[u8]) -> Result<HostFsStat, i32> {
        let s = self.inner.lock().unwrap();
        if let Some(content) = s.files.get(path) {
            return Ok(HostFsStat {
                size: content.len() as u64,
                mode: 0o100_644,
                mtime_ns: 0,
                is_dir: false,
                is_symlink: false,
            });
        }
        if s.dirs.contains(path) {
            return Ok(HostFsStat {
                size: 0,
                mode: 0o040_755,
                mtime_ns: 0,
                is_dir: true,
                is_symlink: false,
            });
        }
        if s.symlinks.contains_key(path) {
            return Ok(HostFsStat {
                size: 0,
                mode: 0o120_777,
                mtime_ns: 0,
                is_dir: false,
                is_symlink: true,
            });
        }
        Err(-2_i32)
    }

    fn unlink(&self, path: &[u8]) -> i32 {
        let mut s = self.inner.lock().unwrap();
        if s.symlinks.remove(path).is_some() {
            return 0;
        }
        if s.files.remove(path).is_some() {
            return 0;
        }
        -2_i32
    }

    fn mkdir(&self, path: &[u8], _mode: u32) -> i32 {
        let mut s = self.inner.lock().unwrap();
        if s.dirs.contains(path) || s.files.contains_key(path) {
            return -17_i32; // -EEXIST
        }
        s.dirs.insert(path.to_vec());
        0
    }

    fn symlink(&self, target: &[u8], link_path: &[u8]) -> i32 {
        let mut s = self.inner.lock().unwrap();
        if s.files.contains_key(link_path)
            || s.symlinks.contains_key(link_path)
            || s.dirs.contains(link_path)
        {
            return -17_i32;
        }
        s.symlinks.insert(link_path.to_vec(), target.to_vec());
        0
    }

    fn rename(&self, old_path: &[u8], new_path: &[u8]) -> i32 {
        let mut s = self.inner.lock().unwrap();
        if let Some(content) = s.files.remove(old_path) {
            s.files.insert(new_path.to_vec(), content);
            return 0;
        }
        if let Some(target) = s.symlinks.remove(old_path) {
            s.symlinks.insert(new_path.to_vec(), target);
            return 0;
        }
        if s.dirs.remove(old_path) {
            s.dirs.insert(new_path.to_vec());
            return 0;
        }
        -2_i32
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

type KernelDispatchThreadFunc = TypedFunc<(u32, u32, u32, u32, u32, u32, u32), i64>;

/// The loaded kernel.wasm plus the typed handles needed to drive it.
/// Kept behind `Arc<Mutex<…>>` so that both the [`KernelHostInterface`] and
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
    pub(crate) dispatch_thread: KernelDispatchThreadFunc,
    pub(crate) list_processes: TypedFunc<(u32, u32), i64>,
    pub(crate) list_threads: TypedFunc<(u32, u32, u32), i64>,
    pub(crate) snapshot: TypedFunc<(u32, u32), i64>,
    pub(crate) schedule_next: TypedFunc<(u32, u32), i64>,
    pub(crate) spawn_thread: TypedFunc<(u32, i32), i64>,
    pub(crate) detach_thread: TypedFunc<(u32, u32), i64>,
    pub(crate) record_thread_exit: TypedFunc<(u32, u32, i32), i64>,
    pub(crate) record_thread_exit_authenticated: TypedFunc<(u32, u32, i32, u32), i64>,
    pub(crate) block_thread: TypedFunc<(u32, u32), i64>,
    pub(crate) unblock_thread: TypedFunc<(u32, u32), i64>,
    pub(crate) kill: TypedFunc<(u32, u32), i64>,
    pub(crate) wait: TypedFunc<(u32, u32, u32, u32, u32), i64>,
    pub(crate) record_exit: TypedFunc<(u32, i32), i64>,
    pub(crate) drain_spawn: TypedFunc<(u32, u32), i64>,
    pub(crate) spawn_process: TypedFunc<(u32, u32, u32, u32, u32), i64>,
}

impl KernelInstance {
    /// Run a syscall. Stages `request` in the kernel scratch buffer,
    /// invokes `kernel_dispatch`, copies the response back out.
    /// `caller_pid` identifies the originating user process (or
    /// [`KERNEL_PID`] for direct kernel-host-interface-internal calls).
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

    /// Run a thread-aware syscall. The host supplies `caller_tid`
    /// from trusted adapter state; guest request bytes are not allowed
    /// to identify the calling thread.
    pub fn thread_syscall(
        &mut self,
        method_id: u32,
        caller_pid: u32,
        caller_tid: u32,
        request: &[u8],
        response: &mut [u8],
    ) -> Result<i64> {
        if request.len() + response.len() > self.scratch_len as usize {
            return Err(anyhow!(
                "request+response ({} bytes) exceeds scratch capacity ({})",
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
                .context("write thread syscall request into kernel scratch")?;
        }
        let rc = self
            .dispatch_thread
            .call(
                &mut self.store,
                (
                    method_id, caller_pid, caller_tid, in_ptr, in_len, out_ptr, out_cap,
                ),
            )
            .context("kernel_dispatch_thread")?;
        if !response.is_empty() {
            self.memory
                .read(&self.store, out_ptr as usize, response)
                .context("read thread syscall response from kernel scratch")?;
        }
        Ok(rc)
    }

    pub fn list_processes(&mut self) -> Result<Vec<ProcessSnapshot>> {
        let rc = self
            .list_processes
            .call(&mut self.store, (self.scratch_ptr, self.scratch_len))
            .context("kernel_list_processes")?;
        if rc < 0 {
            anyhow::bail!("kernel_list_processes failed: rc={rc}");
        }
        let used = rc as usize;
        if used > self.scratch_len as usize {
            anyhow::bail!(
                "kernel_list_processes exceeded scratch capacity: used={used} cap={}",
                self.scratch_len
            );
        }
        let mut bytes = vec![0u8; used];
        self.memory
            .read(&self.store, self.scratch_ptr as usize, &mut bytes)
            .context("read kernel process snapshot")?;
        decode_process_list(&bytes)
    }

    pub fn list_threads(&mut self, pid: u32) -> Result<Vec<ThreadSnapshot>> {
        let rc = self
            .list_threads
            .call(&mut self.store, (pid, self.scratch_ptr, self.scratch_len))
            .context("kernel_list_threads")?;
        if rc < 0 {
            anyhow::bail!("kernel_list_threads failed: rc={rc}");
        }
        let used = rc as usize;
        if used > self.scratch_len as usize {
            anyhow::bail!(
                "kernel_list_threads exceeded scratch capacity: used={used} cap={}",
                self.scratch_len
            );
        }
        let mut bytes = vec![0u8; used];
        self.memory
            .read(&self.store, self.scratch_ptr as usize, &mut bytes)
            .context("read kernel thread snapshot")?;
        decode_thread_list(&bytes)
    }

    pub fn snapshot_kernel_state(&mut self) -> Result<Vec<u8>> {
        let rc = self
            .snapshot
            .call(&mut self.store, (self.scratch_ptr, self.scratch_len))
            .context("kernel_snapshot")?;
        if rc < 0 {
            anyhow::bail!("kernel_snapshot failed: rc={rc}");
        }
        let used = rc as usize;
        if used > self.scratch_len as usize {
            anyhow::bail!(
                "kernel_snapshot exceeded scratch capacity: used={used} cap={}",
                self.scratch_len
            );
        }
        let mut bytes = vec![0u8; used];
        self.memory
            .read(&self.store, self.scratch_ptr as usize, &mut bytes)
            .context("read kernel snapshot")?;
        Ok(bytes)
    }

    pub fn schedule_next(&mut self) -> Result<Option<ScheduleDecision>> {
        let rc = self
            .schedule_next
            .call(&mut self.store, (self.scratch_ptr, 24))
            .context("kernel_schedule_next")?;
        if rc == -EAGAIN {
            return Ok(None);
        }
        if rc < 0 {
            anyhow::bail!("kernel_schedule_next failed: rc={rc}");
        }
        if rc != 24 {
            anyhow::bail!("kernel_schedule_next malformed: rc={rc}");
        }
        let mut bytes = [0u8; 24];
        self.memory
            .read(&self.store, self.scratch_ptr as usize, &mut bytes)
            .context("read kernel schedule decision")?;
        Ok(Some(decode_schedule_decision(&bytes)))
    }

    pub fn spawn_thread(&mut self, pid: u32, host_thread_handle: i32) -> Result<u32> {
        let rc = self
            .spawn_thread
            .call(&mut self.store, (pid, host_thread_handle))
            .context("kernel_spawn_thread")?;
        if rc < 0 {
            anyhow::bail!("kernel_spawn_thread failed: rc={rc}");
        }
        Ok(rc as u32)
    }

    pub fn detach_thread(&mut self, pid: u32, tid: u32) -> Result<()> {
        let rc = self
            .detach_thread
            .call(&mut self.store, (pid, tid))
            .context("kernel_detach_thread")?;
        if rc != 0 {
            anyhow::bail!("kernel_detach_thread failed: rc={rc}");
        }
        Ok(())
    }

    pub fn record_thread_exit(&mut self, pid: u32, tid: u32, exit_value: i32) -> Result<()> {
        let rc = self
            .record_thread_exit
            .call(&mut self.store, (pid, tid, exit_value))
            .context("kernel_record_thread_exit")?;
        if rc != 0 {
            anyhow::bail!("kernel_record_thread_exit failed: rc={rc}");
        }
        Ok(())
    }

    pub fn record_thread_exit_authenticated(
        &mut self,
        pid: u32,
        tid: u32,
        host_thread_handle: i32,
        exit_value: u32,
    ) -> Result<()> {
        let rc = self
            .record_thread_exit_authenticated
            .call(&mut self.store, (pid, tid, host_thread_handle, exit_value))
            .context("kernel_record_thread_exit_authenticated")?;
        if rc != 0 {
            anyhow::bail!("kernel_record_thread_exit_authenticated failed: rc={rc}");
        }
        Ok(())
    }

    pub fn block_thread(&mut self, pid: u32, tid: u32) -> Result<()> {
        let rc = self
            .block_thread
            .call(&mut self.store, (pid, tid))
            .context("kernel_block_thread")?;
        if rc != 0 {
            anyhow::bail!("kernel_block_thread failed: rc={rc}");
        }
        Ok(())
    }

    pub fn unblock_thread(&mut self, pid: u32, tid: u32) -> Result<()> {
        let rc = self
            .unblock_thread
            .call(&mut self.store, (pid, tid))
            .context("kernel_unblock_thread")?;
        if rc != 0 {
            anyhow::bail!("kernel_unblock_thread failed: rc={rc}");
        }
        Ok(())
    }

    pub fn kill_process(&mut self, pid: u32, signal: u32) -> Result<i64> {
        self.kill
            .call(&mut self.store, (pid, signal))
            .context("kernel_kill")
    }

    pub fn wait_process(
        &mut self,
        caller_pid: u32,
        child_pid: u32,
        flags: u32,
    ) -> Result<WaitResult> {
        let rc = self
            .wait
            .call(
                &mut self.store,
                (caller_pid, child_pid, flags, self.scratch_ptr, 8),
            )
            .context("kernel_wait")?;
        if rc < 0 {
            anyhow::bail!("kernel_wait failed: rc={rc}");
        }
        if rc != 8 {
            anyhow::bail!("kernel_wait wrote unexpected size: {rc}");
        }
        let mut bytes = [0u8; 8];
        self.memory
            .read(&self.store, self.scratch_ptr as usize, &mut bytes)
            .context("read kernel wait result")?;
        Ok(WaitResult {
            pid: u32::from_le_bytes(bytes[0..4].try_into().expect("4 bytes")),
            status: i32::from_le_bytes(bytes[4..8].try_into().expect("4 bytes")),
        })
    }

    pub fn record_exit(&mut self, pid: u32, exit_status: i32) -> Result<i64> {
        self.record_exit
            .call(&mut self.store, (pid, exit_status))
            .context("kernel_record_exit")
    }

    pub fn drain_spawn(&mut self, response: &mut [u8]) -> Result<i64> {
        if response.len() > self.scratch_len as usize {
            anyhow::bail!(
                "drain_spawn response cap ({}) exceeds scratch capacity ({})",
                response.len(),
                self.scratch_len
            );
        }
        let rc = self
            .drain_spawn
            .call(&mut self.store, (self.scratch_ptr, response.len() as u32))
            .context("kernel_drain_spawn")?;
        if rc > 0 {
            let used = rc as usize;
            if used > response.len() {
                anyhow::bail!(
                    "kernel_drain_spawn wrote beyond response cap: used={used} cap={}",
                    response.len()
                );
            }
            self.memory
                .read(
                    &self.store,
                    self.scratch_ptr as usize,
                    &mut response[..used],
                )
                .context("read kernel pending spawn")?;
        }
        Ok(rc)
    }

    pub fn spawn_process(&mut self, parent_pid: u32, module_id: &[u8], argv: &[u8]) -> Result<i64> {
        if module_id.len() + argv.len() > self.scratch_len as usize {
            anyhow::bail!(
                "spawn request ({} bytes) exceeds scratch capacity ({})",
                module_id.len() + argv.len(),
                self.scratch_len
            );
        }
        let module_ptr = self.scratch_ptr;
        let argv_ptr = self.scratch_ptr + module_id.len() as u32;
        if !module_id.is_empty() {
            self.memory
                .write(&mut self.store, module_ptr as usize, module_id)
                .context("write spawn module id into kernel scratch")?;
        }
        if !argv.is_empty() {
            self.memory
                .write(&mut self.store, argv_ptr as usize, argv)
                .context("write spawn argv into kernel scratch")?;
        }
        self.spawn_process
            .call(
                &mut self.store,
                (
                    parent_pid,
                    module_ptr,
                    module_id.len() as u32,
                    argv_ptr,
                    argv.len() as u32,
                ),
            )
            .context("kernel_spawn_process")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessSnapshot {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: u32,
    pub sid: u32,
    pub state: &'static str,
    pub exit_status: Option<i32>,
    pub command: Vec<u8>,
    pub fds: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadSnapshot {
    pub tid: u32,
    pub state: &'static str,
    pub detached: bool,
    pub exit_value: Option<i32>,
    pub host_thread_handle: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScheduleDecision {
    pub pid: u32,
    pub tid: u32,
    pub host_thread_handle: Option<i32>,
    pub flags: u32,
    pub budget_ns: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WaitResult {
    pub pid: u32,
    pub status: i32,
}

fn decode_process_list(bytes: &[u8]) -> Result<Vec<ProcessSnapshot>> {
    if bytes.len() < 4 {
        anyhow::bail!("short process list");
    }
    let count = u32::from_le_bytes(bytes[0..4].try_into().expect("4 bytes")) as usize;
    let mut offset = 4usize;
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        if bytes.len() < offset + 25 {
            anyhow::bail!("truncated process list entry");
        }
        let pid = u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"));
        offset += 4;
        let ppid = u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"));
        offset += 4;
        let pgid = u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"));
        offset += 4;
        let sid = u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"));
        offset += 4;
        let state = match bytes[offset] {
            1 => "running",
            2 => "exited",
            other => anyhow::bail!("unknown process state byte: {other}"),
        };
        offset += 1;
        let raw_exit_status =
            i32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"));
        offset += 4;
        let command_len =
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes")) as usize;
        offset += 4;
        if bytes.len() < offset + command_len + 4 {
            anyhow::bail!("truncated process command");
        }
        let command = bytes[offset..offset + command_len].to_vec();
        offset += command_len;
        let fd_count =
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes")) as usize;
        offset += 4;
        if bytes.len() < offset + fd_count * 4 {
            anyhow::bail!("truncated process fd list");
        }
        let mut fds = Vec::with_capacity(fd_count);
        for _ in 0..fd_count {
            fds.push(u32::from_le_bytes(
                bytes[offset..offset + 4].try_into().expect("4 bytes"),
            ));
            offset += 4;
        }
        entries.push(ProcessSnapshot {
            pid,
            ppid,
            pgid,
            sid,
            state,
            exit_status: (state == "exited").then_some(raw_exit_status),
            command,
            fds,
        });
    }
    if offset != bytes.len() {
        anyhow::bail!("trailing bytes in process list");
    }
    Ok(entries)
}

fn decode_thread_list(bytes: &[u8]) -> Result<Vec<ThreadSnapshot>> {
    if bytes.len() < 4 {
        anyhow::bail!("short thread list");
    }
    let count = u32::from_le_bytes(bytes[0..4].try_into().expect("4 bytes")) as usize;
    let mut offset = 4usize;
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        if bytes.len() < offset + 16 {
            anyhow::bail!("truncated thread list entry");
        }
        let tid = u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"));
        offset += 4;
        let state = match bytes[offset] {
            1 => "runnable",
            2 => "blocked",
            3 => "exited",
            other => anyhow::bail!("unknown thread state byte: {other}"),
        };
        offset += 1;
        let detached = bytes[offset] != 0;
        offset += 3;
        let raw_exit_value =
            i32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"));
        offset += 4;
        let raw_host_thread_handle =
            i32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"));
        offset += 4;
        entries.push(ThreadSnapshot {
            tid,
            state,
            detached,
            exit_value: (state == "exited").then_some(raw_exit_value),
            host_thread_handle: (raw_host_thread_handle >= 0).then_some(raw_host_thread_handle),
        });
    }
    if offset != bytes.len() {
        anyhow::bail!("trailing bytes in thread list");
    }
    Ok(entries)
}

fn decode_schedule_decision(bytes: &[u8; 24]) -> ScheduleDecision {
    let pid = u32::from_le_bytes(bytes[0..4].try_into().expect("4 bytes"));
    let tid = u32::from_le_bytes(bytes[4..8].try_into().expect("4 bytes"));
    let raw_handle = i32::from_le_bytes(bytes[8..12].try_into().expect("4 bytes"));
    let flags = u32::from_le_bytes(bytes[12..16].try_into().expect("4 bytes"));
    let budget_ns = u64::from_le_bytes(bytes[16..24].try_into().expect("8 bytes"));
    ScheduleDecision {
        pid,
        tid,
        host_thread_handle: (raw_handle >= 0).then_some(raw_handle),
        flags,
        budget_ns,
    }
}

pub fn budget_ns_to_epoch_quantum(budget_ns: u64) -> u64 {
    budget_ns.div_ceil(1_000_000).max(1)
}

// ── KernelHostInterface: orchestrates the kernel and user processes ───────────────

pub struct KernelHostInterface {
    engine: Engine,
    kernel: Arc<Mutex<KernelInstance>>,
    process_engine: Arc<Mutex<CachedProcessEngine>>,
    next_anonymous_module_id: RefCell<u32>,
}

impl KernelHostInterface {
    /// Load `kernel.wasm` from `path` into a fresh wasmtime engine and
    /// instantiate it with the documented `kh_*` import surface.
    pub fn load(path: &Path, host_state: HostState) -> Result<Self> {
        let wasm = std::fs::read(path)
            .with_context(|| format!("read kernel.wasm at {}", path.display()))?;
        let mut config = Config::new();
        config.epoch_interruption(true);
        config.wasm_threads(true);
        let engine = Engine::new(&config).context("create wasmtime engine")?;
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
        let process_engine = store_data.host.process_engine.clone();
        let mut store = Store::new(&engine, store_data);
        store.set_epoch_deadline(DEFAULT_EPOCH_DEADLINE);
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
        let dispatch_thread = instance.get_typed_func::<(u32, u32, u32, u32, u32, u32, u32), i64>(
            &mut store,
            "kernel_dispatch_thread",
        )?;
        let list_processes =
            instance.get_typed_func::<(u32, u32), i64>(&mut store, "kernel_list_processes")?;
        let list_threads =
            instance.get_typed_func::<(u32, u32, u32), i64>(&mut store, "kernel_list_threads")?;
        let snapshot = instance.get_typed_func::<(u32, u32), i64>(&mut store, "kernel_snapshot")?;
        let schedule_next =
            instance.get_typed_func::<(u32, u32), i64>(&mut store, "kernel_schedule_next")?;
        let spawn_thread =
            instance.get_typed_func::<(u32, i32), i64>(&mut store, "kernel_spawn_thread")?;
        let detach_thread =
            instance.get_typed_func::<(u32, u32), i64>(&mut store, "kernel_detach_thread")?;
        let record_thread_exit = instance
            .get_typed_func::<(u32, u32, i32), i64>(&mut store, "kernel_record_thread_exit")?;
        let record_thread_exit_authenticated = instance
            .get_typed_func::<(u32, u32, i32, u32), i64>(
                &mut store,
                "kernel_record_thread_exit_authenticated",
            )?;
        let block_thread =
            instance.get_typed_func::<(u32, u32), i64>(&mut store, "kernel_block_thread")?;
        let unblock_thread =
            instance.get_typed_func::<(u32, u32), i64>(&mut store, "kernel_unblock_thread")?;
        let kill = instance.get_typed_func::<(u32, u32), i64>(&mut store, "kernel_kill")?;
        let wait =
            instance.get_typed_func::<(u32, u32, u32, u32, u32), i64>(&mut store, "kernel_wait")?;
        let record_exit =
            instance.get_typed_func::<(u32, i32), i64>(&mut store, "kernel_record_exit")?;
        let drain_spawn =
            instance.get_typed_func::<(u32, u32), i64>(&mut store, "kernel_drain_spawn")?;
        let spawn_process = instance
            .get_typed_func::<(u32, u32, u32, u32, u32), i64>(&mut store, "kernel_spawn_process")?;

        let kernel = KernelInstance {
            store,
            memory,
            scratch_ptr,
            scratch_len,
            dispatch,
            dispatch_thread,
            list_processes,
            list_threads,
            snapshot,
            schedule_next,
            spawn_thread,
            detach_thread,
            record_thread_exit,
            record_thread_exit_authenticated,
            block_thread,
            unblock_thread,
            kill,
            wait,
            record_exit,
            drain_spawn,
            spawn_process,
        };
        let kernel = Arc::new(Mutex::new(kernel));
        {
            let mut guard = kernel.lock().unwrap();
            if guard.store.data().host.thread_host.is_none() {
                guard.store.data_mut().host.thread_host = Some(Arc::new(WasmtimeThreadHost::new(
                    engine.clone(),
                    kernel.clone(),
                )));
            }
        }
        Ok(Self {
            engine,
            kernel,
            process_engine,
            next_anonymous_module_id: RefCell::new(0),
        })
    }

    /// Invoke a kernel syscall directly (no user process). The kernel
    /// sees `KERNEL_PID` (0) as the caller. Useful for tests and for
    /// operations that originate inside the kernel-host interface itself.
    pub fn syscall(&self, method_id: u32, request: &[u8], response: &mut [u8]) -> Result<i64> {
        self.kernel
            .lock()
            .unwrap()
            .syscall(method_id, KERNEL_PID, request, response)
    }

    pub fn thread_syscall(
        &self,
        method_id: u32,
        caller_pid: u32,
        caller_tid: u32,
        request: &[u8],
        response: &mut [u8],
    ) -> Result<i64> {
        self.kernel
            .lock()
            .unwrap()
            .thread_syscall(method_id, caller_pid, caller_tid, request, response)
    }

    /// Return the kernel-owned process snapshot. The wasmtime adapter
    /// decodes the binary record for embedders, but the process table
    /// itself lives in kernel.wasm.
    pub fn list_processes(&self) -> Result<Vec<ProcessSnapshot>> {
        self.kernel.lock().unwrap().list_processes()
    }

    /// Return the kernel-owned thread snapshot for one process.
    pub fn list_threads(&self, pid: u32) -> Result<Vec<ThreadSnapshot>> {
        self.kernel.lock().unwrap().list_threads(pid)
    }

    /// Return the versioned binary kernel-state snapshot envelope.
    pub fn snapshot_kernel_state(&self) -> Result<Vec<u8>> {
        self.kernel.lock().unwrap().snapshot_kernel_state()
    }

    /// Ask kernel.wasm which runnable thread should resume next. The returned
    /// budget is engine-neutral; wasmtime translates it into epoch/fuel policy.
    pub fn schedule_next(&self) -> Result<Option<ScheduleDecision>> {
        self.kernel.lock().unwrap().schedule_next()
    }

    /// Register a host-created thread in kernel-owned state.
    pub fn spawn_thread(&self, pid: u32, host_thread_handle: i32) -> Result<u32> {
        self.kernel
            .lock()
            .unwrap()
            .spawn_thread(pid, host_thread_handle)
    }

    pub fn detach_thread(&self, pid: u32, tid: u32) -> Result<()> {
        self.kernel.lock().unwrap().detach_thread(pid, tid)
    }

    pub fn record_thread_exit(&self, pid: u32, tid: u32, exit_value: i32) -> Result<()> {
        self.kernel
            .lock()
            .unwrap()
            .record_thread_exit(pid, tid, exit_value)
    }

    pub fn record_thread_exit_authenticated(
        &self,
        pid: u32,
        tid: u32,
        host_thread_handle: i32,
        exit_value: u32,
    ) -> Result<()> {
        self.kernel
            .lock()
            .unwrap()
            .record_thread_exit_authenticated(pid, tid, host_thread_handle, exit_value)
    }

    pub fn block_thread(&self, pid: u32, tid: u32) -> Result<()> {
        self.kernel.lock().unwrap().block_thread(pid, tid)
    }

    pub fn unblock_thread(&self, pid: u32, tid: u32) -> Result<()> {
        self.kernel.lock().unwrap().unblock_thread(pid, tid)
    }

    /// Route signal delivery through kernel.wasm's host-control export.
    pub fn kill_process(&self, pid: u32, signal: u32) -> Result<i64> {
        self.kernel.lock().unwrap().kill_process(pid, signal)
    }

    /// Wait/reap through kernel.wasm's host-control export.
    pub fn wait_process(&self, caller_pid: u32, child_pid: u32, flags: u32) -> Result<WaitResult> {
        self.kernel
            .lock()
            .unwrap()
            .wait_process(caller_pid, child_pid, flags)
    }

    pub fn cache_process_module(&self, module_id: &[u8], wasm: &[u8]) -> Result<()> {
        if module_id.is_empty() {
            anyhow::bail!("module id must not be empty");
        }
        self.process_engine
            .lock()
            .unwrap()
            .cache_module(module_id, wasm);
        Ok(())
    }

    pub fn spawn_cached_user_process<S: AsRef<[u8]>>(
        &self,
        parent_pid: u32,
        module_id: &[u8],
        argv: &[S],
    ) -> Result<UserProcess> {
        let argv_request = encode_argv_records(argv);
        let pid =
            self.kernel
                .lock()
                .unwrap()
                .spawn_process(parent_pid, module_id, &argv_request)?;
        if pid < 0 {
            anyhow::bail!("kernel_spawn_process failed: rc={pid}");
        }
        let pid = pid as u32;
        let spawn = self
            .process_engine
            .lock()
            .unwrap()
            .take_pending(pid)
            .ok_or_else(|| anyhow!("kh_spawn_process did not publish pid {pid}"))?;
        self.instantiate_with_pid(pid, &spawn.wasm, spawn.argv)
    }

    /// Invoke a kernel syscall as a specific caller pid. Used by
    /// tests that need to exercise per-process state (sys_wait
    /// reaping a child of pid 1, /proc/self resolution, etc.)
    /// without spinning up a real user process.
    pub fn syscall_as(
        &self,
        caller_pid: u32,
        method_id: u32,
        request: &[u8],
        response: &mut [u8],
    ) -> Result<i64> {
        self.kernel
            .lock()
            .unwrap()
            .syscall(method_id, caller_pid, request, response)
    }

    /// Install a file blob into kernel.wasm's in-memory ramfs at
    /// `path`, replacing any existing content. Phase 2 ramfs is
    /// read-only from userland; this is the only way bytes get in
    /// today. Real `open(O_CREAT | O_WRONLY)` from user processes
    /// arrives with the OFD registry.
    pub fn register_ramfs_file(&self, path: &[u8], content: &[u8]) -> Result<()> {
        let mut req = Vec::with_capacity(4 + path.len() + content.len());
        req.extend_from_slice(&(path.len() as u32).to_le_bytes());
        req.extend_from_slice(path);
        req.extend_from_slice(content);
        let rc = self.syscall(METHOD_KERNEL_REGISTER_FILE, &req, &mut [])?;
        if rc != 0 {
            anyhow::bail!("kernel_register_file failed: rc={rc}");
        }
        Ok(())
    }

    /// Mount a [`HostFsBackend`] at `prefix`. Embedders pick the
    /// prefix — `/host`, `/users/user`, `/`, anywhere their workload
    /// expects the host fs to live. Pair with
    /// `HostState.host_fs_root` (the disk root) and a
    /// `PolicyEnforcer.may_open_path` impl to control which paths
    /// are accessible.
    pub fn mount_host_fs(&self, prefix: &[u8]) -> Result<()> {
        if prefix.is_empty() {
            anyhow::bail!("mount_host_fs: prefix must not be empty");
        }
        let rc = self.syscall(METHOD_KERNEL_INSTALL_HOST_FS_MOUNT, prefix, &mut [])?;
        if rc != 0 {
            anyhow::bail!("kernel_install_host_fs_mount failed: rc={rc}");
        }
        Ok(())
    }

    /// Spawn a child user-process linked to `parent_pid`. Same as
    /// `spawn_user_process_with_args` but registers the parent/child
    /// relationship in the kernel; the parent's `sys_wait` finds
    /// the child once it exits. Use `record_exit` after the child
    /// runs to completion to make wait return the status.
    pub fn spawn_child<S: AsRef<[u8]>>(
        &self,
        parent_pid: u32,
        wasm: &[u8],
        argv: &[S],
    ) -> Result<UserProcess> {
        let module_id = self.cache_anonymous_process_module(wasm)?;
        self.spawn_cached_user_process(parent_pid, &module_id, argv)
    }

    /// Record a process's exit status with the kernel so its
    /// parent's `sys_wait` can reap it. Embedders typically call
    /// this after a `UserProcess::run_start` returns (extracting
    /// the exit code from the proc_exit trap).
    pub fn record_exit(&self, pid: u32, exit_status: i32) -> Result<()> {
        let rc = self.kernel.lock().unwrap().record_exit(pid, exit_status)?;
        if rc != 0 {
            anyhow::bail!("kernel_record_exit failed: rc={rc}");
        }
        Ok(())
    }

    /// Drain the next sys_spawn-staged child from the kernel, if
    /// any. Returns Ok(Some(record)) when a spawn is waiting,
    /// Ok(None) when the queue is empty. The embedder typically
    /// calls this in a loop after each parent syscall and
    /// instantiates each child via `spawn_child` + run-to-
    /// completion + `record_exit`.
    pub fn drain_pending_spawn(&self) -> Result<Option<PendingSpawn>> {
        let mut buf = vec![0u8; self.kernel.lock().unwrap().scratch_len as usize];
        let rc = self.kernel.lock().unwrap().drain_spawn(&mut buf)?;
        if rc == -2 {
            return Ok(None); // -ENOENT: queue empty
        }
        if rc < 0 {
            anyhow::bail!("kernel_drain_spawn failed: rc={rc}");
        }
        let used = rc as usize;
        if used > buf.len() {
            anyhow::bail!(
                "kernel_drain_spawn record exceeds scratch capacity: used={used} cap={}",
                buf.len()
            );
        }
        if used < 8 {
            anyhow::bail!("kernel_drain_spawn returned malformed record (len={used})");
        }
        let child_pid = u32::from_le_bytes(buf[0..4].try_into().expect("4 bytes"));
        let wasm_len = u32::from_le_bytes(buf[4..8].try_into().expect("4 bytes")) as usize;
        if 8 + wasm_len + 4 > used {
            anyhow::bail!("kernel_drain_spawn record truncated at wasm body");
        }
        let wasm = buf[8..8 + wasm_len].to_vec();
        let mut cur = 8 + wasm_len;
        let argc = u32::from_le_bytes(buf[cur..cur + 4].try_into().expect("4 bytes")) as usize;
        cur += 4;
        let mut argv = Vec::with_capacity(argc);
        for _ in 0..argc {
            if cur + 4 > used {
                anyhow::bail!("kernel_drain_spawn argv header truncated");
            }
            let alen = u32::from_le_bytes(buf[cur..cur + 4].try_into().expect("4 bytes")) as usize;
            cur += 4;
            if cur + alen > used {
                anyhow::bail!("kernel_drain_spawn argv body truncated");
            }
            argv.push(buf[cur..cur + alen].to_vec());
            cur += alen;
        }
        Ok(Some(PendingSpawn {
            child_pid,
            wasm,
            argv,
        }))
    }

    /// Mount a YURTFS L1+L2 overlay at `prefix`. The image bytes
    /// (uncompressed tar) become the read-only lower layer; a fresh
    /// in-memory ramfs is the writable upper layer. Reads fall
    /// through to the image; writes go to the overlay; first write
    /// of a lower-only file copy-ups so the image content is
    /// preserved at the upper inode.
    ///
    /// Phase 6 surface — uncompressed tar only, ramfs upper, no
    /// whiteouts, no metadata copy-up. Future slices: zstd-wrapped
    /// images, disk-backed indexfs upper for persistence,
    /// MetadataOverlay sidecar.
    pub fn mount_yurtfs(&self, prefix: &[u8], image_tar: &[u8]) -> Result<()> {
        if prefix.is_empty() {
            anyhow::bail!("mount_yurtfs: prefix must not be empty");
        }
        let mut req = Vec::with_capacity(4 + prefix.len() + image_tar.len());
        req.extend_from_slice(&(prefix.len() as u32).to_le_bytes());
        req.extend_from_slice(prefix);
        req.extend_from_slice(image_tar);
        let rc = self.syscall(METHOD_KERNEL_INSTALL_YURTFS, &req, &mut [])?;
        if rc != 0 {
            anyhow::bail!("kernel_install_yurtfs failed: rc={rc}");
        }
        Ok(())
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
        let module_id = self.cache_anonymous_process_module(wasm)?;
        self.spawn_cached_user_process(0, &module_id, argv)
    }

    /// Build a UserProcess with an explicit pid (used by
    /// `run_pending_spawns` so the host's instance pid matches the
    /// kernel-side pid that sys_spawn allocated). Same setup as
    /// `spawn_user_process_with_args` modulo the pid source.
    fn instantiate_with_pid(
        &self,
        pid: u32,
        wasm: &[u8],
        argv: Vec<Vec<u8>>,
    ) -> Result<UserProcess> {
        let module = Module::new(&self.engine, wasm).context("compile user-process wasm")?;
        let mut linker: Linker<UserState> = Linker::new(&self.engine);
        register_sys_imports(&mut linker)?;
        register_yurt_thread_imports(&mut linker)?;
        crate::wasi_shim::add_to_linker(&mut linker)
            .context("install WASI preview1 shim on user-process linker")?;
        let shared_memory = imported_shared_memory_type(&module)
            .map(|ty| SharedMemory::new(&self.engine, ty))
            .transpose()
            .context("create imported shared memory")?;

        let thread_argv = argv.clone();
        let user_state = UserState {
            kernel: self.kernel.clone(),
            pid,
            caller_tid: 1,
            argv,
            dir_fds: std::collections::BTreeMap::new(),
            last_exit: None,
            last_scheduler_budget_ns: None,
            last_scheduler_epoch_quantum: None,
        };
        let mut store = Store::new(&self.engine, user_state);
        store.set_epoch_deadline(DEFAULT_EPOCH_DEADLINE);
        if let Some(memory) = shared_memory.clone() {
            define_imported_shared_memory(&module, &mut linker, &store, memory)?;
        }
        let instance = linker
            .instantiate(&mut store, &module)
            .context("instantiate user-process wasm")?;
        if let Some(thread_host) = self
            .kernel
            .lock()
            .unwrap()
            .store
            .data()
            .host
            .thread_host
            .as_ref()
        {
            thread_host.register_process(
                pid,
                Arc::<[u8]>::from(wasm.to_vec()),
                thread_argv,
                shared_memory,
            );
        }
        Ok(UserProcess {
            store,
            instance,
            pid,
        })
    }

    fn cache_anonymous_process_module(&self, wasm: &[u8]) -> Result<Vec<u8>> {
        let mut next = self.next_anonymous_module_id.borrow_mut();
        let module_id = format!("anonymous:{}", *next).into_bytes();
        *next = next.saturating_add(1);
        drop(next);
        self.cache_process_module(&module_id, wasm)?;
        Ok(module_id)
    }

    /// Drain every staged sys_spawn child, instantiate it with the
    /// kernel-allocated pid, run it to completion, and call
    /// `record_exit` so the parent's `sys_wait` can reap it.
    /// Returns the number of children actually run. Embedders
    /// typically call this in a loop after each parent syscall (or
    /// in a fixed-cadence drain) — without it, sys_spawn-staged
    /// children never run.
    pub fn run_pending_spawns(&self) -> Result<usize> {
        let mut count = 0usize;
        while let Some(spawn) = self.drain_pending_spawn()? {
            let mut child = self.instantiate_with_pid(spawn.child_pid, &spawn.wasm, spawn.argv)?;
            // run_start traps when the child calls proc_exit; the
            // shim stashes the exit code in UserState first. A
            // clean return (non-WASI exit) leaves last_exit None,
            // which we report as 0.
            let _ = child.run_start();
            let exit = child.last_exit().unwrap_or(0);
            self.record_exit(spawn.child_pid, exit)?;
            count += 1;
        }
        Ok(count)
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

/// One sys_spawn-staged child waiting for the host to instantiate
/// and run it. Returned from [`KernelHostInterface::drain_pending_spawn`].
pub struct PendingSpawn {
    pub child_pid: u32,
    pub wasm: Vec<u8>,
    pub argv: Vec<Vec<u8>>,
}

fn encode_argv_records<S: AsRef<[u8]>>(argv: &[S]) -> Vec<u8> {
    let mut out = Vec::with_capacity(argv.iter().map(|a| 4 + a.as_ref().len()).sum());
    for arg in argv {
        let bytes = arg.as_ref();
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

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
/// Note on argv: keeping it in host-interface-side state for now is
/// fine — the kernel's process tree is not tracking argv yet. Once
/// `sys_spawn` lands and the kernel allocates pids itself, argv
/// migrates into `Process` so it's preserved across exec.
pub struct UserState {
    pub kernel: Arc<Mutex<KernelInstance>>,
    pub pid: u32,
    pub caller_tid: u32,
    pub argv: Vec<Vec<u8>>,
    /// fd → absolute path, populated on every successful `path_open`
    /// and cleared on `fd_close`. Used by the WASI `fd_readdir` shim
    /// to translate a directory fd back into a path it can pass to
    /// `sys_readdir` on the kernel side. Storing the path here (not
    /// the kernel) keeps the kernel's OFD surface unchanged — the
    /// shim is the one that needs the path-key, not the kernel.
    pub dir_fds: std::collections::BTreeMap<i32, Vec<u8>>,
    /// Last `proc_exit` code the process passed before the WASI
    /// shim trapped. The trap message is the only signal that
    /// reaches the embedder otherwise; this side-channel gives a
    /// typed exit code to `run_pending_spawns` so it can call
    /// `record_exit` without parsing the trap string.
    pub last_exit: Option<i32>,
    /// Last kernel scheduler budget applied to this wasmtime Store.
    /// Observability only; the kernel owns the policy.
    pub last_scheduler_budget_ns: Option<u64>,
    /// Wasmtime-specific mechanism derived from `last_scheduler_budget_ns`.
    /// This stays host-local and is not exposed through the kernel ABI.
    pub last_scheduler_epoch_quantum: Option<u64>,
}

impl yurt_kernel_host_interface_core::HasCallerPid for UserState {
    fn caller_pid(&self) -> u32 {
        self.pid
    }
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

    /// Exit code the process passed to `proc_exit`, if it called
    /// proc_exit (which the WASI shim turns into a trap). Returns
    /// None for processes that returned normally from `_start` or
    /// haven't run yet.
    pub fn last_exit(&self) -> Option<i32> {
        self.store.data().last_exit
    }

    pub fn apply_schedule_decision(&mut self, decision: ScheduleDecision) -> Result<bool> {
        if decision.pid != self.pid {
            return Ok(false);
        }
        let quantum = budget_ns_to_epoch_quantum(decision.budget_ns);
        self.store.set_epoch_deadline(quantum);
        let state = self.store.data_mut();
        state.last_scheduler_budget_ns = Some(decision.budget_ns);
        state.last_scheduler_epoch_quantum = Some(quantum);
        Ok(true)
    }

    pub fn last_scheduler_budget_ns(&self) -> Option<u64> {
        self.store.data().last_scheduler_budget_ns
    }

    pub fn last_scheduler_epoch_quantum(&self) -> Option<u64> {
        self.store.data().last_scheduler_epoch_quantum
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
        let len =
            checked_guest_buffer_len(len).map_err(|rc| anyhow!("read_memory failed: {rc}"))?;
        if let Some(memory) = self.instance.get_memory(&mut self.store, "memory") {
            let mut buf = vec![0u8; len];
            memory
                .read(&self.store, addr as usize, &mut buf)
                .context("read user-process memory")?;
            return Ok(buf);
        }
        if let Some(memory) = self.instance.get_shared_memory(&mut self.store, "memory") {
            return read_shared_memory(memory, addr, len);
        }
        anyhow::bail!("user-process missing 'memory' export")
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
// Trampoline helpers (`forward_*`, `trampoline_request*`) live in
// `yurt_kernel_host_interface_core` now — they're engine-agnostic. We re-export
// the two `pub` ones the WASI shim uses for backwards compatibility.
pub use yurt_kernel_host_interface_core::{trampoline_request, trampoline_request_with_response};

// ── Linker registration ──────────────────────────────────────────────────────

fn thread_syscall_from_user(
    caller: &mut Caller<'_, UserState>,
    method_id: u32,
    request: &[u8],
    response: &mut [u8],
) -> i64 {
    let kernel = caller.data().kernel.clone();
    let pid = caller.data().pid;
    let tid = caller.data().caller_tid;
    let rc = match kernel
        .lock()
        .unwrap()
        .thread_syscall(method_id, pid, tid, request, response)
    {
        Ok(rc) => rc,
        Err(_) => -EIO,
    };
    rc
}

fn register_yurt_thread_imports(linker: &mut Linker<UserState>) -> Result<()> {
    linker.func_wrap(
        YURT_NAMESPACE,
        "host_thread_spawn",
        |mut caller: Caller<'_, UserState>, fn_ptr: i32, arg: i32| -> i32 {
            let mut request = Vec::with_capacity(8);
            request.extend_from_slice(&(fn_ptr as u32).to_le_bytes());
            request.extend_from_slice(&(arg as u32).to_le_bytes());
            thread_syscall_from_user(&mut caller, sys_method_id::THREAD_SPAWN, &request, &mut [])
                as i32
        },
    )?;
    linker.func_wrap(
        YURT_NAMESPACE,
        "host_thread_self",
        |mut caller: Caller<'_, UserState>| -> i32 {
            thread_syscall_from_user(&mut caller, sys_method_id::THREAD_SELF, &[], &mut []) as i32
        },
    )?;
    linker.func_wrap(
        YURT_NAMESPACE,
        "host_thread_join",
        |mut caller: Caller<'_, UserState>, tid: i32, out_retval_ptr: u32| -> i32 {
            let request = (tid as u32).to_le_bytes();
            let mut response = [0u8; 4];
            let mut rc = thread_syscall_from_user(
                &mut caller,
                sys_method_id::THREAD_JOIN,
                &request,
                &mut response,
            );
            let mut waiting_as_registered_joiner = rc == -EAGAIN;
            while rc == -EAGAIN || (waiting_as_registered_joiner && rc == -EBUSY) {
                thread::sleep(std::time::Duration::from_millis(1));
                rc = thread_syscall_from_user(
                    &mut caller,
                    sys_method_id::THREAD_JOIN,
                    &request,
                    &mut response,
                );
                waiting_as_registered_joiner |= rc == -EAGAIN;
            }
            if rc != 0 {
                return rc as i32;
            }
            if write_user_guest_bytes(&mut caller, out_retval_ptr, &response).is_err() {
                return -(EFAULT as i32);
            }
            0
        },
    )?;
    linker.func_wrap(
        YURT_NAMESPACE,
        "host_thread_detach",
        |mut caller: Caller<'_, UserState>, tid: i32| -> i32 {
            let request = (tid as u32).to_le_bytes();
            thread_syscall_from_user(&mut caller, sys_method_id::THREAD_DETACH, &request, &mut [])
                as i32
        },
    )?;
    linker.func_wrap(
        YURT_NAMESPACE,
        "host_thread_exit",
        |mut caller: Caller<'_, UserState>, retval: i32| -> Result<()> {
            let request = (retval as u32).to_le_bytes();
            let _ = thread_syscall_from_user(
                &mut caller,
                sys_method_id::THREAD_EXIT,
                &request,
                &mut [],
            );
            Err(anyhow!("thread exited"))
        },
    )?;
    linker.func_wrap(
        YURT_NAMESPACE,
        "host_thread_yield",
        |mut caller: Caller<'_, UserState>| -> i32 {
            thread_syscall_from_user(&mut caller, sys_method_id::THREAD_YIELD, &[], &mut []) as i32
        },
    )?;
    Ok(())
}

/// Read a kernel-supplied path slice out of kernel.wasm memory.
/// Returns the bytes verbatim — no rooting, no canonicalization;
/// each [`HostFsImpl`] decides how to interpret them.
fn read_path(
    caller: &mut Caller<'_, KernelStoreData>,
    path_ptr: u32,
    path_len: u32,
) -> std::result::Result<Vec<u8>, i32> {
    read_kernel_guest_bytes(caller, path_ptr, path_len).map_err(|rc| rc as i32)
}

fn host_io_errno(e: std::io::Error) -> i32 {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => -ENOENT as i32,
        PermissionDenied => -EACCES as i32,
        AlreadyExists => -17_i32,     // -EEXIST
        DirectoryNotEmpty => -39_i32, // -ENOTEMPTY
        _ => -EFAULT as i32,
    }
}

fn register_kh_imports(linker: &mut Linker<KernelStoreData>) -> Result<()> {
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_now_realtime",
        |mut caller: Caller<'_, KernelStoreData>, out_ptr: u32| -> i32 {
            // Policy gate: privacy-sensitive embedders may refuse
            // wall-clock access. Default policy is Allow.
            if caller.data().host.policy.may_get_realtime() == PolicyDecision::Deny {
                return -(EACCES as i32);
            }
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
            let buf = match read_kernel_guest_bytes(&mut caller, msg_ptr, msg_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let sink = caller.data().host.log_sink.clone();
            let policy = caller.data().host.policy.clone();
            if let Ok(s) = std::str::from_utf8(&buf) {
                // Policy gate fires per message so embedders can
                // suppress noisy severities or specific content.
                if policy.may_log(severity, s) == PolicyDecision::Allow {
                    sink.emit(severity, s);
                }
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
            let memory = match kernel_memory(&mut caller) {
                Ok(m) => m,
                Err(rc) => return rc,
            };
            let request = match read_kernel_guest_bytes(&mut caller, req_ptr, req_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            // Policy gate: embedders that don't trust extension
            // requests inspect the bytes here. Returning Deny short-
            // circuits the registry call with -EACCES.
            if caller.data().host.policy.may_invoke_extension(&request) == PolicyDecision::Deny {
                return -EACCES;
            }
            let out_cap = match checked_guest_buffer_len(out_cap) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut response = vec![0u8; out_cap];
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
    // ── Real-disk host FS imports ──────────────────────────────────
    //
    // kh_real_open / kh_real_read / kh_real_close back the
    // HostFsBackend in kernel.wasm. Each open is double-gated:
    //   1. HostState.host_fs_root must be Some (no root → EACCES).
    //   2. PolicyEnforcer.may_open_path must Allow.
    // The relative path the kernel sends is joined against the root
    // and canonicalized; results that escape the root via `..`
    // traversal are rejected. fd handles are u31 (positive i32)
    // tracked by the host_fs HostFsImpl; the trait's close removes
    // the entry. All routing — local disk, OPFS, S3, in-memory —
    // goes through HostState.host_fs.
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_real_open",
        |mut caller: Caller<'_, KernelStoreData>,
         path_ptr: u32,
         path_len: u32,
         flags: u32,
         _mode: u32|
         -> i32 {
            let path = match read_path(&mut caller, path_ptr, path_len) {
                Ok(p) => p,
                Err(rc) => return rc,
            };
            let writable = flags & 0b001 != 0;
            if caller.data().host.policy.may_open_path(&path, writable) == PolicyDecision::Deny {
                return -(EACCES as i32);
            }
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return -(EACCES as i32),
            };
            fs.open(&path, flags)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_real_read",
        |mut caller: Caller<'_, KernelStoreData>, fd: i32, out_ptr: u32, len: u32| -> i64 {
            let memory = match kernel_memory(&mut caller) {
                Ok(m) => m,
                Err(rc) => return rc,
            };
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return -EBADF,
            };
            let len = match checked_guest_buffer_len(len) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut buf = vec![0u8; len];
            let n = fs.read(fd, &mut buf);
            if n > 0
                && memory
                    .write(&mut caller, out_ptr as usize, &buf[..n as usize])
                    .is_err()
            {
                return -EFAULT;
            }
            n
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_real_write",
        |mut caller: Caller<'_, KernelStoreData>, fd: i32, data_ptr: u32, data_len: u32| -> i64 {
            let buf = match read_kernel_guest_bytes(&mut caller, data_ptr, data_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return -EBADF,
            };
            fs.write(fd, &buf)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_real_close",
        |caller: Caller<'_, KernelStoreData>, fd: i32| -> i32 {
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return 0,
            };
            fs.close(fd)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_real_stat",
        |mut caller: Caller<'_, KernelStoreData>,
         path_ptr: u32,
         path_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i64 {
            if (out_cap as usize) < 32 {
                return -EINVAL;
            }
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            let path = match read_path(&mut caller, path_ptr, path_len) {
                Ok(p) => p,
                Err(rc) => return rc as i64,
            };
            if caller.data().host.policy.may_open_path(&path, false) == PolicyDecision::Deny {
                return -EACCES;
            }
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return -EACCES,
            };
            let stat = match fs.stat(&path) {
                Ok(s) => s,
                Err(rc) => return rc as i64,
            };
            // kh_stat_v1: u16 version + u16 _pad + u32 mode +
            // u64 size + u64 mtime_ns + u8 is_dir + u8 is_symlink +
            // u8[6] _reserved = 32 bytes total.
            let mut buf = [0u8; 32];
            buf[0..2].copy_from_slice(&1_u16.to_le_bytes());
            buf[4..8].copy_from_slice(&stat.mode.to_le_bytes());
            buf[8..16].copy_from_slice(&stat.size.to_le_bytes());
            buf[16..24].copy_from_slice(&stat.mtime_ns.to_le_bytes());
            buf[24] = if stat.is_dir { 1 } else { 0 };
            buf[25] = if stat.is_symlink { 1 } else { 0 };
            if memory.write(&mut caller, out_ptr as usize, &buf).is_err() {
                return -EFAULT;
            }
            32
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_real_unlink",
        |mut caller: Caller<'_, KernelStoreData>, path_ptr: u32, path_len: u32| -> i32 {
            let path = match read_path(&mut caller, path_ptr, path_len) {
                Ok(p) => p,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_open_path(&path, true) == PolicyDecision::Deny {
                return -(EACCES as i32);
            }
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return -(EACCES as i32),
            };
            fs.unlink(&path)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_real_mkdir",
        |mut caller: Caller<'_, KernelStoreData>, path_ptr: u32, path_len: u32, mode: u32| -> i32 {
            let path = match read_path(&mut caller, path_ptr, path_len) {
                Ok(p) => p,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_open_path(&path, true) == PolicyDecision::Deny {
                return -(EACCES as i32);
            }
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return -(EACCES as i32),
            };
            fs.mkdir(&path, mode)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_real_symlink",
        |mut caller: Caller<'_, KernelStoreData>,
         target_ptr: u32,
         target_len: u32,
         link_ptr: u32,
         link_len: u32|
         -> i32 {
            // Read both byte ranges from kernel memory; target is
            // verbatim symlink content, link is a path subject to
            // the policy gate.
            let target = match read_kernel_guest_bytes(&mut caller, target_ptr, target_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let link_path = match read_path(&mut caller, link_ptr, link_len) {
                Ok(p) => p,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_open_path(&link_path, true) == PolicyDecision::Deny {
                return -(EACCES as i32);
            }
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return -(EACCES as i32),
            };
            fs.symlink(&target, &link_path)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_real_rename",
        |mut caller: Caller<'_, KernelStoreData>,
         old_ptr: u32,
         old_len: u32,
         new_ptr: u32,
         new_len: u32|
         -> i32 {
            let old_path = match read_path(&mut caller, old_ptr, old_len) {
                Ok(p) => p,
                Err(rc) => return rc,
            };
            let new_path = match read_path(&mut caller, new_ptr, new_len) {
                Ok(p) => p,
                Err(rc) => return rc,
            };
            let policy = caller.data().host.policy.clone();
            if policy.may_open_path(&old_path, true) == PolicyDecision::Deny
                || policy.may_open_path(&new_path, true) == PolicyDecision::Deny
            {
                return -(EACCES as i32);
            }
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return -(EACCES as i32),
            };
            fs.rename(&old_path, &new_path)
        },
    )?;

    // ── kh_socket_* (outbound TCP) ─────────────────────────────────
    //
    // connect: decode POSIX sockaddr bytes, consult may_connect, delegate
    // to HostState.tcp. send/recv/close pass the host handle through.
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_connect",
        |mut caller: Caller<'_, KernelStoreData>,
         addr_ptr: u32,
         addr_len: u32,
         flags: u32|
         -> i32 {
            let addr = match read_kernel_guest_bytes(&mut caller, addr_ptr, addr_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let (host, port) = match decode_ipv4_sockaddr(&addr) {
                Ok(addr) => addr,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_connect(&host, port) == PolicyDecision::Deny {
                return -EACCES as i32;
            }
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EACCES as i32,
            };
            tcp.connect(&host, port, flags)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_send",
        |mut caller: Caller<'_, KernelStoreData>,
         handle: i32,
         data_ptr: u32,
         data_len: u32|
         -> i64 {
            let buf = match read_kernel_guest_bytes(&mut caller, data_ptr, data_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_socket_io(handle, true) == PolicyDecision::Deny {
                return -EACCES;
            }
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EBADF,
            };
            tcp.send(handle, &buf)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_recv",
        |mut caller: Caller<'_, KernelStoreData>,
         handle: i32,
         out_ptr: u32,
         len: u32,
         flags: u32|
         -> i64 {
            let memory = match kernel_memory(&mut caller) {
                Ok(m) => m,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_socket_io(handle, false) == PolicyDecision::Deny {
                return -EACCES;
            }
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EBADF,
            };
            let len = match checked_guest_buffer_len(len) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut buf = vec![0u8; len];
            let n = tcp.recv(handle, &mut buf, flags);
            if n > 0
                && memory
                    .write(&mut caller, out_ptr as usize, &buf[..n as usize])
                    .is_err()
            {
                return -EFAULT;
            }
            n
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_close",
        |caller: Caller<'_, KernelStoreData>, handle: i32| -> i32 {
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return 0,
            };
            tcp.close(handle)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_listen_at",
        |mut caller: Caller<'_, KernelStoreData>,
         addr_ptr: u32,
         addr_len: u32,
         backlog: u32|
         -> i32 {
            let addr = match read_kernel_guest_bytes(&mut caller, addr_ptr, addr_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let (host, port) = match decode_ipv4_sockaddr(&addr) {
                Ok(addr) => addr,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_listen(port) == PolicyDecision::Deny {
                return -EACCES as i32;
            }
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EACCES as i32,
            };
            tcp.listen(&host, port, backlog)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_accept_blocking",
        |caller: Caller<'_, KernelStoreData>, handle: i32, flags: u32| -> i32 {
            if caller.data().host.policy.may_accept_socket(handle) == PolicyDecision::Deny {
                return -EACCES as i32;
            }
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EBADF as i32,
            };
            tcp.accept(handle, flags)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_local_addr",
        |mut caller: Caller<'_, KernelStoreData>, handle: i32, out_ptr: u32, out_cap: u32| -> i64 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            if caller.data().host.policy.may_socket_addr(handle, false) == PolicyDecision::Deny {
                return -EACCES;
            }
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EBADF,
            };
            let (host, port) = match tcp.local_addr(handle) {
                Some(p) => p,
                None => return -EBADF,
            };
            let buf = socket_addr_record(&host, port);
            let need = buf.len();
            if (need as u32) > out_cap {
                return -E2BIG;
            }
            if memory.write(&mut caller, out_ptr as usize, &buf).is_err() {
                return -EFAULT;
            }
            need as i64
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_peer_addr",
        |mut caller: Caller<'_, KernelStoreData>, handle: i32, out_ptr: u32, out_cap: u32| -> i64 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            if caller.data().host.policy.may_socket_addr(handle, true) == PolicyDecision::Deny {
                return -EACCES;
            }
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EBADF,
            };
            let (host, port) = match tcp.peer_addr(handle) {
                Some(p) => p,
                None => return -EBADF,
            };
            let buf = socket_addr_record(&host, port);
            let need = buf.len();
            if (need as u32) > out_cap {
                return -E2BIG;
            }
            if memory.write(&mut caller, out_ptr as usize, &buf).is_err() {
                return -EFAULT;
            }
            need as i64
        },
    )?;

    // ── kh_idb_* (durable KV) ───────────────────────────────────────
    //
    // get/put/delete/list against HostState.kv. Each call is gated
    // by may_idb(store, write). Browsers point kv at IndexedDB;
    // native deployments at disk or InMemoryKv.
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_idb_get",
        |mut caller: Caller<'_, KernelStoreData>,
         store_ptr: u32,
         store_len: u32,
         key_ptr: u32,
         key_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i64 {
            let memory = match kernel_memory(&mut caller) {
                Ok(m) => m,
                Err(rc) => return rc,
            };
            let store = match read_kernel_guest_bytes(&mut caller, store_ptr, store_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            let key = match read_kernel_guest_bytes(&mut caller, key_ptr, key_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_idb(&store, false) == PolicyDecision::Deny {
                return -EACCES;
            }
            let kv = match caller.data().host.kv.clone() {
                Some(k) => k,
                None => return -EACCES,
            };
            let value = match kv.get(&store, &key) {
                Ok(v) => v,
                Err(rc) => return rc as i64,
            };
            if (value.len() as u32) > out_cap {
                return -E2BIG;
            }
            if memory.write(&mut caller, out_ptr as usize, &value).is_err() {
                return -EFAULT;
            }
            value.len() as i64
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_idb_put",
        |mut caller: Caller<'_, KernelStoreData>,
         store_ptr: u32,
         store_len: u32,
         key_ptr: u32,
         key_len: u32,
         value_ptr: u32,
         value_len: u32|
         -> i32 {
            let store = match read_kernel_guest_bytes(&mut caller, store_ptr, store_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let key = match read_kernel_guest_bytes(&mut caller, key_ptr, key_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let value = match read_kernel_guest_bytes(&mut caller, value_ptr, value_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            if caller.data().host.policy.may_idb(&store, true) == PolicyDecision::Deny {
                return -EACCES as i32;
            }
            let kv = match caller.data().host.kv.clone() {
                Some(k) => k,
                None => return -EACCES as i32,
            };
            kv.put(&store, &key, &value)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_idb_delete",
        |mut caller: Caller<'_, KernelStoreData>,
         store_ptr: u32,
         store_len: u32,
         key_ptr: u32,
         key_len: u32|
         -> i32 {
            let store = match read_kernel_guest_bytes(&mut caller, store_ptr, store_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let key = match read_kernel_guest_bytes(&mut caller, key_ptr, key_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            if caller.data().host.policy.may_idb(&store, true) == PolicyDecision::Deny {
                return -EACCES as i32;
            }
            let kv = match caller.data().host.kv.clone() {
                Some(k) => k,
                None => return -EACCES as i32,
            };
            kv.delete(&store, &key)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_idb_list",
        |mut caller: Caller<'_, KernelStoreData>,
         store_ptr: u32,
         store_len: u32,
         prefix_ptr: u32,
         prefix_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i64 {
            let memory = match kernel_memory(&mut caller) {
                Ok(m) => m,
                Err(rc) => return rc,
            };
            let store = match read_kernel_guest_bytes(&mut caller, store_ptr, store_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            let prefix = match read_kernel_guest_bytes(&mut caller, prefix_ptr, prefix_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_idb(&store, false) == PolicyDecision::Deny {
                return -EACCES;
            }
            let kv = match caller.data().host.kv.clone() {
                Some(k) => k,
                None => return -EACCES,
            };
            let keys = kv.list(&store, &prefix);
            let out_cap_len = match checked_guest_buffer_len(out_cap) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            // Pack count + (len, bytes)*. Stop early when out of room.
            let mut buf: Vec<u8> = Vec::with_capacity(out_cap_len);
            buf.extend_from_slice(&0u32.to_le_bytes());
            let mut count: u32 = 0;
            for k in &keys {
                let need = 4 + k.len();
                if buf.len() + need > out_cap_len {
                    break;
                }
                buf.extend_from_slice(&(k.len() as u32).to_le_bytes());
                buf.extend_from_slice(k);
                count += 1;
            }
            buf[0..4].copy_from_slice(&count.to_le_bytes());
            if memory.write(&mut caller, out_ptr as usize, &buf).is_err() {
                return -EFAULT;
            }
            buf.len() as i64
        },
    )?;

    // ── kh_fetch_blocking ──────────────────────────────────────────
    // Sync wrapper around `network::fetch`. Reads request bytes
    // from kernel memory, drives the async fetch on a shared
    // tokio runtime, writes the response bytes back. Policy gate
    // fires on the request bytes; deny → -EACCES.
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_fetch_blocking",
        |mut caller: Caller<'_, KernelStoreData>,
         req_ptr: u32,
         req_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i64 {
            let memory = match kernel_memory(&mut caller) {
                Ok(m) => m,
                Err(rc) => return rc,
            };
            let request = match read_kernel_guest_bytes(&mut caller, req_ptr, req_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            if caller.data().host.policy.may_fetch(&request) == PolicyDecision::Deny {
                return -EACCES;
            }
            let response = match run_fetch_blocking(request) {
                Ok(response) => response,
                Err(rc) => return rc,
            };
            let bytes = response.as_slice();
            if (bytes.len() as u32) > out_cap {
                return -E2BIG;
            }
            if memory.write(&mut caller, out_ptr as usize, bytes).is_err() {
                return -EFAULT;
            }
            bytes.len() as i64
        },
    )?;

    // ── Wasm engine ops ────────────────────────────────────────────
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_spawn_process",
        |mut caller: Caller<'_, KernelStoreData>,
         module_id_ptr: u32,
         module_id_len: u32,
         context_ptr: u32,
         context_len: u32|
         -> i32 {
            let module_id = match read_kernel_guest_bytes(&mut caller, module_id_ptr, module_id_len)
            {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let context = match read_kernel_guest_bytes(&mut caller, context_ptr, context_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            if caller
                .data()
                .host
                .policy
                .may_spawn_process(&module_id, &context)
                == PolicyDecision::Deny
            {
                return -EACCES as i32;
            }
            caller
                .data()
                .host
                .process_engine
                .lock()
                .unwrap()
                .spawn(&module_id, &context)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_destroy_instance",
        |caller: Caller<'_, KernelStoreData>, handle: i32| -> i32 {
            caller
                .data()
                .host
                .process_engine
                .lock()
                .unwrap()
                .destroy(handle)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_process_mem_read",
        |caller: Caller<'_, KernelStoreData>,
         handle: i32,
         _addr: u32,
         _dst_ptr: u32,
         _len: u32|
         -> i64 {
            if caller.data().host.policy.may_process_memory(handle, false) == PolicyDecision::Deny {
                return -EACCES;
            }
            -ENOSYS
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_process_mem_write",
        |caller: Caller<'_, KernelStoreData>,
         handle: i32,
         _addr: u32,
         _src_ptr: u32,
         _len: u32|
         -> i64 {
            if caller.data().host.policy.may_process_memory(handle, true) == PolicyDecision::Deny {
                return -EACCES;
            }
            -ENOSYS
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_process_resume",
        |caller: Caller<'_, KernelStoreData>, handle: i32, _result: i64, _budget_ns: u64| -> i64 {
            if caller.data().host.policy.may_resume_process(handle) == PolicyDecision::Deny {
                return -EACCES;
            }
            -ENOSYS
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_thread_spawn",
        |caller: Caller<'_, KernelStoreData>, pid: u32, tid: u32, fn_ptr: u32, arg: u32| {
            let Some(thread_host) = caller.data().host.thread_host.as_ref() else {
                return -ENOSYS as i32;
            };
            thread_host.spawn(pid, tid, fn_ptr, arg)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_thread_release",
        |caller: Caller<'_, KernelStoreData>, host_thread_handle: i32| {
            let Some(thread_host) = caller.data().host.thread_host.as_ref() else {
                return 0_i32;
            };
            thread_host.release(host_thread_handle)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_thread_cancel",
        |caller: Caller<'_, KernelStoreData>, host_thread_handle: i32| {
            let Some(thread_host) = caller.data().host.thread_host.as_ref() else {
                return 0_i32;
            };
            thread_host.cancel(host_thread_handle)
        },
    )?;

    Ok(())
}

/// Wires the `sys_*` import surface user processes link against. Each
/// import forwards into `kernel_dispatch` with the appropriate method
/// id from `yurt_abi_methods.toml`. The wasm import names match the architectural reality: these are syscalls.
fn register_sys_imports(linker: &mut Linker<UserState>) -> Result<()> {
    // Trampoline helpers are now in `kernel-host-interface-core` — they're
    // engine-agnostic and shared by every native engine impl. The
    // `register_sys_imports` body just wires the typed wasmtime
    // closures to those helpers.
    use yurt_kernel_host_interface_core::{
        forward_request_bytes, forward_request_with_user_response, forward_response_to_user,
        forward_scalar, forward_u32_arg, forward_user_ptr_len, trampoline_request_with_response,
    };

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getuid",
        |mut caller: Caller<'_, UserState>| -> i32 {
            forward_scalar(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETUID,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_geteuid",
        |mut caller: Caller<'_, UserState>| -> i32 {
            forward_scalar(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETEUID,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getgid",
        |mut caller: Caller<'_, UserState>| -> i32 {
            forward_scalar(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETGID,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getegid",
        |mut caller: Caller<'_, UserState>| -> i32 {
            forward_scalar(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETEGID,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getpid",
        |mut caller: Caller<'_, UserState>| -> i32 {
            forward_scalar(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETPID,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getppid",
        |mut caller: Caller<'_, UserState>| -> i32 {
            forward_scalar(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETPPID,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_umask",
        |mut caller: Caller<'_, UserState>, mask: i32| -> i32 {
            forward_u32_arg(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::UMASK,
                mask as u32,
            )
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
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SETRESUID,
                &req,
            ) as i32
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
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SETRESGID,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getpriority",
        |mut caller: Caller<'_, UserState>, which: i32, who: i32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(which as u32).to_le_bytes());
            req.extend_from_slice(&(who as u32).to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETPRIORITY,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_setpriority",
        |mut caller: Caller<'_, UserState>, which: i32, who: i32, nice: i32| -> i32 {
            let mut req = Vec::with_capacity(12);
            req.extend_from_slice(&(which as u32).to_le_bytes());
            req.extend_from_slice(&(who as u32).to_le_bytes());
            req.extend_from_slice(&nice.to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SETPRIORITY,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_chdir",
        |mut caller: Caller<'_, UserState>, path_ptr: u32, path_len: u32| -> i32 {
            forward_user_ptr_len(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::CHDIR,
                path_ptr,
                path_len,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getcwd",
        |mut caller: Caller<'_, UserState>, out_ptr: u32, out_cap: u32| -> i32 {
            forward_response_to_user(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETCWD,
                out_ptr,
                out_cap,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getrlimit",
        |mut caller: Caller<'_, UserState>, resource: i32, out_ptr: u32| -> i32 {
            let req = (resource as u32).to_le_bytes();
            let rc = forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
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
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SETRLIMIT,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_extension_invoke",
        |mut caller: Caller<'_, UserState>,
         req_ptr: u32,
         req_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i64 {
            let req = match read_user_guest_bytes(&mut caller, req_ptr, req_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::EXTENSION_INVOKE,
                &req,
                out_ptr,
                out_cap,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_close",
        |mut caller: Caller<'_, UserState>, fd: i32| -> i32 {
            forward_u32_arg(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::CLOSE,
                fd as u32,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_dup",
        |mut caller: Caller<'_, UserState>, oldfd: i32| -> i32 {
            forward_u32_arg(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::DUP,
                oldfd as u32,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_dup2",
        |mut caller: Caller<'_, UserState>, oldfd: i32, newfd: i32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(oldfd as u32).to_le_bytes());
            req.extend_from_slice(&(newfd as u32).to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::DUP2,
                &req,
            ) as i32
        },
    )?;
    // POSIX `pipe(int fd[2])`: caller provides a 2-int buffer, kernel
    // fills (read_fd, write_fd). Returns 0 on success / negated errno.
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_pipe",
        |mut caller: Caller<'_, UserState>, out_ptr: u32| -> i32 {
            let rc = forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
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
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
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
            let payload = match read_user_guest_bytes(&mut caller, buf_ptr, count) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = Vec::with_capacity(4 + payload.len());
            req.extend_from_slice(&(fd as u32).to_le_bytes());
            req.extend_from_slice(&payload);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::WRITE,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_poll",
        |mut caller: Caller<'_, UserState>, fds_ptr: u32, nfds: i32, timeout_ms: i32| -> i32 {
            if nfds < 0 {
                return -(EINVAL as i32);
            }
            let len = match (nfds as usize).checked_mul(8) {
                Some(n) => n,
                None => return -(EINVAL as i32),
            };
            if len > MAX_GUEST_BUFFER_LEN as usize {
                return -E2BIG as i32;
            }
            let user_memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -(EFAULT as i32),
            };
            let mut fds = vec![0u8; len];
            if len > 0
                && user_memory
                    .read(&caller, fds_ptr as usize, &mut fds)
                    .is_err()
            {
                return -(EFAULT as i32);
            }
            let mut req = Vec::with_capacity(4 + fds.len());
            req.extend_from_slice(&timeout_ms.to_le_bytes());
            req.extend_from_slice(&fds);
            let mut response = vec![0u8; len];
            let pid = caller.data().pid;
            let kernel = caller.data().kernel.clone();
            let rc = {
                let mut kernel = kernel.lock().unwrap();
                match kernel.syscall(sys_method_id::POLL, pid, &req, &mut response) {
                    Ok(rc) => rc,
                    Err(_) => return -(EFAULT as i32),
                }
            };
            if rc >= 0
                && len > 0
                && user_memory
                    .write(&mut caller, fds_ptr as usize, &response)
                    .is_err()
            {
                return -(EFAULT as i32);
            }
            rc as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_isatty",
        |mut caller: Caller<'_, UserState>, fd: i32| -> i32 {
            forward_u32_arg(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::ISATTY,
                fd as u32,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_clock_gettime",
        |mut caller: Caller<'_, UserState>, clock_id: i32, out_ptr: u32| -> i32 {
            let req = (clock_id as u32).to_le_bytes();
            let rc = forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
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
            forward_u32_arg(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETPGID,
                pid as u32,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_setpgid",
        |mut caller: Caller<'_, UserState>, pid: i32, pgid: i32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(pid as u32).to_le_bytes());
            req.extend_from_slice(&(pgid as u32).to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SETPGID,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_getsid",
        |mut caller: Caller<'_, UserState>, pid: i32| -> i32 {
            forward_u32_arg(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::GETSID,
                pid as u32,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_setsid",
        |mut caller: Caller<'_, UserState>| -> i32 {
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SETSID,
                &[],
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_kill",
        |mut caller: Caller<'_, UserState>, pid: i32, sig: i32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(pid as u32).to_le_bytes());
            req.extend_from_slice(&(sig as u32).to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::KILL,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_killpg",
        |mut caller: Caller<'_, UserState>, pgid: i32, sig: i32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(pgid as u32).to_le_bytes());
            req.extend_from_slice(&(sig as u32).to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::KILLPG,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_sigaction",
        |mut caller: Caller<'_, UserState>, sig: i32, disposition: i32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(sig as u32).to_le_bytes());
            req.extend_from_slice(&(disposition as u32).to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SIGACTION,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_sched_yield",
        |mut caller: Caller<'_, UserState>| -> i32 {
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SCHED_YIELD,
                &[],
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_sched_getscheduler",
        |mut caller: Caller<'_, UserState>, pid: i32| -> i32 {
            forward_u32_arg(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SCHED_GETSCHEDULER,
                pid as u32,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_sched_getparam",
        |mut caller: Caller<'_, UserState>, pid: i32| -> i32 {
            forward_u32_arg(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SCHED_GETPARAM,
                pid as u32,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_sched_setscheduler",
        |mut caller: Caller<'_, UserState>, pid: i32, policy: i32, priority: i32| -> i32 {
            let mut req = Vec::with_capacity(12);
            req.extend_from_slice(&(pid as u32).to_le_bytes());
            req.extend_from_slice(&policy.to_le_bytes());
            req.extend_from_slice(&priority.to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SCHED_SETSCHEDULER,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_sched_setparam",
        |mut caller: Caller<'_, UserState>, pid: i32, priority: i32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(pid as u32).to_le_bytes());
            req.extend_from_slice(&priority.to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SCHED_SETPARAM,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_nanosleep",
        |mut caller: Caller<'_, UserState>, ns: i64| -> i32 {
            let req = (ns as u64).to_le_bytes();
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::NANOSLEEP,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_open",
        |mut caller: Caller<'_, UserState>, flags: i32, path_ptr: u32, path_len: u32| -> i32 {
            // Read the path bytes out of user memory and prepend
            // u32 flags LE as the wire format expects.
            let path = match read_user_guest_bytes(&mut caller, path_ptr, path_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = Vec::with_capacity(4 + path.len());
            req.extend_from_slice(&(flags as u32).to_le_bytes());
            req.extend_from_slice(&path);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::OPEN,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_lseek",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         offset: i64,
         whence: i32,
         out_ptr: u32|
         -> i32 {
            let mut req = Vec::with_capacity(16);
            req.extend_from_slice(&(fd as u32).to_le_bytes());
            req.extend_from_slice(&offset.to_le_bytes());
            req.extend_from_slice(&(whence as u32).to_le_bytes());
            let rc = forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::LSEEK,
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
        "sys_fstat",
        |mut caller: Caller<'_, UserState>, fd: i32, out_ptr: u32| -> i32 {
            let req = (fd as u32).to_le_bytes();
            let rc = forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::FSTAT,
                &req,
                out_ptr,
                16,
            );
            if rc == 16 {
                0
            } else {
                rc as i32
            }
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_chmod",
        |mut caller: Caller<'_, UserState>, mode: i32, path_ptr: u32, path_len: u32| -> i32 {
            let path = match read_user_guest_bytes(&mut caller, path_ptr, path_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = Vec::with_capacity(4 + path.len());
            req.extend_from_slice(&(mode as u32).to_le_bytes());
            req.extend_from_slice(&path);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::CHMOD,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_chown",
        |mut caller: Caller<'_, UserState>,
         uid: i32,
         gid: i32,
         path_ptr: u32,
         path_len: u32|
         -> i32 {
            let path = match read_user_guest_bytes(&mut caller, path_ptr, path_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = Vec::with_capacity(8 + path.len());
            req.extend_from_slice(&(uid as u32).to_le_bytes());
            req.extend_from_slice(&(gid as u32).to_le_bytes());
            req.extend_from_slice(&path);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::CHOWN,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_utimens",
        |mut caller: Caller<'_, UserState>, mtime_ns: i64, path_ptr: u32, path_len: u32| -> i32 {
            let path = match read_user_guest_bytes(&mut caller, path_ptr, path_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = Vec::with_capacity(8 + path.len());
            req.extend_from_slice(&(mtime_ns as u64).to_le_bytes());
            req.extend_from_slice(&path);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::UTIMENS,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_unlink",
        |mut caller: Caller<'_, UserState>, path_ptr: u32, path_len: u32| -> i32 {
            forward_user_ptr_len(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::UNLINK,
                path_ptr,
                path_len,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_stat",
        |mut caller: Caller<'_, UserState>, path_ptr: u32, path_len: u32, out_ptr: u32| -> i32 {
            let path = match read_user_guest_bytes(&mut caller, path_ptr, path_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let rc = forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::STAT,
                &path,
                out_ptr,
                16,
            );
            if rc == 16 {
                0
            } else {
                rc as i32
            }
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_symlink",
        |mut caller: Caller<'_, UserState>,
         target_ptr: u32,
         target_len: u32,
         link_ptr: u32,
         link_len: u32|
         -> i32 {
            let target = match read_user_guest_bytes(&mut caller, target_ptr, target_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let link = match read_user_guest_bytes(&mut caller, link_ptr, link_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = Vec::with_capacity(4 + target.len() + link.len());
            req.extend_from_slice(&target_len.to_le_bytes());
            req.extend_from_slice(&target);
            req.extend_from_slice(&link);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SYMLINK,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_readlink",
        |mut caller: Caller<'_, UserState>,
         path_ptr: u32,
         path_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i32 {
            let path = match read_user_guest_bytes(&mut caller, path_ptr, path_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::READLINK,
                &path,
                out_ptr,
                out_cap,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_mkdir",
        |mut caller: Caller<'_, UserState>, path_ptr: u32, path_len: u32| -> i32 {
            forward_user_ptr_len(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::MKDIR,
                path_ptr,
                path_len,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_rmdir",
        |mut caller: Caller<'_, UserState>, path_ptr: u32, path_len: u32| -> i32 {
            forward_user_ptr_len(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::RMDIR,
                path_ptr,
                path_len,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_readdir",
        |mut caller: Caller<'_, UserState>,
         path_ptr: u32,
         path_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i32 {
            let path = match read_user_guest_bytes(&mut caller, path_ptr, path_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::READDIR,
                &path,
                out_ptr,
                out_cap,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_wait",
        |mut caller: Caller<'_, UserState>, child_pid: i32, flags: i32, out_ptr: u32| -> i32 {
            let mut req = Vec::with_capacity(8);
            req.extend_from_slice(&(child_pid as u32).to_le_bytes());
            req.extend_from_slice(&(flags as u32).to_le_bytes());
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::WAIT,
                &req,
                out_ptr,
                8,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_link",
        |mut caller: Caller<'_, UserState>,
         target_ptr: u32,
         target_len: u32,
         link_ptr: u32,
         link_len: u32|
         -> i32 {
            let target = match read_user_guest_bytes(&mut caller, target_ptr, target_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let link = match read_user_guest_bytes(&mut caller, link_ptr, link_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = Vec::with_capacity(4 + target.len() + link.len());
            req.extend_from_slice(&target_len.to_le_bytes());
            req.extend_from_slice(&target);
            req.extend_from_slice(&link);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::LINK,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_rename",
        |mut caller: Caller<'_, UserState>,
         old_ptr: u32,
         old_len: u32,
         new_ptr: u32,
         new_len: u32|
         -> i32 {
            let old_path = match read_user_guest_bytes(&mut caller, old_ptr, old_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let new_path = match read_user_guest_bytes(&mut caller, new_ptr, new_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = Vec::with_capacity(4 + old_path.len() + new_path.len());
            req.extend_from_slice(&old_len.to_le_bytes());
            req.extend_from_slice(&old_path);
            req.extend_from_slice(&new_path);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::RENAME,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_spawn",
        |mut caller: Caller<'_, UserState>, req_ptr: u32, req_len: u32| -> i32 {
            let req = match read_user_guest_bytes(&mut caller, req_ptr, req_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SPAWN,
                &req,
            ) as i32
        },
    )?;

    // ── Networking + KV imports for user processes ──────────────────
    //
    // These wrap the sys_fetch / sys_socket_* / sys_idb_* methods so
    // libc-shaped userland (BusyBox, Python, zsh) reaches them under
    // the same `env` namespace as every other sys_* call. Each one
    // copies request bytes out of user memory, dispatches via the
    // shared trampoline helpers, and copies any response bytes back.

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_fetch",
        |mut caller: Caller<'_, UserState>,
         req_ptr: u32,
         req_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i64 {
            let req = match read_user_guest_bytes(&mut caller, req_ptr, req_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::FETCH,
                &req,
                out_ptr,
                out_cap,
            )
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_connect",
        |mut caller: Caller<'_, UserState>, fd: i32, addr_ptr: u32, addr_len: u32| -> i32 {
            let addr = match read_user_guest_bytes(&mut caller, addr_ptr, addr_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&addr);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_CONNECT,
                &req,
            ) as i32
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_send",
        |mut caller: Caller<'_, UserState>, fd: i32, data_ptr: u32, data_len: u32| -> i64 {
            let data = match read_user_guest_bytes(&mut caller, data_ptr, data_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&data);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_SEND,
                &req,
            )
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_recv",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         out_ptr: u32,
         out_cap: u32,
         flags: i32|
         -> i64 {
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&(flags as u32).to_le_bytes());
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_RECV,
                &req,
                out_ptr,
                out_cap,
            )
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_close",
        |mut caller: Caller<'_, UserState>, fd: i32| -> i32 {
            let req = (fd as u32).to_le_bytes();
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_CLOSE,
                &req,
            ) as i32
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socketpair",
        |mut caller: Caller<'_, UserState>,
         family: i32,
         sock_type: i32,
         flags: i32,
         out_ptr: u32|
         -> i32 {
            let mut req = [0u8; 8];
            req[0] = family as u8;
            req[1] = sock_type as u8;
            req[4..8].copy_from_slice(&(flags as u32).to_le_bytes());
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKETPAIR,
                &req,
                out_ptr,
                8,
            ) as i32
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_open",
        |mut caller: Caller<'_, UserState>, family: i32, sock_type: i32, flags: i32| -> i32 {
            let mut req = [0u8; 8];
            req[0] = family as u8;
            req[1] = sock_type as u8;
            req[4..8].copy_from_slice(&(flags as u32).to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_OPEN,
                &req,
            ) as i32
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_bind",
        |mut caller: Caller<'_, UserState>, fd: i32, addr_ptr: u32, addr_len: u32| -> i32 {
            let addr = match read_user_guest_bytes(&mut caller, addr_ptr, addr_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&addr);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_BIND,
                &req,
            ) as i32
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_option",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         option: i32,
         has_value: i32,
         value: i32|
         -> i32 {
            let mut req = Vec::with_capacity(16);
            req.extend_from_slice(&(fd as u32).to_le_bytes());
            req.extend_from_slice(&(option as u32).to_le_bytes());
            req.extend_from_slice(&(has_value as u32).to_le_bytes());
            req.extend_from_slice(&value.to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_OPTION,
                &req,
            ) as i32
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_sendto",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         data_ptr: u32,
         data_len: u32,
         flags: i32,
         addr_ptr: u32,
         addr_len: u32|
         -> i64 {
            let data = match read_user_guest_bytes(&mut caller, data_ptr, data_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            let addr = match read_user_guest_bytes(&mut caller, addr_ptr, addr_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&(flags as u32).to_le_bytes());
            req.extend_from_slice(&addr_len.to_le_bytes());
            req.extend_from_slice(&addr);
            req.extend_from_slice(&data);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_SENDTO,
                &req,
            )
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_sendmsg",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         data_ptr: u32,
         data_len: u32,
         fds_ptr: u32,
         fds_count: u32|
         -> i64 {
            let data = match read_user_guest_bytes(&mut caller, data_ptr, data_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            let fds_len = match fds_count.checked_mul(4) {
                Some(len) => len,
                None => return -E2BIG,
            };
            let fds = match read_user_guest_bytes(&mut caller, fds_ptr, fds_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&data_len.to_le_bytes());
            req.extend_from_slice(&fds_count.to_le_bytes());
            req.extend_from_slice(&data);
            req.extend_from_slice(&fds);
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_SENDMSG,
                &req,
            )
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_recvmsg",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         out_ptr: u32,
         out_cap: u32,
         fds_ptr: u32,
         fds_cap: u32,
         n_fds_ptr: u32|
         -> i64 {
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&0u32.to_le_bytes());
            req.extend_from_slice(&out_cap.to_le_bytes());
            let fds_bytes = match fds_cap.checked_mul(4) {
                Some(n) => n,
                None => return -E2BIG,
            };
            let response_len = match checked_guest_buffer_sum(&[out_cap, 4, fds_bytes]) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let out_cap_len = match checked_guest_buffer_len(out_cap) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut response = vec![0u8; response_len];
            let rc = trampoline_request_with_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_RECVMSG,
                &req,
                &mut response,
            );
            if rc < 0 {
                return rc;
            }
            let memory = match user_memory(&mut caller) {
                Ok(m) => m,
                Err(rc) => return rc,
            };
            let rc_len = match usize::try_from(rc) {
                Ok(n) if n <= out_cap_len => n,
                _ => return -EFAULT,
            };
            if rc > 0
                && memory
                    .write(&mut caller, out_ptr as usize, &response[..rc_len])
                    .is_err()
            {
                return -EFAULT;
            }
            let rights = &response[out_cap_len..];
            let n_fds = u32::from_le_bytes(rights[0..4].try_into().expect("fd count"));
            let copy_fds = n_fds.min(fds_cap);
            if copy_fds > 0
                && memory
                    .write(
                        &mut caller,
                        fds_ptr as usize,
                        &rights[4..4 + copy_fds as usize * 4],
                    )
                    .is_err()
            {
                return -EFAULT;
            }
            if memory
                .write(&mut caller, n_fds_ptr as usize, &copy_fds.to_le_bytes())
                .is_err()
            {
                return -EFAULT;
            }
            rc
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_info",
        |mut caller: Caller<'_, UserState>, fd: i32, out_ptr: u32| -> i64 {
            let req = (fd as u32).to_le_bytes();
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_INFO,
                &req,
                out_ptr,
                24,
            )
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_recvfrom",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         out_ptr: u32,
         data_cap: u32,
         path_ptr: u32,
         path_cap: u32,
         flags: i32|
         -> i64 {
            let path_bytes = match checked_guest_buffer_len(path_cap) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let response_len = match checked_guest_buffer_sum(&[data_cap, 8, path_cap]) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let data_len = match checked_guest_buffer_len(data_cap) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&(flags as u32).to_le_bytes());
            req.extend_from_slice(&data_cap.to_le_bytes());
            req.extend_from_slice(&path_cap.to_le_bytes());
            let mut response = vec![0u8; response_len];
            let rc = trampoline_request_with_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_RECVFROM,
                &req,
                &mut response,
            );
            if rc < 0 {
                return rc;
            }
            let memory = match user_memory(&mut caller) {
                Ok(m) => m,
                Err(rc) => return rc,
            };
            let data_written = match usize::try_from(rc) {
                Ok(n) if n <= data_len => n,
                _ => return -EFAULT,
            };
            if data_written > 0
                && memory
                    .write(&mut caller, out_ptr as usize, &response[..data_written])
                    .is_err()
            {
                return -EFAULT;
            }
            let meta_offset = data_len;
            let path_offset = meta_offset + 8;
            let path_len = u32::from_le_bytes(
                response[meta_offset..meta_offset + 4]
                    .try_into()
                    .expect("path len"),
            );
            let path_copy = (path_len as usize).min(path_bytes);
            if path_copy > 0
                && memory
                    .write(
                        &mut caller,
                        path_ptr as usize,
                        &response[path_offset..path_offset + path_copy],
                    )
                    .is_err()
            {
                return -EFAULT;
            }
            rc
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_listen",
        |mut caller: Caller<'_, UserState>, fd: i32, backlog: i32| -> i32 {
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&(backlog as u32).to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_LISTEN,
                &req,
            ) as i32
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_accept",
        |mut caller: Caller<'_, UserState>, fd: i32, flags: i32| -> i32 {
            let mut req = (fd as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&(flags as u32).to_le_bytes());
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_ACCEPT,
                &req,
            ) as i32
        },
    )?;

    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_socket_addr",
        |mut caller: Caller<'_, UserState>, fd: i32, out_ptr: u32, out_cap: u32| -> i64 {
            let req = (fd as u32).to_le_bytes();
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::SOCKET_ADDR,
                &req,
                out_ptr,
                out_cap,
            )
        },
    )?;

    // sys_idb_* — request bytes are already the native wire format
    // (u8 store_len + store + key/prefix or key+value). Userland
    // packs the request; we just shuttle bytes.
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_idb_get",
        |mut caller: Caller<'_, UserState>,
         req_ptr: u32,
         req_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i64 {
            let req = match read_user_guest_bytes(&mut caller, req_ptr, req_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::IDB_GET,
                &req,
                out_ptr,
                out_cap,
            )
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_idb_put",
        |mut caller: Caller<'_, UserState>, req_ptr: u32, req_len: u32| -> i32 {
            let req = match read_user_guest_bytes(&mut caller, req_ptr, req_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::IDB_PUT,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_idb_delete",
        |mut caller: Caller<'_, UserState>, req_ptr: u32, req_len: u32| -> i32 {
            let req = match read_user_guest_bytes(&mut caller, req_ptr, req_len) {
                Ok(buf) => buf,
                Err(rc) => return rc as i32,
            };
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::IDB_DELETE,
                &req,
            ) as i32
        },
    )?;
    linker.func_wrap(
        SYS_NAMESPACE,
        "sys_idb_list",
        |mut caller: Caller<'_, UserState>,
         req_ptr: u32,
         req_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i64 {
            let req = match read_user_guest_bytes(&mut caller, req_ptr, req_len) {
                Ok(buf) => buf,
                Err(rc) => return rc,
            };
            forward_request_with_user_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::IDB_LIST,
                &req,
                out_ptr,
                out_cap,
            )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_buffer_lengths_are_capped_before_allocation() {
        assert_eq!(checked_guest_buffer_len(0), Ok(0));
        assert_eq!(
            checked_guest_buffer_len(MAX_GUEST_BUFFER_LEN),
            Ok(MAX_GUEST_BUFFER_LEN as usize)
        );
        assert_eq!(
            checked_guest_buffer_len(MAX_GUEST_BUFFER_LEN + 1),
            Err(-E2BIG)
        );
    }

    #[test]
    fn guest_buffer_sum_checks_overflow_and_cap() {
        assert_eq!(checked_guest_buffer_sum(&[4, 8, 16]), Ok(28));
        assert_eq!(
            checked_guest_buffer_sum(&[MAX_GUEST_BUFFER_LEN - 4, 4]),
            Ok(MAX_GUEST_BUFFER_LEN as usize)
        );
        assert_eq!(
            checked_guest_buffer_sum(&[MAX_GUEST_BUFFER_LEN, 1]),
            Err(-E2BIG)
        );
        assert_eq!(checked_guest_buffer_sum(&[u32::MAX, 1]), Err(-E2BIG));
    }

    #[test]
    fn fetch_executor_uses_a_bounded_shared_worker_queue() {
        let cap = fetch_executor_queue_capacity_for_tests();
        assert!(cap > 0);
        assert!(cap <= 128);
    }
}
