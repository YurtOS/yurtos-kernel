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

use std::collections::{BTreeMap, BTreeSet};

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
    /// argv as raw bytes per arg. Empty if this pid was created
    /// without a spawn argv record.
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

    /// Optional errno from the last failed `open`. Most in-kernel
    /// backends use `None` so the caller maps failure to ENOENT or
    /// EPERM. HostFsBackend uses this to preserve host/policy errno.
    fn take_open_error(&mut self) -> Option<i32> {
        None
    }

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

    /// Remove `path` from the backend. Returns:
    ///   0  — success
    ///  -2  — path not found (`-ENOENT`)
    /// -30  — backend is read-only (`-EROFS`)
    /// Default impl is `-EROFS`; mutable backends override.
    fn unlink(&mut self, _path: &[u8]) -> i32 {
        -crate::abi::EROFS
    }

    /// Install a symlink at `link_path` pointing at `target`.
    /// Returns 0 on success, -EROFS if the backend is read-only,
    /// -EEXIST if a path is already there. Default: -EROFS.
    fn symlink(&mut self, _target: &[u8], _link_path: &[u8]) -> i32 {
        -crate::abi::EROFS
    }

    /// If `path` is a symlink, return its target bytes verbatim
    /// (resolution is the kernel's job, not the backend's).
    /// Returns None for non-symlinks or unknown paths.
    fn readlink(&self, _path: &[u8]) -> Option<Vec<u8>> {
        None
    }

    /// Create a directory at `path`. Returns 0 / -EEXIST / -EROFS.
    fn mkdir(&mut self, _path: &[u8]) -> i32 {
        -crate::abi::EROFS
    }

    /// Remove an empty directory. Returns 0 / -ENOENT / -ENOTEMPTY /
    /// -EROFS.
    fn rmdir(&mut self, _path: &[u8]) -> i32 {
        -crate::abi::EROFS
    }

    /// List immediate children of `path`. Returns the entry names
    /// (no leading directory portion). None means "no such
    /// directory" / "not a directory" / "backend doesn't track
    /// dirs". Empty Vec means "empty directory".
    fn readdir(&self, _path: &[u8]) -> Option<Vec<Vec<u8>>> {
        None
    }

    /// Classify an entry by absolute (mount-relative) path. Returns
    /// a WASI filetype byte: 0=UNKNOWN, 3=DIRECTORY, 4=REGULAR_FILE,
    /// 7=SYMBOLIC_LINK. The dispatch layer pairs each name returned
    /// from `readdir` with this byte so userland (libc readdir) sees
    /// the right `d_type` and avoids an extra stat per entry.
    /// Default: UNKNOWN — backends that don't implement it force
    /// userland to stat for the truth, which is correct, just slow.
    fn entry_type(&self, _path: &[u8]) -> u8 {
        0
    }

    /// Stable inode of `path` iff it is a directory. `None` ⇒ this
    /// backend does not support inode-anchored dirs (caller uses the
    /// path-snapshot degraded mode for that mount).
    fn dir_inode(&self, _path: &[u8]) -> Option<u64> {
        None
    }

    /// Resolve ONE component `name` directly under `dir_inode`.
    /// Returns `(child_inode, filetype)`; `filetype` is the existing
    /// WASI byte from `entry_type` (3=DIR,4=REG,7=SYMLINK). The child
    /// inode is `None` for symlinks (dispatch falls back to the
    /// path-based resolver — no fake inodes).
    fn resolve_at(&self, _dir_inode: u64, _name: &[u8]) -> Option<(Option<u64>, u8)> {
        None
    }

    /// Reverse: current absolute (mount-relative) path of a live dir
    /// inode; `None` if the inode is no longer a live directory
    /// (rmdir/unlink) — distinct from "backend unsupported".
    fn dir_path(&self, _dir_inode: u64) -> Option<Vec<u8>> {
        None
    }

    /// Create a hard link at `link_path` pointing at the same inode
    /// as `target`. Both paths are absolute on the backend (already
    /// stripped of any mount prefix by the dispatch layer). Returns
    /// 0 / -ENOENT (target missing) / -EEXIST (link_path occupied) /
    /// -EROFS (backend immutable). Default: -EPERM (backend has no
    /// concept of multiple paths sharing an inode).
    fn link(&mut self, _target: &[u8], _link_path: &[u8]) -> i32 {
        -crate::abi::EPERM
    }

    /// Atomically rename `old_path` to `new_path`. Same backend; the
    /// MountTable enforces same-mount before delegating. Default:
    /// -EROFS — backends that don't support mutation say so.
    fn rename(&mut self, _old_path: &[u8], _new_path: &[u8]) -> i32 {
        -crate::abi::EROFS
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

/// Compose a mount-ABSOLUTE path from a mount `prefix` (root mount =
/// `/`, others e.g. `/mnt` with no trailing slash) and a backend's
/// mount-RELATIVE `rel` (always starts `/`; the mount root is `/`).
/// Root mount: prefix `/` + rel `/d` ⇒ `/d`; prefix `/` + rel `/` ⇒
/// `/`. Non-root: prefix `/mnt` + rel `/` ⇒ `/mnt`; prefix `/mnt` +
/// rel `/d` ⇒ `/mnt/d`. Never doubles or drops the separator.
pub(crate) fn compose_mount_abspath(prefix: &[u8], rel: &[u8]) -> Vec<u8> {
    if prefix == b"/" {
        // Root mount: the mount-relative path *is* the absolute path
        // (matching `MountTable::resolve`'s root branch).
        return if rel.is_empty() {
            b"/".to_vec()
        } else {
            rel.to_vec()
        };
    }
    // Non-root mount: prefix + rel, where rel == b"/" means the mount
    // root itself (just the prefix).
    let mut out = prefix.to_vec();
    if rel != b"/" && !rel.is_empty() {
        if !rel.starts_with(b"/") {
            out.push(b'/');
        }
        out.extend_from_slice(rel);
    }
    out
}

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
        let root_mount = ROOT_MOUNT as usize;
        let mounts = vec![Mount {
            prefix: b"/".to_vec(),
            backend: root,
        }];
        debug_assert_eq!(root_mount, 0);
        Self { mounts }
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

    /// `(mount_id, dir_inode)` for an absolute path that is a
    /// directory in a backend supporting inode anchoring.
    // Consumed since B2.9 Task 5 (the `dir_anchor` helper in
    // dispatch/fs.rs: sys_open dir-branch / chdir / fchdir).
    pub fn dir_inode_at(&self, path: &[u8]) -> Option<(MountId, u64)> {
        let (mid, rel) = self.resolve(path)?;
        let ino = self.mounts[mid as usize].backend.dir_inode(&rel)?;
        Some((mid, ino))
    }

    /// One-component resolve within `(mount_id, dir_inode)`.
    // Consumed by the inode-anchored openat walk (B2.9 Task 6).
    pub fn resolve_at_in(
        &self,
        mount_id: MountId,
        dir_inode: u64,
        name: &[u8],
    ) -> Option<(Option<u64>, u8)> {
        self.mounts[mount_id as usize]
            .backend
            .resolve_at(dir_inode, name)
    }

    /// Live mount-relative path of `(mount_id, dir_inode)`.
    // Consumed by the PathResolver cwd-refresh invariant (B2.9 Task 6).
    pub fn dir_path_in(&self, mount_id: MountId, dir_inode: u64) -> Option<Vec<u8>> {
        self.mounts[mount_id as usize].backend.dir_path(dir_inode)
    }

    /// Absolute path prefix the mount is rooted at. The root mount
    /// reports `/`; a backend mounted at `/mnt` reports `/mnt` (no
    /// trailing slash, matching the `Mount::prefix` invariant). B2.9
    /// Task 6 composes this with `dir_path_in` so a refreshed cwd /
    /// `getcwd` is the mount-ABSOLUTE path, never mount-relative.
    pub fn mount_prefix(&self, mount_id: MountId) -> Vec<u8> {
        self.mounts[mount_id as usize].prefix.clone()
    }

    /// Public longest-prefix mount resolver: `(mount_id, relpath)` for
    /// an absolute path, mirroring the private `resolve`. B2.9 Task 6's
    /// openat walk uses it to detect a child-mount crossing (the
    /// reconstructed path resolves to a *different* mount than the
    /// dirfd's) so it can stop the inode walk and re-delegate to the
    /// path-based `sys_open` (which routes through this same
    /// longest-prefix logic).
    pub fn mount_of(&self, path: &[u8]) -> Option<(MountId, Vec<u8>)> {
        self.resolve(path)
    }

    /// Compose the mount-ABSOLUTE path of `(mount_id, dir_inode)` from
    /// the backend's live mount-relative `dir_path` and the mount
    /// prefix. `None` ⇒ the inode is no longer a live directory
    /// (rmdir/unlink) — callers map that to `ENOENT`. Normalizes the
    /// join so the root mount yields `/...` and a `/mnt` mount yields
    /// `/mnt/...` (never a doubled or missing separator).
    pub fn dir_abspath_in(&self, mount_id: MountId, dir_inode: u64) -> Option<Vec<u8>> {
        let rel = self.dir_path_in(mount_id, dir_inode)?;
        let prefix = self.mount_prefix(mount_id);
        Some(compose_mount_abspath(&prefix, &rel))
    }

    pub fn open(&mut self, path: &[u8], flags: u32) -> Option<(MountId, u64)> {
        let (id, rel) = self.resolve(path)?;
        self.mounts[id as usize]
            .backend
            .open(&rel, flags)
            .map(|inode| (id, inode))
    }

    pub fn open_result(&mut self, path: &[u8], flags: u32) -> Result<(MountId, u64), i32> {
        let Some((id, rel)) = self.resolve(path) else {
            return Err(crate::abi::ENOENT);
        };
        let backend = &mut self.mounts[id as usize].backend;
        match backend.open(&rel, flags) {
            Some(inode) => Ok((id, inode)),
            None => Err(backend.take_open_error().unwrap_or(crate::abi::ENOENT)),
        }
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

    pub fn write(&mut self, mount_id: MountId, inode: u64, offset: u64, payload: &[u8]) -> i64 {
        match self.mounts.get_mut(mount_id as usize) {
            Some(m) => m.backend.write(inode, offset, payload),
            None => -(crate::abi::EBADF as i64),
        }
    }

    pub fn size(&self, mount_id: MountId, inode: u64) -> Option<u64> {
        self.mounts
            .get(mount_id as usize)
            .and_then(|m| m.backend.size(inode))
    }

    /// Surface a backend's best-guess default metadata for an
    /// inode. The kernel composes this with its override map.
    pub fn default_metadata(&self, mount_id: MountId, inode: u64) -> Option<Metadata> {
        self.mounts
            .get(mount_id as usize)
            .and_then(|m| m.backend.default_metadata(inode))
    }

    /// Remove `path`. Routes to the owning backend's `unlink`. Returns
    /// 0 on success, negated POSIX errno otherwise.
    pub fn unlink(&mut self, path: &[u8]) -> i32 {
        let Some((id, rel)) = self.resolve(path) else {
            return -crate::abi::ENOENT;
        };
        self.mounts[id as usize].backend.unlink(&rel)
    }

    /// Create a symlink at `link_path` pointing at `target`. Routes to
    /// the backend that owns `link_path`. Returns 0 on success or
    /// negated POSIX errno.
    pub fn symlink(&mut self, target: &[u8], link_path: &[u8]) -> i32 {
        let Some((id, rel)) = self.resolve(link_path) else {
            return -crate::abi::ENOENT;
        };
        self.mounts[id as usize].backend.symlink(target, &rel)
    }

    /// Read the symlink at `path`. Returns target bytes if `path`
    /// resolves to a symlink, None otherwise.
    pub fn readlink(&self, path: &[u8]) -> Option<Vec<u8>> {
        let (id, rel) = self.resolve(path)?;
        self.mounts[id as usize].backend.readlink(&rel)
    }

    pub fn mkdir(&mut self, path: &[u8]) -> i32 {
        let Some((id, rel)) = self.resolve(path) else {
            return -crate::abi::ENOENT;
        };
        self.mounts[id as usize].backend.mkdir(&rel)
    }

    pub fn rmdir(&mut self, path: &[u8]) -> i32 {
        let Some((id, rel)) = self.resolve(path) else {
            return -crate::abi::ENOENT;
        };
        self.mounts[id as usize].backend.rmdir(&rel)
    }

    pub fn readdir(&self, path: &[u8]) -> Option<Vec<Vec<u8>>> {
        let (id, rel) = self.resolve(path)?;
        self.mounts[id as usize].backend.readdir(&rel)
    }

    pub fn entry_type(&self, path: &[u8]) -> u8 {
        let Some((id, rel)) = self.resolve(path) else {
            return 0;
        };
        self.mounts[id as usize].backend.entry_type(&rel)
    }

    /// Hard-link `link_path` to the same inode as `target`. Both
    /// must resolve to the same mount — POSIX disallows cross-
    /// device hard links, and our mount-id-tagged inodes don't
    /// translate across backends. Returns -EXDEV when they don't
    /// match.
    pub fn link(&mut self, target: &[u8], link_path: &[u8]) -> i32 {
        let Some((tid, t_rel)) = self.resolve(target) else {
            return -(crate::abi::ENOENT as i64) as i32;
        };
        let Some((lid, l_rel)) = self.resolve(link_path) else {
            return -(crate::abi::ENOENT as i64) as i32;
        };
        if tid != lid {
            return -(crate::abi::EXDEV as i64) as i32;
        }
        self.mounts[tid as usize].backend.link(&t_rel, &l_rel)
    }

    pub fn rename(&mut self, old_path: &[u8], new_path: &[u8]) -> i32 {
        let Some((oid, o_rel)) = self.resolve(old_path) else {
            return -(crate::abi::ENOENT as i64) as i32;
        };
        let Some((nid, n_rel)) = self.resolve(new_path) else {
            return -(crate::abi::ENOENT as i64) as i32;
        };
        if oid != nid {
            return -(crate::abi::EXDEV as i64) as i32;
        }
        self.mounts[oid as usize].backend.rename(&o_rel, &n_rel)
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
    /// path → symlink target bytes. Symlinks are tracked separately
    /// from regular files so lookup paths can fall through to
    /// readlink without colliding with regular-file inode numbers.
    symlinks: BTreeMap<Vec<u8>, Vec<u8>>,
    /// path → stable dir inode. mkdir mints (from `next_id`, the
    /// same counter `install` uses for file inodes — one
    /// collision-free id space within ramfs); rmdir frees both
    /// sides. Dir inodes never enter `inodes`/`refcount`:
    /// directories have no byte content and no hardlinks (isolation
    /// invariant). readdir filters self.paths/symlinks by parent.
    /// Phase 8: directories carry no metadata of their own beyond
    /// the implicit "this path is a dir" marker; future MetadataOverlay
    /// stores dir-level uid/gid/mode independently.
    dir_inodes: BTreeMap<Vec<u8>, u64>,
    /// reverse: dir inode → current path. Moved (never reused) on
    /// directory rename; removed on rmdir. Backs `dir_path`.
    dir_paths: BTreeMap<u64, Vec<u8>>,
    /// inode → number of paths referring to it. Bumped by install
    /// (creating a new path) and by `link`; decremented by `unlink`.
    /// When the count hits zero the inode buffer in `inodes` is
    /// dropped — that's the moment a hardlinked file actually
    /// disappears, *not* the first unlink.
    refcount: BTreeMap<u64, u32>,
    next_id: u64,
}

impl RamfsBackend {
    pub fn new() -> Self {
        let mut dir_inodes = BTreeMap::new();
        let mut dir_paths = BTreeMap::new();
        // Fixed root dir inode (id 0 is reserved for it; next_id
        // starts at 1 for everything else — unchanged).
        dir_inodes.insert(b"/".to_vec(), 0u64);
        dir_paths.insert(0u64, b"/".to_vec());
        Self {
            inodes: BTreeMap::new(),
            paths: BTreeMap::new(),
            symlinks: BTreeMap::new(),
            dir_inodes,
            dir_paths,
            refcount: BTreeMap::new(),
            next_id: 1,
        }
    }

    /// Parent path of `p` — the directory `readdir` would list to
    /// see this entry. Used for the readdir "is this entry under
    /// `path`?" check. `/foo` → `/`; `/foo/bar` → `/foo`.
    fn parent_of(p: &[u8]) -> Vec<u8> {
        if let Some(idx) = p.iter().rposition(|&b| b == b'/') {
            if idx == 0 {
                b"/".to_vec()
            } else {
                p[..idx].to_vec()
            }
        } else {
            b"/".to_vec()
        }
    }

    /// Last path component (basename) of `p`.
    fn basename(p: &[u8]) -> Vec<u8> {
        if let Some(idx) = p.iter().rposition(|&b| b == b'/') {
            p[idx + 1..].to_vec()
        } else {
            p.to_vec()
        }
    }

    /// Install or replace a path's content. Used by the kernel_host_interface
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
        self.refcount.insert(id, 1);
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

/// Fixed dir inode for the `/dev` mount root. `0` is reserved for it
/// (the device files use 1/2), mirroring the ramfs/proc convention of
/// reserving id 0 for the mount root directory.
const DEV_ROOT_INODE: u64 = 0;
const DEV_NULL_INODE: u64 = 1;
const DEV_ZERO_INODE: u64 = 2;
const DEV_URANDOM_INODE: u64 = 3;
const DEV_RANDOM_INODE: u64 = 4;

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
            b"/urandom" => Some(DEV_URANDOM_INODE),
            b"/random" => Some(DEV_RANDOM_INODE),
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
            DEV_URANDOM_INODE | DEV_RANDOM_INODE => {
                // /dev/random == /dev/urandom (modern Linux semantics;
                // matches packages/kernel/src/vfs/dev-provider.ts). Never
                // short. `&self` is fine: fill_random holds no RNG state.
                match crate::kh::fill_random(buf) {
                    Ok(()) => buf.len() as i64,
                    Err(rc) => rc as i64,
                }
            }
            _ => -(crate::abi::EBADF as i64),
        }
    }

    fn write(&mut self, inode: u64, _offset: u64, payload: &[u8]) -> i64 {
        match inode {
            DEV_NULL_INODE | DEV_ZERO_INODE | DEV_URANDOM_INODE | DEV_RANDOM_INODE => {
                payload.len() as i64 // swallowed like /dev/null
            }
            _ => -(crate::abi::EBADF as i64),
        }
    }

    fn size(&self, inode: u64) -> Option<u64> {
        match inode {
            DEV_NULL_INODE | DEV_ZERO_INODE | DEV_URANDOM_INODE | DEV_RANDOM_INODE => Some(0),
            _ => None,
        }
    }

    fn dir_inode(&self, path: &[u8]) -> Option<u64> {
        // Fixed namespace: only the mount root `/` is a directory.
        (path == b"/").then_some(DEV_ROOT_INODE)
    }

    fn dir_path(&self, dir_inode: u64) -> Option<Vec<u8>> {
        (dir_inode == DEV_ROOT_INODE).then(|| b"/".to_vec())
    }

    fn resolve_at(&self, dir_inode: u64, name: &[u8]) -> Option<(Option<u64>, u8)> {
        if dir_inode != DEV_ROOT_INODE {
            return None;
        }
        // Hardcoded /dev table. All entries are regular device files
        // (WASI filetype 4); no subdirectories or symlinks in /dev.
        match name {
            b"null" => Some((Some(DEV_NULL_INODE), 4)),
            b"zero" => Some((Some(DEV_ZERO_INODE), 4)),
            b"urandom" => Some((Some(DEV_URANDOM_INODE), 4)),
            b"random" => Some((Some(DEV_RANDOM_INODE), 4)),
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

    fn unlink(&mut self, path: &[u8]) -> i32 {
        // Symlinks unlink the same way as regular files (and have
        // no refcount — each symlink is its own entity).
        if self.symlinks.remove(path).is_some() {
            return 0;
        }
        let Some(id) = self.paths.remove(path) else {
            return -crate::abi::ENOENT;
        };
        // Decrement refcount; only drop the inode buffer when the
        // last path goes away. This is what makes hard links work.
        let remaining = self
            .refcount
            .get_mut(&id)
            .map(|c| {
                *c = c.saturating_sub(1);
                *c
            })
            .unwrap_or(0);
        if remaining == 0 {
            self.inodes.remove(&id);
            self.refcount.remove(&id);
        }
        0
    }

    fn link(&mut self, target: &[u8], link_path: &[u8]) -> i32 {
        let Some(&id) = self.paths.get(target) else {
            return -(crate::abi::ENOENT as i64) as i32;
        };
        if self.paths.contains_key(link_path)
            || self.symlinks.contains_key(link_path)
            || self.dir_inodes.contains_key(link_path)
        {
            return -(crate::abi::EEXIST as i64) as i32;
        }
        self.paths.insert(link_path.to_vec(), id);
        let refs = self.refcount.entry(id).or_insert(0);
        *refs = refs.saturating_add(1);
        0
    }

    fn entry_type(&self, path: &[u8]) -> u8 {
        if path == b"/" || self.dir_inodes.contains_key(path) {
            3 // DIRECTORY
        } else if self.symlinks.contains_key(path) {
            7 // SYMBOLIC_LINK
        } else if self.paths.contains_key(path) {
            4 // REGULAR_FILE
        } else {
            0
        }
    }

    fn dir_inode(&self, path: &[u8]) -> Option<u64> {
        self.dir_inodes.get(path).copied()
    }

    fn dir_path(&self, dir_inode: u64) -> Option<Vec<u8>> {
        self.dir_paths.get(&dir_inode).cloned()
    }

    fn resolve_at(&self, dir_inode: u64, name: &[u8]) -> Option<(Option<u64>, u8)> {
        // Anchor on the live path of `dir_inode`. `None` ⇒ the inode
        // is no longer a directory (rmdir/rename freed it).
        let base = self.dir_paths.get(&dir_inode)?;
        // Join `name` under the base without doubling the separator:
        // root "/" + "f" = "/f"; "/d" + "f" = "/d/f".
        let mut child = base.clone();
        if child.last() != Some(&b'/') {
            child.push(b'/');
        }
        child.extend_from_slice(name);
        // Classify via the existing WASI filetype byte. Dir/file
        // inodes come from the same maps `dir_inode`/`open` use;
        // symlinks carry no inode (dispatch takes the path fallback).
        match self.entry_type(&child) {
            3 => Some((self.dir_inodes.get(&child).copied(), 3)),
            4 => Some((self.paths.get(&child).copied(), 4)),
            7 => Some((None, 7)),
            _ => None,
        }
    }

    fn rename(&mut self, old_path: &[u8], new_path: &[u8]) -> i32 {
        if old_path == new_path {
            return 0;
        }
        // The root dir inode backs the global cwd/dirfd anchor; it can
        // never be moved (POSIX rename of "/" is EBUSY). Without this
        // guard, renaming "/" re-keys inode 0 to the new path and
        // orphans every top-level entry. (rename ONTO "/" is already
        // refused EEXIST by the dir-destination check below.)
        if old_path == b"/" {
            return -(crate::abi::EBUSY as i64) as i32;
        }
        // Source must exist (regular file, symlink, or directory).
        let src_kind = if self.paths.contains_key(old_path) {
            1u8
        } else if self.symlinks.contains_key(old_path) {
            2
        } else if self.dir_inodes.contains_key(old_path) {
            3
        } else {
            return -(crate::abi::ENOENT as i64) as i32;
        };
        if src_kind == 3 {
            let mut descendant_prefix = old_path.to_vec();
            descendant_prefix.push(b'/');
            if new_path.starts_with(&descendant_prefix) {
                return -(crate::abi::EINVAL as i64) as i32;
            }
        }
        // The destination's parent directory must exist (POSIX
        // ENOENT). `MountTable::rename` only proves both paths route
        // to the same mount, not that the parent is real, so without
        // this the recursive dir re-key — and the dir-inode reverse
        // map — would publish a ghost subtree under a non-existent
        // parent that an open dirfd/cwd could keep resolving. Same
        // shape as the `mkdir` parent check; `parent_of` yields the
        // always-present root "/" for a top-level destination.
        if !self.dir_inodes.contains_key(&Self::parent_of(new_path)) {
            return -crate::abi::ENOENT;
        }
        // Destination handling: refuse if it's a directory (POSIX
        // requires the destination be empty, and we don't yet
        // walk children to check). Replace a regular file by
        // unlinking it first; replace a symlink the same way.
        if self.dir_inodes.contains_key(new_path) {
            return -(crate::abi::EEXIST as i64) as i32;
        }
        // POSIX: a directory may only replace an (empty) directory.
        // If the source is a directory and the destination exists as a
        // non-directory (regular file or symlink), fail ENOTDIR rather
        // than unlinking it below and moving the dir there (data loss).
        if src_kind == 3
            && (self.paths.contains_key(new_path) || self.symlinks.contains_key(new_path))
        {
            return -(crate::abi::ENOTDIR as i64) as i32;
        }
        if self.paths.contains_key(new_path) {
            self.unlink(new_path);
        } else if self.symlinks.contains_key(new_path) {
            self.symlinks.remove(new_path);
        }
        match src_kind {
            1 => {
                let id = self.paths.remove(old_path).expect("checked above");
                self.paths.insert(new_path.to_vec(), id);
            }
            2 => {
                let target = self.symlinks.remove(old_path).expect("checked above");
                self.symlinks.insert(new_path.to_vec(), target);
            }
            _ => {
                // Directory rename: re-key every descendant from the
                // old prefix to the new prefix. Inode ids are
                // preserved (only path keys move) so open file OFDs
                // (which hold `inode`, not path) and every dir inode
                // survive the parent-dir rename unchanged. Per the
                // isolation invariant we touch ONLY the path-keyed
                // maps (`paths`, `symlinks`, `dir_inodes`,
                // `dir_paths`) and never `inodes`/`refcount` — file
                // content and hardlink counts must survive untouched.
                //
                // A key `k` is in the subtree iff `k == old_path` OR
                // `k` starts with `old_path + "/"` — an exact prefix
                // boundary so `/base` never catches `/baseball`.
                let mut prefix = old_path.to_vec();
                prefix.push(b'/');
                let in_subtree = |k: &[u8]| k == old_path || k.starts_with(&prefix);
                let remap = |k: &[u8]| {
                    let mut nk = new_path.to_vec();
                    nk.extend_from_slice(&k[old_path.len()..]);
                    nk
                };

                // Files (path → inode): inode id unchanged.
                let moved: Vec<(Vec<u8>, u64)> = self
                    .paths
                    .iter()
                    .filter(|(k, _)| in_subtree(k))
                    .map(|(k, v)| (k.clone(), *v))
                    .collect();
                for (k, id) in moved {
                    self.paths.remove(&k);
                    self.paths.insert(remap(&k), id);
                }

                // Symlinks (path → target): target text unchanged.
                let moved: Vec<(Vec<u8>, Vec<u8>)> = self
                    .symlinks
                    .iter()
                    .filter(|(k, _)| in_subtree(k))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                for (k, target) in moved {
                    self.symlinks.remove(&k);
                    self.symlinks.insert(remap(&k), target);
                }

                // Dir inodes (forward + reverse), preserving ids.
                let moved: Vec<(Vec<u8>, u64)> = self
                    .dir_inodes
                    .iter()
                    .filter(|(k, _)| in_subtree(k))
                    .map(|(k, v)| (k.clone(), *v))
                    .collect();
                for (k, id) in moved {
                    self.dir_inodes.remove(&k);
                    let nk = remap(&k);
                    self.dir_inodes.insert(nk.clone(), id);
                    self.dir_paths.insert(id, nk);
                }
            }
        }
        0
    }

    fn symlink(&mut self, target: &[u8], link_path: &[u8]) -> i32 {
        if self.paths.contains_key(link_path) || self.symlinks.contains_key(link_path) {
            return -crate::abi::EEXIST;
        }
        self.symlinks.insert(link_path.to_vec(), target.to_vec());
        0
    }

    fn readlink(&self, path: &[u8]) -> Option<Vec<u8>> {
        self.symlinks.get(path).cloned()
    }

    fn mkdir(&mut self, path: &[u8]) -> i32 {
        if self.paths.contains_key(path)
            || self.symlinks.contains_key(path)
            || self.dir_inodes.contains_key(path)
        {
            return -crate::abi::EEXIST;
        }
        let parent = Self::parent_of(path);
        if !self.dir_inodes.contains_key(&parent) {
            return -crate::abi::ENOENT;
        }
        // Mint a fresh stable dir inode (forward + reverse). Shares
        // `next_id` with file inodes but never enters
        // `inodes`/`refcount` — dirs have no content/hardlinks.
        let id = self.next_id;
        self.next_id += 1;
        self.dir_inodes.insert(path.to_vec(), id);
        self.dir_paths.insert(id, path.to_vec());
        0
    }

    fn rmdir(&mut self, path: &[u8]) -> i32 {
        // The root dir inode backs the global cwd/dirfd anchor; it can
        // never be freed (POSIX `rmdir("/")` is EBUSY). Without this
        // an empty ramfs would fall through the emptiness walk below
        // and delete dir_inodes["/"]/dir_paths[0].
        if path == b"/" {
            return -crate::abi::EBUSY;
        }
        if !self.dir_inodes.contains_key(path) {
            return -crate::abi::ENOENT; // (or ENOTDIR for a regular file)
        }
        // Empty check: walk children. A child is any tracked path
        // whose parent is `path`.
        for p in self
            .paths
            .keys()
            .chain(self.symlinks.keys())
            .chain(self.dir_inodes.keys())
        {
            if p == path {
                continue;
            }
            if Self::parent_of(p) == path {
                return -crate::abi::ENOTEMPTY;
            }
        }
        // Free both sides of the dir-inode mapping.
        if let Some(id) = self.dir_inodes.remove(path) {
            self.dir_paths.remove(&id);
        }
        0
    }

    fn readdir(&self, path: &[u8]) -> Option<Vec<Vec<u8>>> {
        // Treat root "/" as always-extant; otherwise require a
        // mkdir record. (Root is implicit; mkdir on "/" would
        // -EEXIST anyway.)
        let exists = path == b"/" || self.dir_inodes.contains_key(path);
        if !exists {
            // If the path resolves to a regular file we should
            // surface -ENOTDIR via the dispatch layer; "None" here
            // means "no such directory" → caller maps to -ENOENT.
            return None;
        }
        let mut entries: Vec<Vec<u8>> = Vec::new();
        for p in self
            .paths
            .keys()
            .chain(self.symlinks.keys())
            .chain(self.dir_inodes.keys())
        {
            if p == path {
                continue;
            }
            if Self::parent_of(p) == path {
                entries.push(Self::basename(p));
            }
        }
        entries.sort();
        entries.dedup(); // dirs/symlinks/files at the same path can't really collide,
                         // but defensive.
        Some(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devbackend_urandom_and_random_yield_entropy() {
        let mut dev = DevBackend::new();
        for name in [b"/urandom".as_slice(), b"/random".as_slice()] {
            let inode = dev.open(name, 0).expect("node exists");
            let mut a = [0u8; 48];
            let mut b = [0u8; 48];
            assert_eq!(dev.read(inode, 0, &mut a), 48, "fills whole buffer");
            assert_eq!(dev.read(inode, 0, &mut b), 48);
            assert!(a.iter().any(|&x| x != 0), "all-zero draw");
            assert_ne!(a, b, "identical draws");
            // Writes are swallowed like /dev/null; size is 0.
            assert_eq!(dev.write(inode, 0, b"discard me"), 10);
            assert_eq!(dev.size(inode), Some(0));
        }
        // Unknown /dev/* still unmapped.
        assert_eq!(dev.open(b"/nope", 0), None);
    }

    #[test]
    fn devbackend_random_preserves_host_memory_fault_errno() {
        let _g = crate::kernel::TestGuard::acquire();
        crate::kh::test_support::push_random_result(Err(-crate::abi::EFAULT));
        let mut dev = DevBackend::new();
        let inode = dev.open(b"/urandom", 0).expect("node exists");
        let mut buf = [0u8; 8];

        assert_eq!(dev.read(inode, 0, &mut buf), -(crate::abi::EFAULT as i64));
    }

    #[test]
    fn vfs_backend_dir_handle_api_defaults_to_none() {
        // The default-`None` contract is asserted via a backend that
        // keeps the trait defaults. RamfsBackend (Task 2) and now
        // proc/tar/dev (Task 4) all override the dir-handle API, so
        // HostFsBackend — the permanent path-snapshot degraded-mode
        // backend (host renames are invisible to us; spec §2) — is the
        // remaining backend that intentionally keeps the trait defaults.
        let b = HostFsBackend::new();
        assert_eq!(b.dir_inode(b"/"), None);
        assert_eq!(b.resolve_at(0, b"x"), None);
        assert_eq!(b.dir_path(0), None);
    }

    #[test]
    fn ramfs_dirs_have_stable_inodes_minted_and_freed() {
        let mut b = RamfsBackend::new();
        let root = b.dir_inode(b"/").expect("root has a fixed dir inode");
        assert_eq!(b.mkdir(b"/d"), 0);
        let d = b.dir_inode(b"/d").expect("mkdir mints a dir inode");
        assert_ne!(d, root);
        assert_eq!(b.dir_inode(b"/d"), Some(d), "inode stable across lookups");
        assert_eq!(b.rmdir(b"/d"), 0);
        assert_eq!(b.dir_inode(b"/d"), None, "rmdir frees the inode");
        assert_eq!(b.dir_path(d), None, "reverse map freed too");
    }

    #[test]
    fn ramfs_dir_rename_recursively_rekeys_children() {
        let mut b = RamfsBackend::new();
        assert_eq!(b.mkdir(b"/base"), 0);
        assert_eq!(b.mkdir(b"/base/sub"), 0);
        let sub_ino = b.dir_inode(b"/base/sub").unwrap();
        // File under the subtree (real install API: owned Vecs,
        // returns the file inode id).
        let file_ino = b.install(b"/base/sub/f".to_vec(), b"hi".to_vec());

        assert_eq!(b.rename(b"/base", b"/renamed"), 0);

        // Children reachable at the new prefix, gone at the old.
        assert_eq!(b.entry_type(b"/renamed/sub/f"), 4, "file re-keyed");
        assert_eq!(b.entry_type(b"/base/sub/f"), 0, "old key gone");

        // Dir inode ids preserved (only path keys moved).
        assert_eq!(b.dir_inode(b"/renamed/sub"), Some(sub_ino));
        assert_eq!(b.dir_path(sub_ino).as_deref(), Some(&b"/renamed/sub"[..]));

        // Isolation invariant: the FILE inode id is preserved across
        // the rename (only the path key moved). This is exactly what
        // keeps an open file's OFD — which holds the inode, not the
        // path — valid after a parent-dir rename. Verified two ways:
        // (1) the path→inode map still yields the original id at the
        //     new key, and
        // (2) the content is still readable via that inode.
        assert_eq!(
            b.paths.get(b"/renamed/sub/f".as_slice()).copied(),
            Some(file_ino),
            "file inode id preserved across rename (OFDs unaffected)"
        );
        let mut buf = [0u8; 8];
        let n = b.read(file_ino, 0, &mut buf);
        assert_eq!(
            &buf[..n.max(0) as usize],
            b"hi",
            "content survives via inode"
        );
    }

    #[test]
    fn ramfs_dir_rename_into_own_descendant_is_einval() {
        let mut b = RamfsBackend::new();
        assert_eq!(b.mkdir(b"/a"), 0);
        assert_eq!(b.mkdir(b"/a/b"), 0);
        let a_ino = b.dir_inode(b"/a").unwrap();
        let b_ino = b.dir_inode(b"/a/b").unwrap();
        let file_ino = b.install(b"/a/f".to_vec(), b"x".to_vec());

        assert_eq!(
            b.rename(b"/a", b"/a/b/c"),
            -(crate::abi::EINVAL as i64) as i32
        );

        assert_eq!(b.dir_inode(b"/a"), Some(a_ino));
        assert_eq!(b.dir_inode(b"/a/b"), Some(b_ino));
        assert_eq!(b.dir_inode(b"/a/b/c"), None);
        assert_eq!(b.paths.get(b"/a/f".as_slice()).copied(), Some(file_ino));
        assert_eq!(b.entry_type(b"/a/b/c/f"), 0);
    }

    #[test]
    fn ramfs_root_is_protected_from_rmdir_and_rename() {
        // The root dir inode (id 0) backs the global cwd/dirfd
        // inode-anchor invariant: every Process::new default cwd and
        // `dir_inode_at("/")` resolve through it. `rmdir("/")` /
        // `rename("/", …)` must NOT be able to free or move it (POSIX
        // EBUSY), or the anchor breaks process-wide.
        let mut b = RamfsBackend::new();
        let root = b.dir_inode(b"/").expect("root inode exists");

        // rmdir("/") on an empty ramfs would otherwise fall through
        // the emptiness walk and delete dir_inodes["/"]/dir_paths[0].
        assert_eq!(b.rmdir(b"/"), -(crate::abi::EBUSY as i64) as i32);
        assert_eq!(b.dir_inode(b"/"), Some(root), "root survives rmdir(/)");
        assert_eq!(b.dir_path(root).as_deref(), Some(&b"/"[..]));

        // rename("/", "/new") would otherwise re-key inode 0 to /new
        // and orphan every top-level entry.
        assert_eq!(b.rename(b"/", b"/new"), -(crate::abi::EBUSY as i64) as i32);
        assert_eq!(b.dir_inode(b"/"), Some(root), "root inode unchanged");
        assert_eq!(b.dir_inode(b"/new"), None, "no phantom /new anchor");
        assert_eq!(b.dir_path(root).as_deref(), Some(&b"/"[..]));
    }

    #[test]
    fn ramfs_rename_into_missing_parent_is_enoent() {
        // POSIX: rename fails ENOENT when a directory component of the
        // destination does not exist. Without this guard the recursive
        // dir re-key publishes a ghost subtree, and the new dir-inode
        // reverse map reports its live path under a non-existent
        // parent — an open dirfd/cwd could keep resolving/creating
        // inside an unreachable tree. (mkdir already guards this.)
        let mut b = RamfsBackend::new();
        assert_eq!(b.mkdir(b"/a"), 0);
        assert_eq!(b.mkdir(b"/a/sub"), 0);
        let a_ino = b.dir_inode(b"/a").unwrap();
        let sub_ino = b.dir_inode(b"/a/sub").unwrap();

        // Directory source, missing destination parent "/missing".
        assert_eq!(b.rename(b"/a", b"/missing/a"), -crate::abi::ENOENT);
        assert_eq!(b.dir_inode(b"/a"), Some(a_ino), "source dir unmoved");
        assert_eq!(b.dir_inode(b"/missing/a"), None, "no ghost dir inode");
        assert_eq!(b.dir_inode(b"/a/sub"), Some(sub_ino), "subtree unmoved");
        assert_eq!(
            b.dir_path(a_ino).as_deref(),
            Some(&b"/a"[..]),
            "reverse map not moved to a ghost path"
        );

        // Regular-file source, same missing parent → same ENOENT
        // (the destination-parent rule is type-agnostic).
        let f_ino = b.install(b"/f".to_vec(), b"x".to_vec());
        assert_eq!(b.rename(b"/f", b"/missing/f"), -crate::abi::ENOENT);
        assert_eq!(
            b.paths.get(b"/f".as_slice()).copied(),
            Some(f_ino),
            "file unmoved"
        );
        assert_eq!(b.paths.get(b"/missing/f".as_slice()), None, "no ghost file");
    }

    #[test]
    fn ramfs_rename_dir_onto_non_dir_is_enotdir() {
        // POSIX: if the source is a directory, the destination must
        // not exist or be an empty directory. Renaming a dir onto a
        // regular file (or a symlink) must fail ENOTDIR — NOT silently
        // unlink the destination and move the dir there (data loss).
        let mut b = RamfsBackend::new();
        assert_eq!(b.mkdir(b"/d"), 0);
        let d_ino = b.dir_inode(b"/d").unwrap();
        let f_ino = b.install(b"/f".to_vec(), b"keep".to_vec());

        assert_eq!(b.rename(b"/d", b"/f"), -crate::abi::ENOTDIR);
        assert_eq!(
            b.paths.get(b"/f".as_slice()).copied(),
            Some(f_ino),
            "destination file must not be unlinked"
        );
        assert_eq!(b.dir_inode(b"/d"), Some(d_ino), "source dir unmoved");
        assert_eq!(b.dir_inode(b"/f"), None, "dir not placed at /f");

        // A symlink destination is also not a directory → ENOTDIR.
        assert_eq!(b.symlink(b"/target", b"/ln"), 0);
        assert_eq!(b.rename(b"/d", b"/ln"), -crate::abi::ENOTDIR);
        assert_eq!(b.dir_inode(b"/d"), Some(d_ino), "source dir still unmoved");
        assert_eq!(b.dir_inode(b"/ln"), None);
    }

    #[test]
    fn ramfs_resolve_at_classifies_children() {
        let mut b = RamfsBackend::new();
        assert_eq!(b.mkdir(b"/d"), 0);
        assert_eq!(b.mkdir(b"/d/sub"), 0);
        let file_ino = b.install(b"/d/f".to_vec(), b"x".to_vec());
        // Real symlink API: (target, link_path) — target first.
        assert_eq!(b.symlink(b"/target", b"/d/ln"), 0);
        let d = b.dir_inode(b"/d").unwrap();

        // Directory child: filetype 3, child dir inode present.
        assert_eq!(b.resolve_at(d, b"sub").map(|(_, t)| t), Some(3));
        assert!(matches!(b.resolve_at(d, b"sub"), Some((Some(_), 3))));
        assert_eq!(
            b.resolve_at(d, b"sub").and_then(|(i, _)| i),
            b.dir_inode(b"/d/sub")
        );

        // Regular file: filetype 4, file inode present.
        assert_eq!(b.resolve_at(d, b"f"), Some((Some(file_ino), 4)));

        // Symlink: filetype 7, NO inode (dispatch path-fallback).
        assert_eq!(b.resolve_at(d, b"ln"), Some((None, 7)));

        // Missing child → None.
        assert_eq!(b.resolve_at(d, b"missing"), None);

        // Root-base join must not double-slash: /<name>, not //<name>.
        let root = b.dir_inode(b"/").unwrap();
        assert_eq!(b.resolve_at(root, b"d"), Some((Some(d), 3)));
    }

    #[test]
    fn proc_resolve_at_lists_pid_dirs() {
        let mut b = ProcBackend::new();
        // Seed via the real refresh_processes API (the only way proc
        // entries exist). One process → /7/{status,cmdline,comm,cwd}.
        let snap = ProcessSnapshot {
            pid: 7,
            ppid: 1,
            uid: 0,
            euid: 0,
            gid: 0,
            egid: 0,
            pgid: 7,
            sid: 7,
            argv: vec![b"/bin/sh".to_vec()],
            cwd: b"/".to_vec(),
        };
        b.refresh_processes(&[snap]);

        let root = b.dir_inode(b"/").expect("proc root has a dir inode");
        let pid7 = b.dir_inode(b"/7").expect("per-pid dir has an inode");
        assert_ne!(root, pid7);

        // root → /7 is a directory child carrying the pid dir inode.
        assert_eq!(b.resolve_at(root, b"7"), Some((Some(pid7), 3)));
        // /7 → status is a regular synthetic file.
        let status_ino = b
            .resolve_at(pid7, b"status")
            .expect("status resolves under /7");
        assert_eq!(status_ino.1, 4, "status is REGULAR_FILE");
        assert!(status_ino.0.is_some(), "proc file inode is tracked");
        // Missing child → None.
        assert_eq!(b.resolve_at(pid7, b"missing"), None);

        // dir_path round-trips both directories.
        assert_eq!(b.dir_path(root).as_deref(), Some(&b"/"[..]));
        assert_eq!(b.dir_path(pid7).as_deref(), Some(&b"/7"[..]));
    }

    #[test]
    fn tar_resolve_at_from_path_index() {
        let mut ar_bytes: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut ar_bytes);
            for (path, body) in [
                ("bin/sh", &b"#!sh"[..]),
                ("etc/hosts", &b"127.0.0.1 localhost\n"[..]),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_path(path).unwrap();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append(&header, body).unwrap();
            }
            builder.finish().unwrap();
        }
        let b = TarLayerBackend::new(ar_bytes);

        let root = b.dir_inode(b"/").expect("tar root has a dir inode");
        let bin = b.dir_inode(b"/bin").expect("implicit /bin dir inode");
        assert_ne!(root, bin);

        // root → bin is a directory.
        assert_eq!(b.resolve_at(root, b"bin"), Some((Some(bin), 3)));
        // /bin → sh is a regular file with its tracked inode.
        let sh = b.resolve_at(bin, b"sh").expect("sh resolves under /bin");
        assert_eq!(sh.1, 4, "sh is REGULAR_FILE");
        assert!(sh.0.is_some(), "tar file inode tracked");
        // Missing child → None.
        assert_eq!(b.resolve_at(bin, b"missing"), None);

        // dir_path round-trips.
        assert_eq!(b.dir_path(root).as_deref(), Some(&b"/"[..]));
        assert_eq!(b.dir_path(bin).as_deref(), Some(&b"/bin"[..]));
    }

    #[test]
    fn dev_resolve_at_fixed_namespace() {
        let b = DevBackend::new();
        let root = b.dir_inode(b"/").expect("dev root has a fixed dir inode");

        // /dev/null, /dev/zero, and random devices are regular device files.
        assert_eq!(b.resolve_at(root, b"null"), Some((Some(DEV_NULL_INODE), 4)));
        assert_eq!(b.resolve_at(root, b"zero"), Some((Some(DEV_ZERO_INODE), 4)));
        assert_eq!(
            b.resolve_at(root, b"urandom"),
            Some((Some(DEV_URANDOM_INODE), 4))
        );
        assert_eq!(
            b.resolve_at(root, b"random"),
            Some((Some(DEV_RANDOM_INODE), 4))
        );
        // Unknown child → None.
        assert_eq!(b.resolve_at(root, b"missing"), None);

        // dir_path round-trips the fixed root.
        assert_eq!(b.dir_path(root).as_deref(), Some(&b"/"[..]));
    }

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
    fn ramfs_link_refcount_saturates() {
        let mut ramfs = RamfsBackend::new();
        let inode = ramfs.install(b"/a".to_vec(), b"x".to_vec());
        ramfs.refcount.insert(inode, u32::MAX);

        assert_eq!(ramfs.link(b"/a", b"/b"), 0);
        assert_eq!(ramfs.refcount.get(&inode), Some(&u32::MAX));
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
    fn overlay_unlink_whiteouts_lower_only_path() {
        // /etc/motd lives only in lower; unlink masks it via
        // whiteout. Subsequent open returns None.
        let mut lower = RamfsBackend::new();
        lower.install(b"/etc/motd".to_vec(), b"image text".to_vec());
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        // Pre-unlink: open succeeds.
        assert!(overlay.open(b"/etc/motd", 0).is_some());
        assert_eq!(overlay.unlink(b"/etc/motd"), 0);
        // Post-unlink: lookup misses despite lower still having it.
        assert!(overlay.open(b"/etc/motd", 0).is_none());

        // Re-create with the create-bit lifts the whiteout.
        let new_inode = overlay.open(b"/etc/motd", 0b011).unwrap();
        overlay.write(new_inode, 0, b"new");
        let r = overlay.open(b"/etc/motd", 0).unwrap();
        let mut buf = [0u8; 16];
        let n = overlay.read(r, 0, &mut buf);
        assert_eq!(&buf[..n as usize], b"new");
    }

    #[test]
    fn overlay_unlink_upper_only_path_does_not_whiteout_lower() {
        // If upper has a path that lower doesn't, unlinking just
        // removes from upper — no whiteout needed.
        let lower = RamfsBackend::new();
        let mut upper = RamfsBackend::new();
        upper.install(b"/upper-only".to_vec(), b"data".to_vec());
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));
        assert!(overlay.open(b"/upper-only", 0).is_some());
        assert_eq!(overlay.unlink(b"/upper-only"), 0);
        assert!(overlay.open(b"/upper-only", 0).is_none());
    }

    #[test]
    fn overlay_unlink_unknown_path_is_enoent() {
        let lower = RamfsBackend::new();
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));
        assert_eq!(overlay.unlink(b"/missing"), -crate::abi::ENOENT);
    }

    #[test]
    fn tar_layer_readdir_lists_immediate_children() {
        // Build a small tar in-memory with /bin/sh, /bin/ls,
        // /etc/hosts, and verify readdir of "/" lists ["bin","etc"]
        // and readdir of "/bin" lists ["ls","sh"].
        let mut ar_bytes: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut ar_bytes);
            for (path, body) in [
                ("bin/sh", &b"#!sh"[..]),
                ("bin/ls", &b"#!ls"[..]),
                ("etc/hosts", &b"127.0.0.1 localhost\n"[..]),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_path(path).unwrap();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append(&header, body).unwrap();
            }
            builder.finish().unwrap();
        }
        let tar = TarLayerBackend::new(ar_bytes);
        let root = tar.readdir(b"/").expect("/ exists");
        assert_eq!(
            root,
            vec![b"bin".to_vec(), b"etc".to_vec()],
            "tar root readdir must surface dir prefixes"
        );
        let bin = tar.readdir(b"/bin").expect("/bin exists");
        assert_eq!(bin, vec![b"ls".to_vec(), b"sh".to_vec()]);
        assert!(tar.readdir(b"/missing").is_none());
    }

    #[test]
    fn overlay_readdir_unions_layers_and_hides_whiteouts() {
        // Lower has /a, /b. Upper has /c. Overlay should list a,b,c.
        // After unlink(/a), whiteout drops "a" from the listing.
        let mut lower = RamfsBackend::new();
        lower.install(b"/a".to_vec(), b"A".to_vec());
        lower.install(b"/b".to_vec(), b"B".to_vec());
        let mut upper = RamfsBackend::new();
        upper.install(b"/c".to_vec(), b"C".to_vec());
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        let mut entries = overlay.readdir(b"/").expect("root");
        entries.sort();
        assert_eq!(
            entries,
            vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()],
            "overlay readdir must union both layers"
        );

        let rc = overlay.unlink(b"/a");
        assert_eq!(rc, 0);
        let entries = overlay.readdir(b"/").expect("root");
        assert_eq!(
            entries,
            vec![b"b".to_vec(), b"c".to_vec()],
            "whiteout must hide /a from readdir"
        );
    }

    #[test]
    fn overlay_link_copies_lower_target_up_then_links_in_upper() {
        // Lower has /orig with bytes; upper is empty. After link
        // /dup → /orig, both paths read the same content; unlinking
        // one preserves the other (refcount semantics through upper).
        let mut lower = RamfsBackend::new();
        lower.install(b"/orig".to_vec(), b"link-me".to_vec());
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        let rc = overlay.link(b"/orig", b"/dup");
        assert_eq!(rc, 0, "link rc = {rc}");

        // /dup reads the same content.
        let i = overlay.open(b"/dup", 0).unwrap();
        let mut buf = [0u8; 16];
        let n = overlay.read(i, 0, &mut buf);
        assert_eq!(&buf[..n as usize], b"link-me");

        // After unlinking /orig, /dup still resolves and reads.
        let rc = overlay.unlink(b"/orig");
        assert_eq!(rc, 0);
        let i = overlay
            .open(b"/dup", 0)
            .expect("/dup must outlive /orig (hard link)");
        let mut buf = [0u8; 16];
        let n = overlay.read(i, 0, &mut buf);
        assert_eq!(&buf[..n as usize], b"link-me");
    }

    #[test]
    fn overlay_link_to_existing_path_is_eexist() {
        let mut lower = RamfsBackend::new();
        lower.install(b"/a".to_vec(), b"a".to_vec());
        lower.install(b"/b".to_vec(), b"b".to_vec());
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));
        assert_eq!(
            overlay.link(b"/a", b"/b"),
            -(crate::abi::EEXIST as i64) as i32,
        );
    }

    #[test]
    fn overlay_rename_lower_only_file_to_new_path() {
        // Source lives only in lower. After rename, new_path reads
        // the original bytes; old_path is whited out (gone).
        let mut lower = RamfsBackend::new();
        lower.install(b"/orig".to_vec(), b"hello-overlay".to_vec());
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        let rc = overlay.rename(b"/orig", b"/moved");
        assert_eq!(rc, 0);

        // /moved exists with original content.
        let inode = overlay.open(b"/moved", 0).expect("/moved must exist");
        let mut buf = [0u8; 32];
        let n = overlay.read(inode, 0, &mut buf);
        assert!(n >= 0);
        assert_eq!(&buf[..n as usize], b"hello-overlay");

        // /orig is gone (whited out).
        assert!(overlay.open(b"/orig", 0).is_none());
    }

    #[test]
    fn overlay_rename_upper_file_replaces_lower_destination() {
        // Lower has /a (lower-side data) and /b (lower-side data).
        // Upper has /a (upper-shadow) — rename(/a, /b) must end up
        // with /b carrying the upper-shadow bytes and /a gone.
        let mut lower = RamfsBackend::new();
        lower.install(b"/a".to_vec(), b"lower-A".to_vec());
        lower.install(b"/b".to_vec(), b"lower-B".to_vec());
        let mut upper = RamfsBackend::new();
        upper.install(b"/a".to_vec(), b"UPPER-A".to_vec());
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));

        assert_eq!(overlay.rename(b"/a", b"/b"), 0);

        let inode = overlay.open(b"/b", 0).expect("/b must exist");
        let mut buf = [0u8; 32];
        let n = overlay.read(inode, 0, &mut buf);
        assert_eq!(&buf[..n as usize], b"UPPER-A");
        assert!(overlay.open(b"/a", 0).is_none(), "/a must be gone");
    }

    #[test]
    fn overlay_rename_missing_source_is_enoent() {
        let lower = RamfsBackend::new();
        let upper = RamfsBackend::new();
        let mut overlay = OverlayBackend::new(Box::new(lower), Box::new(upper));
        assert_eq!(
            overlay.rename(b"/nope", b"/yep"),
            -(crate::abi::ENOENT as i64) as i32,
        );
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
    /// Implicit directory → stable dir inode. `/proc` exposes `/`
    /// (mount root) and one `/<pid>` directory per live process; the
    /// per-pid files (`status`, `cmdline`, …) live under those. Minted
    /// from the same `next_id` space as file inodes during
    /// `refresh_processes`; a pid-dir inode is preserved across
    /// refreshes while the pid lives (same stability contract as file
    /// inodes) and dropped when the pid exits. Root `/` is fixed at
    /// inode 0 (file ids start at 1, so 0 is free — the ramfs/dev/tar
    /// mount-root convention). Backs `dir_inode`.
    dir_inodes: BTreeMap<Vec<u8>, u64>,
    /// Reverse: dir inode → path. Backs `dir_path`.
    dir_paths: BTreeMap<u64, Vec<u8>>,
    next_id: u64,
}

impl ProcBackend {
    pub fn new() -> Self {
        let mut dir_inodes = BTreeMap::new();
        let mut dir_paths = BTreeMap::new();
        dir_inodes.insert(b"/".to_vec(), 0u64);
        dir_paths.insert(0u64, b"/".to_vec());
        Self {
            entries: BTreeMap::new(),
            inodes: BTreeMap::new(),
            dir_inodes,
            dir_paths,
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
        s.push_str(&format!(
            "Uid:\t{}\t{}\t{}\t{}\n",
            p.uid, p.euid, p.euid, p.euid
        ));
        s.push_str(&format!(
            "Gid:\t{}\t{}\t{}\t{}\n",
            p.gid, p.egid, p.egid, p.egid
        ));
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
        for (id, content) in self.entries.values() {
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

    fn readdir(&self, path: &[u8]) -> Option<Vec<Vec<u8>>> {
        if path == b"/" {
            let mut pids = Vec::new();
            for key in self.entries.keys() {
                let rest = key.strip_prefix(b"/")?;
                let Some(end) = rest.iter().position(|b| *b == b'/') else {
                    continue;
                };
                let pid = rest[..end].to_vec();
                if !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
            return Some(pids);
        }

        let prefix = [path, b"/"].concat();
        let mut names = Vec::new();
        for key in self.entries.keys() {
            let Some(rest) = key.strip_prefix(prefix.as_slice()) else {
                continue;
            };
            if rest.contains(&b'/') {
                continue;
            }
            names.push(rest.to_vec());
        }
        (!names.is_empty()).then_some(names)
    }

    fn entry_type(&self, path: &[u8]) -> u8 {
        if self.entries.contains_key(path) {
            return 4;
        }
        if path == b"/" {
            return 3;
        }
        let prefix = [path, b"/"].concat();
        if self.entries.keys().any(|key| key.starts_with(&prefix)) {
            return 3;
        }
        0
    }

    fn refresh_processes(&mut self, snapshots: &[ProcessSnapshot]) {
        // Drop entries for pids no longer in the snapshot, regenerate
        // content for those still present, leave the inode-id mapping
        // intact so any open fd survives a refresh.
        let mut new_entries: BTreeMap<Vec<u8>, (u64, Vec<u8>)> = BTreeMap::new();
        // Rebuild the dir-inode maps each refresh: keep `/` (fixed
        // inode 0) plus one `/<pid>` dir per live process, preserving
        // an existing pid-dir inode while that pid lives (same
        // stability contract as the per-file inodes above) so an open
        // dir fd survives a refresh, and dropping it when the pid
        // exits.
        let mut new_dir_inodes: BTreeMap<Vec<u8>, u64> = BTreeMap::new();
        let mut new_dir_paths: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
        new_dir_inodes.insert(b"/".to_vec(), 0u64);
        new_dir_paths.insert(0u64, b"/".to_vec());
        for snap in snapshots {
            let pid_dir = format!("/{}", snap.pid).into_bytes();
            let dir_id = match self.dir_inodes.get(&pid_dir) {
                Some(&id) => id,
                None => {
                    let id = self.next_id;
                    self.next_id += 1;
                    id
                }
            };
            new_dir_inodes.insert(pid_dir.clone(), dir_id);
            new_dir_paths.insert(dir_id, pid_dir);
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
        self.dir_inodes = new_dir_inodes;
        self.dir_paths = new_dir_paths;
    }

    fn dir_inode(&self, path: &[u8]) -> Option<u64> {
        self.dir_inodes.get(path).copied()
    }

    fn dir_path(&self, dir_inode: u64) -> Option<Vec<u8>> {
        self.dir_paths.get(&dir_inode).cloned()
    }

    fn resolve_at(&self, dir_inode: u64, name: &[u8]) -> Option<(Option<u64>, u8)> {
        let base = self.dir_paths.get(&dir_inode)?;
        // Join `name` under the base without doubling the separator
        // ("/" + "7" = "/7"; "/7" + "status" = "/7/status").
        let mut child = base.clone();
        if child.last() != Some(&b'/') {
            child.push(b'/');
        }
        child.extend_from_slice(name);
        // /proc has synthetic dirs (/, /<pid>) and regular files; no
        // symlinks at this layer.
        match self.entry_type(&child) {
            3 => Some((self.dir_inodes.get(&child).copied(), 3)),
            4 => Some((self.entries.get(&child).map(|(id, _)| *id), 4)),
            _ => None,
        }
    }
}

// ── Host-FS backend ───────────────────────────────────────────────
//
// Mounts a real-disk subtree at a given prefix (e.g. /host/data).
// Path lookups translate to `kh_real_open` calls; reads to
// `kh_real_read`; close to `kh_real_close`. The host (kernel_host_interface)
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
    last_open_error: Option<i32>,
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
            last_open_error: None,
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
        self.last_open_error = None;
        // Cached: re-use the existing host-fd / inode mapping. The
        // cached fd was opened with whatever flags the *first*
        // caller used; subsequent opens with different flags share
        // it. POSIX-correct behavior would dup() with new flags;
        // Phase 5 keeps it simple — embedders that need separate
        // RW vs RO views close + reopen in between.
        if let Some(&inode) = self.paths.get(path) {
            return Some(inode);
        }
        // Cold path: ask the host. The kernel_host_interface applies the
        // policy gate (`PolicyEnforcer::may_open_path`) and root
        // canonicalization before touching the real disk — a Deny
        // returns a negative errno which sys_open must preserve.
        let host_fd = crate::kh::real_open(path, flags, 0);
        if host_fd < 0 {
            self.last_open_error = Some(-host_fd);
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

    fn take_open_error(&mut self) -> Option<i32> {
        self.last_open_error.take()
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

    fn unlink(&mut self, path: &[u8]) -> i32 {
        // Drop our cached fd if any so the next open re-issues. We
        // don't actively kh_real_close here — that happens in Drop.
        self.paths.remove(path);
        crate::kh::real_unlink(path)
    }

    fn mkdir(&mut self, path: &[u8]) -> i32 {
        crate::kh::real_mkdir(path, 0o755)
    }

    fn symlink(&mut self, target: &[u8], link_path: &[u8]) -> i32 {
        crate::kh::real_symlink(target, link_path)
    }

    fn rename(&mut self, old_path: &[u8], new_path: &[u8]) -> i32 {
        // Invalidate any cached host-fd for the source path; the
        // target inode is now reachable under new_path. Real fds
        // stay open — the host's rename(2) preserves them.
        if let Some(inode) = self.paths.remove(old_path) {
            self.paths.insert(new_path.to_vec(), inode);
        } else {
            self.paths.remove(new_path);
        }
        crate::kh::real_rename(old_path, new_path)
    }
}

impl Drop for HostFsBackend {
    fn drop(&mut self) {
        // Best-effort close every open host-fd when the backend
        // goes away. Errors are dropped — the host is the only
        // party that can reasonably react.
        for &inode in self.fds.keys() {
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
// kernel_host_interface pushes the tar bytes once via
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
    /// Implicit directory → stable dir inode. Tar carries regular
    /// files only; every proper prefix of a file path (plus the mount
    /// root `/`) is an implicit directory. Minted once at construction
    /// from the same `next_id` space as file inodes (collision-free
    /// within the backend); never changes — the archive is immutable,
    /// no rename. Backs `dir_inode`.
    dir_inodes: BTreeMap<Vec<u8>, u64>,
    /// Reverse: dir inode → path. Backs `dir_path`.
    dir_paths: BTreeMap<u64, Vec<u8>>,
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
        // Derive the implicit directory namespace. Root `/` is fixed
        // at inode 0 (the file id space starts at 1, so 0 is free —
        // same convention as ramfs/proc/dev mount roots). Every proper
        // ancestor of each indexed file path is an implicit directory;
        // mint a stable inode for each, continuing from `next_id`.
        let mut dir_inodes: BTreeMap<Vec<u8>, u64> = BTreeMap::new();
        let mut dir_paths: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
        dir_inodes.insert(b"/".to_vec(), 0);
        dir_paths.insert(0, b"/".to_vec());
        for file_path in files.keys() {
            // Walk each `/`-separated ancestor: "/a/b/c" yields the
            // implicit dirs "/a" and "/a/b" (the final component is the
            // file itself, not a dir). Relies on the `files` key
            // invariant that every path is ABSOLUTE: `cut + 1` skips
            // index 0 (the leading `/`) so the root itself is not
            // re-derived. If that key format ever changes this loop
            // must change with it.
            let mut cut = 0;
            while let Some(rel) = file_path[cut + 1..].iter().position(|&b| b == b'/') {
                let end = cut + 1 + rel;
                let ancestor = file_path[..end].to_vec();
                if !dir_inodes.contains_key(&ancestor) {
                    let id = next_id;
                    next_id += 1;
                    dir_inodes.insert(ancestor.clone(), id);
                    dir_paths.insert(id, ancestor);
                }
                cut = end;
            }
        }
        Self {
            archive,
            files,
            inodes,
            metadata,
            dir_inodes,
            dir_paths,
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

    fn readdir(&self, path: &[u8]) -> Option<Vec<Vec<u8>>> {
        // Tar archives carry regular files only (we filtered out
        // dir/symlink entries during indexing). Directories are
        // implicit — every prefix of a file path is a directory.
        // To list `path`, walk every indexed file and emit the
        // immediate child basename (whether the child is a file in
        // the archive or just a directory containing deeper files).
        let prefix: Vec<u8> = if path == b"/" {
            b"/".to_vec()
        } else {
            let mut p = path.to_vec();
            p.push(b'/');
            p
        };
        let mut entries: Vec<Vec<u8>> = Vec::new();
        let mut found_dir = path == b"/";
        for file_path in self.files.keys() {
            if !file_path.starts_with(&prefix) {
                continue;
            }
            found_dir = true;
            let rest = &file_path[prefix.len()..];
            if rest.is_empty() {
                continue;
            }
            // Immediate child = bytes up to the next '/'.
            let child = match rest.iter().position(|&b| b == b'/') {
                Some(idx) => rest[..idx].to_vec(),
                None => rest.to_vec(),
            };
            entries.push(child);
        }
        if !found_dir {
            return None;
        }
        entries.sort();
        entries.dedup();
        Some(entries)
    }

    fn entry_type(&self, path: &[u8]) -> u8 {
        if self.files.contains_key(path) {
            return 4; // REGULAR_FILE
        }
        // Directory if any indexed file is under `path/`. Root is
        // always a directory regardless of whether the archive
        // happens to be empty.
        if path == b"/" {
            return 3;
        }
        let mut probe = path.to_vec();
        probe.push(b'/');
        for k in self.files.keys() {
            if k.starts_with(&probe) {
                return 3; // DIRECTORY
            }
        }
        0
    }

    fn dir_inode(&self, path: &[u8]) -> Option<u64> {
        self.dir_inodes.get(path).copied()
    }

    fn dir_path(&self, dir_inode: u64) -> Option<Vec<u8>> {
        self.dir_paths.get(&dir_inode).cloned()
    }

    fn resolve_at(&self, dir_inode: u64, name: &[u8]) -> Option<(Option<u64>, u8)> {
        let base = self.dir_paths.get(&dir_inode)?;
        // Join `name` under the base without doubling the separator
        // ("/" + "bin" = "/bin"; "/bin" + "sh" = "/bin/sh").
        let mut child = base.clone();
        if child.last() != Some(&b'/') {
            child.push(b'/');
        }
        child.extend_from_slice(name);
        // Tar carries regular files only; dirs are implicit. No
        // symlinks in this index.
        match self.entry_type(&child) {
            3 => Some((self.dir_inodes.get(&child).copied(), 3)),
            4 => Some((self.inodes.get(&child).copied(), 4)),
            _ => None,
        }
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
    /// Paths that have been unlinked at the overlay level. Future
    /// lookups for these paths return None even if the lower layer
    /// still has them. Cleared if the path is recreated via open
    /// with the create-bit. Mirrors UnionFS / OverlayFS whiteouts.
    whiteouts: BTreeSet<Vec<u8>>,
    next_id: u64,
}

impl OverlayBackend {
    pub fn new(lower: Box<dyn VfsBackend>, upper: Box<dyn VfsBackend>) -> Self {
        Self {
            lower,
            upper,
            layered: BTreeMap::new(),
            paths: BTreeMap::new(),
            whiteouts: BTreeSet::new(),
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
        // Whiteout takes priority over the cache + lower fallback.
        // Re-creating with the create-bit clears the whiteout so the
        // path becomes visible again (with a fresh upper file).
        if self.whiteouts.contains(path) {
            if !create {
                return None;
            }
            self.whiteouts.remove(path);
            // Drop any cached lower-tagged id from before the unlink.
            self.paths.remove(path);
        }
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
        if let Some(&(Layer::Upper, inner)) = self.layered.get(&inode) {
            self.upper.truncate(inner);
            // Truncating a lower-only file is meaningless — lower is
            // read-only. Silently ignore (matches POSIX truncate-on-
            // O_TRUNC of a file with no write permission: error,
            // but we don't have an errno return on truncate yet).
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

    fn unlink(&mut self, path: &[u8]) -> i32 {
        // Always invalidate the cache regardless — even if the path
        // exists only in lower (we'll just whiteout).
        let cached = self.paths.remove(path);
        let _ = cached; // existing OFDs keep working through `layered`.

        // Try unlinking from upper first.
        let upper_rc = self.upper.unlink(path);
        // Try lower as well — but it's read-only, so its unlink
        // returns -EROFS. We don't propagate that as an error: the
        // canonical UnionFS behavior for a lower-only file is
        // whiteout, not refuse.
        let lower_has = {
            let probe = self.lower.open(path, 0);
            probe.is_some()
        };

        if upper_rc == 0 || lower_has {
            // Whether we removed from upper, or the lower had it
            // (or both), we whiteout the path so future lookups
            // skip both layers. The path can be re-created via open
            // with the create-bit, which lifts the whiteout.
            self.whiteouts.insert(path.to_vec());
            return 0;
        }
        // Neither layer had it.
        -crate::abi::ENOENT
    }

    fn readdir(&self, path: &[u8]) -> Option<Vec<Vec<u8>>> {
        // Union of upper and lower entries. Either layer being a
        // directory makes the path a directory; missing in both →
        // None (caller turns into -ENOENT). For every entry we
        // also check whether the absolute child path is whited
        // out — if so, we drop it.
        let upper = self.upper.readdir(path);
        let lower = self.lower.readdir(path);
        if upper.is_none() && lower.is_none() {
            return None;
        }
        let prefix: Vec<u8> = if path == b"/" {
            b"/".to_vec()
        } else {
            let mut p = path.to_vec();
            p.push(b'/');
            p
        };
        let mut entries: Vec<Vec<u8>> = Vec::new();
        for src in upper.into_iter().chain(lower) {
            for name in src {
                let mut full = prefix.clone();
                full.extend_from_slice(&name);
                if self.whiteouts.contains(&full) {
                    continue;
                }
                entries.push(name);
            }
        }
        entries.sort();
        entries.dedup();
        Some(entries)
    }

    fn entry_type(&self, path: &[u8]) -> u8 {
        if self.whiteouts.contains(path) {
            return 0;
        }
        let upper = self.upper.entry_type(path);
        if upper != 0 {
            return upper;
        }
        self.lower.entry_type(path)
    }

    fn link(&mut self, target: &[u8], link_path: &[u8]) -> i32 {
        // Target must exist somewhere; the destination must not.
        if self.whiteouts.contains(target) {
            return -(crate::abi::ENOENT as i64) as i32;
        }
        if self.entry_type(target) == 0 {
            return -(crate::abi::ENOENT as i64) as i32;
        }
        if self.entry_type(link_path) != 0 {
            return -(crate::abi::EEXIST as i64) as i32;
        }
        // Hard links share an inode, which only makes sense within
        // a single backend. Copy the target up to upper if it's
        // currently lower-only so both paths land in the same
        // upper backend; then delegate to upper.link. (The lower
        // version remains addressable through any pre-existing
        // OFD, but new opens of `target` go through the upper
        // copy-up like any other write.)
        let in_upper = matches!(self.upper.entry_type(target), 3 | 4 | 7,);
        if !in_upper {
            // Copy-up only handles regular files today; symlinks
            // would need readlink+symlink in upper. Fall back to
            // -EPERM for non-files until that's plumbed.
            if self.lower.entry_type(target) != 4 {
                return -(crate::abi::EPERM as i64) as i32;
            }
            if self.copy_up(target).is_none() {
                return -(crate::abi::EIO as i64) as i32;
            }
            // Drop any cached lower-tagged id so future opens see
            // the new upper copy.
            self.paths.remove(target);
        }
        let rc = self.upper.link(target, link_path);
        if rc == 0 {
            self.whiteouts.remove(link_path);
        }
        rc
    }

    fn rename(&mut self, old_path: &[u8], new_path: &[u8]) -> i32 {
        // Source must exist (in either layer, ignoring whiteout).
        if self.whiteouts.contains(old_path) {
            return -(crate::abi::ENOENT as i64) as i32;
        }
        let src_kind = self.entry_type(old_path);
        if src_kind == 0 {
            return -(crate::abi::ENOENT as i64) as i32;
        }
        if old_path == new_path {
            return 0;
        }
        // Destination: directories aren't supported as a target
        // here; surface -EEXIST to mirror RamfsBackend's stance.
        if self.entry_type(new_path) == 3 {
            return -(crate::abi::EEXIST as i64) as i32;
        }
        // Rename strategy: open source for read, install bytes at
        // the new path in upper (which handles whiteouts if the
        // dest existed in lower), then unlink source (which
        // whiteouts in lower or removes upper). Inode identity is
        // not preserved — POSIX rename callers don't observe inode
        // numbers, and lower→upper transitions already break
        // identity via copy-up.
        match src_kind {
            // Regular file: read source, write to new (create-bit),
            // unlink source. Symlinks go through readlink+symlink.
            4 => {
                let src_inode = match self.open(old_path, 0) {
                    Some(i) => i,
                    None => return -(crate::abi::ENOENT as i64) as i32,
                };
                let len = self.size(src_inode).unwrap_or(0) as usize;
                let mut content = vec![0u8; len];
                if len > 0 {
                    let n = self.read(src_inode, 0, &mut content);
                    if n < 0 {
                        return n as i32;
                    }
                    content.truncate(n as usize);
                }
                // If destination exists in upper, unlink it first
                // so the create-write doesn't refuse via EEXIST in
                // ramfs; if it exists only in lower, our unlink
                // will produce a whiteout that we then clear by
                // creating in upper with the create-bit.
                if self.entry_type(new_path) != 0 {
                    self.unlink(new_path);
                }
                let dst_inode = match self.open(new_path, 0b011) {
                    Some(i) => i,
                    None => return -(crate::abi::EIO as i64) as i32,
                };
                self.truncate(dst_inode);
                let w = self.write(dst_inode, 0, &content);
                if w < 0 {
                    return w as i32;
                }
                self.unlink(old_path);
                0
            }
            7 => {
                let target = match self.readlink(old_path) {
                    Some(t) => t,
                    None => return -(crate::abi::ENOENT as i64) as i32,
                };
                if self.entry_type(new_path) != 0 {
                    self.unlink(new_path);
                }
                let rc = self.symlink(&target, new_path);
                if rc != 0 {
                    return rc;
                }
                self.unlink(old_path);
                0
            }
            // Directory rename across the union is non-trivial
            // (requires walking children for whiteout/copy-up).
            // Refuse for now; userland sees -EXDEV and falls back
            // to recursive copy.
            _ => -(crate::abi::EXDEV as i64) as i32,
        }
    }
}
