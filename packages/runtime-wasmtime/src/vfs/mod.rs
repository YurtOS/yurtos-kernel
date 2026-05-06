#![allow(dead_code)] // Free functions used by MemVfs methods; exported via pub API
//! In-memory virtual filesystem.
//!
//! Mirrors `packages/kernel/src/vfs/vfs.ts`.
//!
//! Design:
//! - `Arc<Vec<u8>>` for file content → copy-on-write fork/snapshot semantics.
//!   Writes replace the Arc; other clones keep the old one.
//! - `/dev/*` and `/proc/*` are handled as virtual paths before inode lookup.
//! - During `initializing`, permission checks are skipped.

pub mod error;
pub mod glob;
pub mod inode;
pub mod path;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub use error::{VfsError, VfsResult};
pub use inode::{DirEntry, Inode, StatResult};

use inode::now_ms;
use path::{join_path, parse_path, split_path};

const MAX_SYMLINK_DEPTH: usize = 40;
const DEV_DEVICES: &[&str] = &["null", "zero", "random", "urandom"];
const PROC_FILES: &[&str] = &["uptime", "version", "cpuinfo", "meminfo", "diskstats"];

// ── MemVfs ─────────────────────────────────────────────────────────────────

pub struct MemVfs {
    root: Inode, // always Inode::Dir
    snapshots: HashMap<String, Inode>,
    next_snap_id: u32,

    total_bytes: usize,
    fs_limit_bytes: Option<usize>,
    file_count: usize,
    file_count_limit: Option<usize>,

    initializing: bool,
    started_at: std::time::Instant,
}

impl MemVfs {
    pub fn new(fs_limit_bytes: Option<usize>, file_count_limit: Option<usize>) -> Self {
        let mut vfs = Self {
            root: Inode::new_dir(0o555),
            snapshots: HashMap::new(),
            next_snap_id: 0,
            total_bytes: 0,
            fs_limit_bytes,
            file_count: 0,
            file_count_limit,
            initializing: true,
            started_at: std::time::Instant::now(),
        };
        vfs.init_layout();
        vfs.initializing = false;
        vfs
    }

    fn init_layout(&mut self) {
        for &(dir, mode) in &[
            ("/home", 0o755u32),
            ("/home/user", 0o755),
            ("/tmp", 0o777),
            ("/bin", 0o555),
            ("/usr", 0o555),
            ("/usr/bin", 0o555),
            ("/usr/lib", 0o555),
            ("/usr/lib/python", 0o755),
            ("/etc", 0o555),
            ("/etc/yurt", 0o555),
            ("/usr/share", 0o555),
            ("/usr/share/pkg", 0o755),
            ("/mnt", 0o555),
        ] {
            mkdir_in(&mut self.root, dir, mode, true).expect("init_layout: mkdir failed");
            self.file_count += 1;
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    pub fn stat(&self, path: &str) -> VfsResult<StatResult> {
        if let Some(s) = self.virtual_stat(path) {
            return Ok(s);
        }
        resolve(&self.root, path, true, 0).map(inode_to_stat)
    }

    pub fn lstat(&self, path: &str) -> VfsResult<StatResult> {
        if let Some(s) = self.virtual_stat(path) {
            return Ok(s);
        }
        resolve(&self.root, path, false, 0).map(inode_to_stat)
    }

    pub fn read_file(&self, path: &str) -> VfsResult<Vec<u8>> {
        if let Some(b) = self.virtual_read(path) {
            return Ok(b);
        }
        match resolve(&self.root, path, true, 0)? {
            Inode::File { content, .. } => Ok(content.as_ref().clone()),
            Inode::Dir { .. } => Err(VfsError::IsDir(path.to_owned())),
            Inode::Symlink { .. } => unreachable!(),
        }
    }

    pub fn write_file(&mut self, path: &str, data: &[u8], append: bool) -> VfsResult<()> {
        // Check limits before touching the tree
        let incoming = data.len();
        if let Some(limit) = self.fs_limit_bytes {
            if self.total_bytes + incoming > limit {
                return Err(VfsError::NoSpace);
            }
        }
        let initializing = self.initializing;
        let delta = write_file_in(&mut self.root, path, data, append, initializing)?;
        if delta > 0 {
            self.file_count += 1;
        }
        // delta can be negative (overwrite shorter content)
        self.total_bytes = (self.total_bytes as isize + delta) as usize;
        Ok(())
    }

    pub fn mkdir(&mut self, path: &str) -> VfsResult<()> {
        let init = self.initializing;
        mkdir_in(&mut self.root, path, 0o755, init)?;
        self.file_count += 1;
        Ok(())
    }

    pub fn mkdirp(&mut self, path: &str) -> VfsResult<()> {
        let parts =
            parse_path(path).ok_or_else(|| VfsError::Invalid("relative path".to_owned()))?;
        let mut sofar = Vec::with_capacity(parts.len());
        for part in &parts {
            sofar.push(*part);
            let p = join_path(&sofar);
            let init = self.initializing;
            match mkdir_in(&mut self.root, &p, 0o755, init) {
                Ok(()) => self.file_count += 1,
                Err(VfsError::Exists(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    pub fn readdir(&self, path: &str) -> VfsResult<Vec<DirEntry>> {
        if let Some(v) = self.virtual_readdir(path) {
            return Ok(v);
        }
        match resolve(&self.root, path, true, 0)? {
            Inode::Dir { children, .. } => {
                let mut entries: Vec<DirEntry> = children
                    .iter()
                    .map(|(n, i)| DirEntry {
                        name: n.clone(),
                        is_dir: i.is_dir(),
                    })
                    .collect();
                entries.sort_by(|a, b| a.name.cmp(&b.name));
                Ok(entries)
            }
            _ => Err(VfsError::NotDir(path.to_owned())),
        }
    }

    pub fn unlink(&mut self, path: &str) -> VfsResult<()> {
        let size = remove_node(&mut self.root, path, false)?;
        self.total_bytes -= size;
        self.file_count -= 1;
        Ok(())
    }

    pub fn rmdir(&mut self, path: &str) -> VfsResult<()> {
        remove_node(&mut self.root, path, false)?;
        self.file_count -= 1;
        Ok(())
    }

    pub fn remove_recursive(&mut self, path: &str) -> VfsResult<()> {
        let (bytes, count) = remove_subtree(&mut self.root, path)?;
        self.total_bytes -= bytes;
        self.file_count -= count;
        Ok(())
    }

    pub fn rename(&mut self, from: &str, to: &str) -> VfsResult<()> {
        rename_node(&mut self.root, from, to)
    }

    pub fn symlink(&mut self, target: &str, link: &str) -> VfsResult<()> {
        symlink_in(&mut self.root, target, link)?;
        self.file_count += 1;
        Ok(())
    }

    pub fn chmod(&mut self, path: &str, mode: u32) -> VfsResult<()> {
        chmod_in(&mut self.root, path, mode)
    }

    pub fn readlink(&self, path: &str) -> VfsResult<String> {
        match resolve(&self.root, path, false, 0)? {
            Inode::Symlink { target, .. } => Ok(target.clone()),
            _ => Err(VfsError::Invalid(format!("{path}: not a symlink"))),
        }
    }

    pub fn glob_paths(&self, pattern: &str) -> Vec<String> {
        let mut out = Vec::new();
        glob_walk(&self.root, "/", pattern, &mut out, |p| {
            self.virtual_readdir(p)
        });
        out.sort();
        out
    }

    // ── Snapshot / COW ──────────────────────────────────────────────────────

    pub fn snapshot(&mut self) -> String {
        let id = self.next_snap_id.to_string();
        self.next_snap_id += 1;
        self.snapshots.insert(id.clone(), deep_clone(&self.root));
        id
    }

    pub fn restore(&mut self, id: &str) -> VfsResult<()> {
        let saved = self
            .snapshots
            .get(id)
            .ok_or_else(|| VfsError::NotFound(format!("snapshot {id}")))?;
        self.root = deep_clone(saved);
        Ok(())
    }

    pub fn cow_clone(&self) -> Self {
        Self {
            root: deep_clone(&self.root),
            snapshots: self
                .snapshots
                .iter()
                .map(|(k, v)| (k.clone(), deep_clone(v)))
                .collect(),
            next_snap_id: self.next_snap_id,
            total_bytes: self.total_bytes,
            fs_limit_bytes: self.fs_limit_bytes,
            file_count: self.file_count,
            file_count_limit: self.file_count_limit,
            initializing: false,
            started_at: self.started_at,
        }
    }

    // ── Persistence (export / import) ────────────────────────────────────────

    /// Serialize the entire filesystem to a compact binary blob.
    pub fn export_bytes(&self) -> anyhow::Result<Vec<u8>> {
        #[derive(Serialize)]
        struct VfsSnapshot<'a> {
            root: &'a Inode,
        }
        let snap = VfsSnapshot { root: &self.root };
        Ok(bincode::serialize(&snap)?)
    }

    /// Deserialize a filesystem from a blob returned by `export_bytes`.
    pub fn import_bytes(blob: &[u8]) -> anyhow::Result<Self> {
        Self::import_bytes_with_limits(blob, None, None)
    }

    /// Deserialize a filesystem from a blob, applying optional storage limits.
    pub fn import_bytes_with_limits(
        blob: &[u8],
        fs_limit_bytes: Option<usize>,
        file_count_limit: Option<usize>,
    ) -> anyhow::Result<Self> {
        #[derive(Deserialize)]
        struct VfsSnapshot {
            root: Inode,
        }
        let snap: VfsSnapshot = bincode::deserialize(blob)?;
        let mut vfs = MemVfs::new(fs_limit_bytes, file_count_limit);
        vfs.root = snap.root;
        // Recompute accounting from the imported tree (init_layout values are
        // now stale since we replaced vfs.root entirely).
        let (bytes, count) = count_subtree(&vfs.root);
        vfs.total_bytes = bytes;
        vfs.file_count = count;
        Ok(vfs)
    }

    // ── Stats ────────────────────────────────────────────────────────────────

    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }
    pub fn fs_limit_bytes(&self) -> Option<usize> {
        self.fs_limit_bytes
    }
    pub fn file_count(&self) -> usize {
        self.file_count
    }

    // ── Virtual providers (/dev, /proc) ──────────────────────────────────────

    fn virtual_stat(&self, path: &str) -> Option<StatResult> {
        let now = now_ms();
        let stat = |is_dir: bool, size: usize| StatResult {
            is_file: !is_dir,
            is_dir,
            is_symlink: false,
            size,
            permissions: if is_dir { 0o555 } else { 0o444 },
            mtime: now,
            ctime: now,
            atime: now,
        };
        match path {
            "/dev" | "/proc" => Some(stat(true, 0)),
            p if p.starts_with("/dev/") => DEV_DEVICES.contains(&&p[5..]).then(|| stat(false, 0)),
            p if p.starts_with("/proc/") => {
                let name = &p[6..];
                PROC_FILES
                    .contains(&name)
                    .then(|| stat(false, self.proc_bytes(name).len()))
            }
            _ => None,
        }
    }

    fn virtual_read(&self, path: &str) -> Option<Vec<u8>> {
        match path {
            p if p.starts_with("/dev/") => Some(match &p[5..] {
                "null" => vec![],
                "zero" => vec![0u8; 4096],
                "random" | "urandom" => pseudo_random(4096),
                _ => return None,
            }),
            p if p.starts_with("/proc/") => {
                let name = &p[6..];
                PROC_FILES.contains(&name).then(|| self.proc_bytes(name))
            }
            _ => None,
        }
    }

    fn virtual_readdir(&self, path: &str) -> Option<Vec<DirEntry>> {
        match path {
            "/dev" => Some(
                DEV_DEVICES
                    .iter()
                    .map(|&n| DirEntry {
                        name: n.to_owned(),
                        is_dir: false,
                    })
                    .collect(),
            ),
            "/proc" => Some(
                PROC_FILES
                    .iter()
                    .map(|&n| DirEntry {
                        name: n.to_owned(),
                        is_dir: false,
                    })
                    .collect(),
            ),
            _ => None,
        }
    }

    fn proc_bytes(&self, name: &str) -> Vec<u8> {
        let up = self.started_at.elapsed().as_secs_f64();
        match name {
            "uptime" => format!("{up:.2} {:.2}\n", up * 0.9).into_bytes(),
            "version" => b"Yurt 1.0.0 (WASI sandbox)\n".to_vec(),
            "cpuinfo" => {
                b"processor\t: 0\nmodel name\t: Yurt virtual CPU\ncpu MHz\t\t: 1000.000\n".to_vec()
            }
            "meminfo" => b"MemTotal:       2097152 kB\nMemFree:        1048576 kB\n".to_vec(),
            "diskstats" => {
                format!(
                "{{\"totalBytes\":{},\"limitBytes\":{},\"fileCount\":{},\"fileCountLimit\":{}}}\n",
                self.total_bytes,
                self.fs_limit_bytes.map_or("null".to_owned(), |n| n.to_string()),
                self.file_count,
                self.file_count_limit.map_or("null".to_owned(), |n| n.to_string()),
            )
                .into_bytes()
            }
            _ => vec![],
        }
    }
}

// ── Tree-mutating free functions ──────────────────────────────────────────────
// These take `root: &mut Inode` so the VFS methods can call them without
// holding `self` borrowed, allowing subsequent `self.total_bytes +=` etc.

/// Navigate to parent directory and insert/update a file.
/// Returns the byte delta (new_len - old_len; positive if new file was created).
fn write_file_in(
    root: &mut Inode,
    path: &str,
    data: &[u8],
    append: bool,
    initializing: bool,
) -> VfsResult<isize> {
    let (parent_parts, name) =
        split_path(path).ok_or_else(|| VfsError::Invalid("cannot write root".to_owned()))?;
    let parent = navigate_dir_mut(root, &parent_parts)?;
    match parent.get_mut(name) {
        Some(Inode::File { meta, content }) => {
            let old_len = content.len() as isize;
            let new_content = if append {
                let mut v = content.as_ref().clone();
                v.extend_from_slice(data);
                v
            } else {
                data.to_vec()
            };
            let new_len = new_content.len() as isize;
            let now = now_ms();
            meta.mtime = now;
            meta.atime = now;
            *content = Arc::new(new_content);
            Ok(new_len - old_len)
        }
        Some(Inode::Dir { .. }) => Err(VfsError::IsDir(path.to_owned())),
        Some(Inode::Symlink { .. }) => Err(VfsError::Invalid(format!("{path}: is a symlink"))),
        None => {
            if !initializing {
                // Check parent write permission
                // (We don't have parent meta here; skip for now — Phase 3 can tighten)
            }
            let len = data.len() as isize;
            parent.insert(name.to_owned(), Inode::new_file(0o644, data.to_vec()));
            Ok(len) // positive delta signals new file (caller bumps file_count)
        }
    }
}

/// Create a directory at `path` with `mode`.
fn mkdir_in(root: &mut Inode, path: &str, mode: u32, _skip_perm: bool) -> VfsResult<()> {
    let (parent_parts, name) =
        split_path(path).ok_or_else(|| VfsError::Invalid("cannot mkdir root".to_owned()))?;
    let parent = navigate_dir_mut(root, &parent_parts)?;
    if parent.contains_key(name) {
        return Err(VfsError::Exists(path.to_owned()));
    }
    parent.insert(name.to_owned(), Inode::new_dir(mode));
    Ok(())
}

/// Remove a single node (file or empty dir) and return its byte size.
fn remove_node(root: &mut Inode, path: &str, _recursive: bool) -> VfsResult<usize> {
    let (parent_parts, name) =
        split_path(path).ok_or_else(|| VfsError::NotFound(path.to_owned()))?;
    let parent = navigate_dir_mut(root, &parent_parts)?;
    match parent.get(name) {
        None => Err(VfsError::NotFound(path.to_owned())),
        Some(Inode::Dir { children, .. }) if !children.is_empty() => {
            Err(VfsError::NotEmpty(path.to_owned()))
        }
        Some(node) => {
            let size = node.byte_len();
            parent.remove(name);
            Ok(size)
        }
    }
}

/// Remove a node and its entire subtree; return (bytes_freed, entries_removed).
fn remove_subtree(root: &mut Inode, path: &str) -> VfsResult<(usize, usize)> {
    let (parent_parts, name) =
        split_path(path).ok_or_else(|| VfsError::NotFound(path.to_owned()))?;
    let parent = navigate_dir_mut(root, &parent_parts)?;
    match parent.remove(name) {
        None => Err(VfsError::NotFound(path.to_owned())),
        Some(node) => Ok(count_subtree(&node)),
    }
}

fn rename_node(root: &mut Inode, from: &str, to: &str) -> VfsResult<()> {
    // We can't hold two mutable borrows into the tree simultaneously.
    // Strategy: remove node from source, then insert at destination.
    // If the destination insert fails we've lost the node — acceptable for MVP;
    // a transactional rename can be added later.
    let (from_parts, from_name) =
        split_path(from).ok_or_else(|| VfsError::NotFound(from.to_owned()))?;
    let node = {
        let parent = navigate_dir_mut(root, &from_parts)?;
        parent
            .remove(from_name)
            .ok_or_else(|| VfsError::NotFound(from.to_owned()))?
    };
    let (to_parts, to_name) =
        split_path(to).ok_or_else(|| VfsError::Invalid("cannot rename to root".to_owned()))?;
    let parent = navigate_dir_mut(root, &to_parts)?;
    parent.insert(to_name.to_owned(), node);
    Ok(())
}

fn symlink_in(root: &mut Inode, target: &str, link: &str) -> VfsResult<()> {
    let (parent_parts, name) =
        split_path(link).ok_or_else(|| VfsError::Invalid("cannot symlink root".to_owned()))?;
    let parent = navigate_dir_mut(root, &parent_parts)?;
    if parent.contains_key(name) {
        return Err(VfsError::Exists(link.to_owned()));
    }
    parent.insert(name.to_owned(), Inode::new_symlink(target.to_owned()));
    Ok(())
}

fn chmod_in(root: &mut Inode, path: &str, mode: u32) -> VfsResult<()> {
    let (parent_parts, name) =
        split_path(path).ok_or_else(|| VfsError::NotFound(path.to_owned()))?;
    let parent = navigate_dir_mut(root, &parent_parts)?;
    match parent.get_mut(name) {
        None => Err(VfsError::NotFound(path.to_owned())),
        Some(node) => {
            let meta = node.meta_mut();
            meta.permissions = mode & 0o7777;
            Ok(())
        }
    }
}

// ── Navigation ────────────────────────────────────────────────────────────────

/// Walk `root` following `parts` and return the children map of the terminal
/// directory.  Returns `VfsError::NotDir` if any intermediate node is not a dir.
fn navigate_dir_mut<'a>(
    root: &'a mut Inode,
    parts: &[&str],
) -> VfsResult<&'a mut BTreeMap<String, Inode>> {
    let mut current = root;
    for (i, part) in parts.iter().enumerate() {
        current = match current {
            Inode::Dir { children, .. } => children
                .get_mut(*part)
                .ok_or_else(|| VfsError::NotFound(join_path(&parts[..=i])))?,
            _ => return Err(VfsError::NotDir(join_path(&parts[..i]))),
        };
    }
    match current {
        Inode::Dir { children, .. } => Ok(children),
        _ => Err(VfsError::NotDir("terminal".to_owned())),
    }
}

/// Resolve a path to an inode, following symlinks when `follow` is true.
fn resolve<'a>(root: &'a Inode, path: &str, follow: bool, depth: usize) -> VfsResult<&'a Inode> {
    if depth > MAX_SYMLINK_DEPTH {
        return Err(VfsError::SymlinkLoop);
    }
    let parts = parse_path(path).ok_or_else(|| VfsError::Invalid("relative path".to_owned()))?;
    let mut current = root;
    for (i, part) in parts.iter().enumerate() {
        match current {
            Inode::Dir { children, .. } => {
                let child = children
                    .get(*part)
                    .ok_or_else(|| VfsError::NotFound(join_path(&parts[..=i])))?;
                let is_last = i == parts.len() - 1;
                if let Inode::Symlink { target, .. } = child {
                    if !is_last || follow {
                        return resolve(root, target, follow, depth + 1);
                    }
                }
                current = child;
            }
            _ => return Err(VfsError::NotDir(join_path(&parts[..i]))),
        }
    }
    Ok(current)
}

// ── Glob walker ───────────────────────────────────────────────────────────────

fn glob_walk<F>(
    node: &Inode,
    dir_path: &str,
    pattern: &str,
    out: &mut Vec<String>,
    virtual_readdir: F,
) where
    F: Fn(&str) -> Option<Vec<DirEntry>> + Copy,
{
    let children: Vec<(String, bool)> = if let Some(virt) = virtual_readdir(dir_path) {
        virt.into_iter().map(|e| (e.name, e.is_dir)).collect()
    } else if let Inode::Dir { children, .. } = node {
        children
            .iter()
            .map(|(n, i)| (n.clone(), i.is_dir()))
            .collect()
    } else {
        return;
    };

    for (name, is_dir) in children {
        let child_path = if dir_path == "/" {
            format!("/{name}")
        } else {
            format!("{dir_path}/{name}")
        };
        if glob::glob_match(pattern, &child_path) {
            out.push(child_path.clone());
        }
        if is_dir {
            if let Inode::Dir { children, .. } = node {
                if let Some(child_node) = children.get(&name) {
                    glob_walk(child_node, &child_path, pattern, out, virtual_readdir);
                }
            }
        }
    }
}

// ── COW deep clone ────────────────────────────────────────────────────────────

pub fn deep_clone(node: &Inode) -> Inode {
    match node {
        Inode::File { meta, content } => Inode::File {
            meta: meta.clone(),
            content: Arc::clone(content),
        },
        Inode::Dir { meta, children } => Inode::Dir {
            meta: meta.clone(),
            children: children
                .iter()
                .map(|(k, v)| (k.clone(), deep_clone(v)))
                .collect(),
        },
        Inode::Symlink { meta, target } => Inode::Symlink {
            meta: meta.clone(),
            target: target.clone(),
        },
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn inode_to_stat(inode: &Inode) -> StatResult {
    let meta = inode.meta();
    StatResult {
        is_file: inode.is_file(),
        is_dir: inode.is_dir(),
        is_symlink: inode.is_symlink(),
        size: inode.byte_len(),
        permissions: meta.permissions,
        mtime: meta.mtime,
        ctime: meta.ctime,
        atime: meta.atime,
    }
}

fn count_subtree(node: &Inode) -> (usize, usize) {
    match node {
        Inode::File { content, .. } => (content.len(), 1),
        Inode::Symlink { .. } => (0, 1),
        Inode::Dir { children, .. } => children.values().fold((0, 1), |(b, c), child| {
            let (cb, cc) = count_subtree(child);
            (b + cb, c + cc)
        }),
    }
}

fn pseudo_random(len: usize) -> Vec<u8> {
    let mut state: u64 = 0xdeadbeefcafe1234
        ^ std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
    let mut buf = vec![0u8; len];
    for chunk in buf.chunks_mut(8) {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let bytes = state.to_le_bytes();
        for (i, b) in chunk.iter_mut().enumerate() {
            *b = bytes[i];
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vfs() -> MemVfs {
        MemVfs::new(None, None)
    }

    #[test]
    fn default_layout_exists() {
        let v = vfs();
        assert!(v.stat("/home/user").unwrap().is_dir);
        assert!(v.stat("/tmp").unwrap().is_dir);
        assert!(v.stat("/usr/bin").unwrap().is_dir);
    }

    #[test]
    fn write_and_read_file() {
        let mut v = vfs();
        v.write_file("/tmp/hello.txt", b"hello", false).unwrap();
        assert_eq!(v.read_file("/tmp/hello.txt").unwrap(), b"hello");
        assert_eq!(v.stat("/tmp/hello.txt").unwrap().size, 5);
    }

    #[test]
    fn append_file() {
        let mut v = vfs();
        v.write_file("/tmp/f", b"hello", false).unwrap();
        v.write_file("/tmp/f", b" world", true).unwrap();
        assert_eq!(v.read_file("/tmp/f").unwrap(), b"hello world");
    }

    #[test]
    fn mkdir_and_readdir() {
        let mut v = vfs();
        v.mkdir("/tmp/sub").unwrap();
        v.write_file("/tmp/sub/a.txt", b"a", false).unwrap();
        let entries = v.readdir("/tmp/sub").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "a.txt");
    }

    #[test]
    fn mkdirp() {
        let mut v = vfs();
        v.mkdirp("/tmp/a/b/c").unwrap();
        assert!(v.stat("/tmp/a/b/c").unwrap().is_dir);
    }

    #[test]
    fn unlink() {
        let mut v = vfs();
        v.write_file("/tmp/f", b"data", false).unwrap();
        let bytes_before = v.total_bytes();
        v.unlink("/tmp/f").unwrap();
        assert!(v.stat("/tmp/f").is_err());
        assert_eq!(v.total_bytes(), bytes_before - 4);
    }

    #[test]
    fn remove_recursive() {
        let mut v = vfs();
        v.mkdirp("/tmp/tree/a").unwrap();
        v.write_file("/tmp/tree/a/f", b"hello", false).unwrap();
        v.remove_recursive("/tmp/tree").unwrap();
        assert!(v.stat("/tmp/tree").is_err());
        assert_eq!(v.total_bytes(), 0);
    }

    #[test]
    fn symlink_and_readlink() {
        let mut v = vfs();
        v.write_file("/tmp/real", b"data", false).unwrap();
        v.symlink("/tmp/real", "/tmp/link").unwrap();
        assert_eq!(v.readlink("/tmp/link").unwrap(), "/tmp/real");
        assert_eq!(v.read_file("/tmp/link").unwrap(), b"data"); // follows symlink
    }

    #[test]
    fn rename() {
        let mut v = vfs();
        v.write_file("/tmp/a", b"x", false).unwrap();
        v.rename("/tmp/a", "/tmp/b").unwrap();
        assert!(v.stat("/tmp/a").is_err());
        assert_eq!(v.read_file("/tmp/b").unwrap(), b"x");
    }

    #[test]
    fn cow_clone_isolation() {
        let mut v = vfs();
        v.write_file("/tmp/shared", b"original", false).unwrap();
        let mut clone = v.cow_clone();
        clone.write_file("/tmp/shared", b"modified", false).unwrap();
        // Original is unchanged
        assert_eq!(v.read_file("/tmp/shared").unwrap(), b"original");
        assert_eq!(clone.read_file("/tmp/shared").unwrap(), b"modified");
    }

    #[test]
    fn snapshot_and_restore() {
        let mut v = vfs();
        v.write_file("/tmp/f", b"v1", false).unwrap();
        let snap = v.snapshot();
        v.write_file("/tmp/f", b"v2", false).unwrap();
        v.restore(&snap).unwrap();
        assert_eq!(v.read_file("/tmp/f").unwrap(), b"v1");
    }

    #[test]
    fn virtual_dev_null() {
        let v = vfs();
        assert_eq!(v.read_file("/dev/null").unwrap(), b"");
        assert!(v.stat("/dev/null").unwrap().is_file);
    }

    #[test]
    fn virtual_proc_version() {
        let v = vfs();
        let content = v.read_file("/proc/version").unwrap();
        assert!(content.starts_with(b"Yurt"));
    }

    #[test]
    fn glob_star() {
        let mut v = vfs();
        v.write_file("/tmp/a.rs", b"", false).unwrap();
        v.write_file("/tmp/b.rs", b"", false).unwrap();
        v.write_file("/tmp/c.txt", b"", false).unwrap();
        let matches = v.glob_paths("/tmp/*.rs");
        assert_eq!(matches, vec!["/tmp/a.rs", "/tmp/b.rs"]);
    }

    #[test]
    fn byte_accounting() {
        let mut v = vfs();
        assert_eq!(v.total_bytes(), 0);
        v.write_file("/tmp/f", b"hello", false).unwrap();
        assert_eq!(v.total_bytes(), 5);
        v.write_file("/tmp/f", b"hi", false).unwrap(); // overwrite shorter
        assert_eq!(v.total_bytes(), 2);
    }
}
