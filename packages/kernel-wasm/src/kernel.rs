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
    /// argv as raw bytes per arg. Set at spawn time via
    /// `kernel_set_argv`; surfaces through /proc/<pid>/cmdline and
    /// /proc/<pid>/comm. Empty if the microkernel never registered
    /// it (e.g. tests that hit the kernel directly).
    pub argv: Vec<Vec<u8>>,
    /// Parent pid. 0 means "no parent / kernel is parent" (the
    /// initial user process and any orphaned children point here).
    /// Set by the microkernel via `kernel_register_child` after a
    /// successful spawn.
    pub ppid: Pid,
    /// Direct children's pids. Updated alongside ppid on
    /// register_child; entries are removed when sys_wait reaps a
    /// child (zombie → fully gone).
    pub children: Vec<Pid>,
    /// POSIX exit status when the process has terminated; None
    /// while running. Bits 0..=7 carry the exit code, bits 8..=15
    /// carry the signal number when killed (matches Linux
    /// waitstatus encoding). The microkernel sets this via
    /// `kernel_record_exit`; sys_wait reads it.
    pub exit_status: Option<i32>,
    /// Opaque wasm-instance handle owned by the KH adapter. Kernel
    /// policy owns the process record; the host interface owns the
    /// engine mechanism addressed by this handle.
    pub host_instance_handle: Option<i32>,
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
            pending_signals: 0,
            signal_dispositions: [0; 63],
            yield_count: 0,
            last_nanosleep_ns: 0,
            argv: Vec::new(),
            ppid: 0,
            children: Vec::new(),
            exit_status: None,
            host_instance_handle: None,
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

pub struct Kernel {
    processes: BTreeMap<Pid, Process>,
    pipes: BTreeMap<u64, PipeBuf>,
    next_pipe_id: u64,
    /// Filesystem layer. All file syscalls go through this. Backends
    /// (ramfs, host-fs, S3, image layers) are registered as mounts.
    pub vfs: crate::vfs::MountTable,
    ofds: BTreeMap<u64, OpenFileDescription>,
    next_ofd_id: u64,
    /// MetadataOverlay — `(mount_id, inode) → Metadata`.
    /// chmod/chown/utimens write here; fstat reads composed
    /// override → backend default → kernel fallback. Survives the
    /// lifetime of the kernel; persistence (sidecar journal) lands
    /// later. Lets sandbox-uid metadata coexist with host-uid
    /// storage on HostFs / YURTFS L2.
    metadata_overrides: BTreeMap<(crate::vfs::MountId, u64), crate::vfs::Metadata>,
    /// FIFO of children that sys_spawn has accepted but the host
    /// hasn't yet instantiated. Microkernel drains via the
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

impl Kernel {
    fn new() -> Self {
        let mut vfs = crate::vfs::MountTable::new(Box::new(crate::vfs::RamfsBackend::new()));
        // Linux-style virtual mounts. Both backends slot in via the
        // VfsBackend trait; dispatch never special-cases their paths.
        vfs.add_mount(b"/dev".to_vec(), Box::new(crate::vfs::DevBackend::new()));
        vfs.add_mount(b"/proc".to_vec(), Box::new(crate::vfs::ProcBackend::new()));
        // No auto-mount for HostFs — the right prefix is workload-
        // specific. Embedders that want host-fs access call
        // `kernel_install_host_fs_mount(prefix)` (or, microkernel-
        // side, `mk.mount_host_fs(prefix)`) and pick where it lives:
        // /host, /users/user, /, whatever fits their sandbox shape.
        Self {
            processes: BTreeMap::new(),
            pipes: BTreeMap::new(),
            next_pipe_id: 1,
            vfs,
            ofds: BTreeMap::new(),
            next_ofd_id: 1,
            metadata_overrides: BTreeMap::new(),
            pending_spawns: VecDeque::new(),
            next_spawn_pid: 1000,
            next_host_pid: 1,
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
        {
            let p = self.process_mut(pid);
            p.ppid = parent_pid;
            p.argv = argv;
            p.host_instance_handle = host_instance_handle;
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
    k.vfs.clear();
    k.ofds.clear();
    k.next_ofd_id = 1;
    k.metadata_overrides.clear();
    k.next_host_pid = 1;
    k.next_spawn_pid = 1000;
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
}
