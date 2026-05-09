//! Kernel state.
//!
//! Per-pid `Process` records plus a singleton [`Kernel`] holding the
//! map. New state-dependent syscalls (umask, cwd, fd table, …) read
//! and write through `with_kernel(|k| k.process(pid)…)`. The map
//! lazily inserts a default `Process` for unknown pids so that the
//! first syscall from a freshly-spawned process Just Works without
//! requiring an explicit registration step. Real `sys_spawn` semantics
//! land in a later phase and replace lazy insert with explicit
//! creation tied to the parent's process record.
//!
//! Kernel.wasm is single-threaded by design (the spec calls this out),
//! but `static` requires `Sync`; we use `Mutex` rather than `RefCell`
//! so the type system reflects the actual single-locking discipline.

// `BTreeMap`, not `HashMap`: HashMap's RandomState pulls
// `wasi_snapshot_preview1::random_get` into kernel.wasm's import set,
// which violates the architectural invariant that the kernel only
// imports `kh_*`. BTreeMap is deterministic and trivially fast at the
// process counts we actually run.
use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

use crate::state::Credentials;

pub type Pid = u32;

pub const DEFAULT_UMASK: u16 = 0o022;

/// `(soft, hard)` resource limits. `u64::MAX` means RLIM_INFINITY.
pub type ResourceLimit = (u64, u64);

/// Number of POSIX rlimit slots tracked. Matches the TS kernel's
/// supported set (RLIMIT_CPU through RLIMIT_NOFILE = 0..=7).
pub const RLIMIT_SLOTS: usize = 8;

// ── File descriptor table ──────────────────────────────────────────────────

/// One end of a pipe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PipeEnd {
    Read,
    Write,
}

/// What an open fd refers to. Cloneable so `dup` / `dup2` can share
/// the same underlying object across multiple fds.
///
/// Pipe entries refer to a [`PipeBuf`] in [`Kernel::pipes`] by id —
/// we don't embed `Rc<RefCell<…>>` inside the entry, since `Process`
/// lives behind a `Mutex<Kernel>` and shared mutable state stays
/// inside the kernel. Future variants (file, socket) will follow the
/// same id-into-registry pattern.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FdEntry {
    Stdin,
    Stdout,
    Stderr,
    Pipe { id: u64, end: PipeEnd },
    // Future: File { id: u64 }
    // Future: Socket { id: u64 }
}

/// Per-pid file-descriptor table. Sparse — closed fds are absent.
#[derive(Clone, Debug)]
pub struct FdTable {
    entries: BTreeMap<u32, FdEntry>,
}

impl FdTable {
    /// Default table for a freshly-spawned process: stdin/stdout/stderr
    /// pre-opened on fds 0/1/2. Real "inheritance from parent" plus
    /// O_CLOEXEC handling lands when sys_spawn does.
    fn new() -> Self {
        let mut entries = BTreeMap::new();
        entries.insert(0, FdEntry::Stdin);
        entries.insert(1, FdEntry::Stdout);
        entries.insert(2, FdEntry::Stderr);
        Self { entries }
    }

    /// Read-only view of an entry. None if `fd` is closed.
    pub fn entry(&self, fd: u32) -> Option<&FdEntry> {
        self.entries.get(&fd)
    }

    /// Lowest unused fd number. Used by `dup` and `pipe` to allocate.
    pub fn lowest_free_fd(&self) -> u32 {
        let mut n = 0;
        while self.entries.contains_key(&n) {
            n += 1;
        }
        n
    }

    /// Install `entry` at `fd`, returning the previous occupant (which
    /// the caller is responsible for cleaning up — pipe refcount,
    /// future file refcount, etc.).
    pub fn install(&mut self, fd: u32, entry: FdEntry) -> Option<FdEntry> {
        self.entries.insert(fd, entry)
    }

    /// Remove the entry at `fd`. Caller is responsible for any
    /// refcount cleanup on the returned entry.
    pub fn remove(&mut self, fd: u32) -> Option<FdEntry> {
        self.entries.remove(&fd)
    }
}

impl Default for FdTable {
    fn default() -> Self {
        Self::new()
    }
}

/// Default resource limits, indexed by resource id. Mirrors
/// `defaultImportResourceLimit` in the TS kernel.
pub const DEFAULT_RLIMITS: [Option<ResourceLimit>; RLIMIT_SLOTS] = [
    Some((u64::MAX, u64::MAX)),                 // 0 RLIMIT_CPU
    Some((u64::MAX, u64::MAX)),                 // 1 RLIMIT_FSIZE
    Some((64 * 1024 * 1024, 64 * 1024 * 1024)), // 2 RLIMIT_DATA
    Some((1024 * 1024, 1024 * 1024)),           // 3 RLIMIT_STACK
    Some((0, 0)),                               // 4 RLIMIT_CORE
    Some((64 * 1024 * 1024, 64 * 1024 * 1024)), // 5 RLIMIT_RSS
    Some((1024, 1024)),                         // 6 RLIMIT_NPROC
    Some((1024, 1024)),                         // 7 RLIMIT_NOFILE
];

#[derive(Clone, Debug)]
pub struct Process {
    pub umask: u16,
    pub credentials: Credentials,
    /// Working directory as raw bytes (cwd has no UTF-8 guarantee in
    /// POSIX). Default `/`.
    pub cwd: Vec<u8>,
    /// POSIX resource limits per `getrlimit` / `setrlimit`. `None`
    /// for unsupported resource ids; `Some((soft, hard))` otherwise.
    pub rlimits: [Option<ResourceLimit>; RLIMIT_SLOTS],
    /// Open file descriptors. Default = stdin/stdout/stderr on 0/1/2.
    pub fd_table: FdTable,
    /// Bytes the host has supplied as standard input. Drains as
    /// `sys_read` on `FdEntry::Stdin` consumes them. When empty and
    /// `stdin_eof` is set, reads return 0 (EOF); otherwise -EAGAIN.
    pub stdin_buffer: std::collections::VecDeque<u8>,
    /// Set by the microkernel via `METHOD_KERNEL_STDIN_EOF` once it
    /// has no more bytes to feed.
    pub stdin_eof: bool,
    /// Bytes this process has written to stdout (FdEntry::Stdout).
    /// The microkernel drains this via `METHOD_KERNEL_DRAIN_STDOUT`.
    pub stdout_buffer: Vec<u8>,
    /// Bytes this process has written to stderr (FdEntry::Stderr).
    pub stderr_buffer: Vec<u8>,
    /// POSIX process group id. New processes inherit pgid==pid until
    /// `setpgid` moves them; we approximate that here by initializing
    /// to the pid on first observation (caller responsibility — the
    /// dispatch handler primes it on first `getpgid`).
    pub pgid: Pid,
    /// POSIX session id. Same default-to-pid convention as `pgid`.
    pub sid: Pid,
}

impl Default for Process {
    fn default() -> Self {
        Self {
            umask: DEFAULT_UMASK,
            credentials: Credentials::DEFAULT,
            cwd: b"/".to_vec(),
            rlimits: DEFAULT_RLIMITS,
            fd_table: FdTable::default(),
            stdin_buffer: std::collections::VecDeque::new(),
            stdin_eof: false,
            stdout_buffer: Vec::new(),
            stderr_buffer: Vec::new(),
            pgid: 0,
            sid: 0,
        }
    }
}

// ── Pipe registry ─────────────────────────────────────────────────────────

/// Anonymous-pipe buffer plus refcounts for each end. Lives in
/// [`Kernel::pipes`]; FdEntry::Pipe references it by id.
#[derive(Debug)]
pub struct PipeBuf {
    /// Bytes queued for the read side. Writers append; the reader drains.
    pub bytes: std::collections::VecDeque<u8>,
    /// Number of fds currently referring to the read end. When this
    /// drops to zero with `bytes` empty and `write_ends > 0`, writes
    /// see `EPIPE`.
    pub read_ends: u32,
    /// Number of fds currently referring to the write end. When this
    /// drops to zero, reads on a drained buffer see EOF (return 0)
    /// instead of `EAGAIN`.
    pub write_ends: u32,
}

impl PipeBuf {
    fn new() -> Self {
        Self {
            bytes: std::collections::VecDeque::new(),
            read_ends: 1,
            write_ends: 1,
        }
    }

    pub fn inc_ref(&mut self, end: PipeEnd) {
        match end {
            PipeEnd::Read => self.read_ends += 1,
            PipeEnd::Write => self.write_ends += 1,
        }
    }

    /// Decrement the refcount on `end`. Returns true if the buffer
    /// has no remaining references at all (caller should drop it
    /// from the registry).
    pub fn dec_ref(&mut self, end: PipeEnd) -> bool {
        match end {
            PipeEnd::Read => self.read_ends = self.read_ends.saturating_sub(1),
            PipeEnd::Write => self.write_ends = self.write_ends.saturating_sub(1),
        }
        self.read_ends == 0 && self.write_ends == 0
    }
}

pub struct Kernel {
    processes: BTreeMap<Pid, Process>,
    pipes: BTreeMap<u64, PipeBuf>,
    next_pipe_id: u64,
}

impl Kernel {
    fn new() -> Self {
        Self {
            processes: BTreeMap::new(),
            pipes: BTreeMap::new(),
            next_pipe_id: 1,
        }
    }

    /// Allocate a fresh pipe buffer with one reader-end and one
    /// writer-end already counted. Returns the pipe id.
    pub fn create_pipe(&mut self) -> u64 {
        let id = self.next_pipe_id;
        self.next_pipe_id += 1;
        self.pipes.insert(id, PipeBuf::new());
        id
    }

    pub fn pipe_buf_mut(&mut self, id: u64) -> Option<&mut PipeBuf> {
        self.pipes.get_mut(&id)
    }

    /// Decrement the refcount on one end of pipe `id` and free the
    /// buffer if both ends are now closed.
    pub fn pipe_dec_ref(&mut self, id: u64, end: PipeEnd) {
        let drop = self
            .pipes
            .get_mut(&id)
            .map(|b| b.dec_ref(end))
            .unwrap_or(false);
        if drop {
            self.pipes.remove(&id);
        }
    }

    /// Get a mutable reference to the process record for `pid`.
    /// Lazily inserts a default `Process` if no entry exists yet.
    pub fn process_mut(&mut self, pid: Pid) -> &mut Process {
        self.processes.entry(pid).or_default()
    }

    /// Get an immutable reference to the process record for `pid`.
    /// Lazily inserts a default `Process` if no entry exists yet.
    pub fn process(&mut self, pid: Pid) -> &Process {
        self.processes.entry(pid).or_default()
    }
}

static KERNEL: LazyLock<Mutex<Kernel>> = LazyLock::new(|| Mutex::new(Kernel::new()));

pub fn with_kernel<R>(f: impl FnOnce(&mut Kernel) -> R) -> R {
    let mut k = KERNEL.lock().expect("kernel state poisoned");
    f(&mut k)
}

#[cfg(test)]
pub fn reset_for_tests() {
    let mut k = KERNEL.lock().unwrap();
    k.processes.clear();
}

/// Native unit tests share the same `static KERNEL` and run in
/// parallel by default. Tests that observe global state should hold
/// this guard so they serialize relative to each other. Wasm runtime
/// is single-threaded by design — this is a native-test-only concern.
#[cfg(test)]
pub struct TestGuard {
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl TestGuard {
    pub fn acquire() -> Self {
        static TEST_LOCK: Mutex<()> = Mutex::new(());
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();
        Self { _guard: guard }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lazy_insert_yields_defaults() {
        let _g = TestGuard::acquire();
        let umask = with_kernel(|k| k.process_mut(42).umask);
        let cwd = with_kernel(|k| k.process_mut(42).cwd.clone());
        assert_eq!(umask, DEFAULT_UMASK);
        assert_eq!(cwd, b"/");
    }

    #[test]
    fn writes_persist_across_calls() {
        let _g = TestGuard::acquire();
        with_kernel(|k| k.process_mut(1).umask = 0o077);
        let again = with_kernel(|k| k.process_mut(1).umask);
        assert_eq!(again, 0o077);
    }

    #[test]
    fn pids_are_independent() {
        let _g = TestGuard::acquire();
        with_kernel(|k| k.process_mut(1).umask = 0o077);
        with_kernel(|k| k.process_mut(2).umask = 0o022);
        assert_eq!(with_kernel(|k| k.process_mut(1).umask), 0o077);
        assert_eq!(with_kernel(|k| k.process_mut(2).umask), 0o022);
    }
}
