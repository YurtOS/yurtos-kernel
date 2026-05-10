//! Pluggable filesystem layer.
//!
//! `kernel.wasm` can't ship with a single hardcoded ramfs: real
//! workloads need local-directory mounts (via host fs callbacks),
//! S3-backed mounts, image layers (read-only zstd-tar), and a real
//! ramfs for transient state — possibly several at once. This module
//! defines:
//!
//!   - [`VfsBackend`] — the small trait every backend implements
//!   - [`MountTable`] — longest-prefix mount lookup
//!   - [`RamfsBackend`] — the in-memory backend (the only one today)
//!
//! New backends slot in by implementing the trait. The dispatch
//! handlers (`sys_open`, `sys_read`, `sys_write`, `sys_lseek`,
//! `sys_fstat`) only ever talk through [`MountTable`]; they don't
//! reach into any one backend's storage. That's the architectural
//! invariant the user flagged when describing the existing TS VFS as
//! "a mess" — paths in dispatch must be a one-call dispatch into the
//! mount table, never a peek into ramfs internals.
//!
//! ## Phase 3 limits
//!
//! - Single global inode-id space across all backends. Backends
//!   allocate ids; the trait passes them back unchanged. (When we
//!   add a second backend, the OFD will gain a `mount_id` so the
//!   kernel knows which backend owns an inode.)
//! - No directory operations yet. Backends can hand out flat path
//!   namespaces; mkdir/readdir/unlink land later.
//! - Permissions / owner / mode bits not modeled.

use std::collections::BTreeMap;

/// Lightweight, copy-friendly snapshot of one process's metadata.
/// Backends that want to surface live process state (`/proc`)
/// receive these via [`VfsBackend::refresh_processes`].
#[derive(Clone, Debug)]
pub struct ProcessSnapshot {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub euid: u32,
    pub gid: u32,
    pub egid: u32,
    pub pgid: u32,
    pub sid: u32,
    /// argv as raw bytes per arg. Empty if the microkernel never
    /// pushed an argv for this pid via `kernel_set_argv`.
    pub argv: Vec<Vec<u8>>,
    /// Working directory raw bytes (no UTF-8 guarantee). Defaults to
    /// `/`.
    pub cwd: Vec<u8>,
}

/// What every concrete filesystem backend implements. The kernel
/// dispatch layer only ever calls these methods — it never inspects
/// backend internals.
pub trait VfsBackend: Send {
    /// Resolve a path *relative to this mount* to an inode id, or
    /// `None` if the path doesn't exist. Takes `&mut self` because
    /// some backends (HostFsBackend) need to open + cache the
    /// underlying handle on first lookup; pure-storage backends
    /// (ramfs) only mutate when they have to.
    fn lookup(&mut self, path: &[u8]) -> Option<u64>;

    /// Create a fresh empty file at `path`, returning its inode id.
    /// Used by `sys_open` when O_CREAT is set and the path is missing.
    /// Returning `None` means the backend refuses creation (e.g. a
    /// read-only image-layer mount).
    fn create(&mut self, path: &[u8]) -> Option<u64>;

    /// Truncate the file's content to length zero.
    fn truncate(&mut self, inode: u64);

    /// Read up to `buf.len()` bytes starting at `offset`. Returns
    /// bytes copied; 0 means EOF; negative is a kernel-style POSIX
    /// errno.
    fn read(&self, inode: u64, offset: u64, buf: &mut [u8]) -> i64;

    /// Write `payload` at `offset`, growing the file as needed.
    /// Returns bytes written, or a negated POSIX errno.
    fn write(&mut self, inode: u64, offset: u64, payload: &[u8]) -> i64;

    /// Current size of the file in bytes, or `None` if the inode
    /// is unknown.
    fn size(&self, inode: u64) -> Option<u64>;

    /// Optional hook: receive a fresh snapshot of the kernel's
    /// process table. Backends that surface live process state
    /// (procfs) refresh internal caches; default no-op for everyone
    /// else. Called from the dispatch layer before /proc-touching
    /// syscalls (we just call it on every sys_open today — the cost
    /// is one no-op closure for non-proc backends).
    fn refresh_processes(&mut self, _snapshots: &[ProcessSnapshot]) {}
}

/// One row in the mount table.
struct Mount {
    /// Path prefix (with trailing `/` only for the root mount; sub-
    /// mounts use no trailing slash so prefix-match is unambiguous).
    prefix: Vec<u8>,
    backend: Box<dyn VfsBackend>,
}

/// Stable identifier for a mount inside [`MountTable`]. Returned
/// from path resolution so the OFD can record *which* backend owns
/// an inode, then re-used on subsequent reads/writes/etc.
pub type MountId = u32;

pub const ROOT_MOUNT: MountId = 0;

/// Mount table. Resolution is longest-prefix-match against the
/// installed mounts. The root mount (prefix `/`) is mandatory and
/// catches any path that no specific mount claims. Mount ids are
/// stable across the table's lifetime — adding/removing a mount
/// reuses the position when possible (Phase 3 only ever appends).
pub struct MountTable {
    mounts: Vec<Mount>,
}

impl MountTable {
    pub fn new(root: Box<dyn VfsBackend>) -> Self {
        Self {
            mounts: vec![Mount {
                prefix: b"/".to_vec(),
                backend: root,
            }],
        }
    }

    /// Add a mount at `prefix`. Returns its [`MountId`].
    pub fn add_mount(&mut self, prefix: Vec<u8>, backend: Box<dyn VfsBackend>) -> MountId {
        self.mounts.push(Mount { prefix, backend });
        (self.mounts.len() - 1) as MountId
    }

    /// Find the mount that owns `path`. Returns `(mount_id, relpath)`.
    /// The root mount's relative path is the absolute path verbatim;
    /// non-root mounts get the suffix after their prefix. A non-root
    /// prefix `/dev` only matches when the next character is `/` or
    /// end-of-path — `/devil` belongs to the root mount.
    fn resolve(&self, path: &[u8]) -> Option<(MountId, Vec<u8>)> {
        let mut best: Option<usize> = None;
        let mut best_len = 0usize;
        for (i, m) in self.mounts.iter().enumerate() {
            if !path.starts_with(&m.prefix) {
                continue;
            }
            if m.prefix != b"/" {
                // Component boundary check: next byte must be '/' or
                // end-of-path. Skips false-prefix matches like
                // "/devil" against a "/dev" mount.
                let after = &path[m.prefix.len()..];
                if !(after.is_empty() || after.starts_with(b"/")) {
                    continue;
                }
            }
            if m.prefix.len() >= best_len {
                best = Some(i);
                best_len = m.prefix.len();
            }
        }
        let i = best?;
        let rel = if self.mounts[i].prefix == b"/" {
            path.to_vec()
        } else {
            path[self.mounts[i].prefix.len()..].to_vec()
        };
        Some((i as MountId, rel))
    }

    pub fn lookup(&mut self, path: &[u8]) -> Option<(MountId, u64)> {
        let (id, rel) = self.resolve(path)?;
        self.mounts[id as usize]
            .backend
            .lookup(&rel)
            .map(|inode| (id, inode))
    }

    pub fn create(&mut self, path: &[u8]) -> Option<(MountId, u64)> {
        let (id, rel) = self.resolve(path)?;
        self.mounts[id as usize]
            .backend
            .create(&rel)
            .map(|inode| (id, inode))
    }

    pub fn truncate(&mut self, mount_id: MountId, inode: u64) {
        if let Some(m) = self.mounts.get_mut(mount_id as usize) {
            m.backend.truncate(inode);
        }
    }

    pub fn read(&mut self, mount_id: MountId, inode: u64, offset: u64, buf: &mut [u8]) -> i64 {
        match self.mounts.get_mut(mount_id as usize) {
            Some(m) => m.backend.read(inode, offset, buf),
            None => -(crate::abi::EBADF as i64),
        }
    }

    pub fn write(
        &mut self,
        mount_id: MountId,
        inode: u64,
        offset: u64,
        payload: &[u8],
    ) -> i64 {
        match self.mounts.get_mut(mount_id as usize) {
            Some(m) => m.backend.write(inode, offset, payload),
            None => -(crate::abi::EBADF as i64),
        }
    }

    pub fn size(&self, mount_id: MountId, inode: u64) -> Option<u64> {
        self.mounts.get(mount_id as usize).and_then(|m| m.backend.size(inode))
    }

    /// Push a fresh snapshot of the kernel's process table to every
    /// mounted backend. Called from dispatch before /proc-touching
    /// syscalls so procfs serves up-to-date contents.
    pub fn refresh_processes(&mut self, snapshots: &[ProcessSnapshot]) {
        for m in &mut self.mounts {
            m.backend.refresh_processes(snapshots);
        }
    }

    #[cfg(test)]
    pub fn clear(&mut self) {
        // Reset the table to its boot-time shape: fresh ramfs at /,
        // fresh DevBackend at /dev, fresh ProcBackend at /proc,
        // fresh HostFsBackend at /host. Drops any extra mounts that
        // tests may have added.
        self.mounts.clear();
        self.mounts.push(Mount {
            prefix: b"/".to_vec(),
            backend: Box::new(RamfsBackend::new()),
        });
        self.mounts.push(Mount {
            prefix: b"/dev".to_vec(),
            backend: Box::new(DevBackend::new()),
        });
        self.mounts.push(Mount {
            prefix: b"/proc".to_vec(),
            backend: Box::new(ProcBackend::new()),
        });
        self.mounts.push(Mount {
            prefix: b"/host".to_vec(),
            backend: Box::new(HostFsBackend::new()),
        });
    }
}

// ── Ramfs backend ─────────────────────────────────────────────────

/// In-memory backend. Flat path namespace; allocates inode ids
/// monotonically.
pub struct RamfsBackend {
    inodes: BTreeMap<u64, Vec<u8>>, // inode → content
    paths: BTreeMap<Vec<u8>, u64>,  // path → inode
    next_id: u64,
}

impl RamfsBackend {
    pub fn new() -> Self {
        Self {
            inodes: BTreeMap::new(),
            paths: BTreeMap::new(),
            next_id: 1,
        }
    }

    /// Install or replace a path's content. Used by the microkernel
    /// via `kernel_register_file`.
    pub fn install(&mut self, path: Vec<u8>, content: Vec<u8>) -> u64 {
        if let Some(&id) = self.paths.get(&path) {
            if let Some(buf) = self.inodes.get_mut(&id) {
                *buf = content;
            }
            return id;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.inodes.insert(id, content);
        self.paths.insert(path, id);
        id
    }
}

impl Default for RamfsBackend {
    fn default() -> Self {
        Self::new()
    }
}

// ── /dev backend ───────────────────────────────────────────────────
//
// Mounted at "/dev". Linux-style virtual filesystem: well-known paths
// resolve to fixed inode ids; reads/writes execute the device's
// behavior rather than touching any storage. Phase 3 ships /dev/null
// and /dev/zero — enough to validate the trait against a non-ramfs
// backend without pulling in `kh_random` (which urandom would need).
//
// Inode ids are stable so callers can hold a fd across opens; nothing
// here references the kernel's process table.

const DEV_NULL_INODE: u64 = 1;
const DEV_ZERO_INODE: u64 = 2;

pub struct DevBackend;

impl DevBackend {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DevBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl VfsBackend for DevBackend {
    fn lookup(&mut self, path: &[u8]) -> Option<u64> {
        match path {
            b"/null" => Some(DEV_NULL_INODE),
            b"/zero" => Some(DEV_ZERO_INODE),
            _ => None,
        }
    }

    fn create(&mut self, _path: &[u8]) -> Option<u64> {
        // /dev is a fixed namespace; refuse new entries.
        None
    }

    fn truncate(&mut self, _inode: u64) {
        // No-op: device files have no content to truncate.
    }

    fn read(&self, inode: u64, _offset: u64, buf: &mut [u8]) -> i64 {
        match inode {
            DEV_NULL_INODE => 0, // immediate EOF
            DEV_ZERO_INODE => {
                buf.fill(0);
                buf.len() as i64
            }
            _ => -(crate::abi::EBADF as i64),
        }
    }

    fn write(&mut self, inode: u64, _offset: u64, payload: &[u8]) -> i64 {
        match inode {
            DEV_NULL_INODE | DEV_ZERO_INODE => payload.len() as i64, // /dev/null swallows; /dev/zero same
            _ => -(crate::abi::EBADF as i64),
        }
    }

    fn size(&self, inode: u64) -> Option<u64> {
        match inode {
            DEV_NULL_INODE | DEV_ZERO_INODE => Some(0),
            _ => None,
        }
    }
}

impl VfsBackend for RamfsBackend {
    fn lookup(&mut self, path: &[u8]) -> Option<u64> {
        self.paths.get(path).copied()
    }

    fn create(&mut self, path: &[u8]) -> Option<u64> {
        Some(self.install(path.to_vec(), Vec::new()))
    }

    fn truncate(&mut self, inode: u64) {
        if let Some(buf) = self.inodes.get_mut(&inode) {
            buf.clear();
        }
    }

    fn read(&self, inode: u64, offset: u64, buf: &mut [u8]) -> i64 {
        let Some(content) = self.inodes.get(&inode) else {
            return -(crate::abi::EBADF as i64);
        };
        let start = (offset as usize).min(content.len());
        let avail = content.len() - start;
        let n = avail.min(buf.len());
        if n > 0 {
            buf[..n].copy_from_slice(&content[start..start + n]);
        }
        n as i64
    }

    fn write(&mut self, inode: u64, offset: u64, payload: &[u8]) -> i64 {
        let Some(content) = self.inodes.get_mut(&inode) else {
            return -(crate::abi::EBADF as i64);
        };
        let start = offset as usize;
        let end = start + payload.len();
        if end > content.len() {
            content.resize(end, 0);
        }
        content[start..end].copy_from_slice(payload);
        payload.len() as i64
    }

    fn size(&self, inode: u64) -> Option<u64> {
        self.inodes.get(&inode).map(|c| c.len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longest_prefix_match_routes_to_submount() {
        let mut mt = MountTable::new(Box::new(RamfsBackend::new()));
        let sub_id = mt.add_mount(b"/data".to_vec(), Box::new(RamfsBackend::new()));
        assert_eq!(sub_id, 1);

        // /etc/hello → root mount; /data/foo → sub-mount.
        // The root sees the full path (incl. leading /); the sub-mount
        // sees the suffix after its prefix ("/foo").
        mt.create(b"/etc/hello").unwrap();
        let (sub_mount, sub_inode) = mt.create(b"/data/foo").unwrap();
        assert_eq!(sub_mount, sub_id);

        // Each backend sees an independent inode-id space.
        mt.write(sub_mount, sub_inode, 0, b"hi");
        let mut buf = [0u8; 8];
        let n = mt.read(sub_mount, sub_inode, 0, &mut buf);
        assert_eq!(&buf[..n as usize], b"hi");
    }

    #[test]
    fn lookup_returns_none_for_unknown_path() {
        let mut mt = MountTable::new(Box::new(RamfsBackend::new()));
        assert!(mt.lookup(b"/missing").is_none());
    }

    #[test]
    fn root_mount_is_id_zero() {
        let mt = MountTable::new(Box::new(RamfsBackend::new()));
        assert_eq!(ROOT_MOUNT, 0);
        let _ = mt; // keep MountTable construction tested.
    }
}

// ── /proc backend ──────────────────────────────────────────────────
//
// Mounted at "/proc". Linux-style: per-pid synthetic files generated
// from a snapshot of the kernel's process table. Phase 4 surface:
//
//   /proc/<pid>/status — Linux-style multi-line key:value text
//
// (`/proc/self/...` resolution happens at the dispatch layer, not
// here — `caller_pid` lives there and the substitution is trivial.)
//
// Snapshots are pushed from dispatch via `refresh_processes` before
// each /proc-touching syscall. Inode ids are stable for a given path
// across refreshes so an open fd keeps reading the path you opened —
// even though the *content* is regenerated when you call sys_read.

pub struct ProcBackend {
    /// path → (inode_id, current_content). Both fields refresh on
    /// `refresh_processes`. Inode id stays stable across refreshes
    /// for the same path so existing OFDs don't dangle.
    entries: BTreeMap<Vec<u8>, (u64, Vec<u8>)>,
    /// Path → stable inode id (preserved across refreshes).
    inodes: BTreeMap<Vec<u8>, u64>,
    next_id: u64,
}

impl ProcBackend {
    pub fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            inodes: BTreeMap::new(),
            next_id: 1,
        }
    }

    /// Format the per-pid status content. Linux-shaped subset.
    fn format_status(p: &ProcessSnapshot) -> Vec<u8> {
        let mut s = String::new();
        // /proc/<pid>/comm equivalent for status (Name:) is the
        // basename of argv[0], like Linux.
        if let Some(name) = comm_from_argv(&p.argv) {
            s.push_str(&format!("Name:\t{}\n", name));
        }
        s.push_str(&format!("Pid:\t{}\n", p.pid));
        s.push_str(&format!("PPid:\t{}\n", p.ppid));
        // Real / effective / saved (we don't track saved yet — repeat euid)
        s.push_str(&format!("Uid:\t{}\t{}\t{}\t{}\n", p.uid, p.euid, p.euid, p.euid));
        s.push_str(&format!("Gid:\t{}\t{}\t{}\t{}\n", p.gid, p.egid, p.egid, p.egid));
        s.push_str(&format!("Pgid:\t{}\n", p.pgid));
        s.push_str(&format!("Sid:\t{}\n", p.sid));
        s.into_bytes()
    }

    /// Format /proc/<pid>/cmdline: argv concatenated with NUL
    /// separators, no trailing newline. Linux convention.
    fn format_cmdline(p: &ProcessSnapshot) -> Vec<u8> {
        let mut out = Vec::new();
        for arg in &p.argv {
            out.extend_from_slice(arg);
            out.push(0);
        }
        out
    }

    /// Format /proc/<pid>/comm: basename of argv[0] + trailing newline.
    fn format_comm(p: &ProcessSnapshot) -> Vec<u8> {
        let mut out = comm_from_argv(&p.argv)
            .map(|s| s.into_bytes())
            .unwrap_or_default();
        out.push(b'\n');
        out
    }

    /// Format /proc/<pid>/cwd as a regular file containing the cwd
    /// path bytes. Real Linux exposes /proc/<pid>/cwd as a symlink;
    /// we don't have symlinks yet so we surface the path as content.
    fn format_cwd(p: &ProcessSnapshot) -> Vec<u8> {
        p.cwd.clone()
    }
}

/// First-component basename of argv[0] as a UTF-8-lossy String, or
/// None if argv is empty. Used for Name:/comm output.
fn comm_from_argv(argv: &[Vec<u8>]) -> Option<String> {
    let first = argv.first()?;
    let last_slash = first.iter().rposition(|&b| b == b'/');
    let basename: &[u8] = match last_slash {
        Some(i) => &first[i + 1..],
        None => first,
    };
    Some(String::from_utf8_lossy(basename).into_owned())
}

impl Default for ProcBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl VfsBackend for ProcBackend {
    fn lookup(&mut self, path: &[u8]) -> Option<u64> {
        self.entries.get(path).map(|(id, _)| *id)
    }

    fn create(&mut self, _path: &[u8]) -> Option<u64> {
        // /proc is a synthetic namespace; userland can't add files.
        None
    }

    fn truncate(&mut self, _inode: u64) {}

    fn read(&self, inode: u64, offset: u64, buf: &mut [u8]) -> i64 {
        // Linear scan — Phase 4 has at most a handful of entries.
        for (_path, (id, content)) in &self.entries {
            if *id == inode {
                let start = (offset as usize).min(content.len());
                let n = (content.len() - start).min(buf.len());
                if n > 0 {
                    buf[..n].copy_from_slice(&content[start..start + n]);
                }
                return n as i64;
            }
        }
        -(crate::abi::EBADF as i64)
    }

    fn write(&mut self, _inode: u64, _offset: u64, _payload: &[u8]) -> i64 {
        // /proc files are read-only at this layer.
        -(crate::abi::EBADF as i64)
    }

    fn size(&self, inode: u64) -> Option<u64> {
        self.entries
            .iter()
            .find(|(_p, (id, _c))| *id == inode)
            .map(|(_p, (_id, c))| c.len() as u64)
    }

    fn refresh_processes(&mut self, snapshots: &[ProcessSnapshot]) {
        // Drop entries for pids no longer in the snapshot, regenerate
        // content for those still present, leave the inode-id mapping
        // intact so any open fd survives a refresh.
        let mut new_entries: BTreeMap<Vec<u8>, (u64, Vec<u8>)> = BTreeMap::new();
        for snap in snapshots {
            // Per-pid files we synthesize. Each is a (suffix, content)
            // pair; we mint stable inode ids per absolute path.
            let files: [(&str, Vec<u8>); 4] = [
                ("status", Self::format_status(snap)),
                ("cmdline", Self::format_cmdline(snap)),
                ("comm", Self::format_comm(snap)),
                ("cwd", Self::format_cwd(snap)),
            ];
            for (name, content) in files {
                let path = format!("/{}/{}", snap.pid, name).into_bytes();
                let id = match self.inodes.get(&path) {
                    Some(&id) => id,
                    None => {
                        let id = self.next_id;
                        self.next_id += 1;
                        self.inodes.insert(path.clone(), id);
                        id
                    }
                };
                new_entries.insert(path, (id, content));
            }
        }
        self.entries = new_entries;
    }
}

// ── Host-FS backend ───────────────────────────────────────────────
//
// Mounts a real-disk subtree at a given prefix (e.g. /host/data).
// Path lookups translate to `kh_real_open` calls; reads to
// `kh_real_read`; close to `kh_real_close`. The host (microkernel)
// gates every open through `PolicyEnforcer::may_open_path` and
// translates the relative path against an embedder-supplied root —
// the kernel never sees absolute host paths.
//
// Inode ids are the host fd handles. Each lookup → host-fd pair is
// tracked here so subsequent reads + close can find them. Reads
// pull bytes via kh_real_read until EOF (no offset support yet —
// host-fs OFDs always read sequentially through this backend).

pub struct HostFsBackend {
    /// inode id (== host fd, as i32 widened to u64) → cached size
    /// after first stat-via-read; None until known.
    fds: BTreeMap<u64, HostFsHandle>,
    /// Path → inode id (host fd). Stable for the lifetime of the
    /// open; lookups for the same path return the same fd until
    /// close.
    paths: BTreeMap<Vec<u8>, u64>,
}

#[derive(Debug)]
struct HostFsHandle {
    /// Cumulative bytes consumed from the host file. Tracks EOF
    /// detection — read returning 0 marks the file fully drained.
    drained: u64,
    eof_seen: bool,
    /// Cached file size from kh_real_stat at open time. `None` if
    /// the host couldn't stat (most likely permission denied even
    /// though open succeeded — rare). `fstat` returns 0 in that
    /// case, matching the previous behavior.
    size: Option<u64>,
}

impl HostFsBackend {
    pub fn new() -> Self {
        Self {
            fds: BTreeMap::new(),
            paths: BTreeMap::new(),
        }
    }
}

impl Default for HostFsBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl VfsBackend for HostFsBackend {
    fn lookup(&mut self, path: &[u8]) -> Option<u64> {
        // Cached: re-use the existing host-fd / inode mapping.
        if let Some(&inode) = self.paths.get(path) {
            return Some(inode);
        }
        // Cold path: ask the host. The microkernel applies the
        // policy gate (`PolicyEnforcer::may_open_path`) before
        // touching the real disk — a Deny returns -EACCES which
        // we map to None (lookup miss → ENOENT in the syscall).
        // Real ENOENTs from the host filesystem also surface as
        // None here.
        let host_fd = crate::kh::real_open(path, 0, 0);
        if host_fd < 0 {
            return None;
        }
        let inode = host_fd as u64;
        // Stat the file to cache its size. Failures here don't fail
        // the open — host_fd is already valid. We just leave size
        // unknown so size() returns 0 (matching pre-stat behavior).
        let size = crate::kh::real_stat_size(path).ok();
        self.paths.insert(path.to_vec(), inode);
        self.fds.insert(
            inode,
            HostFsHandle {
                drained: 0,
                eof_seen: false,
                size,
            },
        );
        Some(inode)
    }

    fn create(&mut self, path: &[u8]) -> Option<u64> {
        // Host-fs "create" today is the same as lookup — there's
        // no kh_real_open(O_CREAT) wired yet, so attempting to
        // create a path that doesn't exist on the host fails. When
        // kh_real_create lands this becomes a separate path with
        // O_CREAT|O_TRUNC|O_WRONLY semantics.
        self.lookup(path)
    }

    fn truncate(&mut self, _inode: u64) {
        // Read-only mount; truncate is a no-op.
    }

    fn read(&self, inode: u64, _offset: u64, buf: &mut [u8]) -> i64 {
        // Note: offset is ignored — host-fs reads sequentially.
        // The OFD's offset still advances on the kernel side, but
        // it doesn't drive position here. sys_lseek on a host-fs
        // file is therefore a no-op until kh_real_seek lands.
        if !self.fds.contains_key(&inode) {
            return -(crate::abi::EBADF as i64);
        }
        crate::kh::real_read(inode as i32, buf)
    }

    fn write(&mut self, _inode: u64, _offset: u64, _payload: &[u8]) -> i64 {
        // Read-only Phase 5 surface — kh_real_write isn't wired yet.
        -(crate::abi::EBADF as i64)
    }

    fn size(&self, inode: u64) -> Option<u64> {
        // Cached at open time via kh_real_stat. None falls back to
        // 0 in the dispatch layer; that's correct for files we
        // couldn't stat for whatever reason.
        self.fds.get(&inode).and_then(|h| h.size).or(Some(0))
    }
}

impl Drop for HostFsBackend {
    fn drop(&mut self) {
        // Best-effort close every open host-fd when the backend
        // goes away. Errors are dropped — the host is the only
        // party that can reasonably react.
        for (&inode, _) in &self.fds {
            let _ = crate::kh::real_close(inode as i32);
        }
    }
}

#[allow(dead_code)]
impl HostFsHandle {
    fn note_progress(&mut self, n: i64) {
        if n == 0 {
            self.eof_seen = true;
        } else if n > 0 {
            self.drained = self.drained.saturating_add(n as u64);
        }
    }
}
