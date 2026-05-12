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
const EACCES: i64 = 13;
const EBADF: i64 = 9;
const EINVAL: i64 = 22;
const ENOSYS: i64 = 38;

/// Public re-export so the engine adapter (`engine::WasmtimeCtx`)
/// can return the same EFAULT value our trampoline uses internally.
pub(crate) const EFAULT_PUB: i64 = EFAULT;

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
    pub const KILL: u32 = 0x1_001B;
    pub const SIGACTION: u32 = 0x1_001C;
    pub const SCHED_YIELD: u32 = 0x1_001D;
    pub const NANOSLEEP: u32 = 0x1_001E;
    pub const OPEN: u32 = 0x1_001F;
    pub const LSEEK: u32 = 0x1_0020;
    pub const FSTAT: u32 = 0x1_0021;
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
const METHOD_KERNEL_REGISTER_FILE: u32 = 8;
const METHOD_KERNEL_SET_ARGV: u32 = 9;
const METHOD_KERNEL_INSTALL_HOST_FS_MOUNT: u32 = 11;
const METHOD_KERNEL_INSTALL_YURTFS: u32 = 12;
const METHOD_KERNEL_REGISTER_CHILD: u32 = 13;
const METHOD_KERNEL_RECORD_EXIT: u32 = 14;
const METHOD_KERNEL_DRAIN_SPAWN: u32 = 15;

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
/// kernel.wasm is about to reach the outside world. The microkernel
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

    /// Gate outbound HTTP fetches. `request` is the JSON document
    /// the kernel forwarded — embedders inspect the URL, method,
    /// or headers and Allow/Deny. Default: Allow.
    fn may_fetch(&self, _request: &[u8]) -> PolicyDecision {
        PolicyDecision::Allow
    }

    /// Gate durable KV access. `store` is the store name, `write`
    /// distinguishes mutating ops (put/delete) from read-only
    /// (get/list). Embedders enforce per-store namespacing.
    fn may_idb(&self, _store: &[u8], _write: bool) -> PolicyDecision {
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
    /// Policy gate consulted at every `kh_*` boundary that touches
    /// the outside world. Defaults to AllowAllPolicy; embedders
    /// override via `Microkernel::with_host_state_mut` or by
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
    ///   tests and for browser microkernels that haven't wired up
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
    /// - Browser microkernels plug in a WebSocket-backed impl
    ///   here (browsers can't open raw TCP).
    pub tcp: Option<Arc<dyn TcpSocketImpl>>,
    /// Durable key-value backend for the `kh_idb_*` imports.
    /// `None` denies every access. Browser microkernels back
    /// this with IndexedDB; native deployments use a disk-backed
    /// store or [`InMemoryKv`] for tests.
    pub kv: Option<Arc<dyn KvBackend>>,
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
        }
    }
}

/// Pluggable durable key-value store. Browser microkernels back
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

    fn table_def(store: &[u8]) -> redb::TableDefinition<'_, &'static [u8], &'static [u8]> {
        // redb requires UTF-8 table names; if a store name isn't
        // valid UTF-8 the embedder gets a single shared "_bin"
        // table. Almost every real-world store name is UTF-8.
        let name = std::str::from_utf8(store).unwrap_or("_bin");
        // SAFETY: we leak the name string for the table definition
        // — table defs are short-lived per call, but the Cow they
        // hold needs a 'static lifetime. Real impl could use a
        // store-name → 'static-string interner; for the slice we
        // use a single shared static fallback above when names are
        // non-UTF-8.
        redb::TableDefinition::new(Box::leak(name.to_owned().into_boxed_str()))
    }
}

impl KvBackend for RedbKv {
    fn get(&self, store: &[u8], key: &[u8]) -> Result<Vec<u8>, i32> {
        let txn = self.db.begin_read().map_err(|_| -5_i32)?;
        let table = match txn.open_table(Self::table_def(store)) {
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
        let txn = match self.db.begin_write() {
            Ok(t) => t,
            Err(_) => return -5_i32,
        };
        {
            let mut table = match txn.open_table(Self::table_def(store)) {
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
        let txn = match self.db.begin_write() {
            Ok(t) => t,
            Err(_) => return -5_i32,
        };
        {
            let mut table = match txn.open_table(Self::table_def(store)) {
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
        let txn = match self.db.begin_read() {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        let table = match txn.open_table(Self::table_def(store)) {
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
/// browser microkernels point at while IndexedDB wiring is in
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
/// Browser microkernels plug in a WebSocket-backed impl since
/// browsers can't open raw TCP; native deployments use
/// [`NativeTcpSocket`]. Containment is the embedder's job — the
/// `may_connect` policy gate fires before this trait sees any
/// request.
pub trait TcpSocketImpl: Send + Sync {
    /// Connect to `host:port` and return a non-negative socket
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
    /// Bind to `host:port` (port=0 lets the host pick) and start
    /// accepting. Returns a listener handle or negated errno.
    /// Default: -ENOSYS — embedders that want listen wire it up
    /// in their TcpSocketImpl. (Browser microkernels typically
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
}

/// std::net::TcpStream-backed [`TcpSocketImpl`]. Blocking I/O;
/// each `connect` issues a fresh DNS resolve + TCP handshake with
/// a configurable timeout. Suitable for native CLI / server
/// embedders. Browser microkernels need their own impl.
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
        let bind_addr = if host == "0.0.0.0" || host.is_empty() {
            format!("0.0.0.0:{port}")
        } else if host == "localhost" {
            format!("127.0.0.1:{port}")
        } else {
            format!("{host}:{port}")
        };
        let listener = match std::net::TcpListener::bind(&bind_addr) {
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
                None => return -9_i32, // -EBADF
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

/// Pluggable host-fs backend. *Every* host-fs access goes through
/// this trait — local disk, OPFS, S3, in-memory, all the same
/// surface. The microkernel calls these methods from inside each
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
/// browser microkernels (and tests that don't want a temp dir)
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
    /// fixtures before the microkernel touches them.
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
        let user = self.spawn_user_process_with_args(wasm, argv)?;
        let mut req = Vec::with_capacity(8);
        req.extend_from_slice(&parent_pid.to_le_bytes());
        req.extend_from_slice(&user.pid.to_le_bytes());
        let rc = self.syscall(METHOD_KERNEL_REGISTER_CHILD, &req, &mut [])?;
        if rc != 0 {
            anyhow::bail!("kernel_register_child failed: rc={rc}");
        }
        Ok(user)
    }

    /// Record a process's exit status with the kernel so its
    /// parent's `sys_wait` can reap it. Embedders typically call
    /// this after a `UserProcess::run_start` returns (extracting
    /// the exit code from the proc_exit trap).
    pub fn record_exit(&self, pid: u32, exit_status: i32) -> Result<()> {
        let mut req = Vec::with_capacity(8);
        req.extend_from_slice(&pid.to_le_bytes());
        req.extend_from_slice(&exit_status.to_le_bytes());
        let rc = self.syscall(METHOD_KERNEL_RECORD_EXIT, &req, &mut [])?;
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
        // Sized to leave room in the kernel scratch buffer (1 MiB
        // total). Real wasm fixtures need to fit; we'll switch to
        // a chunked transfer if/when individual children grow
        // beyond this.
        let mut buf = vec![0u8; 768 * 1024];
        let rc = self.syscall(METHOD_KERNEL_DRAIN_SPAWN, &[], &mut buf)?;
        if rc == -2 {
            return Ok(None); // -ENOENT: queue empty
        }
        if rc < 0 {
            anyhow::bail!("kernel_drain_spawn failed: rc={rc}");
        }
        let used = rc as usize;
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
        let mut next = self.next_pid.borrow_mut();
        let pid = *next;
        *next += 1;
        drop(next);
        let argv: Vec<Vec<u8>> = argv.iter().map(|s| s.as_ref().to_vec()).collect();
        self.instantiate_with_pid(pid, wasm, argv)
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
        crate::wasi_shim::add_to_linker(&mut linker)
            .context("install WASI preview1 shim on user-process linker")?;

        // Push argv to the kernel so /proc/<pid>/cmdline + comm have
        // content to serve. Format: u32 pid + (u32 len + bytes)*.
        let mut req = Vec::with_capacity(4 + argv.iter().map(|a| 4 + a.len()).sum::<usize>());
        req.extend_from_slice(&pid.to_le_bytes());
        for a in &argv {
            req.extend_from_slice(&(a.len() as u32).to_le_bytes());
            req.extend_from_slice(a);
        }
        self.syscall(METHOD_KERNEL_SET_ARGV, &req, &mut [])?;

        let user_state = UserState {
            kernel: self.kernel.clone(),
            pid,
            argv,
            dir_fds: std::collections::BTreeMap::new(),
            last_exit: None,
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
/// and run it. Returned from [`Microkernel::drain_pending_spawn`].
pub struct PendingSpawn {
    pub child_pid: u32,
    pub wasm: Vec<u8>,
    pub argv: Vec<Vec<u8>>,
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
/// Note on argv: keeping it in microkernel-side state for now is
/// fine — the kernel's process tree is not tracking argv yet. Once
/// `sys_spawn` lands and the kernel allocates pids itself, argv
/// migrates into `Process` so it's preserved across exec.
pub struct UserState {
    pub kernel: Arc<Mutex<KernelInstance>>,
    pub pid: u32,
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
}

impl yurt_microkernel_core::HasCallerPid for UserState {
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
// Trampoline helpers (`forward_*`, `trampoline_request*`) live in
// `yurt_microkernel_core` now — they're engine-agnostic. We re-export
// the two `pub` ones the WASI shim uses for backwards compatibility.
pub use yurt_microkernel_core::{trampoline_request, trampoline_request_with_response};

// ── Linker registration ──────────────────────────────────────────────────────

/// Read a kernel-supplied path slice out of kernel.wasm memory.
/// Returns the bytes verbatim — no rooting, no canonicalization;
/// each [`HostFsImpl`] decides how to interpret them.
fn read_path(
    caller: &mut Caller<'_, KernelStoreData>,
    path_ptr: u32,
    path_len: u32,
) -> std::result::Result<Vec<u8>, i32> {
    let memory = caller
        .get_export("memory")
        .and_then(|e| e.into_memory())
        .ok_or(-EFAULT as i32)?;
    let mut path = vec![0u8; path_len as usize];
    if path_len > 0 && memory.read(&*caller, path_ptr as usize, &mut path).is_err() {
        return Err(-EFAULT as i32);
    }
    Ok(path)
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -(EFAULT as i32),
            };
            let mut buf = vec![0u8; msg_len as usize];
            if memory.read(&caller, msg_ptr as usize, &mut buf).is_err() {
                return -(EFAULT as i32);
            }
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
            // Policy gate: embedders that don't trust extension
            // requests inspect the bytes here. Returning Deny short-
            // circuits the registry call with -EACCES.
            if caller.data().host.policy.may_invoke_extension(&request) == PolicyDecision::Deny {
                return -EACCES;
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            let fs = match caller.data().host.host_fs.clone() {
                Some(f) => f,
                None => return -EBADF,
            };
            let mut buf = vec![0u8; len as usize];
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            let mut buf = vec![0u8; data_len as usize];
            if data_len > 0 && memory.read(&caller, data_ptr as usize, &mut buf).is_err() {
                return -EFAULT;
            }
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT as i32,
            };
            let mut target = vec![0u8; target_len as usize];
            if target_len > 0
                && memory
                    .read(&caller, target_ptr as usize, &mut target)
                    .is_err()
            {
                return -EFAULT as i32;
            }
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
    // connect: parse "host:port", consult may_connect, delegate to
    // HostState.tcp. send/recv/close pass the host handle through.
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_connect",
        |mut caller: Caller<'_, KernelStoreData>,
         addr_ptr: u32,
         addr_len: u32,
         flags: u32|
         -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT as i32,
            };
            let mut addr = vec![0u8; addr_len as usize];
            if addr_len > 0 && memory.read(&caller, addr_ptr as usize, &mut addr).is_err() {
                return -EFAULT as i32;
            }
            let addr_str = match std::str::from_utf8(&addr) {
                Ok(s) => s,
                Err(_) => return -EINVAL as i32,
            };
            let (host, port_str) = match addr_str.rsplit_once(':') {
                Some(p) => p,
                None => return -EINVAL as i32,
            };
            let port: u16 = match port_str.parse() {
                Ok(p) => p,
                Err(_) => return -EINVAL as i32,
            };
            if caller.data().host.policy.may_connect(host, port) == PolicyDecision::Deny {
                return -EACCES as i32;
            }
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EACCES as i32,
            };
            tcp.connect(host, port, flags)
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            let mut buf = vec![0u8; data_len as usize];
            if data_len > 0 && memory.read(&caller, data_ptr as usize, &mut buf).is_err() {
                return -EFAULT;
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EBADF,
            };
            let mut buf = vec![0u8; len as usize];
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT as i32,
            };
            let mut addr = vec![0u8; addr_len as usize];
            if addr_len > 0 && memory.read(&caller, addr_ptr as usize, &mut addr).is_err() {
                return -EFAULT as i32;
            }
            let addr_str = match std::str::from_utf8(&addr) {
                Ok(s) => s,
                Err(_) => return -EINVAL as i32,
            };
            let (host, port_str) = match addr_str.rsplit_once(':') {
                Some(p) => p,
                None => return -EINVAL as i32,
            };
            let port: u16 = match port_str.parse() {
                Ok(p) => p,
                Err(_) => return -EINVAL as i32,
            };
            if caller.data().host.policy.may_listen(port) == PolicyDecision::Deny {
                return -EACCES as i32;
            }
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -EACCES as i32,
            };
            tcp.listen(host, port, backlog)
        },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_socket_accept_blocking",
        |caller: Caller<'_, KernelStoreData>, handle: i32, flags: u32| -> i32 {
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -9_i32, // -EBADF
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
            let tcp = match caller.data().host.tcp.clone() {
                Some(t) => t,
                None => return -9_i64,
            };
            let (host, port) = match tcp.local_addr(handle) {
                Some(p) => p,
                None => return -9_i64,
            };
            let host_bytes = host.as_bytes();
            let need = 2 + host_bytes.len();
            if (need as u32) > out_cap {
                return -7_i64; // -E2BIG
            }
            let mut buf = Vec::with_capacity(need);
            buf.extend_from_slice(&port.to_le_bytes());
            buf.extend_from_slice(host_bytes);
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            let mut store = vec![0u8; store_len as usize];
            if store_len > 0
                && memory
                    .read(&caller, store_ptr as usize, &mut store)
                    .is_err()
            {
                return -EFAULT;
            }
            let mut key = vec![0u8; key_len as usize];
            if key_len > 0 && memory.read(&caller, key_ptr as usize, &mut key).is_err() {
                return -EFAULT;
            }
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
                return -7_i64; // -E2BIG
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT as i32,
            };
            let mut store = vec![0u8; store_len as usize];
            if store_len > 0
                && memory
                    .read(&caller, store_ptr as usize, &mut store)
                    .is_err()
            {
                return -EFAULT as i32;
            }
            let mut key = vec![0u8; key_len as usize];
            if key_len > 0 && memory.read(&caller, key_ptr as usize, &mut key).is_err() {
                return -EFAULT as i32;
            }
            let mut value = vec![0u8; value_len as usize];
            if value_len > 0
                && memory
                    .read(&caller, value_ptr as usize, &mut value)
                    .is_err()
            {
                return -EFAULT as i32;
            }
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT as i32,
            };
            let mut store = vec![0u8; store_len as usize];
            if store_len > 0
                && memory
                    .read(&caller, store_ptr as usize, &mut store)
                    .is_err()
            {
                return -EFAULT as i32;
            }
            let mut key = vec![0u8; key_len as usize];
            if key_len > 0 && memory.read(&caller, key_ptr as usize, &mut key).is_err() {
                return -EFAULT as i32;
            }
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            let mut store = vec![0u8; store_len as usize];
            if store_len > 0
                && memory
                    .read(&caller, store_ptr as usize, &mut store)
                    .is_err()
            {
                return -EFAULT;
            }
            let mut prefix = vec![0u8; prefix_len as usize];
            if prefix_len > 0
                && memory
                    .read(&caller, prefix_ptr as usize, &mut prefix)
                    .is_err()
            {
                return -EFAULT;
            }
            if caller.data().host.policy.may_idb(&store, false) == PolicyDecision::Deny {
                return -EACCES;
            }
            let kv = match caller.data().host.kv.clone() {
                Some(k) => k,
                None => return -EACCES,
            };
            let keys = kv.list(&store, &prefix);
            // Pack count + (len, bytes)*. Stop early when out of room.
            let mut buf: Vec<u8> = Vec::with_capacity(out_cap as usize);
            buf.extend_from_slice(&0u32.to_le_bytes());
            let mut count: u32 = 0;
            for k in &keys {
                let need = 4 + k.len();
                if buf.len() + need > out_cap as usize {
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -EFAULT,
            };
            let mut request = vec![0u8; req_len as usize];
            if req_len > 0
                && memory
                    .read(&caller, req_ptr as usize, &mut request)
                    .is_err()
            {
                return -EFAULT;
            }
            if caller.data().host.policy.may_fetch(&request) == PolicyDecision::Deny {
                return -EACCES;
            }
            let req_str = match std::str::from_utf8(&request) {
                Ok(s) => s.to_owned(),
                Err(_) => return -EINVAL,
            };
            // Run the async fetch on a fresh OS thread so the
            // implementation is the same whether the caller is
            // inside a tokio runtime (`#[tokio::test]`, embedder
            // server context) or not. block_on inside an existing
            // runtime is illegal; spawning a thread sidesteps it.
            let response = std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("kh_fetch_blocking: build current-thread tokio runtime");
                rt.block_on(crate::wasm::network::fetch(&req_str))
            })
            .join()
            .unwrap_or_else(|_| r#"{"ok":false,"error":"fetch worker panicked"}"#.to_owned());
            let bytes = response.as_bytes();
            if (bytes.len() as u32) > out_cap {
                return -7_i64; // -E2BIG
            }
            if memory.write(&mut caller, out_ptr as usize, bytes).is_err() {
                return -EFAULT;
            }
            bytes.len() as i64
        },
    )?;

    // ── Wasm engine ops ────────────────────────────────────────────
    // Native kernel-driven process instantiation is not wired here
    // yet. Bind the documented KH surface so kernel.wasm can link;
    // the JS KH adapter has the first concrete cached-module handle
    // table. Wasmtime implementation follows in a dedicated slice.
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_spawn_process",
        |_caller: Caller<'_, KernelStoreData>,
         _module_id_ptr: u32,
         _module_id_len: u32,
         _argv_ptr: u32,
         _argv_len: u32,
         _envp_ptr: u32,
         _envp_len: u32|
         -> i32 { -(ENOSYS as i32) },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_destroy_instance",
        |_caller: Caller<'_, KernelStoreData>, _handle: i32| -> i32 { -(ENOSYS as i32) },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_process_mem_read",
        |_caller: Caller<'_, KernelStoreData>,
         _handle: i32,
         _addr: u32,
         _dst_ptr: u32,
         _len: u32|
         -> i64 { -ENOSYS },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_process_mem_write",
        |_caller: Caller<'_, KernelStoreData>,
         _handle: i32,
         _addr: u32,
         _src_ptr: u32,
         _len: u32|
         -> i64 { -ENOSYS },
    )?;
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_process_resume",
        |_caller: Caller<'_, KernelStoreData>, _handle: i32, _result: i64| -> i64 { -ENOSYS },
    )?;

    Ok(())
}

/// Wires the `sys_*` import surface user processes link against. Each
/// import forwards into `kernel_dispatch` with the appropriate method
/// id from `yurt_abi_methods.toml`. The wasm import names match the architectural reality: these are syscalls.
fn register_sys_imports(linker: &mut Linker<UserState>) -> Result<()> {
    // Trampoline helpers are now in `microkernel-core` — they're
    // engine-agnostic and shared by every native engine impl. The
    // `register_sys_imports` body just wires the typed wasmtime
    // closures to those helpers.
    use yurt_microkernel_core::{
        forward_request_bytes, forward_request_with_user_response, forward_response_to_user,
        forward_scalar, forward_u32_arg, forward_user_ptr_len,
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
            forward_request_bytes(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                sys_method_id::WRITE,
                &req,
            ) as i32
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -22,
            };
            let mut path = vec![0u8; path_len as usize];
            if path_len > 0 && memory.read(&caller, path_ptr as usize, &mut path).is_err() {
                return -22;
            }
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -22,
            };
            let mut req = vec![0u8; req_len as usize];
            if req_len > 0 && memory.read(&caller, req_ptr as usize, &mut req).is_err() {
                return -22;
            }
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
        |mut caller: Caller<'_, UserState>,
         family: i32,
         sock_type: i32,
         flags: i32,
         addr_ptr: u32,
         addr_len: u32|
         -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -22,
            };
            let mut addr = vec![0u8; addr_len as usize];
            if addr_len > 0 && memory.read(&caller, addr_ptr as usize, &mut addr).is_err() {
                return -22;
            }
            // Wire format: u8 family + u8 sock_type + u16 _pad + u32 flags + addr.
            let mut req: Vec<u8> = vec![family as u8, sock_type as u8, 0, 0];
            req.extend_from_slice(&(flags as u32).to_le_bytes());
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -22,
            };
            let mut data = vec![0u8; data_len as usize];
            if data_len > 0 && memory.read(&caller, data_ptr as usize, &mut data).is_err() {
                return -22;
            }
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
        "sys_socket_listen",
        |mut caller: Caller<'_, UserState>, backlog: i32, addr_ptr: u32, addr_len: u32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -22,
            };
            let mut addr = vec![0u8; addr_len as usize];
            if addr_len > 0 && memory.read(&caller, addr_ptr as usize, &mut addr).is_err() {
                return -22;
            }
            let mut req = (backlog as u32).to_le_bytes().to_vec();
            req.extend_from_slice(&addr);
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -22,
            };
            let mut req = vec![0u8; req_len as usize];
            if req_len > 0 && memory.read(&caller, req_ptr as usize, &mut req).is_err() {
                return -22;
            }
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -22,
            };
            let mut req = vec![0u8; req_len as usize];
            if req_len > 0 && memory.read(&caller, req_ptr as usize, &mut req).is_err() {
                return -22;
            }
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -22,
            };
            let mut req = vec![0u8; req_len as usize];
            if req_len > 0 && memory.read(&caller, req_ptr as usize, &mut req).is_err() {
                return -22;
            }
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
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -22,
            };
            let mut req = vec![0u8; req_len as usize];
            if req_len > 0 && memory.read(&caller, req_ptr as usize, &mut req).is_err() {
                return -22;
            }
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
