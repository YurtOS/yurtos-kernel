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

/// What every concrete filesystem backend implements. The kernel
/// dispatch layer only ever calls these methods — it never inspects
/// backend internals.
pub trait VfsBackend: Send {
    /// Resolve a path *relative to this mount* to an inode id, or
    /// `None` if the path doesn't exist.
    fn lookup(&self, path: &[u8]) -> Option<u64>;

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
}

/// One row in the mount table.
struct Mount {
    /// Path prefix (with trailing `/` only for the root mount; sub-
    /// mounts use no trailing slash so prefix-match is unambiguous).
    prefix: Vec<u8>,
    backend: Box<dyn VfsBackend>,
}

/// Mount table. Resolution is longest-prefix-match against the
/// installed mounts. The root mount (prefix `/`) is mandatory and
/// catches any path that no specific mount claims.
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

    /// Find the mount that owns `path`, plus the path *relative to*
    /// that mount. The root mount's relative path is the absolute
    /// path verbatim — backends are responsible for stripping any
    /// expected leading `/` themselves. Future non-root mounts will
    /// hand back the suffix after their prefix.
    fn resolve(&mut self, path: &[u8]) -> Option<(&mut Mount, Vec<u8>)> {
        // Phase 3: only the root mount exists, so this is trivial.
        // The longest-prefix walk lives here so adding mounts later
        // is a one-line append; dispatch doesn't change.
        let mut best: Option<usize> = None;
        let mut best_len = 0usize;
        for (i, m) in self.mounts.iter().enumerate() {
            if path.starts_with(&m.prefix) && m.prefix.len() >= best_len {
                best = Some(i);
                best_len = m.prefix.len();
            }
        }
        let i = best?;
        // Root mount returns the full path verbatim; sub-mounts get
        // the suffix.
        let rel = if self.mounts[i].prefix == b"/" {
            path.to_vec()
        } else {
            path[self.mounts[i].prefix.len()..].to_vec()
        };
        Some((&mut self.mounts[i], rel))
    }

    pub fn lookup(&mut self, path: &[u8]) -> Option<u64> {
        let (m, rel) = self.resolve(path)?;
        m.backend.lookup(&rel)
    }

    pub fn create(&mut self, path: &[u8]) -> Option<u64> {
        let (m, rel) = self.resolve(path)?;
        m.backend.create(&rel)
    }

    pub fn truncate(&mut self, inode: u64) {
        // Phase 3: single mount, all inodes belong to root.
        self.mounts[0].backend.truncate(inode);
    }

    pub fn read(&mut self, inode: u64, offset: u64, buf: &mut [u8]) -> i64 {
        self.mounts[0].backend.read(inode, offset, buf)
    }

    pub fn write(&mut self, inode: u64, offset: u64, payload: &[u8]) -> i64 {
        self.mounts[0].backend.write(inode, offset, payload)
    }

    pub fn size(&self, inode: u64) -> Option<u64> {
        self.mounts[0].backend.size(inode)
    }

    #[cfg(test)]
    pub fn clear(&mut self) {
        if let Some(m) = self.mounts.first_mut() {
            // Reset by replacing with a fresh ramfs.
            m.backend = Box::new(RamfsBackend::new());
        }
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

impl VfsBackend for RamfsBackend {
    fn lookup(&self, path: &[u8]) -> Option<u64> {
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
