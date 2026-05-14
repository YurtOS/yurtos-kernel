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
use std::collections::{BTreeMap, VecDeque};
use std::sync::{LazyLock, Mutex};

use crate::state::Credentials;

pub type Pid = u32;
pub type Tid = u32;

pub const DEFAULT_UMASK: u16 = 0o022;

/// `(soft, hard)` resource limits. `u64::MAX` means RLIM_INFINITY.
pub type ResourceLimit = (u64, u64);

/// Number of POSIX rlimit slots tracked. Matches the TS kernel's
/// supported set (RLIMIT_CPU through RLIMIT_NOFILE = 0..=7).
pub const RLIMIT_SLOTS: usize = 8;

/// Kernel-owned execution state for one user thread. Host backends may
/// map this to a Worker, a wasmtime task, or a cooperative stack, but
/// the lifecycle state belongs to kernel.wasm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadState {
    Runnable,
    // Reserved for the scheduler/poll/pthread ABI wiring that will
    // consume the kernel-owned transition methods below.
    #[allow(dead_code)]
    Blocked,
    #[allow(dead_code)]
    Exited,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitReason {
    HostBlock,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadRecord {
    pub tid: Tid,
    pub state: ThreadState,
    pub detached: bool,
    pub exit_value: Option<i32>,
    pub host_thread_handle: Option<i32>,
    pub wait_reason: Option<WaitReason>,
}

impl ThreadRecord {
    fn main(host_thread_handle: Option<i32>) -> Self {
        Self {
            tid: 1,
            state: ThreadState::Runnable,
            detached: false,
            exit_value: None,
            host_thread_handle,
            wait_reason: None,
        }
    }
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
            signal_dispositions: [0; 63],
            yield_count: 0,
            last_nanosleep_ns: 0,
            argv: Vec::new(),
            ppid: 0,
            children: Vec::new(),
            exit_status: None,
            host_instance_handle: None,
            threads: BTreeMap::new(),
            next_tid: 1,
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
}

pub enum SocketKind {
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
        rx: VecDeque<u8>,
        peer_open: bool,
    },
    UnixDatagram {
        peer_id: u64,
        rx: VecDeque<Vec<u8>>,
        peer_open: bool,
    },
}

pub struct SocketEntry {
    pub refs: u32,
    pub domain: u8,
    pub sock_type: u8,
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
            metadata_overrides: BTreeMap::new(),
            pending_spawns: VecDeque::new(),
            next_spawn_pid: 1000,
            next_host_pid: 1,
            last_scheduled: None,
        }
    }

    /// Allocate the next pid for a host-created process in the low
    /// pid range. Skips occupied pids so tests that seed process
    /// records manually don't collide.
    pub fn alloc_host_pid(&mut self) -> Pid {
        while self.processes.contains_key(&self.next_host_pid) || self.next_host_pid >= 1000 {
            self.next_host_pid = self.next_host_pid.saturating_add(1);
            if self.next_host_pid >= 1000 {
                self.next_host_pid = 1;
            }
        }
        let pid = self.next_host_pid;
        self.next_host_pid = self.next_host_pid.saturating_add(1);
        pid
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
            let parent = self.process_mut(parent_pid);
            if !parent.children.contains(&pid) {
                parent.children.push(pid);
            }
        }
    }

    /// Allocate the next pid for a sys_spawn child and bump the
    /// counter. Pids stay above 1000 to leave room for host-
    /// allocated user processes.
    pub fn alloc_spawn_pid(&mut self) -> Pid {
        let pid = self.next_spawn_pid;
        self.next_spawn_pid = self.next_spawn_pid.saturating_add(1);
        pid
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
                kind: SocketKind::Host { handle },
            },
        );
        id
    }

    pub fn create_unix_stream_pair(&mut self) -> (u64, u64) {
        let left = self.next_socket_id;
        let right = self.next_socket_id + 1;
        self.next_socket_id += 2;
        self.sockets.insert(
            left,
            SocketEntry {
                refs: 1,
                domain: 1,
                sock_type: 1,
                kind: SocketKind::UnixStream {
                    peer_id: right,
                    rx: VecDeque::new(),
                    peer_open: true,
                },
            },
        );
        self.sockets.insert(
            right,
            SocketEntry {
                refs: 1,
                domain: 1,
                sock_type: 1,
                kind: SocketKind::UnixStream {
                    peer_id: left,
                    rx: VecDeque::new(),
                    peer_open: true,
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
                kind: SocketKind::UnixDatagram {
                    peer_id: right,
                    rx: VecDeque::new(),
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
                kind: SocketKind::UnixDatagram {
                    peer_id: left,
                    rx: VecDeque::new(),
                    peer_open: true,
                },
            },
        );
        (left, right)
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
                kind: SocketKind::UnixListener {
                    path: path.to_vec(),
                    backlog,
                    pending: VecDeque::new(),
                },
            },
        );
        self.unix_listeners.insert(path.to_vec(), id);
        Ok(id)
    }

    pub fn connect_unix_stream(&mut self, path: &[u8]) -> Result<u64, i32> {
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
        let (client_id, server_id) = self.create_unix_stream_pair();
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

    pub fn socket_inc_ref(&mut self, id: u64) {
        if let Some(socket) = self.sockets.get_mut(&id) {
            socket.refs += 1;
        }
    }

    pub fn socket_dec_ref(&mut self, id: u64) -> Option<i32> {
        let drop_kind = if let Some(socket) = self.sockets.get_mut(&id) {
            socket.refs = socket.refs.saturating_sub(1);
            if socket.refs == 0 {
                match &socket.kind {
                    SocketKind::Host { handle } => Some((Some(*handle), None, None, Vec::new())),
                    SocketKind::UnixListener { path, pending, .. } => Some((
                        None,
                        None,
                        Some(path.clone()),
                        pending.iter().copied().collect(),
                    )),
                    SocketKind::UnixStream { peer_id, .. } => {
                        Some((None, Some(*peer_id), None, Vec::new()))
                    }
                    SocketKind::UnixDatagram { peer_id, .. } => {
                        Some((None, Some(*peer_id), None, Vec::new()))
                    }
                }
            } else {
                None
            }
        } else {
            None
        };
        let (close_handle, peer_id, listener_path, pending_ids) = drop_kind?;
        if let Some(path) = listener_path {
            self.unix_listeners.remove(&path);
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
        close_handle
    }

    /// Increment the refcount on an OFD (dup / dup2).
    pub fn ofd_inc_ref(&mut self, id: u64) {
        if let Some(ofd) = self.ofds.get_mut(&id) {
            ofd.refs += 1;
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

    pub fn list_processes(&self) -> Vec<ProcessListEntry> {
        self.processes
            .iter()
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

    pub fn list_threads(&self, pid: Pid) -> Vec<ThreadRecord> {
        self.processes
            .get(&pid)
            .map(|p| p.threads.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn list_waits(&self) -> Vec<WaitRecord> {
        self.processes
            .iter()
            .flat_map(|(pid, p)| {
                p.threads.iter().filter_map(move |(tid, t)| {
                    t.wait_reason.map(|reason| WaitRecord {
                        pid: *pid,
                        tid: *tid,
                        reason,
                        detail: 0,
                    })
                })
            })
            .collect()
    }

    pub fn list_runnable_threads(&self) -> Vec<RunnableThread> {
        self.processes
            .iter()
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

    // Reserved for pthread host-import wiring; tests pin the kernel-owned
    // lifecycle before host backends start calling into it.
    #[allow(dead_code)]
    pub fn spawn_thread(&mut self, pid: Pid, host_thread_handle: Option<i32>) -> Option<Tid> {
        let p = self.processes.get_mut(&pid)?;
        let tid = p.next_tid.max(1);
        p.next_tid = tid.saturating_add(1);
        p.threads.insert(
            tid,
            ThreadRecord {
                tid,
                state: ThreadState::Runnable,
                detached: false,
                exit_value: None,
                host_thread_handle,
                wait_reason: None,
            },
        );
        Some(tid)
    }

    #[allow(dead_code)]
    pub fn detach_thread(&mut self, pid: Pid, tid: Tid) -> Option<()> {
        let thread = self.processes.get_mut(&pid)?.threads.get_mut(&tid)?;
        thread.detached = true;
        Some(())
    }

    #[allow(dead_code)]
    pub fn exit_thread(&mut self, pid: Pid, tid: Tid, exit_value: i32) -> Option<()> {
        let thread = self.processes.get_mut(&pid)?.threads.get_mut(&tid)?;
        thread.state = ThreadState::Exited;
        thread.exit_value = Some(exit_value);
        thread.wait_reason = None;
        Some(())
    }

    #[allow(dead_code)]
    pub fn block_thread(&mut self, pid: Pid, tid: Tid) -> Option<()> {
        let thread = self.processes.get_mut(&pid)?.threads.get_mut(&tid)?;
        if thread.state != ThreadState::Exited {
            thread.state = ThreadState::Blocked;
            thread.wait_reason = Some(WaitReason::HostBlock);
        }
        Some(())
    }

    #[allow(dead_code)]
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
            self.ofds.remove(&id);
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

    pub fn has_process(&self, pid: Pid) -> bool {
        self.processes.contains_key(&pid)
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
    k.vfs.clear();
    k.ofds.clear();
    k.next_ofd_id = 1;
    k.sockets.clear();
    k.next_socket_id = 1;
    k.metadata_overrides.clear();
    k.next_host_pid = 1;
    k.next_spawn_pid = 1000;
    k.last_scheduled = None;
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

pub fn scheduler_budget_ns(nice: i32) -> u64 {
    let clamped = nice.clamp(-20, 19);
    let budget_ms = 20_i32.saturating_sub(clamped).clamp(1, 40);
    (budget_ms as u64) * 1_000_000
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
}
