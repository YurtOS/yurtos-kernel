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
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{LazyLock, Mutex};

use crate::state::Credentials;

pub type Pid = u32;
pub type Tid = u32;

pub const DEFAULT_UMASK: u16 = 0o022;
pub const MAIN_THREAD_TID: Tid = 1;
pub const GUEST_MAIN_PTHREAD_ID: Tid = 0;
pub const FIRST_WORKER_TID: Tid = 2;
pub const MAX_GUEST_THREAD_ID: Tid = i32::MAX as u32;

/// `(soft, hard)` resource limits. `u64::MAX` means RLIM_INFINITY.
pub type ResourceLimit = (u64, u64);

/// Maximum bytes buffered inside one kernel-owned stream queue.
///
/// Applies to process stdio capture, anonymous pipes, and AF_UNIX socket
/// receive queues. Writers that would exceed this cap get `-EAGAIN` so a
/// stalled reader cannot grow kernel.wasm memory without bound.
pub const KERNEL_BUFFER_CAP: usize = 64 * 1024;

/// Maximum queued descriptor-rights records on one AF_UNIX socket.
pub const KERNEL_RIGHTS_QUEUE_CAP: usize = 1024;

/// Sanity bound on a process's queued real-time signals (`pending_rt`),
/// mirroring Linux `RLIMIT_SIGPENDING`. `sigqueue` returns `-EAGAIN`
/// once a target is at this cap, so a guest looping `sigqueue` cannot
/// grow kernel memory without bound while the consumer
/// (`sigwaitinfo`/delivery) is gate-deferred.
pub const KERNEL_RT_SIGNAL_QUEUE_CAP: usize = 1024;

/// Number of POSIX rlimit slots tracked. Matches the TS kernel's
/// supported set (RLIMIT_CPU through RLIMIT_NOFILE = 0..=7).
pub const RLIMIT_SLOTS: usize = 8;
pub const RLIMIT_NOFILE: usize = 7;

/// Kernel-owned execution state for one user thread. Host backends may
/// map this to a Worker, a wasmtime task, or a cooperative stack, but
/// the lifecycle state belongs to kernel.wasm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadState {
    Runnable,
    Blocked,
    Exited,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitReason {
    HostBlock,
    ThreadJoin { target_tid: Tid },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinResult {
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadRecord {
    pub tid: Tid,
    pub state: ThreadState,
    pub detached: bool,
    pub exit_value: Option<u32>,
    pub host_thread_handle: Option<i32>,
    pub wait_reason: Option<WaitReason>,
    pub waiter_tid: Option<Tid>,
    /// POSIX deferred cancellation: set by `pthread_cancel`, observed by
    /// the target at a cancellation point (`pthread_testcancel`). The
    /// guest performs the actual unwind/exit; the kernel only owns the
    /// pending-cancel state.
    pub cancel_requested: bool,
}

impl ThreadRecord {
    fn main(host_thread_handle: Option<i32>) -> Self {
        Self {
            tid: MAIN_THREAD_TID,
            state: ThreadState::Runnable,
            detached: false,
            exit_value: None,
            host_thread_handle,
            wait_reason: None,
            waiter_tid: None,
            cancel_requested: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessForkState {
    Running,
    ForkPreparing { parent_pid: Pid },
}

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
    Pipe {
        id: u64,
        end: PipeEnd,
    },
    /// Read-only handle into the in-memory ramfs. `ofd_id` references
    /// an [`OpenFileDescription`] in `Kernel::ofds`; the OFD owns the
    /// byte cursor and (once we add it) flags. Multiple fds — created
    /// via dup/dup2 — share the same OFD, matching POSIX semantics.
    File {
        ofd_id: u64,
    },
    /// Open directory handle. Directory fds are kernel-owned path
    /// capabilities; they do not use OFDs because there is no byte
    /// cursor or backend inode operation behind fchdir/readdir.
    Directory {
        path: Vec<u8>,
    },
    /// Kernel-owned POSIX socket. `id` references a [`SocketEntry`] in
    /// `Kernel::sockets`; the entry owns the KH socket handle and refcount.
    Socket {
        id: u64,
    },
}

/// Per-pid file-descriptor table. Sparse — closed fds are absent.
#[derive(Clone, Debug)]
pub struct FdTable {
    entries: BTreeMap<u32, FdEntry>,
    descriptor_flags: BTreeMap<u32, u32>,
}

impl FdTable {
    /// Default table for a freshly-spawned process: stdin/stdout/stderr
    /// pre-opened on fds 0/1/2.
    fn new() -> Self {
        let mut entries = BTreeMap::new();
        entries.insert(0, FdEntry::Stdin);
        entries.insert(1, FdEntry::Stdout);
        entries.insert(2, FdEntry::Stderr);
        Self {
            entries,
            descriptor_flags: BTreeMap::new(),
        }
    }

    /// Read-only view of an entry. None if `fd` is closed.
    pub fn entry(&self, fd: u32) -> Option<&FdEntry> {
        self.entries.get(&fd)
    }

    /// Lowest unused fd number. Used by `dup` and `pipe` to allocate.
    pub fn lowest_free_fd(&self) -> u32 {
        self.lowest_free_fd_at(0).expect("fd table exhausted")
    }

    pub fn lowest_free_fd_at(&self, min_fd: u32) -> Option<u32> {
        self.lowest_free_fd_below(min_fd, u64::from(u32::MAX) + 1)
    }

    pub fn lowest_free_fd_below(&self, min_fd: u32, exclusive_limit: u64) -> Option<u32> {
        let mut n = min_fd;
        loop {
            if u64::from(n) >= exclusive_limit {
                return None;
            }
            if !self.entries.contains_key(&n) {
                return Some(n);
            }
            if n == u32::MAX {
                return None;
            }
            n += 1;
        }
    }

    pub fn set_descriptor_flags(&mut self, fd: u32, flags: u32) -> Result<(), i32> {
        if !self.entries.contains_key(&fd) {
            return Err(crate::abi::EBADF);
        }
        const FD_CLOEXEC: u32 = 1;
        let flags = flags & FD_CLOEXEC;
        if flags == 0 {
            self.descriptor_flags.remove(&fd);
        } else {
            self.descriptor_flags.insert(fd, flags);
        }
        Ok(())
    }

    fn descriptor_flags(&self, fd: u32) -> u32 {
        self.descriptor_flags.get(&fd).copied().unwrap_or(0)
    }

    /// `fcntl(F_GETFD)`: the descriptor flags (FD_CLOEXEC bit) for an
    /// open fd, or `EBADF` if the fd is not open.
    pub fn get_descriptor_flags(&self, fd: u32) -> Result<u32, i32> {
        if !self.entries.contains_key(&fd) {
            return Err(crate::abi::EBADF);
        }
        Ok(self.descriptor_flags(fd))
    }

    pub fn inheritable_entries(&self) -> Vec<(u32, FdEntry)> {
        const FD_CLOEXEC: u32 = 1;
        self.entries
            .iter()
            .filter(|(fd, _)| self.descriptor_flags(**fd) & FD_CLOEXEC == 0)
            .map(|(fd, entry)| (*fd, entry.clone()))
            .collect()
    }

    /// Install `entry` at `fd`, returning the previous occupant (which
    /// the caller is responsible for cleaning up — pipe refcount,
    /// future file refcount, etc.).
    pub fn install(&mut self, fd: u32, entry: FdEntry) -> Option<FdEntry> {
        self.descriptor_flags.remove(&fd);
        self.entries.insert(fd, entry)
    }

    /// Remove the entry at `fd`. Caller is responsible for any
    /// refcount cleanup on the returned entry.
    pub fn remove(&mut self, fd: u32) -> Option<FdEntry> {
        self.descriptor_flags.remove(&fd);
        self.entries.remove(&fd)
    }

    pub fn from_entries(entries: Vec<(u32, FdEntry)>) -> Self {
        Self {
            entries: entries.into_iter().collect(),
            descriptor_flags: BTreeMap::new(),
        }
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
    Some((1024, 1024)),                         // RLIMIT_NOFILE
];

/// One queued POSIX real-time signal (`sigqueue`). Carries the payload
/// and sender identity POSIX exposes via `siginfo_t` on delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RtSignal {
    pub signo: u32,
    pub value: i32,
    pub sender_pid: u32,
}

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
    /// Set by the kernel_host_interface via `METHOD_KERNEL_STDIN_EOF` once it
    /// has no more bytes to feed.
    pub stdin_eof: bool,
    /// Bytes this process has written to stdout (FdEntry::Stdout).
    /// The kernel_host_interface drains this via `METHOD_KERNEL_DRAIN_STDOUT`.
    pub stdout_buffer: Vec<u8>,
    /// Bytes this process has written to stderr (FdEntry::Stderr).
    pub stderr_buffer: Vec<u8>,
    /// POSIX nice value used by the kernel-owned scheduler policy.
    /// Lower numeric values have higher priority. Clamped to -20..=19.
    pub nice: i32,
    /// POSIX scheduler policy. Phase B2 supports SCHED_OTHER only.
    pub scheduler_policy: i32,
    /// POSIX sched_param.sched_priority. For SCHED_OTHER this must be 0.
    pub scheduler_priority: i32,
    /// POSIX process group id. New processes inherit pgid==pid until
    /// `setpgid` moves them; we approximate that here by initializing
    /// to the pid on first observation (caller responsibility — the
    /// dispatch handler primes it on first `getpgid`).
    pub pgid: Pid,
    /// POSIX session id. Same default-to-pid convention as `pgid`.
    pub sid: Pid,
    /// Pending signals as a bitmask: bit (sig-1) is set when sig is
    /// queued for delivery. Phase 2 records but does not deliver —
    /// delivery requires asyncify/JSPI unwind which lands later. Sig
    /// numbers 1..=63 use bits 0..=62.
    pub pending_signals: u64,
    /// POSIX real-time signal queue (`sigqueue`). Unlike the bitmask,
    /// RT signals are *queued with multiplicity* and carry a payload +
    /// sender. Separated-producer model: this queue is the SOLE store
    /// for RT signals — it does NOT also set `pending_signals` (that
    /// bitmask is owned by kill/SIGCHLD). `sigpending()` returns the
    /// read-time union of both, so neither producer clobbers the other.
    /// Consumption (`sigwaitinfo`/delivery) is gate-deferred (B1.8-b).
    pub pending_rt: VecDeque<RtSignal>,
    /// Per-signal disposition. Index `sig - 1` for sig in 1..=63.
    /// 0 = SIG_DFL, 1 = SIG_IGN, anything else is an opaque user-side
    /// handler value (typically a wasm function table index).
    pub signal_dispositions: [u32; 63],
    /// Times the process has called `sys_sched_yield`. Phase 2
    /// observability hook — real cooperative scheduling lands with
    /// the AsyncBridge integration; tests use this to assert that
    /// userland's yield call reached the kernel.
    pub yield_count: u64,
    /// Most recent argument the process passed to `sys_nanosleep`,
    /// in nanoseconds. Same Phase 2 observability rationale as
    /// `yield_count`.
    pub last_nanosleep_ns: u64,
    /// argv as raw bytes per arg. Set at spawn time; surfaces
    /// through /proc/<pid>/cmdline and /proc/<pid>/comm. Empty for
    /// tests that create processes directly without spawn metadata.
    pub argv: Vec<Vec<u8>>,
    /// Parent pid. 0 means "no parent / kernel is parent" (the
    /// initial user process and any orphaned children point here).
    /// Set by kernel-owned spawn paths when a child process is
    /// created.
    pub ppid: Pid,
    /// Whether this process has claimed the kernel-owned stdio TTY as
    /// its controlling terminal.
    pub has_controlling_tty: bool,
    /// Direct children's pids. Updated alongside ppid on
    /// process creation; entries are removed when sys_wait reaps a
    /// child (zombie → fully gone).
    pub children: Vec<Pid>,
    /// POSIX exit status when the process has terminated; None
    /// while running. Bits 0..=7 carry the exit code, bits 8..=15
    /// carry the signal number when killed (matches Linux
    /// waitstatus encoding). The kernel_host_interface sets this via
    /// `kernel_record_exit`; sys_wait reads it.
    pub exit_status: Option<i32>,
    /// Opaque wasm-instance handle owned by the KH adapter. Kernel
    /// policy owns the process record; the host interface owns the
    /// engine mechanism addressed by this handle.
    pub host_instance_handle: Option<i32>,
    /// Kernel-owned thread group. Tid 1 is the main thread. Host
    /// handles are opaque KH adapter ids; lifecycle and joinability
    /// are authored here.
    pub threads: BTreeMap<Tid, ThreadRecord>,
    pub next_tid: Tid,
    fork_state: ProcessForkState,
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
            nice: 0,
            scheduler_policy: 0,
            scheduler_priority: 0,
            pgid: 0,
            sid: 0,
            pending_signals: 0,
            pending_rt: VecDeque::new(),
            signal_dispositions: [0; 63],
            yield_count: 0,
            last_nanosleep_ns: 0,
            argv: Vec::new(),
            ppid: 0,
            has_controlling_tty: false,
            children: Vec::new(),
            exit_status: None,
            host_instance_handle: None,
            threads: BTreeMap::new(),
            next_tid: 1,
            fork_state: ProcessForkState::Running,
        }
    }
}

impl Process {
    fn ensure_main_thread(&mut self, host_thread_handle: Option<i32>) {
        self.threads
            .entry(1)
            .or_insert_with(|| ThreadRecord::main(host_thread_handle));
        self.next_tid = self.next_tid.max(2);
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
            PipeEnd::Read => self.read_ends = self.read_ends.saturating_add(1),
            PipeEnd::Write => self.write_ends = self.write_ends.saturating_add(1),
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

/// One open-file-description: the POSIX object that holds a cursor
/// (and, eventually, open flags) for a particular `open()` call.
/// Multiple fds — created via dup/dup2 — point at the same OFD and
/// therefore share its cursor. `refs` is the count of live fds
/// referencing this OFD; when it hits zero the OFD is freed.
#[derive(Debug)]
pub struct OpenFileDescription {
    /// Which mount in `Kernel.vfs` owns this OFD's inode. Lets the
    /// kernel route reads/writes to the right backend without doing
    /// path resolution on every syscall.
    pub mount_id: crate::vfs::MountId,
    /// Backend-allocated inode id (only meaningful relative to
    /// `mount_id`).
    pub inode: u64,
    pub offset: u64,
    pub refs: u32,
    /// Whether this OFD permits writes (O_WRONLY / O_RDWR set at
    /// open time). Read-only OFDs reject sys_write with -EBADF.
    pub writable: bool,
    /// POSIX file status flags (`fcntl` F_GETFL/F_SETFL), e.g.
    /// `O_APPEND`/`O_NONBLOCK`. B2.3b stores and round-trips the
    /// settable subset; making reads/writes actually *honor* these
    /// is gate-sequenced (it changes I/O behavior).
    pub status_flags: u32,
}

pub enum SocketKind {
    Open {
        flags: u32,
        bound_addr: Option<Vec<u8>>,
    },
    Host {
        handle: i32,
    },
    UnixListener {
        path: Vec<u8>,
        backlog: u32,
        pending: VecDeque<u64>,
    },
    UnixStream {
        peer_id: u64,
        local_path: Option<Vec<u8>>,
        peer_path: Option<Vec<u8>>,
        rx: VecDeque<u8>,
        rights: VecDeque<Vec<FdEntry>>,
        peer_open: bool,
        /// SO_PEERCRED of the connected peer, captured at pair creation.
        peer_cred: PeerCred,
    },
    UnixDatagram {
        peer_id: Option<u64>,
        peer_path: Option<Vec<u8>>,
        bound_path: Option<Vec<u8>>,
        rx: VecDeque<UnixDatagramPacket>,
        rights: VecDeque<Vec<FdEntry>>,
        peer_open: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnixDatagramPacket {
    pub data: Vec<u8>,
    pub source_path: Option<Vec<u8>>,
}

/// SO_PEERCRED: the pid + effective uid/gid of the process at the other
/// end of a connected AF_UNIX stream, captured at socketpair / connect
/// time (Linux semantics). Default `{0,0,0}` mirrors the TS kernel's
/// `host_socket_peercred` `?? 0` for sockets with no captured peer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PeerCred {
    pub pid: u32,
    pub uid: u32,
    pub gid: u32,
}

pub struct SocketEntry {
    pub refs: u32,
    pub domain: u8,
    pub sock_type: u8,
    pub no_delay: bool,
    pub kind: SocketKind,
}

pub struct Kernel {
    processes: BTreeMap<Pid, Process>,
    pipes: BTreeMap<u64, PipeBuf>,
    next_pipe_id: u64,
    /// Filesystem layer. All file syscalls go through this. Backends
    /// (ramfs, host-fs, S3, image layers) are registered as mounts.
    pub vfs: crate::vfs::MountTable,
    ofds: BTreeMap<u64, OpenFileDescription>,
    next_ofd_id: u64,
    sockets: BTreeMap<u64, SocketEntry>,
    next_socket_id: u64,
    unix_listeners: BTreeMap<Vec<u8>, u64>,
    unix_datagrams: BTreeMap<Vec<u8>, u64>,
    unix_socket_inodes: BTreeSet<Vec<u8>>,
    /// `shutdown(2)` half-close state by socket id. bit0 = SHUT_RD
    /// (recv → EOF), bit1 = SHUT_WR (send → EPIPE). Absent = open both
    /// ways. Cleared when the socket is freed. (B3.1)
    socket_shutdown: BTreeMap<u64, u8>,
    /// MetadataOverlay — `(mount_id, inode) → Metadata`.
    /// chmod/chown/utimens write here; fstat reads composed
    /// override → backend default → kernel fallback. Survives the
    /// lifetime of the kernel; persistence (sidecar journal) lands
    /// later. Lets sandbox-uid metadata coexist with host-uid
    /// storage on HostFs / YURTFS L2.
    metadata_overrides: BTreeMap<(crate::vfs::MountId, u64), crate::vfs::Metadata>,
    /// FIFO of children that sys_spawn has accepted but the host
    /// hasn't yet instantiated. KernelHostInterface drains via the
    /// `kernel_drain_spawn` internal method between syscalls and
    /// runs each child synchronously, then calls
    /// `kernel_record_exit`. Necessary because re-entering kernel
    /// dispatch from inside another dispatch call would deadlock
    /// the kernel-state lock.
    pending_spawns: VecDeque<PendingSpawn>,
    /// Pid counter for sys_spawn-allocated children. Starts at 1000
    /// to leave the low range for host-allocated user processes;
    /// the host's pid allocator must stay below 1000 for now (a
    /// proper unified allocator is a follow-up).
    next_spawn_pid: Pid,
    /// Pid counter for host-created root/user processes. The host
    /// asks kernel.wasm for these pids before instantiating a user
    /// module; this keeps process identity owned by the kernel.
    next_host_pid: Pid,
    /// Last `(pid, tid)` handed to the host scheduler. The next pick rotates
    /// after this entry among runnable threads.
    last_scheduled: Option<(Pid, Tid)>,
    pending_thread_releases: Vec<i32>,
    /// Foreground process group for the kernel-owned stdio TTY.
    tty_foreground_pgid: Pid,
    /// `flock(2)` advisory locks per `(mount_id, inode)`. The lock is
    /// associated with the **open file description**, not the fd —
    /// `dup` shares it, a fresh `open()` of the same file gets a
    /// separate ofd and a separate lock. Released when the owning
    /// OFD's refcount hits zero (see `ofd_dec_ref`). Issue #89.
    flock_locks: BTreeMap<(crate::vfs::MountId, u64), FlockState>,
}

/// State of a single inode's `flock(2)` lock. `Shared(holders)`
/// represents `LOCK_SH` held by one or more OFDs simultaneously;
/// `Exclusive(ofd)` represents `LOCK_EX` held by exactly one OFD.
#[derive(Clone, Debug)]
pub enum FlockState {
    Shared(Vec<u64>),
    Exclusive(u64),
}

/// One staged sys_spawn waiting for the host to instantiate it.
/// Bytes + argv are owned by the kernel until drained.
pub struct PendingSpawn {
    pub child_pid: Pid,
    pub wasm: Vec<u8>,
    pub argv: Vec<Vec<u8>>,
}

/// Kernel-owned process metadata for host-control snapshots.
pub struct ProcessListEntry {
    pub pid: Pid,
    pub ppid: Pid,
    pub pgid: Pid,
    pub sid: Pid,
    pub exit_status: Option<i32>,
    pub command: Vec<u8>,
    pub fds: Vec<u32>,
}

pub struct WaitRecord {
    pub pid: Pid,
    pub tid: Tid,
    pub reason: WaitReason,
    pub detail: u32,
}

pub struct RunnableThread {
    pub pid: Pid,
    pub tid: Tid,
}

pub struct ScheduleDecision {
    pub pid: Pid,
    pub tid: Tid,
    pub host_thread_handle: Option<i32>,
    pub budget_ns: u64,
}

impl Kernel {
    fn new() -> Self {
        let mut vfs = crate::vfs::MountTable::new(Box::new(crate::vfs::RamfsBackend::new()));
        // Linux-style virtual mounts. Both backends slot in via the
        // VfsBackend trait; dispatch never special-cases their paths.
        vfs.add_mount(b"/dev".to_vec(), Box::new(crate::vfs::DevBackend::new()));
        vfs.add_mount(b"/proc".to_vec(), Box::new(crate::vfs::ProcBackend::new()));
        // No auto-mount for HostFs — the right prefix is workload-
        // specific. Embedders that want host-fs access call
        // `kernel_install_host_fs_mount(prefix)` (or, kernel_host_interface-
        // side, `mk.mount_host_fs(prefix)`) and pick where it lives:
        // /host, /users/user, /, whatever fits their sandbox shape.
        Self {
            processes: BTreeMap::new(),
            pipes: BTreeMap::new(),
            next_pipe_id: 1,
            vfs,
            ofds: BTreeMap::new(),
            next_ofd_id: 1,
            sockets: BTreeMap::new(),
            next_socket_id: 1,
            unix_listeners: BTreeMap::new(),
            unix_datagrams: BTreeMap::new(),
            unix_socket_inodes: BTreeSet::new(),
            socket_shutdown: BTreeMap::new(),
            metadata_overrides: BTreeMap::new(),
            pending_spawns: VecDeque::new(),
            next_spawn_pid: 1000,
            next_host_pid: 1,
            last_scheduled: None,
            pending_thread_releases: Vec::new(),
            tty_foreground_pgid: 1,
            flock_locks: BTreeMap::new(),
        }
    }

    /// Try to allocate the next pid for a host-created process in the low
    /// pid range. Skips occupied pids so tests that seed process
    /// records manually don't collide.
    pub fn try_alloc_host_pid(&mut self) -> Option<Pid> {
        for _ in 1..1000 {
            if self.next_host_pid >= 1000 {
                self.next_host_pid = 1;
            }
            let pid = self.next_host_pid;
            self.next_host_pid = self.next_host_pid.saturating_add(1);
            if !self.processes.contains_key(&pid) {
                return Some(pid);
            }
        }
        None
    }

    /// Return an uncommitted low pid reservation to the allocator.
    /// This is used when the host rejects a spawn after the kernel has
    /// already put the reserved pid in the spawn context.
    pub fn release_host_pid_reservation(&mut self, pid: Pid) {
        if (1..1000).contains(&pid) && !self.processes.contains_key(&pid) {
            self.next_host_pid = pid;
        }
    }

    pub fn prepare_fork(&mut self, parent_pid: Pid) -> Result<Pid, i32> {
        let parent = self.processes.get(&parent_pid).ok_or(crate::abi::ESRCH)?;
        if parent.fork_state != ProcessForkState::Running || parent.exit_status.is_some() {
            return Err(crate::abi::ESRCH);
        }
        if parent.threads.len() > 1 {
            return Err(crate::abi::EAGAIN);
        }
        let mut child = parent.clone();
        let Some(child_pid) = self.try_alloc_host_pid() else {
            return Err(crate::abi::EAGAIN);
        };

        for entry in child.fd_table.entries.values() {
            self.inc_fd_entry_ref(entry);
        }
        child.ppid = parent_pid;
        child.children.clear();
        child.exit_status = None;
        child.host_instance_handle = None;
        // POSIX: the child starts with an EMPTY pending signal set —
        // both the standard bitmask and the RT queue (PR #54 review P2;
        // pending_rt was added after this clone path and was missed).
        child.pending_signals = 0;
        child.pending_rt.clear();
        child.stdin_buffer.clear();
        child.stdout_buffer.clear();
        child.stderr_buffer.clear();
        child.threads.clear();
        child
            .threads
            .insert(MAIN_THREAD_TID, ThreadRecord::main(None));
        child.next_tid = FIRST_WORKER_TID;
        child.fork_state = ProcessForkState::ForkPreparing { parent_pid };

        self.processes.insert(child_pid, child);
        Ok(child_pid)
    }

    pub fn commit_fork(&mut self, parent_pid: Pid, child_pid: Pid) -> Result<(), i32> {
        let child = self
            .processes
            .get_mut(&child_pid)
            .ok_or(crate::abi::ESRCH)?;
        if child.fork_state != (ProcessForkState::ForkPreparing { parent_pid }) {
            return Err(crate::abi::EINVAL);
        }
        child.fork_state = ProcessForkState::Running;
        let parent = self
            .processes
            .get_mut(&parent_pid)
            .ok_or(crate::abi::ESRCH)?;
        if !parent.children.contains(&child_pid) {
            parent.children.push(child_pid);
        }
        Ok(())
    }

    pub fn rollback_fork(&mut self, parent_pid: Pid, child_pid: Pid) -> Result<(), i32> {
        let child = self.processes.get(&child_pid).ok_or(crate::abi::ESRCH)?;
        if child.fork_state != (ProcessForkState::ForkPreparing { parent_pid }) {
            return Err(crate::abi::EINVAL);
        }
        let child = self.processes.remove(&child_pid).expect("child checked");
        for entry in child.fd_table.entries.values() {
            self.dec_fd_entry_ref(entry);
        }
        if let Some(parent) = self.processes.get_mut(&parent_pid) {
            parent.children.retain(|&pid| pid != child_pid);
        }
        self.release_host_pid_reservation(child_pid);
        Ok(())
    }

    /// Test-only convenience wrapper for low-pid allocation paths
    /// where exhaustion is impossible by construction. Production
    /// paths use [`Kernel::try_alloc_host_pid`] and map exhaustion to
    /// errno.
    #[cfg(test)]
    pub fn alloc_host_pid(&mut self) -> Pid {
        self.try_alloc_host_pid().expect("host pid range exhausted")
    }

    pub fn insert_host_process(
        &mut self,
        pid: Pid,
        parent_pid: Pid,
        argv: Vec<Vec<u8>>,
        host_instance_handle: Option<i32>,
    ) {
        let (parent_nice, parent_policy, parent_priority) = self
            .processes
            .get(&parent_pid)
            .map(|p| (p.nice, p.scheduler_policy, p.scheduler_priority))
            .unwrap_or((0, 0, 0));
        {
            let p = self.process_mut(pid);
            p.ppid = parent_pid;
            p.argv = argv;
            p.nice = parent_nice;
            p.scheduler_policy = parent_policy;
            p.scheduler_priority = parent_priority;
            p.host_instance_handle = host_instance_handle;
            p.threads.clear();
            p.threads
                .insert(1, ThreadRecord::main(host_instance_handle));
            p.next_tid = 2;
        }
        if parent_pid != 0 {
            if let Some(parent) = self.processes.get_mut(&parent_pid) {
                if !parent.children.contains(&pid) {
                    parent.children.push(pid);
                }
            }
        }
    }

    /// Try to allocate the next pid for a sys_spawn child. Pids stay
    /// above 1000 to leave room for host-allocated user processes.
    pub fn try_alloc_spawn_pid(&mut self) -> Option<Pid> {
        let first = self.next_spawn_pid.max(1000);
        let mut pid = first;
        loop {
            if !self.processes.contains_key(&pid) {
                self.next_spawn_pid = pid.checked_add(1).unwrap_or(1000);
                return Some(pid);
            }
            pid = pid.checked_add(1).unwrap_or(1000);
            if pid == first {
                return None;
            }
        }
    }

    /// Push a freshly-staged spawn onto the queue.
    pub fn enqueue_spawn(&mut self, spawn: PendingSpawn) {
        self.pending_spawns.push_back(spawn);
    }

    /// Pop the next pending spawn for the host to run. Returns None
    /// when the queue is empty.
    pub fn drain_spawn(&mut self) -> Option<PendingSpawn> {
        self.pending_spawns.pop_front()
    }

    /// Restore a drained spawn to the head of the queue (used when
    /// the response buffer was too small to serialize it).
    pub fn pending_spawns_push_front(&mut self, spawn: PendingSpawn) {
        self.pending_spawns.push_front(spawn);
    }

    /// Compose the kernel's view of an inode's metadata:
    /// override → backend default → fallback.
    pub fn resolve_metadata(
        &self,
        mount_id: crate::vfs::MountId,
        inode: u64,
    ) -> crate::vfs::Metadata {
        if let Some(over) = self.metadata_overrides.get(&(mount_id, inode)) {
            return *over;
        }
        if let Some(def) = self.vfs.default_metadata(mount_id, inode) {
            return def;
        }
        // Fallback for backends with no opinion (Dev/Proc don't
        // track per-file metadata; their inodes have no mode bits
        // beyond filetype).
        crate::vfs::Metadata {
            uid: 0,
            gid: 0,
            mode: 0o100_644,
            mtime_ns: 0,
        }
    }

    /// Set the override metadata for an inode. Used by chmod /
    /// chown / utimens; the new value supplants any backend
    /// default until cleared.
    pub fn set_metadata_override(
        &mut self,
        mount_id: crate::vfs::MountId,
        inode: u64,
        meta: crate::vfs::Metadata,
    ) {
        self.metadata_overrides.insert((mount_id, inode), meta);
    }

    /// Allocate a fresh OFD pointing at `(mount_id, inode)`, with
    /// refcount 1, offset 0, and the requested `writable` flag.
    /// Returns the OFD id.
    pub fn create_ofd(&mut self, mount_id: crate::vfs::MountId, inode: u64, writable: bool) -> u64 {
        let id = self.next_ofd_id;
        self.next_ofd_id += 1;
        self.ofds.insert(
            id,
            OpenFileDescription {
                mount_id,
                inode,
                offset: 0,
                refs: 1,
                writable,
                status_flags: 0,
            },
        );
        id
    }

    pub fn ofd_mut(&mut self, id: u64) -> Option<&mut OpenFileDescription> {
        self.ofds.get_mut(&id)
    }

    pub fn ofd(&self, id: u64) -> Option<&OpenFileDescription> {
        self.ofds.get(&id)
    }

    pub fn create_socket(&mut self, handle: i32, domain: u8, sock_type: u8) -> u64 {
        let id = self.next_socket_id;
        self.next_socket_id += 1;
        self.sockets.insert(
            id,
            SocketEntry {
                refs: 1,
                domain,
                sock_type,
                no_delay: false,
                kind: SocketKind::Host { handle },
            },
        );
        id
    }

    pub fn create_open_socket(&mut self, domain: u8, sock_type: u8, flags: u32) -> u64 {
        let id = self.next_socket_id;
        self.next_socket_id += 1;
        self.sockets.insert(
            id,
            SocketEntry {
                refs: 1,
                domain,
                sock_type,
                no_delay: false,
                kind: SocketKind::Open {
                    flags,
                    bound_addr: None,
                },
            },
        );
        id
    }

    /// pid + effective uid/gid of `pid`, for SO_PEERCRED capture.
    pub fn peer_cred_for(&mut self, pid: Pid) -> PeerCred {
        let creds = self.process(pid).credentials;
        PeerCred {
            pid,
            uid: creds.euid,
            gid: creds.egid,
        }
    }

    /// Create a connected AF_UNIX stream pair. `peer_cred` is the
    /// SO_PEERCRED both ends report — for `socketpair` that is the
    /// calling process; for `connect` it is the connecting process
    /// (see the B3.2 scope note re: client-side asymmetry).
    pub fn create_unix_stream_pair(&mut self, peer_cred: PeerCred) -> (u64, u64) {
        let left = self.next_socket_id;
        let right = self.next_socket_id + 1;
        self.next_socket_id += 2;
        self.sockets.insert(
            left,
            SocketEntry {
                refs: 1,
                domain: 1,
                sock_type: 1,
                no_delay: false,
                kind: SocketKind::UnixStream {
                    peer_id: right,
                    local_path: None,
                    peer_path: None,
                    rx: VecDeque::new(),
                    rights: VecDeque::new(),
                    peer_open: true,
                    peer_cred,
                },
            },
        );
        self.sockets.insert(
            right,
            SocketEntry {
                refs: 1,
                domain: 1,
                sock_type: 1,
                no_delay: false,
                kind: SocketKind::UnixStream {
                    peer_id: left,
                    local_path: None,
                    peer_path: None,
                    rx: VecDeque::new(),
                    rights: VecDeque::new(),
                    peer_open: true,
                    peer_cred,
                },
            },
        );
        (left, right)
    }

    pub fn create_unix_datagram_pair(&mut self) -> (u64, u64) {
        let left = self.next_socket_id;
        let right = self.next_socket_id + 1;
        self.next_socket_id += 2;
        self.sockets.insert(
            left,
            SocketEntry {
                refs: 1,
                domain: 1,
                sock_type: 2,
                no_delay: false,
                kind: SocketKind::UnixDatagram {
                    peer_id: Some(right),
                    peer_path: None,
                    bound_path: None,
                    rx: VecDeque::new(),
                    rights: VecDeque::new(),
                    peer_open: true,
                },
            },
        );
        self.sockets.insert(
            right,
            SocketEntry {
                refs: 1,
                domain: 1,
                sock_type: 2,
                no_delay: false,
                kind: SocketKind::UnixDatagram {
                    peer_id: Some(left),
                    peer_path: None,
                    bound_path: None,
                    rx: VecDeque::new(),
                    rights: VecDeque::new(),
                    peer_open: true,
                },
            },
        );
        (left, right)
    }

    pub fn create_unix_datagram_socket(&mut self) -> u64 {
        let id = self.next_socket_id;
        self.next_socket_id += 1;
        self.sockets.insert(
            id,
            SocketEntry {
                refs: 1,
                domain: 1,
                sock_type: 2,
                no_delay: false,
                kind: SocketKind::UnixDatagram {
                    peer_id: None,
                    peer_path: None,
                    bound_path: None,
                    rx: VecDeque::new(),
                    rights: VecDeque::new(),
                    peer_open: true,
                },
            },
        );
        id
    }

    pub fn bind_unix_datagram(&mut self, id: u64, path: &[u8]) -> Result<(), i32> {
        if self.unix_datagrams.contains_key(path) {
            return Err(crate::abi::EADDRINUSE);
        }
        let Some(socket) = self.sockets.get_mut(&id) else {
            return Err(crate::abi::EBADF);
        };
        match &mut socket.kind {
            SocketKind::UnixDatagram { bound_path, .. } => {
                if let Some(old_path) = bound_path.take() {
                    self.unix_datagrams.remove(&old_path);
                }
                *bound_path = Some(path.to_vec());
                self.unix_datagrams.insert(path.to_vec(), id);
                if !path.starts_with(b"\0") {
                    self.unix_socket_inodes.insert(path.to_vec());
                }
                Ok(())
            }
            _ => Err(crate::abi::EINVAL),
        }
    }

    pub fn unix_datagram_id_for_path(&self, path: &[u8]) -> Option<u64> {
        self.unix_datagrams.get(path).copied()
    }

    pub fn connect_unix_datagram(&mut self, id: u64, path: &[u8]) -> Result<(), i32> {
        let Some(peer_id) = self.unix_datagrams.get(path).copied() else {
            return Err(crate::abi::ECONNREFUSED);
        };
        let Some(socket) = self.sockets.get_mut(&id) else {
            return Err(crate::abi::EBADF);
        };
        match &mut socket.kind {
            SocketKind::UnixDatagram {
                peer_id: id_slot,
                peer_path,
                peer_open,
                ..
            } => {
                *id_slot = Some(peer_id);
                *peer_path = Some(path.to_vec());
                *peer_open = true;
                Ok(())
            }
            _ => Err(crate::abi::EOPNOTSUPP),
        }
    }

    pub fn has_unix_socket_inode(&self, path: &[u8]) -> bool {
        self.unix_socket_inodes.contains(path)
    }

    pub fn unlink_unix_socket_inode(&mut self, path: &[u8]) -> bool {
        self.unix_listeners.remove(path);
        self.unix_datagrams.remove(path);
        self.unix_socket_inodes.remove(path)
    }

    pub fn create_unix_listener(&mut self, path: &[u8], backlog: u32) -> Result<u64, i32> {
        if self.unix_listeners.contains_key(path) {
            return Err(crate::abi::EADDRINUSE);
        }
        let backlog = if backlog == 0 { 128 } else { backlog };
        let id = self.next_socket_id;
        self.next_socket_id += 1;
        self.sockets.insert(
            id,
            SocketEntry {
                refs: 1,
                domain: 3,
                sock_type: 6,
                no_delay: false,
                kind: SocketKind::UnixListener {
                    path: path.to_vec(),
                    backlog,
                    pending: VecDeque::new(),
                },
            },
        );
        self.unix_listeners.insert(path.to_vec(), id);
        if !path.starts_with(b"\0") {
            self.unix_socket_inodes.insert(path.to_vec());
        }
        Ok(id)
    }

    pub fn connect_unix_stream(&mut self, path: &[u8], peer_cred: PeerCred) -> Result<u64, i32> {
        let Some(listener_id) = self.unix_listeners.get(path).copied() else {
            return Err(crate::abi::ECONNREFUSED);
        };
        let (backlog, pending_len) = match self.sockets.get(&listener_id).map(|s| &s.kind) {
            Some(SocketKind::UnixListener {
                backlog, pending, ..
            }) => (*backlog, pending.len()),
            _ => return Err(crate::abi::ECONNREFUSED),
        };
        if pending_len >= backlog as usize {
            return Err(crate::abi::ECONNREFUSED);
        }
        let (client_id, server_id) = self.create_unix_stream_pair(peer_cred);
        let Some(listener) = self.sockets.get_mut(&listener_id) else {
            self.socket_dec_ref(client_id);
            self.socket_dec_ref(server_id);
            return Err(crate::abi::ECONNREFUSED);
        };
        let SocketKind::UnixListener { pending, .. } = &mut listener.kind else {
            self.socket_dec_ref(client_id);
            self.socket_dec_ref(server_id);
            return Err(crate::abi::ECONNREFUSED);
        };
        pending.push_back(server_id);
        if let Some(client) = self.sockets.get_mut(&client_id) {
            if let SocketKind::UnixStream { peer_path, .. } = &mut client.kind {
                *peer_path = Some(path.to_vec());
            }
        }
        if let Some(server) = self.sockets.get_mut(&server_id) {
            if let SocketKind::UnixStream { local_path, .. } = &mut server.kind {
                *local_path = Some(path.to_vec());
            }
        }
        Ok(client_id)
    }

    pub fn accept_unix_stream(&mut self, listener_id: u64) -> Result<u64, i32> {
        let Some(listener) = self.sockets.get_mut(&listener_id) else {
            return Err(crate::abi::EBADF);
        };
        match &mut listener.kind {
            SocketKind::UnixListener { pending, .. } => {
                pending.pop_front().ok_or(crate::abi::EAGAIN)
            }
            _ => Err(crate::abi::EINVAL),
        }
    }

    pub fn socket(&self, id: u64) -> Option<&SocketEntry> {
        self.sockets.get(&id)
    }

    pub fn socket_mut(&mut self, id: u64) -> Option<&mut SocketEntry> {
        self.sockets.get_mut(&id)
    }

    /// `shutdown(2)` half-close bits for a socket (0 = open both ways).
    pub fn socket_shutdown_bits(&self, id: u64) -> u8 {
        self.socket_shutdown.get(&id).copied().unwrap_or(0)
    }

    /// Apply a POSIX `how` (0=SHUT_RD, 1=SHUT_WR, 2=SHUT_RDWR) to a
    /// socket's half-close state (idempotent OR of the bits).
    pub fn socket_shutdown_apply(&mut self, id: u64, how: u32) {
        let bits = match how {
            0 => 0b01, // SHUT_RD
            1 => 0b10, // SHUT_WR
            _ => 0b11, // SHUT_RDWR
        };
        *self.socket_shutdown.entry(id).or_insert(0) |= bits;
        // SHUT_WR / SHUT_RDWR closes the write half: the connected
        // AF_UNIX peer must observe EOF *after it drains its rx* (POSIX)
        // — but the peer's own write side stays open (it can still send
        // to us; only our read half on its end is unaffected). So this
        // is NOT `peer_open = false` (that also EPIPEs the peer's
        // sends); it sets a distinct "peer write-closed" bit (0b100) on
        // the peer's shutdown entry, consulted by recv only on an empty
        // rx (drain-then-EOF). Matching the (buggy) TS kernel is NOT a
        // reason to ship a non-POSIX half-close; a resulting B0 differ
        // divergence is a tracked TS-bug exception (retired in B6). #58.
        if bits & 0b10 != 0 {
            let peer_id = match self.sockets.get(&id).map(|s| &s.kind) {
                Some(SocketKind::UnixStream { peer_id, .. }) => Some(*peer_id),
                Some(SocketKind::UnixDatagram {
                    peer_id: Some(p), ..
                }) => Some(*p),
                _ => None,
            };
            if let Some(peer_id) = peer_id {
                if self.sockets.contains_key(&peer_id) {
                    *self.socket_shutdown.entry(peer_id).or_insert(0) |= 0b100;
                }
            }
        }
    }

    /// True iff the connected peer has done `shutdown(SHUT_WR)` on us:
    /// recv must deliver any remaining queued bytes, then return EOF.
    /// (Distinct from local `SHUT_RD` 0b01, which is an *immediate* EOF
    /// that discards queued data.)
    pub fn socket_peer_write_closed(&self, id: u64) -> bool {
        self.socket_shutdown.get(&id).copied().unwrap_or(0) & 0b100 != 0
    }

    /// Drop a socket id's half-close state. Used when an `Open` socket
    /// is converted to a `Host` connection (connect/listen): a freshly
    /// established host socket has no shutdown state, so any bits a
    /// pre-connect `shutdown()` recorded must not carry over. (PR #58 P2)
    pub fn socket_shutdown_clear(&mut self, id: u64) {
        self.socket_shutdown.remove(&id);
    }

    pub fn socket_inc_ref(&mut self, id: u64) {
        if let Some(socket) = self.sockets.get_mut(&id) {
            socket.refs = socket.refs.saturating_add(1);
        }
    }

    pub fn socket_dec_ref(&mut self, id: u64) -> Option<i32> {
        let drop_kind = if let Some(socket) = self.sockets.get_mut(&id) {
            socket.refs = socket.refs.saturating_sub(1);
            if socket.refs == 0 {
                match &socket.kind {
                    SocketKind::Open { .. } => Some((None, None, None, None, Vec::new())),
                    SocketKind::Host { handle } => {
                        Some((Some(*handle), None, None, None, Vec::new()))
                    }
                    SocketKind::UnixListener { path, pending, .. } => Some((
                        None,
                        None,
                        Some(path.clone()),
                        None,
                        pending.iter().copied().collect(),
                    )),
                    SocketKind::UnixStream { peer_id, .. } => {
                        Some((None, Some(*peer_id), None, None, Vec::new()))
                    }
                    SocketKind::UnixDatagram {
                        peer_id,
                        bound_path,
                        ..
                    } => Some((None, *peer_id, None, bound_path.clone(), Vec::new())),
                }
            } else {
                None
            }
        } else {
            None
        };
        let (close_handle, peer_id, listener_path, datagram_path, pending_ids) = drop_kind?;
        if let Some(path) = listener_path {
            self.unix_listeners.remove(&path);
        }
        if let Some(path) = datagram_path {
            self.unix_datagrams.remove(&path);
        }
        for pending_id in pending_ids {
            self.socket_dec_ref(pending_id);
        }
        if let Some(peer_id) = peer_id {
            if let Some(peer) = self.sockets.get_mut(&peer_id) {
                match &mut peer.kind {
                    SocketKind::UnixStream { peer_open, .. }
                    | SocketKind::UnixDatagram { peer_open, .. } => {
                        *peer_open = false;
                    }
                    _ => {}
                }
            }
        }
        self.sockets.remove(&id);
        self.socket_shutdown.remove(&id);
        close_handle
    }

    /// Increment the refcount on an OFD (dup / dup2).
    pub fn ofd_inc_ref(&mut self, id: u64) {
        if let Some(ofd) = self.ofds.get_mut(&id) {
            ofd.refs = ofd.refs.saturating_add(1);
        }
    }

    fn inc_fd_entry_ref(&mut self, entry: &FdEntry) {
        match entry {
            FdEntry::Pipe { id, end } => {
                if let Some(buf) = self.pipe_buf_mut(*id) {
                    buf.inc_ref(*end);
                }
            }
            FdEntry::File { ofd_id } => self.ofd_inc_ref(*ofd_id),
            FdEntry::Socket { id } => self.socket_inc_ref(*id),
            FdEntry::Directory { .. } | FdEntry::Stdin | FdEntry::Stdout | FdEntry::Stderr => {}
        }
    }

    /// Build a snapshot of the live process table and push it to
    /// every mounted backend. Backends that don't care (everyone
    /// except procfs today) get a default no-op. Called from
    /// dispatch before /proc-touching syscalls.
    pub fn publish_proc_snapshots(&mut self) {
        let snaps: Vec<crate::vfs::ProcessSnapshot> = self
            .processes
            .iter()
            .filter(|(_, p)| p.fork_state == ProcessForkState::Running)
            .map(|(pid, p)| crate::vfs::ProcessSnapshot {
                pid: *pid,
                ppid: p.ppid,
                uid: p.credentials.uid,
                euid: p.credentials.euid,
                gid: p.credentials.gid,
                egid: p.credentials.egid,
                pgid: if p.pgid == 0 { *pid } else { p.pgid },
                sid: if p.sid == 0 { *pid } else { p.sid },
                argv: p.argv.clone(),
                cwd: p.cwd.clone(),
            })
            .collect();
        self.vfs.refresh_processes(&snaps);
    }

    // NOTE (#105 / M8): the former `can_read_proc_path` lived here and
    // returned `false` (→ -EPERM at the call site) for a *present-but-
    // unauthorized* /proc/<pid>, but `true` for an *absent* pid (→
    // -ENOENT from the backend). That EPERM-vs-ENOENT split was a
    // cross-tenant pid-existence oracle. The visibility decision now
    // lives at the dispatch/fs layer (`proc_path_reachable`) and
    // consumes #66's `may_control_pid` so absent and unauthorized are
    // indistinguishable (uniform -ENOENT).

    pub fn list_processes(&self) -> Vec<ProcessListEntry> {
        self.processes
            .iter()
            .filter(|(_, p)| p.fork_state == ProcessForkState::Running)
            .map(|(pid, p)| ProcessListEntry {
                pid: *pid,
                ppid: p.ppid,
                pgid: if p.pgid == 0 { *pid } else { p.pgid },
                sid: if p.sid == 0 { *pid } else { p.sid },
                exit_status: p.exit_status,
                command: p.argv.first().cloned().unwrap_or_default(),
                fds: p.fd_table.entries.keys().copied().collect(),
            })
            .collect()
    }

    pub fn tty_foreground_pgid(&self) -> Pid {
        self.tty_foreground_pgid
    }

    pub fn set_tty_foreground_pgid(&mut self, pgid: Pid) {
        self.tty_foreground_pgid = pgid;
    }

    pub fn process_group_session(&self, pgid: Pid) -> Option<Pid> {
        self.processes.iter().find_map(|(pid, process)| {
            if process.fork_state != ProcessForkState::Running {
                return None;
            }
            let process_pgid = if process.pgid == 0 {
                *pid
            } else {
                process.pgid
            };
            (process.exit_status.is_none() && process_pgid == pgid).then_some(if process.sid == 0 {
                *pid
            } else {
                process.sid
            })
        })
    }

    /// Live members of process group `pgid`. Single source of truth for
    /// "what is in this group": a running, not-yet-reaped process whose
    /// effective pgid (own pid when `pgid == 0`) equals `pgid`. The
    /// authorization decision (POSIX per-target `may_signal`) and signal
    /// delivery are owned by the dispatch layer (`killpg_request`) — it
    /// holds the host-authenticated `caller_pid` and the credential gate.
    pub fn process_group_member_pids(&self, pgid: Pid) -> Vec<Pid> {
        self.processes
            .iter()
            .filter(|(pid, process)| {
                if process.fork_state != ProcessForkState::Running || process.exit_status.is_some()
                {
                    return false;
                }
                let process_pgid = if process.pgid == 0 {
                    **pid
                } else {
                    process.pgid
                };
                process_pgid == pgid
            })
            .map(|(pid, _)| *pid)
            .collect()
    }

    pub fn list_threads(&self, pid: Pid) -> Vec<ThreadRecord> {
        self.processes
            .get(&pid)
            .filter(|p| p.fork_state == ProcessForkState::Running)
            .map(|p| p.threads.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn list_waits(&self) -> Vec<WaitRecord> {
        self.processes
            .iter()
            .filter(|(_, p)| p.fork_state == ProcessForkState::Running)
            .flat_map(|(pid, p)| {
                p.threads.iter().filter_map(move |(tid, t)| {
                    t.wait_reason.map(|reason| WaitRecord {
                        pid: *pid,
                        tid: *tid,
                        reason,
                        detail: match reason {
                            WaitReason::HostBlock => 0,
                            WaitReason::ThreadJoin { target_tid } => target_tid,
                        },
                    })
                })
            })
            .collect()
    }

    pub fn list_runnable_threads(&self) -> Vec<RunnableThread> {
        self.processes
            .iter()
            .filter(|(_, p)| p.fork_state == ProcessForkState::Running)
            .flat_map(|(pid, p)| {
                p.threads.iter().filter_map(move |(tid, t)| {
                    (t.state == ThreadState::Runnable).then_some(RunnableThread {
                        pid: *pid,
                        tid: *tid,
                    })
                })
            })
            .collect()
    }

    pub fn schedule_next(&mut self) -> Option<ScheduleDecision> {
        let runnable: Vec<(Pid, Tid, Option<i32>, i32)> = self
            .processes
            .iter()
            .flat_map(|(pid, p)| {
                p.threads.iter().filter_map(move |(tid, t)| {
                    (t.state == ThreadState::Runnable).then_some((
                        *pid,
                        *tid,
                        t.host_thread_handle,
                        p.nice,
                    ))
                })
            })
            .collect();
        if runnable.is_empty() {
            self.last_scheduled = None;
            return None;
        }

        let mut index = 0usize;
        if let Some(last) = self.last_scheduled {
            if let Some(pos) = runnable
                .iter()
                .position(|(pid, tid, _, _)| (*pid, *tid) == last)
            {
                index = (pos + 1) % runnable.len();
            }
        }

        let (pid, tid, host_thread_handle, nice) = runnable[index];
        self.last_scheduled = Some((pid, tid));
        Some(ScheduleDecision {
            pid,
            tid,
            host_thread_handle,
            budget_ns: scheduler_budget_ns(nice),
        })
    }

    pub fn spawn_thread(&mut self, pid: Pid, host_thread_handle: Option<i32>) -> Option<Tid> {
        let tid = self.reserve_thread_id(pid).ok()?;
        self.bind_thread_handle(pid, tid, host_thread_handle).ok()?;
        Some(tid)
    }

    pub fn reserve_thread_id(&mut self, pid: Pid) -> Result<Tid, i32> {
        let p = self.processes.get_mut(&pid).ok_or(crate::abi::ESRCH)?;
        p.ensure_main_thread(None);
        let tid = p.next_tid.max(FIRST_WORKER_TID);
        if tid > MAX_GUEST_THREAD_ID {
            return Err(crate::abi::EAGAIN);
        }
        p.next_tid = tid.saturating_add(1);
        Ok(tid)
    }

    pub fn rollback_reserved_thread(&mut self, pid: Pid, tid: Tid) -> Result<(), i32> {
        let p = self.processes.get_mut(&pid).ok_or(crate::abi::ESRCH)?;
        if p.next_tid == tid.saturating_add(1) {
            p.next_tid = tid;
        }
        Ok(())
    }

    pub fn bind_thread_handle(
        &mut self,
        pid: Pid,
        tid: Tid,
        host_thread_handle: Option<i32>,
    ) -> Result<(), i32> {
        let p = self.processes.get_mut(&pid).ok_or(crate::abi::ESRCH)?;
        if p.threads.contains_key(&tid) {
            return Err(crate::abi::EEXIST);
        }
        p.threads.insert(
            tid,
            ThreadRecord {
                tid,
                state: ThreadState::Runnable,
                detached: false,
                exit_value: None,
                host_thread_handle,
                wait_reason: None,
                waiter_tid: None,
                cancel_requested: false,
            },
        );
        Ok(())
    }

    pub fn detach_thread(&mut self, pid: Pid, tid: Tid) -> Result<(), i32> {
        let p = self.processes.get_mut(&pid).ok_or(crate::abi::ESRCH)?;
        let thread = p.threads.get_mut(&tid).ok_or(crate::abi::ESRCH)?;
        if thread.detached {
            return Err(crate::abi::EINVAL);
        }
        if thread.waiter_tid.is_some() {
            return Err(crate::abi::EINVAL);
        }
        if thread.state == ThreadState::Exited {
            thread.detached = true;
            if let Some(handle) = thread.host_thread_handle.take() {
                self.pending_thread_releases.push(handle);
            }
        } else {
            thread.detached = true;
        }
        Ok(())
    }

    /// `pthread_cancel`: mark the target thread for deferred
    /// cancellation. ESRCH if the thread is unknown or already exited
    /// (POSIX: cancelling a terminated thread is a no-op error). The
    /// guest performs the actual unwind at the next cancellation point.
    pub fn request_thread_cancel(&mut self, pid: Pid, tid: Tid) -> Result<(), i32> {
        let p = self.processes.get_mut(&pid).ok_or(crate::abi::ESRCH)?;
        let thread = p.threads.get_mut(&tid).ok_or(crate::abi::ESRCH)?;
        if thread.state == ThreadState::Exited {
            return Err(crate::abi::ESRCH);
        }
        thread.cancel_requested = true;
        Ok(())
    }

    /// `pthread_testcancel`: true iff the thread has a pending cancel
    /// and has not exited. Unknown thread → false (nothing to act on).
    pub fn thread_cancel_pending(&self, pid: Pid, tid: Tid) -> bool {
        self.processes
            .get(&pid)
            .and_then(|p| p.threads.get(&tid))
            .is_some_and(|t| t.cancel_requested && t.state != ThreadState::Exited)
    }

    pub fn exit_thread(&mut self, pid: Pid, tid: Tid, exit_value: i32) -> Result<(), i32> {
        self.exit_thread_authenticated(pid, tid, exit_value as u32)
            .map(|_| ())
    }

    pub fn exit_thread_authenticated(
        &mut self,
        pid: Pid,
        tid: Tid,
        exit_value: u32,
    ) -> Result<Option<Tid>, i32> {
        let p = self.processes.get_mut(&pid).ok_or(crate::abi::ESRCH)?;
        let (waiter_tid, release_handle) = {
            let thread = p.threads.get_mut(&tid).ok_or(crate::abi::ESRCH)?;
            thread.state = ThreadState::Exited;
            thread.exit_value = Some(exit_value);
            thread.wait_reason = None;
            let waiter_tid = thread.waiter_tid;
            let release_handle = if thread.detached && waiter_tid.is_none() {
                thread.host_thread_handle.take()
            } else {
                None
            };
            (waiter_tid, release_handle)
        };
        if let Some(waiter_tid) = waiter_tid {
            if let Some(waiter) = p.threads.get_mut(&waiter_tid) {
                waiter.state = ThreadState::Runnable;
                waiter.wait_reason = None;
            }
        }
        if let Some(handle) = release_handle {
            self.pending_thread_releases.push(handle);
        }
        Ok(waiter_tid)
    }

    pub fn record_thread_exit_authenticated(
        &mut self,
        pid: Pid,
        tid: Tid,
        host_thread_handle: i32,
        exit_value: u32,
    ) -> Result<Option<Tid>, i32> {
        let thread = self
            .processes
            .get(&pid)
            .and_then(|p| p.threads.get(&tid))
            .ok_or(crate::abi::ESRCH)?;
        if thread.host_thread_handle != Some(host_thread_handle) {
            return Err(crate::abi::EPERM);
        }
        self.exit_thread_authenticated(pid, tid, exit_value)
    }

    pub fn begin_thread_join(
        &mut self,
        pid: Pid,
        waiter_tid: Tid,
        target_tid: Tid,
        retval_out: &mut [u8],
    ) -> Result<JoinResult, i32> {
        if retval_out.len() < 4 {
            return Err(crate::abi::EINVAL);
        }
        if waiter_tid == target_tid {
            return Err(crate::abi::EDEADLK);
        }

        let p = self.processes.get_mut(&pid).ok_or(crate::abi::ESRCH)?;
        let target = p.threads.get(&target_tid).ok_or(crate::abi::ESRCH)?;
        if target.detached {
            return Err(crate::abi::EINVAL);
        }
        if target.state == ThreadState::Exited {
            let retval = target.exit_value.unwrap_or(0);
            let host_thread_handle = target.host_thread_handle;
            retval_out[..4].copy_from_slice(&retval.to_le_bytes());
            if let Some(handle) = host_thread_handle {
                self.pending_thread_releases.push(handle);
            }
            p.threads.remove(&target_tid);
            return Ok(JoinResult::Completed);
        }
        if target.waiter_tid.is_some() {
            return Err(crate::abi::EBUSY);
        }
        if !p.threads.contains_key(&waiter_tid) {
            return Err(crate::abi::ESRCH);
        }

        p.threads
            .get_mut(&target_tid)
            .expect("target checked above")
            .waiter_tid = Some(waiter_tid);
        let waiter = p
            .threads
            .get_mut(&waiter_tid)
            .expect("waiter checked above");
        waiter.state = ThreadState::Blocked;
        waiter.wait_reason = Some(WaitReason::ThreadJoin { target_tid });
        Err(crate::abi::EAGAIN)
    }

    pub fn block_thread(&mut self, pid: Pid, tid: Tid) -> Option<()> {
        let thread = self.processes.get_mut(&pid)?.threads.get_mut(&tid)?;
        if thread.state != ThreadState::Exited {
            thread.state = ThreadState::Blocked;
            thread.wait_reason = Some(WaitReason::HostBlock);
        }
        Some(())
    }

    pub fn drain_thread_releases(&mut self) -> Vec<i32> {
        std::mem::take(&mut self.pending_thread_releases)
    }

    #[cfg(test)]
    pub fn take_thread_releases_for_test(&mut self) -> Vec<i32> {
        self.drain_thread_releases()
    }

    pub fn unblock_thread(&mut self, pid: Pid, tid: Tid) -> Option<()> {
        let thread = self.processes.get_mut(&pid)?.threads.get_mut(&tid)?;
        if thread.state == ThreadState::Blocked {
            thread.state = ThreadState::Runnable;
            thread.wait_reason = None;
        }
        Some(())
    }

    /// Decrement the refcount. Frees the OFD when it hits 0.
    pub fn ofd_dec_ref(&mut self, id: u64) {
        let drop = if let Some(ofd) = self.ofds.get_mut(&id) {
            ofd.refs = ofd.refs.saturating_sub(1);
            ofd.refs == 0
        } else {
            false
        };
        if drop {
            // Release any `flock(2)` lock this OFD held — POSIX
            // ties the lock to the open file description's
            // lifetime, so the final close drops it. Issue #89.
            self.flock_release_for_ofd(id);
            self.ofds.remove(&id);
        }
    }

    /// Release any `flock(2)` lock held by `ofd_id`. Called by
    /// `ofd_dec_ref` when the last fd reference drops; safe to call
    /// when no lock is held (no-op).
    pub fn flock_release_for_ofd(&mut self, ofd_id: u64) {
        // Walk the lock table; any entry that mentions this ofd_id
        // either becomes empty (Shared with no holders left) and is
        // removed, or transitions Shared(other holders) downward, or
        // disappears entirely (Exclusive owner).
        self.flock_locks.retain(|_, state| match state {
            FlockState::Shared(holders) => {
                holders.retain(|h| *h != ofd_id);
                !holders.is_empty()
            }
            FlockState::Exclusive(owner) => *owner != ofd_id,
        });
    }

    /// Attempt to acquire an `flock(2)` lock of `kind` on
    /// `(mount_id, inode)` for `ofd_id`. Returns `Ok(())` on
    /// successful acquisition (including a no-op upgrade/downgrade
    /// against the same OFD), `Err(rc)` with `rc < 0` on conflict.
    /// Conflict errno is the caller's responsibility (`EWOULDBLOCK`
    /// with `LOCK_NB`; the same with blocking variants until
    /// AsyncBridge support lands). Issue #89.
    pub fn flock_try_acquire(
        &mut self,
        ofd_id: u64,
        mount_id: crate::vfs::MountId,
        inode: u64,
        exclusive: bool,
    ) -> Result<(), ()> {
        let key = (mount_id, inode);
        match self.flock_locks.get_mut(&key) {
            None => {
                self.flock_locks.insert(
                    key,
                    if exclusive {
                        FlockState::Exclusive(ofd_id)
                    } else {
                        FlockState::Shared(vec![ofd_id])
                    },
                );
                Ok(())
            }
            Some(FlockState::Shared(holders)) => {
                if exclusive {
                    // Upgrade only if we are the sole holder.
                    if holders.len() == 1 && holders[0] == ofd_id {
                        *holders = vec![]; // tombstone — replaced below
                        self.flock_locks.insert(key, FlockState::Exclusive(ofd_id));
                        Ok(())
                    } else {
                        Err(())
                    }
                } else if !holders.contains(&ofd_id) {
                    holders.push(ofd_id);
                    Ok(())
                } else {
                    Ok(())
                }
            }
            Some(FlockState::Exclusive(owner)) => {
                if *owner == ofd_id {
                    if !exclusive {
                        // Downgrade EX → SH for the same OFD.
                        self.flock_locks
                            .insert(key, FlockState::Shared(vec![ofd_id]));
                    }
                    Ok(())
                } else {
                    Err(())
                }
            }
        }
    }

    /// Release `ofd_id`'s lock on `(mount_id, inode)`, if any. Always
    /// returns `Ok(())` — `LOCK_UN` on a file with no lock is a
    /// no-op per POSIX, not an error. Issue #89.
    pub fn flock_release(&mut self, ofd_id: u64, mount_id: crate::vfs::MountId, inode: u64) {
        let key = (mount_id, inode);
        if let Some(state) = self.flock_locks.get_mut(&key) {
            match state {
                FlockState::Shared(holders) => {
                    holders.retain(|h| *h != ofd_id);
                    if holders.is_empty() {
                        self.flock_locks.remove(&key);
                    }
                }
                FlockState::Exclusive(owner) => {
                    if *owner == ofd_id {
                        self.flock_locks.remove(&key);
                    }
                }
            }
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

    fn dec_fd_entry_ref(&mut self, entry: &FdEntry) {
        match entry {
            FdEntry::Pipe { id, end } => self.pipe_dec_ref(*id, *end),
            FdEntry::File { ofd_id } => self.ofd_dec_ref(*ofd_id),
            FdEntry::Socket { id } => {
                let _ = self.socket_dec_ref(*id);
            }
            FdEntry::Directory { .. } | FdEntry::Stdin | FdEntry::Stdout | FdEntry::Stderr => {}
        }
    }

    /// Get a mutable reference to the process record for `pid`.
    /// Lazily inserts a default `Process` if no entry exists yet.
    pub fn process_mut(&mut self, pid: Pid) -> &mut Process {
        let p = self.processes.entry(pid).or_default();
        p.ensure_main_thread(None);
        p
    }

    /// Get an immutable reference to the process record for `pid`.
    /// Lazily inserts a default `Process` if no entry exists yet.
    pub fn process(&mut self, pid: Pid) -> &Process {
        let p = self.processes.entry(pid).or_default();
        p.ensure_main_thread(None);
        p
    }

    pub fn process_existing_mut(&mut self, pid: Pid) -> Option<&mut Process> {
        let p = self.processes.get_mut(&pid)?;
        p.ensure_main_thread(None);
        Some(p)
    }

    pub fn process_existing(&self, pid: Pid) -> Option<&Process> {
        self.processes.get(&pid)
    }

    pub fn has_process(&self, pid: Pid) -> bool {
        self.process_existing(pid).is_some()
    }

    #[cfg(test)]
    pub fn is_waitable_child_for_test(&self, parent_pid: Pid, child_pid: Pid) -> bool {
        self.processes
            .get(&parent_pid)
            .is_some_and(|parent| parent.children.contains(&child_pid))
            && self
                .processes
                .get(&child_pid)
                .is_some_and(|child| child.fork_state == ProcessForkState::Running)
    }
}

static KERNEL: LazyLock<Mutex<Kernel>> = LazyLock::new(|| Mutex::new(Kernel::new()));

pub fn with_kernel<R>(f: impl FnOnce(&mut Kernel) -> R) -> R {
    let mut k = KERNEL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut k)
}

#[cfg(test)]
pub fn reset_for_tests() {
    let mut k = KERNEL.lock().unwrap();
    k.processes.clear();
    k.pipes.clear();
    k.next_pipe_id = 1;
    k.vfs.clear();
    k.ofds.clear();
    k.next_ofd_id = 1;
    k.sockets.clear();
    k.next_socket_id = 1;
    k.socket_shutdown.clear();
    k.unix_listeners.clear();
    k.unix_datagrams.clear();
    k.unix_socket_inodes.clear();
    k.metadata_overrides.clear();
    k.pending_spawns.clear();
    k.next_host_pid = 1;
    k.next_spawn_pid = 1000;
    k.last_scheduled = None;
    k.pending_thread_releases.clear();
    k.flock_locks.clear();
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
        crate::kh::test_support::clear_random_results();
        Self { _guard: guard }
    }
}

#[cfg(test)]
impl Drop for TestGuard {
    fn drop(&mut self) {
        crate::kh::test_support::clear_random_results();
    }
}

pub fn scheduler_budget_ns(nice: i32) -> u64 {
    let clamped = nice.clamp(-20, 19);
    let budget_ms = 20_i32.saturating_sub(clamped).clamp(1, 40);
    (budget_ms as u64) * 1_000_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::ROOT_MOUNT;

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

    #[test]
    fn lowest_free_fd_at_returns_none_when_u32_max_is_occupied() {
        let table = FdTable::from_entries(vec![(u32::MAX, FdEntry::Stdin)]);
        assert_eq!(table.lowest_free_fd_at(u32::MAX), None);
    }

    #[test]
    fn host_instance_handles_are_kernel_owned_process_state() {
        let _g = TestGuard::acquire();
        let pid = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/app".to_vec()], Some(11));
            pid
        });
        assert_eq!(pid, 1);
        assert_eq!(
            with_kernel(|k| k.process(pid).host_instance_handle),
            Some(11)
        );
    }

    #[test]
    fn insert_host_process_does_not_create_unknown_parent() {
        let _g = TestGuard::acquire();
        with_kernel(|k| {
            k.insert_host_process(7, 999, vec![b"/bin/app".to_vec()], Some(11));
        });

        assert!(with_kernel(|k| k.has_process(7)));
        assert!(!with_kernel(|k| k.has_process(999)));
    }

    #[test]
    fn try_alloc_host_pid_returns_none_when_low_pid_range_is_exhausted() {
        let _g = TestGuard::acquire();
        let exhausted = with_kernel(|k| {
            for pid in 1..1000 {
                k.process_mut(pid);
            }
            k.try_alloc_host_pid()
        });
        assert_eq!(exhausted, None);
    }

    #[test]
    fn try_alloc_spawn_pid_wraps_without_reusing_occupied_max_pid() {
        let _g = TestGuard::acquire();
        let allocated = with_kernel(|k| {
            k.next_spawn_pid = Pid::MAX;
            k.process_mut(Pid::MAX);
            k.try_alloc_spawn_pid()
        });
        assert_eq!(allocated, Some(1000));
        assert!(!with_kernel(|k| k.has_process(1000)));
    }

    #[test]
    fn host_process_starts_with_kernel_owned_main_thread() {
        let _g = TestGuard::acquire();
        let pid = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(22));
            pid
        });

        let threads = with_kernel(|k| k.list_threads(pid));
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].tid, 1);
        assert_eq!(threads[0].state, ThreadState::Runnable);
        assert_eq!(threads[0].host_thread_handle, Some(22));
        assert!(!threads[0].detached);
        assert_eq!(threads[0].exit_value, None);
    }

    #[test]
    fn spawned_threads_are_kernel_owned_joinable_records() {
        let _g = TestGuard::acquire();
        let (pid, tid) = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(30));
            let tid = k.spawn_thread(pid, Some(31)).expect("thread spawn");
            (pid, tid)
        });

        assert_eq!(tid, 2);
        let threads = with_kernel(|k| k.list_threads(pid));
        assert_eq!(threads.len(), 2);
        let worker = threads
            .iter()
            .find(|t| t.tid == tid)
            .expect("worker thread");
        assert_eq!(worker.state, ThreadState::Runnable);
        assert_eq!(worker.host_thread_handle, Some(31));
        assert!(!worker.detached);
        assert_eq!(worker.exit_value, None);
    }

    #[test]
    fn exited_threads_remain_joinable_until_reaped() {
        let _g = TestGuard::acquire();
        let (pid, tid) = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(40));
            let tid = k.spawn_thread(pid, Some(41)).expect("thread spawn");
            k.exit_thread(pid, tid, 123).expect("thread exit");
            (pid, tid)
        });

        let threads = with_kernel(|k| k.list_threads(pid));
        let worker = threads
            .iter()
            .find(|t| t.tid == tid)
            .expect("worker thread");
        assert_eq!(worker.state, ThreadState::Exited);
        assert_eq!(worker.exit_value, Some(123));
        assert!(!worker.detached);
    }

    #[test]
    fn detached_threads_are_marked_in_kernel_state() {
        let _g = TestGuard::acquire();
        let (pid, tid) = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(50));
            let tid = k.spawn_thread(pid, Some(51)).expect("thread spawn");
            k.detach_thread(pid, tid).expect("thread detach");
            (pid, tid)
        });

        let threads = with_kernel(|k| k.list_threads(pid));
        let worker = threads
            .iter()
            .find(|t| t.tid == tid)
            .expect("worker thread");
        assert!(worker.detached);
        assert_eq!(worker.state, ThreadState::Runnable);
    }

    #[test]
    fn blocked_threads_can_be_made_runnable_again_by_scheduler() {
        let _g = TestGuard::acquire();
        let (pid, tid) = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(60));
            let tid = k.spawn_thread(pid, Some(61)).expect("thread spawn");
            k.block_thread(pid, tid).expect("thread block");
            (pid, tid)
        });

        let blocked = with_kernel(|k| {
            k.list_threads(pid)
                .into_iter()
                .find(|t| t.tid == tid)
                .expect("worker thread")
        });
        assert_eq!(blocked.state, ThreadState::Blocked);

        with_kernel(|k| k.unblock_thread(pid, tid).expect("thread unblock"));
        let runnable = with_kernel(|k| {
            k.list_threads(pid)
                .into_iter()
                .find(|t| t.tid == tid)
                .expect("worker thread")
        });
        assert_eq!(runnable.state, ThreadState::Runnable);
    }

    #[test]
    fn thread_ids_stop_at_i32_max() {
        let _g = TestGuard::acquire();
        let pid = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(70));
            k.process_existing_mut(pid).unwrap().next_tid = i32::MAX as u32;
            pid
        });

        assert_eq!(
            with_kernel(|k| k.reserve_thread_id(pid)),
            Ok(i32::MAX as u32)
        );
        assert_eq!(
            with_kernel(|k| k.reserve_thread_id(pid)),
            Err(crate::abi::EAGAIN)
        );
    }

    #[test]
    fn prepare_fork_allocates_hidden_child_until_commit() {
        let _g = TestGuard::acquire();
        let (parent_pid, child_pid) = with_kernel(|k| {
            let parent_pid = k.alloc_host_pid();
            k.insert_host_process(parent_pid, 0, vec![b"/bin/parent".to_vec()], Some(80));
            let child_pid = k.prepare_fork(parent_pid).expect("prepare fork");
            (parent_pid, child_pid)
        });

        assert!(child_pid > parent_pid);
        assert!(!with_kernel(
            |k| k.is_waitable_child_for_test(parent_pid, child_pid)
        ));
        assert!(!with_kernel(|k| k
            .list_processes()
            .iter()
            .any(|entry| entry.pid == child_pid)));

        with_kernel(|k| k.commit_fork(parent_pid, child_pid).expect("commit fork"));
        assert!(with_kernel(
            |k| k.is_waitable_child_for_test(parent_pid, child_pid)
        ));
        assert!(with_kernel(|k| k
            .list_processes()
            .iter()
            .any(|entry| entry.pid == child_pid)));
    }

    #[test]
    fn rollback_fork_removes_prepared_child() {
        let _g = TestGuard::acquire();
        let (parent_pid, child_pid) = with_kernel(|k| {
            let parent_pid = k.alloc_host_pid();
            k.insert_host_process(parent_pid, 0, vec![b"/bin/parent".to_vec()], Some(81));
            let child_pid = k.prepare_fork(parent_pid).expect("prepare fork");
            (parent_pid, child_pid)
        });

        with_kernel(|k| {
            k.rollback_fork(parent_pid, child_pid)
                .expect("rollback fork")
        });
        assert!(!with_kernel(|k| k.has_process(child_pid)));
        assert!(!with_kernel(|k| k
            .process(parent_pid)
            .children
            .contains(&child_pid)));
    }

    #[test]
    fn join_running_thread_blocks_one_waiter() {
        let _g = TestGuard::acquire();
        let (pid, target) = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(80));
            let target = k.spawn_thread(pid, Some(81)).expect("thread spawn");
            (pid, target)
        });

        assert_eq!(
            with_kernel(|k| k.begin_thread_join(pid, MAIN_THREAD_TID, target, &mut [0; 4])),
            Err(crate::abi::EAGAIN)
        );
        assert_eq!(
            with_kernel(|k| k.begin_thread_join(pid, 3, target, &mut [0; 4])),
            Err(crate::abi::EBUSY)
        );

        let waiter = with_kernel(|k| {
            k.process(pid)
                .threads
                .get(&MAIN_THREAD_TID)
                .expect("waiter")
                .clone()
        });
        assert_eq!(waiter.state, ThreadState::Blocked);
        assert_eq!(
            waiter.wait_reason,
            Some(WaitReason::ThreadJoin { target_tid: target })
        );
    }

    #[test]
    fn exited_join_writes_u32_retval_and_releases_handle() {
        let _g = TestGuard::acquire();
        let (pid, target) = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(90));
            let target = k.spawn_thread(pid, Some(91)).expect("thread spawn");
            k.exit_thread_authenticated(pid, target, 0x8000_0001)
                .expect("thread exit");
            (pid, target)
        });

        let mut out = [0; 4];
        assert_eq!(
            with_kernel(|k| k.begin_thread_join(pid, MAIN_THREAD_TID, target, &mut out)),
            Ok(JoinResult::Completed)
        );
        assert_eq!(u32::from_le_bytes(out), 0x8000_0001);
        assert!(with_kernel(|k| !k
            .process(pid)
            .threads
            .contains_key(&target)));
        assert_eq!(with_kernel(|k| k.take_thread_releases_for_test()), vec![91]);
    }

    #[test]
    fn detach_rejects_target_with_pending_join() {
        let _g = TestGuard::acquire();
        let (pid, target) = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(100));
            let target = k.spawn_thread(pid, Some(101)).expect("thread spawn");
            (pid, target)
        });

        assert_eq!(
            with_kernel(|k| k.begin_thread_join(pid, MAIN_THREAD_TID, target, &mut [0; 4])),
            Err(crate::abi::EAGAIN)
        );
        assert_eq!(
            with_kernel(|k| k.detach_thread(pid, target)),
            Err(crate::abi::EINVAL)
        );
    }

    #[test]
    fn detached_exited_threads_remain_tombstoned_for_posix_errors() {
        let _g = TestGuard::acquire();
        let (pid, target) = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(110));
            let target = k.spawn_thread(pid, Some(111)).expect("thread spawn");
            k.detach_thread(pid, target).expect("thread detach");
            k.exit_thread_authenticated(pid, target, 7)
                .expect("thread exit");
            (pid, target)
        });

        let thread = with_kernel(|k| {
            k.process(pid)
                .threads
                .get(&target)
                .expect("detached tombstone")
                .clone()
        });
        assert!(thread.detached);
        assert_eq!(thread.state, ThreadState::Exited);
        assert_eq!(thread.host_thread_handle, None);
        assert_eq!(
            with_kernel(|k| k.take_thread_releases_for_test()),
            vec![111]
        );

        assert_eq!(
            with_kernel(|k| k.begin_thread_join(pid, MAIN_THREAD_TID, target, &mut [0; 4])),
            Err(crate::abi::EINVAL)
        );
        assert_eq!(
            with_kernel(|k| k.detach_thread(pid, target)),
            Err(crate::abi::EINVAL)
        );
    }

    #[test]
    fn detach_after_joinable_exit_releases_and_tombstones() {
        let _g = TestGuard::acquire();
        let (pid, target) = with_kernel(|k| {
            let pid = k.alloc_host_pid();
            k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(120));
            let target = k.spawn_thread(pid, Some(121)).expect("thread spawn");
            k.exit_thread_authenticated(pid, target, 9)
                .expect("thread exit");
            k.detach_thread(pid, target).expect("thread detach");
            (pid, target)
        });

        let thread = with_kernel(|k| {
            k.process(pid)
                .threads
                .get(&target)
                .expect("detached tombstone")
                .clone()
        });
        assert!(thread.detached);
        assert_eq!(thread.state, ThreadState::Exited);
        assert_eq!(thread.host_thread_handle, None);
        assert_eq!(
            with_kernel(|k| k.take_thread_releases_for_test()),
            vec![121]
        );
        assert_eq!(
            with_kernel(|k| k.begin_thread_join(pid, MAIN_THREAD_TID, target, &mut [0; 4])),
            Err(crate::abi::EINVAL)
        );
    }

    #[test]
    fn registry_refcount_increments_saturate() {
        let mut pipe = PipeBuf::new();
        pipe.read_ends = u32::MAX;
        pipe.write_ends = u32::MAX;
        pipe.inc_ref(PipeEnd::Read);
        pipe.inc_ref(PipeEnd::Write);
        assert_eq!(pipe.read_ends, u32::MAX);
        assert_eq!(pipe.write_ends, u32::MAX);

        let _g = TestGuard::acquire();
        with_kernel(|k| {
            let ofd_id = k.create_ofd(ROOT_MOUNT, 1, true);
            k.ofds.get_mut(&ofd_id).unwrap().refs = u32::MAX;
            k.ofd_inc_ref(ofd_id);
            assert_eq!(k.ofds.get(&ofd_id).unwrap().refs, u32::MAX);

            let socket_id = k.create_socket(1, 1, 0);
            k.sockets.get_mut(&socket_id).unwrap().refs = u32::MAX;
            k.socket_inc_ref(socket_id);
            assert_eq!(k.sockets.get(&socket_id).unwrap().refs, u32::MAX);
        });
    }
}
