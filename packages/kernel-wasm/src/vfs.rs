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

/// Per-inode metadata kernels need to track *separately* from the
/// underlying storage. Files written through HostFs land on disk
/// with the host user's uid/gid; files inside a tar layer carry
/// the image-builder's metadata. Neither matches our sandbox's
/// view (uid=1000 by default, mode=0o644 etc.). The kernel keeps a
/// `(mount_id, inode) → Metadata` override map; sys_fstat consults
/// it; sys_chmod / sys_chown / sys_utimens (the last two TBD)
/// write to it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Metadata {
    pub uid: u32,
    pub gid: u32,
    /// POSIX mode bits — file type in the high nibble, perms in
    /// the low. e.g. 0o100644 for a regular file, rw-r--r--.
    pub mode: u32,
    pub mtime_ns: u64,
}

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
    /// Open (or create) `path`, returning the inode id. `flags`
    /// carries the same bits as `sys_open`:
    ///
    ///   bit 0: writable (O_WRONLY/O_RDWR)
    ///   bit 1: create-if-missing (O_CREAT)
    ///   bit 2: truncate (O_TRUNC) — applied after open by dispatch
    ///
    /// Returns `None` for "no such file" or "the backend refuses".
    /// Read-only backends (TarLayerBackend, ProcBackend, DevBackend)
    /// return None for the create bit; HostFsBackend forwards flags
    /// to `kh_real_open` so the write bit reaches the host.
    fn open(&mut self, path: &[u8], flags: u32) -> Option<u64>;

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

    /// Optional hook: backends that have native metadata (tar
    /// headers carry uid/gid/mode/mtime; host fs has them all)
    /// surface their best guess via this. The kernel composes
    /// override → default → fallback; default `None` means "no
    /// opinion" and the kernel uses its standard fallback
    /// (uid=0, gid=0, mode=0o100644 for regular files, mtime=0).
    fn default_metadata(&self, _inode: u64) -> Option<Metadata> {
        None
    }
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

    pub fn open(&mut self, path: &[u8], flags: u32) -> Option<(MountId, u64)> {
        let (id, rel) = self.resolve(path)?;
        self.mounts[id as usize]
            .backend
            .open(&rel, flags)
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

    /// Surface a backend's best-guess default metadata for an
    /// inode. The kernel composes this with its override map.
    pub fn default_metadata(&self, mount_id: MountId, inode: u64) -> Option<Metadata> {
        self.mounts
            .get(mount_id as usize)
            .and_then(|m| m.backend.default_metadata(inode))
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
        // No /host auto-mount — embedders configure HostFs via
        // `kernel_install_host_fs_mount` at whatever prefix fits.
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
    fn open(&mut self, path: &[u8], _flags: u32) -> Option<u64> {
        // /dev is a fixed namespace — flags are ignored. Unknown
        // paths return None; the create bit doesn't add new entries.
        match path {
            b"/null" => Some(DEV_NULL_INODE),
            b"/zero" => Some(DEV_ZERO_INODE),
            _ => None,
        }
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

impl RamfsBackend {
    /// Default metadata for files in the ramfs — regular files,
    /// 0o644 perms. Inode argument is ignored; ramfs doesn't track
    /// per-file metadata yet (would require a parallel map; the
    /// kernel's MetadataOverlay covers all our chmod/chown needs).
    fn ramfs_default_metadata() -> Metadata {
        Metadata {
            uid: 0,
            gid: 0,
            mode: 0o100_644,
            mtime_ns: 0,
        }
    }
}

impl VfsBackend for RamfsBackend {
    fn open(&mut self, path: &[u8], flags: u32) -> Option<u64> {
        if let Some(&id) = self.paths.get(path) {
            return Some(id);
        }
        // Create-if-missing on the create bit.
        if flags & 0b010 != 0 {
            return Some(self.install(path.to_vec(), Vec::new()));
        }
        None
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

    fn default_metadata(&self, _inode: u64) -> Option<Metadata> {
        Some(Self::ramfs_default_metadata())
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
        // Open with create-bit (0b010) so missing paths are made.
        mt.open(b"/etc/hello", 0b010).unwrap();
        let (sub_mount, sub_inode) = mt.open(b"/data/foo", 0b010).unwrap();
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
        // Open without create-bit on a missing path → None.
        assert!(mt.open(b"/missing", 0).is_none());
    }

    #[test]
    fn root_mount_is_id_zero() {
        let mt = MountTable::new(Box::new(RamfsBackend::new()));
        assert_eq!(ROOT_MOUNT, 0);
        let _ = mt; // keep MountTable construction tested.
    }

    #[test]
    fn overlay_reads_fall_through_to_lower() {
        // Lower has /etc/motd; upper is empty.
        let mut lower = RamfsBackend::new();
        lower.install(b"/etc/motd".to_vec(), b"from lower".to_vec());
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        let inode = overlay.open(b"/etc/motd", 0).unwrap();
        let mut buf = [0u8; 32];
        let n = overlay.read(inode, 0, &mut buf);
        assert_eq!(&buf[..n as usize], b"from lower");
    }

    #[test]
    fn overlay_upper_shadows_lower() {
        // Both layers have /file but upper wins.
        let mut lower = RamfsBackend::new();
        lower.install(b"/file".to_vec(), b"old".to_vec());
        let mut upper = RamfsBackend::new();
        upper.install(b"/file".to_vec(), b"new".to_vec());
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        let inode = overlay.open(b"/file", 0).unwrap();
        let mut buf = [0u8; 16];
        let n = overlay.read(inode, 0, &mut buf);
        assert_eq!(&buf[..n as usize], b"new");
    }

    #[test]
    fn overlay_create_lands_in_upper() {
        // Path doesn't exist anywhere; create in upper.
        let lower = RamfsBackend::new();
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        let inode = overlay.open(b"/new", 0b011 /* WRITE | CREAT */).unwrap();
        assert_eq!(overlay.write(inode, 0, b"hello"), 5);
        // Re-open read-only sees the upper content.
        let r = overlay.open(b"/new", 0).unwrap();
        let mut buf = [0u8; 16];
        let n = overlay.read(r, 0, &mut buf);
        assert_eq!(&buf[..n as usize], b"hello");
    }

    #[test]
    fn overlay_writable_open_of_lower_file_copies_up() {
        // /bin/python in lower; open it WRITE → copy-up.
        let mut lower = RamfsBackend::new();
        lower.install(
            b"/bin/python".to_vec(),
            b"#!/usr/bin/env python\nprint('lower')\n".to_vec(),
        );
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        // Writable open triggers copy-up. The fd we get back points
        // at the upper inode (now containing lower's bytes).
        let inode = overlay.open(b"/bin/python", 0b001 /* WRITE */).unwrap();

        // Verify we see lower's content via the upper inode.
        let mut buf = [0u8; 64];
        let n = overlay.read(inode, 0, &mut buf);
        assert!(
            &buf[..n as usize] == b"#!/usr/bin/env python\nprint('lower')\n",
            "expected copy-up to preserve lower content; got {:?}",
            &buf[..n as usize]
        );

        // Overwrite. Subsequent reads see the new bytes — lower is
        // shadowed permanently for this overlay.
        overlay.write(inode, 0, b"!!!");
        let mut buf = [0u8; 64];
        let n = overlay.read(inode, 0, &mut buf);
        // First three bytes are now "!!!", the rest is leftover
        // from lower (we wrote AT offset 0 without truncating).
        assert!(buf[..n as usize].starts_with(b"!!!"));
    }

    #[test]
    fn overlay_read_only_lower_file_keeps_lower_inode() {
        let mut lower = RamfsBackend::new();
        lower.install(b"/ro".to_vec(), b"data".to_vec());
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        // Read-only open returns a lower-tagged external id; writes
        // through it are -EBADF (the trait-level barrier — lower is
        // read-only via OverlayBackend's routing).
        let inode = overlay.open(b"/ro", 0).unwrap();
        let rc = overlay.write(inode, 0, b"NOPE");
        assert!(rc < 0, "write through lower-tagged fd should fail");
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
    fn open(&mut self, path: &[u8], _flags: u32) -> Option<u64> {
        // /proc is read-only synthetic — flags ignored, create-bit
        // doesn't apply. Existing paths return their current inode.
        self.entries.get(path).map(|(id, _)| *id)
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
    fn open(&mut self, path: &[u8], flags: u32) -> Option<u64> {
        // Cached: re-use the existing host-fd / inode mapping. The
        // cached fd was opened with whatever flags the *first*
        // caller used; subsequent opens with different flags share
        // it. POSIX-correct behavior would dup() with new flags;
        // Phase 5 keeps it simple — embedders that need separate
        // RW vs RO views close + reopen in between.
        if let Some(&inode) = self.paths.get(path) {
            return Some(inode);
        }
        // Cold path: ask the host. The microkernel applies the
        // policy gate (`PolicyEnforcer::may_open_path`) and root
        // canonicalization before touching the real disk — a Deny
        // returns -EACCES which we map to None (lookup miss →
        // ENOENT in the syscall).
        let host_fd = crate::kh::real_open(path, flags, 0);
        if host_fd < 0 {
            return None;
        }
        let inode = host_fd as u64;
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

    fn write(&mut self, inode: u64, _offset: u64, payload: &[u8]) -> i64 {
        // Phase 5: writes go straight to the host fd. Offset is
        // ignored — the host writes at its current cursor. Real
        // pwrite-style positioning lands when kh_real_pwrite does.
        if !self.fds.contains_key(&inode) {
            return -(crate::abi::EBADF as i64);
        }
        crate::kh::real_write(inode as i32, payload)
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

// ── Tar image-layer backend ───────────────────────────────────────
//
// Read-only mount served from an in-memory tar archive. The
// microkernel pushes the tar bytes once via
// `kernel_install_tar_layer`; we walk them at install time and
// build a path → (offset, len) index. Reads slice into the
// archive bytes — O(1) per read, zero copy beyond the response
// buffer fill.
//
// Phase 5 surface: uncompressed tar only. Zstd-wrapped tar
// (image-layer.tar.zst, the format the existing TS image-loader
// produces) lands as a follow-up: just `zstd::decode_all` the
// bytes before passing to TarLayerBackend::new.

pub struct TarLayerBackend {
    /// The full tar archive kept in memory. Reads slice into this.
    archive: Vec<u8>,
    /// path (relative to mount, with leading `/`) → (offset, len)
    /// pointing at the file's data range inside `archive`.
    files: BTreeMap<Vec<u8>, (u64, u64)>,
    /// path → stable inode id. Index is monotonic so opens of the
    /// same path return the same inode across the backend's life.
    inodes: BTreeMap<Vec<u8>, u64>,
    /// inode → metadata as the tar header reported it. Surface
    /// these via `default_metadata` so fstat without a chmod
    /// override still reflects the image-builder's intent
    /// (e.g. `/bin/python` arrives 0o755).
    metadata: BTreeMap<u64, Metadata>,
    next_id: u64,
}

impl TarLayerBackend {
    /// Build the index by walking the tar entries. Bad archives
    /// produce an empty backend — callers see -ENOENT for every
    /// path. (Phase 5: no error surface; if the embedder cares,
    /// it can pre-validate.)
    pub fn new(archive: Vec<u8>) -> Self {
        let mut files: BTreeMap<Vec<u8>, (u64, u64)> = BTreeMap::new();
        let mut inodes: BTreeMap<Vec<u8>, u64> = BTreeMap::new();
        let mut metadata: BTreeMap<u64, Metadata> = BTreeMap::new();
        let mut next_id: u64 = 1;
        let mut ar = tar::Archive::new(&archive[..]);
        if let Ok(entries) = ar.entries() {
            for entry in entries.flatten() {
                let header = entry.header();
                if header.entry_type() != tar::EntryType::Regular {
                    continue;
                }
                let Ok(path) = entry.path() else { continue };
                let path_str = path.to_string_lossy().into_owned();
                let mut p = if path_str.starts_with('/') {
                    path_str.into_bytes()
                } else {
                    let mut v = Vec::with_capacity(1 + path_str.len());
                    v.push(b'/');
                    v.extend_from_slice(path_str.as_bytes());
                    v
                };
                if p.ends_with(b"/") {
                    p.pop();
                }
                let offset = entry.raw_file_position();
                let len = header.size().unwrap_or(0);
                let inode_id = if let Some(&existing) = inodes.get(&p) {
                    existing
                } else {
                    let id = next_id;
                    next_id += 1;
                    inodes.insert(p.clone(), id);
                    id
                };
                files.insert(p, (offset, len));
                // Capture the header's view of metadata. Tar carries
                // POSIX-shaped uid/gid/mode + mtime; we store it raw
                // and let `default_metadata` surface it. mode bits
                // come back as the file-perm portion only; we OR in
                // 0o100000 to mark it as a regular file (the tar
                // entry-type filter above already restricts to that).
                let uid = header.uid().unwrap_or(0) as u32;
                let gid = header.gid().unwrap_or(0) as u32;
                let mode_bits = header.mode().unwrap_or(0o644) & 0o7777;
                let mtime = header.mtime().unwrap_or(0).saturating_mul(1_000_000_000);
                metadata.insert(
                    inode_id,
                    Metadata {
                        uid,
                        gid,
                        mode: 0o100_000 | mode_bits,
                        mtime_ns: mtime,
                    },
                );
            }
        }
        Self {
            archive,
            files,
            inodes,
            metadata,
            next_id,
        }
    }
}

impl VfsBackend for TarLayerBackend {
    fn open(&mut self, path: &[u8], flags: u32) -> Option<u64> {
        // Image layers are immutable; refuse the create bit and
        // any writable open. Read-only lookups return existing
        // inodes; missing paths return None.
        if flags & 0b011 != 0 {
            return None;
        }
        self.inodes.get(path).copied()
    }

    fn truncate(&mut self, _inode: u64) {}

    fn read(&self, inode: u64, offset: u64, buf: &mut [u8]) -> i64 {
        // Find the path for this inode (small N — linear scan is
        // fine for image layers up to a few thousand files; if it
        // matters we'll add an inode → range index).
        let entry = self
            .inodes
            .iter()
            .find(|(_p, &id)| id == inode)
            .and_then(|(p, _)| self.files.get(p));
        let Some(&(file_off, file_len)) = entry else {
            return -(crate::abi::EBADF as i64);
        };
        let start = (offset).min(file_len) as usize;
        let avail = (file_len as usize) - start;
        let n = avail.min(buf.len());
        if n > 0 {
            let abs_start = file_off as usize + start;
            buf[..n].copy_from_slice(&self.archive[abs_start..abs_start + n]);
        }
        n as i64
    }

    fn write(&mut self, _inode: u64, _offset: u64, _payload: &[u8]) -> i64 {
        -(crate::abi::EBADF as i64) // read-only image layer
    }

    fn size(&self, inode: u64) -> Option<u64> {
        self.inodes
            .iter()
            .find(|(_p, &id)| id == inode)
            .and_then(|(p, _)| self.files.get(p))
            .map(|&(_off, len)| len)
    }

    fn default_metadata(&self, inode: u64) -> Option<Metadata> {
        self.metadata.get(&inode).copied()
    }
}

// ── Overlay backend (YURTFS L1 + L2 union) ────────────────────────
//
// One logical filesystem composed of two VfsBackends: a read-only
// `lower` (the image — typically TarLayerBackend) and a writable
// `upper` (the overlay — RamfsBackend, future disk-backed indexfs,
// etc.). Reads check upper first, fall through to lower. Writes go
// to upper; first write of a lower-only file triggers copy-up.
//
// Inode-id namespace: this backend allocates *external* ids and
// keeps a side-table that maps each external id to (layer,
// internal_id). The kernel sees only external ids; reads/writes
// dispatch to the right layer.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layer {
    Upper,
    Lower,
}

pub struct OverlayBackend {
    lower: Box<dyn VfsBackend>,
    upper: Box<dyn VfsBackend>,
    /// External inode → (layer, internal inode). Stable across the
    /// backend's lifetime so OFDs survive copy-up.
    layered: BTreeMap<u64, (Layer, u64)>,
    /// Path → external inode cache. Populated lazily on open.
    paths: BTreeMap<Vec<u8>, u64>,
    next_id: u64,
}

impl OverlayBackend {
    pub fn new(lower: Box<dyn VfsBackend>, upper: Box<dyn VfsBackend>) -> Self {
        Self {
            lower,
            upper,
            layered: BTreeMap::new(),
            paths: BTreeMap::new(),
            next_id: 1,
        }
    }

    fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Copy-up: read the full content of `path` from lower, install
    /// it in upper, return the new upper inode. Used on first write
    /// to a lower-only file. Phase 6 surface — relies on
    /// `lower.size()` being accurate (Tar/Ramfs/HostFs all are).
    fn copy_up(&mut self, path: &[u8]) -> Option<u64> {
        let lower_inode = self.lower.open(path, 0)?;
        let len = self.lower.size(lower_inode).unwrap_or(0) as usize;
        let mut content = vec![0u8; len];
        if len > 0 {
            let n = self.lower.read(lower_inode, 0, &mut content);
            if n < 0 {
                return None;
            }
            content.truncate(n as usize);
        }
        // Open in upper with create+write so a new file is made.
        let upper_inode = self.upper.open(path, 0b011)?;
        // Truncate in case upper had some leftover state, then
        // write the lower bytes at offset 0.
        self.upper.truncate(upper_inode);
        let written = self.upper.write(upper_inode, 0, &content);
        if written < 0 {
            return None;
        }
        Some(upper_inode)
    }
}

impl VfsBackend for OverlayBackend {
    fn open(&mut self, path: &[u8], flags: u32) -> Option<u64> {
        let writable = flags & 0b001 != 0;
        let create = flags & 0b010 != 0;
        // Cache hit: re-use the existing external id only when the
        // cached layer is compatible with this open's intent. A
        // Lower-tagged cached id can serve any read; a writable open
        // needs Upper, so we drop the cache entry and re-resolve
        // through copy-up. Keep the layered entry — in-flight fds
        // referring to the old (Lower) external id stay valid; this
        // open returns a fresh Upper-tagged id.
        if let Some(&id) = self.paths.get(path) {
            let cached_layer = self.layered.get(&id).map(|(l, _)| *l);
            let cache_ok = !writable || matches!(cached_layer, Some(Layer::Upper));
            if cache_ok {
                return Some(id);
            }
            self.paths.remove(path);
        }

        // Step 1: check upper. If found there, that wins regardless
        // of intent — upper shadows lower.
        if let Some(upper_inode) = self.upper.open(path, flags) {
            let id = self.alloc_id();
            self.layered.insert(id, (Layer::Upper, upper_inode));
            self.paths.insert(path.to_vec(), id);
            return Some(id);
        }
        // Step 2: check lower. Read-only opens stay in lower;
        // writable opens trigger copy-up so the write lands in upper.
        if let Some(lower_inode) = self.lower.open(path, 0) {
            if writable {
                // Copy-up: lower content → upper, return upper inode.
                let upper_inode = self.copy_up(path)?;
                let id = self.alloc_id();
                self.layered.insert(id, (Layer::Upper, upper_inode));
                self.paths.insert(path.to_vec(), id);
                return Some(id);
            }
            let id = self.alloc_id();
            self.layered.insert(id, (Layer::Lower, lower_inode));
            self.paths.insert(path.to_vec(), id);
            return Some(id);
        }
        // Step 3: doesn't exist in either layer. If create-bit set,
        // create in upper; else miss.
        if create {
            let upper_inode = self.upper.open(path, flags)?;
            let id = self.alloc_id();
            self.layered.insert(id, (Layer::Upper, upper_inode));
            self.paths.insert(path.to_vec(), id);
            return Some(id);
        }
        None
    }

    fn truncate(&mut self, inode: u64) {
        match self.layered.get(&inode) {
            Some(&(Layer::Upper, inner)) => self.upper.truncate(inner),
            // Truncating a lower-only file is meaningless — lower is
            // read-only. Silently ignore (matches POSIX truncate-on-
            // O_TRUNC of a file with no write permission: error,
            // but we don't have an errno return on truncate yet).
            _ => {}
        }
    }

    fn read(&self, inode: u64, offset: u64, buf: &mut [u8]) -> i64 {
        match self.layered.get(&inode) {
            Some(&(Layer::Upper, inner)) => self.upper.read(inner, offset, buf),
            Some(&(Layer::Lower, inner)) => self.lower.read(inner, offset, buf),
            None => -(crate::abi::EBADF as i64),
        }
    }

    fn write(&mut self, inode: u64, offset: u64, payload: &[u8]) -> i64 {
        match self.layered.get(&inode) {
            Some(&(Layer::Upper, inner)) => self.upper.write(inner, offset, payload),
            // Writes through a lower-layer fd shouldn't happen —
            // open() routes writable opens to upper via copy-up. If
            // we get here it's a bug or a read-only fd; refuse.
            _ => -(crate::abi::EBADF as i64),
        }
    }

    fn size(&self, inode: u64) -> Option<u64> {
        match self.layered.get(&inode)? {
            (Layer::Upper, inner) => self.upper.size(*inner),
            (Layer::Lower, inner) => self.lower.size(*inner),
        }
    }
}
