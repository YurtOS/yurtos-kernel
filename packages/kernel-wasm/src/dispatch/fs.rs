use crate::abi;
use crate::kernel::{with_kernel, Kernel};
use crate::path::PathResolver;

use super::{take_bytes, ID_NO_CHANGE};

fn can_modify_owned_metadata(credentials: crate::state::Credentials, owner_uid: u32) -> bool {
    credentials.euid == 0 || credentials.euid == owner_uid
}

/// Derive the `(mount_id, dir_inode)` anchor for an already-normalized
/// absolute directory `path`. Inode-anchored when the owning backend
/// supports dir inodes (`MountTable::dir_inode_at` is `Some`), else the
/// path-snapshot degraded mode: `(ROOT_MOUNT, None)`.
///
/// B2.9 Task 5 is a behavior-preserving shape migration — nothing reads
/// `mount_id`/`dir_inode` to change resolution yet (that is Task 6);
/// resolution still goes through the absolute `path` snapshot, so the
/// degraded `(ROOT_MOUNT, None)` fallback is correct here. The
/// `MountTable` has no public mount-id-only accessor (`resolve` is
/// private), and adding one is out of Task 5's scope; `dir_inode_at`
/// (the Task 1 pass-through) is the minimal sufficient lookup.
fn dir_anchor(k: &Kernel, path: &[u8]) -> (crate::vfs::MountId, Option<u64>) {
    match k.vfs.dir_inode_at(path) {
        Some((mid, ino)) => (mid, Some(ino)),
        None => (crate::vfs::ROOT_MOUNT, None),
    }
}

pub(super) fn chdir(caller_pid: u32, request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, request) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        match k.vfs.entry_type(&path) {
            3 => {}
            0 => return -(abi::ENOENT as i64),
            _ => return -(abi::ENOTDIR as i64),
        }
        let (mount_id, dir_inode) = dir_anchor(k, &path);
        k.process_mut(caller_pid).cwd = crate::kernel::Cwd {
            mount_id,
            dir_inode,
            path,
        };
        0
    })
}

pub(super) fn fchdir(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() != 4 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().unwrap());
    with_kernel(|k| {
        let (mount_id, dir_inode, path) = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(crate::kernel::FdEntry::Directory {
                mount_id,
                dir_inode,
                path,
            }) => (*mount_id, *dir_inode, path.clone()),
            Some(_) => return -(abi::ENOTDIR as i64),
            None => return -(abi::EBADF as i64),
        };
        let path = match dir_inode {
            Some(ino) => match k.vfs.dir_abspath_in(mount_id, ino) {
                Some(abs) => abs,
                None => return -(abi::ENOENT as i64),
            },
            None => {
                if k.vfs.entry_type(&path) != 3 {
                    return -(abi::ENOENT as i64);
                }
                path
            }
        };
        // Copy the fd's full (mount_id, dir_inode, path) capability into
        // cwd (inode-anchored when the fd carried one, else snapshot).
        k.process_mut(caller_pid).cwd = crate::kernel::Cwd {
            mount_id,
            dir_inode,
            path,
        };
        0
    })
}

pub(super) fn getcwd(caller_pid: u32, response: &mut [u8]) -> i64 {
    // Mirrors the TS host_getcwd contract: returns the *required* size
    // (path length + 1 NUL byte). Caller compares against out_cap.
    with_kernel(|k| {
        // B2.9 Task 6: refresh from the live inode→path mapping
        // (mount-prefix-composed) so getcwd stays correct after the
        // cwd directory is renamed. `dir_inode == None` is degraded
        // path-snapshot mode; `dir_abspath_in == None` means the
        // inode-anchored cwd was removed and has no linkable path.
        let cwd_state = k.process(caller_pid).cwd.clone();
        let cwd = match cwd_state.dir_inode {
            Some(ino) => match k.vfs.dir_abspath_in(cwd_state.mount_id, ino) {
                Some(abs) => {
                    if abs != cwd_state.path {
                        k.process_mut(caller_pid).cwd.path = abs.clone();
                    }
                    abs
                }
                None => return -(abi::ENOENT as i64),
            },
            // Degraded-backend cwd (hostfs/overlay → `dir_inode ==
            // None`, e.g. after `chdir` into a `/host/...` mount) OR
            // the `Process::new` default `/`. In both cases no inode is
            // anchored, so the absolute `path` snapshot is itself
            // authoritative — there is nothing to refresh it from.
            // Deliberately NOT the lazy `/`→inode upgrade
            // `PathResolver::resolved_cwd` does (that one is gated on
            // `cwd.path == b"/"`); do not "simplify" this to `b"/"`,
            // which would corrupt a degraded non-root cwd.
            None => cwd_state.path,
        };
        let required = cwd.len() + 1;
        if response.len() < required {
            return required as i64;
        }
        response[..cwd.len()].copy_from_slice(&cwd);
        response[cwd.len()] = 0;
        required as i64
    })
}

/// `sys_open(flags, path) -> fd`. Request: u32 flags LE + path bytes.
/// Flags bits: 0=writable, 1=create-if-missing (O_CREAT),
/// 2=truncate-if-exists (O_TRUNC).
pub(super) fn sys_open(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let flags = u32::from_le_bytes(request[0..4].try_into().unwrap());
    let raw_path = &request[4..];
    if raw_path.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let writable = flags & 0b001 != 0;
    let create = flags & 0b010 != 0;
    let trunc = flags & 0b100 != 0;
    let directory = flags & 0b1000 != 0;
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, raw_path) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        // Follow symlinks (shared with stat_path so the semantics
        // cannot drift): up to SYMLOOP_MAX hops, each re-authorized.
        let resolved = match follow_symlinks(k, caller_pid, path) {
            Ok(p) => p,
            Err(rc) => return rc,
        };
        let path: &[u8] = &resolved;
        let entry_type = k.vfs.entry_type(path);
        if directory && entry_type != 3 {
            return -(abi::ENOTDIR as i64);
        }
        if entry_type == 3 {
            if writable || create || trunc {
                return -(abi::EISDIR as i64);
            }
            // Dual-shape anchor: inode-anchored when the backend
            // supports dir inodes, else path-snapshot degraded mode.
            // Behavior is path-snapshot identical until Task 6 wires
            // the inode walk.
            let (mount_id, dir_inode) = dir_anchor(k, path);
            let dir_path = path.to_vec();
            let p = k.process_mut(caller_pid);
            let fd = p.fd_table.lowest_free_fd();
            p.fd_table.install(
                fd,
                crate::kernel::FdEntry::Directory {
                    mount_id,
                    dir_inode,
                    path: dir_path,
                },
            );
            return fd as i64;
        }
        // open() handles both lookup and create-if-missing in one
        // call. The flags bits propagate to the backend so it knows
        // the caller's intent (writable opens vs read-only).
        let (mount_id, inode) = match k.vfs.open_result(path, flags) {
            Ok(pair) => pair,
            Err(err) => {
                if err != abi::ENOENT {
                    return -(err as i64);
                }
                // Distinguish "create wasn't allowed" from "no such
                // file": read-only backends (Tar, Proc, Dev) refuse
                // the create bit and return the default ENOENT shape.
                if create {
                    return -(abi::EPERM as i64);
                } else {
                    return -(abi::ENOENT as i64);
                }
            }
        };
        if trunc {
            k.vfs.truncate(mount_id, inode);
        }
        let ofd_id = k.create_ofd(mount_id, inode, writable);
        let p = k.process_mut(caller_pid);
        let fd = p.fd_table.lowest_free_fd();
        p.fd_table
            .install(fd, crate::kernel::FdEntry::File { ofd_id });
        fd as i64
    })
}

/// `openat(dirfd, path, flags)` — relative-to-directory-fd open.
///
/// Absolute paths and `dirfd == AT_FDCWD` behave exactly like
/// `sys_open` (cwd-relative).
///
/// Otherwise the directory fd is resolved POSIX-faithfully (B2.9).
/// When the fd is **inode-anchored** (`dir_inode == Some`), the dirfd's
/// CURRENT absolute path is reconstructed from the live inode→path
/// mapping (`dir_abspath_in`), so the open stays correct after the
/// directory is renamed and fails `ENOENT` after it is removed. An
/// inode component walk then resolves the relative path one component
/// at a time; the moment it would have to follow a symlink, cross a
/// `.`/`..` lexical step, or cross into a child mount, it STOPS,
/// reconstructs the absolute path, and re-delegates to the path-based
/// `sys_open` (which owns the centralized 40-hop SYMLOOP, lexical
/// normalization, longest-prefix mount routing, and create/trunc/
/// directory semantics — never duplicated here).
///
/// A `dir_inode == None` fd is the path-snapshot **degraded mode**
/// (hostfs / overlay-if-deferred / embedder backends): behavior is
/// exactly as before — join the stored path and hand it to `sys_open`.
pub(super) fn sys_openat(caller_pid: u32, request: &[u8]) -> i64 {
    const AT_FDCWD: u32 = u32::MAX;
    // WASI filetype byte from `VfsBackend::resolve_at` (matches
    // `entry_type`): 3 = directory. A symlink is 7 and a regular file
    // is 4 — both fall into the walk's STOP arm (reconstruct +
    // re-delegate to the path-based `sys_open`), so only DIR needs a
    // named constant for the descend case.
    const FT_DIR: u8 = 3;
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let dirfd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let path = &request[8..];
    if path.is_empty() {
        return -(abi::EINVAL as i64);
    }

    // Absolute path or AT_FDCWD → identical to plain open (cwd-relative).
    if path[0] == b'/' || dirfd == AT_FDCWD {
        let mut req = flags.to_le_bytes().to_vec();
        req.extend_from_slice(path);
        return sys_open(caller_pid, &req);
    }

    // Snapshot the dirfd's dual capability (no nested with_kernel:
    // every branch returns / re-enters before sys_open re-locks).
    let (mount_id, dir_inode, snap_path) =
        match with_kernel(|k| match k.process_mut(caller_pid).fd_table.entry(dirfd) {
            Some(crate::kernel::FdEntry::Directory {
                mount_id,
                dir_inode,
                path,
            }) => Ok((*mount_id, *dir_inode, path.clone())),
            Some(_) => Err(abi::ENOTDIR),
            None => Err(abi::EBADF),
        }) {
            Ok(t) => t,
            Err(errno) => return -(errno as i64),
        };

    let Some(base_inode) = dir_inode else {
        // Degraded mode (`dir_inode == None`): unchanged path-snapshot
        // join. The stored path is the PathResolver-normalized
        // ABSOLUTE snapshot (preserves the absolute invariant below).
        debug_assert!(
            snap_path.first() == Some(&b'/'),
            "dir fd path must be absolute, got {:?}",
            String::from_utf8_lossy(&snap_path)
        );
        let mut joined = snap_path;
        if joined.last() != Some(&b'/') {
            joined.push(b'/');
        }
        joined.extend_from_slice(path);
        let mut req = flags.to_le_bytes().to_vec();
        req.extend_from_slice(&joined);
        return sys_open(caller_pid, &req);
    };

    // Inode-anchored. The dirfd's CURRENT absolute path is whatever the
    // live inode→path mapping says (rename-stable); `None` ⇒ the dir
    // was removed (rmdir/unlink) — no linkable path, POSIX ENOENT.
    let base_abs = match with_kernel(|k| k.vfs.dir_abspath_in(mount_id, base_inode)) {
        Some(abs) => abs,
        None => return -(abi::ENOENT as i64),
    };

    // Component inode walk. The dirfd's directory is now resolved
    // inode-faithfully (`base_abs`). The walk descends the relative
    // path one component at a time so it can detect the spec's STOP
    // conditions — a `.`/`..` lexical step, a SYMLINK component
    // mid-walk (filetype 7), or a crossing into a CHILD mount — and
    // re-delegate to the path-based resolver instead of resolving
    // those itself. SYMLOOP and lexical normalization are NEVER
    // duplicated here.
    let components: Vec<&[u8]> = path
        .split(|b| *b == b'/')
        .filter(|c| !c.is_empty())
        .collect();
    let has_dot_component = components.iter().any(|c| *c == b"." || *c == b"..");

    // Set when the inode walk cannot descend a *non-final* component:
    // it is a symlink (filetype 7), a regular file (filetype 4), or
    // does not exist (`resolve_at_in == None`). In every such case the
    // inode walk is incomplete and `sys_open`'s whole-path
    // `follow_symlinks` would not resolve an intermediate symlink, so
    // we canonicalize the FINAL component's parent directory through
    // the centralized component-aware resolver (`PathResolver::
    // realpath`, the existing 40-hop SYMLOOP — reused, not duplicated)
    // and hand the canonical parent + final component to `sys_open`,
    // which then yields the correct ENOENT/ENOTDIR/open result.
    let mut needs_path_resolver = false;
    if !has_dot_component && !components.is_empty() {
        let mut cur_inode = base_inode;
        let mut cur_abs = base_abs.clone();
        for name in components.iter().take(components.len() - 1) {
            match with_kernel(|k| k.vfs.resolve_at_in(mount_id, cur_inode, name)) {
                Some((Some(child), FT_DIR)) => {
                    let mut next_abs = cur_abs.clone();
                    if next_abs.last() != Some(&b'/') {
                        next_abs.push(b'/');
                    }
                    next_abs.extend_from_slice(name);
                    // Child-mount crossing ⇒ stop the inode walk; the
                    // path-based `sys_open` routes correctly through
                    // the longest-prefix mount table.
                    let crosses_mount = with_kernel(|k| {
                        k.vfs
                            .mount_of(&next_abs)
                            .map(|(m, _)| m != mount_id)
                            .unwrap_or(true)
                    });
                    if crosses_mount {
                        break;
                    }
                    cur_inode = child;
                    cur_abs = next_abs;
                }
                // Any non-descendable non-final component. First rule
                // out a child-mount crossing: a mount point (`/dev`,
                // `/proc`, …) is a MountTable concept, invisible to the
                // PARENT backend, so `resolve_at` returns `None` for it
                // exactly like a missing entry. That is NOT a
                // non-descendable intermediate — `realpath(parent)`
                // would wrongly `ENOENT` because the child backend need
                // not type its own root via `entry_type`. Re-delegate
                // the whole path to `sys_open`, which routes through the
                // longest-prefix mount table (the pre-B2.9
                // path-snapshot behaviour). Mirrors the descend arm's
                // `crosses_mount` guard.
                _ => {
                    let mut next_abs = cur_abs.clone();
                    if next_abs.last() != Some(&b'/') {
                        next_abs.push(b'/');
                    }
                    next_abs.extend_from_slice(name);
                    let crosses_mount = with_kernel(|k| {
                        k.vfs
                            .mount_of(&next_abs)
                            .map(|(m, _)| m != mount_id)
                            .unwrap_or(true)
                    });
                    // Same-mount symlink (ft 7), regular file (ft 4),
                    // or genuinely missing entry: the centralized
                    // resolver below handles it (intermediate symlink
                    // resolution, ENOENT, or ENOTDIR respectively). A
                    // mount crossing instead falls through to the
                    // mount-routed `sys_open(joined)`.
                    if !crosses_mount {
                        needs_path_resolver = true;
                    }
                    break;
                }
            }
        }
    }

    // Reconstruct the absolute target = the dirfd's inode-faithful
    // CURRENT absolute path + the original relative path.
    let mut joined = base_abs;
    if joined.last() != Some(&b'/') {
        joined.push(b'/');
    }
    joined.extend_from_slice(path);

    if needs_path_resolver {
        // The inode walk stopped on a non-descendable intermediate
        // component. Split off the final component; canonicalize the
        // parent directory via the existing centralized
        // component-SYMLOOP resolver (`PathResolver::realpath`), then
        // delegate `canonical_parent + final` to `sys_open` (which
        // still owns create/trunc/O_DIRECTORY/EISDIR, the
        // final-component symlink, and ENOENT/ENOTDIR for a
        // missing/non-dir intermediate). This reuses the 40-hop
        // SYMLOOP, never duplicates it. `joined` is absolute and has
        // at least one component (a non-final component triggered
        // this branch).
        let split = joined
            .iter()
            .rposition(|&b| b == b'/')
            .expect("absolute path has a separator");
        let (parent, last_with_sep) = joined.split_at(split);
        let last = &last_with_sep[1..];
        let parent: &[u8] = if parent.is_empty() { b"/" } else { parent };
        let canonical_parent =
            match with_kernel(|k| PathResolver::new(k, caller_pid).realpath(parent)) {
                Ok(p) => p,
                Err(errno) => return -(errno as i64),
            };
        let mut target = canonical_parent;
        if target.last() != Some(&b'/') {
            target.push(b'/');
        }
        target.extend_from_slice(last);
        let mut req = flags.to_le_bytes().to_vec();
        req.extend_from_slice(&target);
        return sys_open(caller_pid, &req);
    }

    // No intermediate symlink: `sys_open` owns everything else
    // (normalize for `.`/`..`, whole-path `follow_symlinks` for a
    // final-component symlink, MountTable longest-prefix for mount
    // crossings, create/trunc/directory semantics).
    let mut req = flags.to_le_bytes().to_vec();
    req.extend_from_slice(&joined);
    sys_open(caller_pid, &req)
}

fn normalize_readable_path(
    k: &mut Kernel,
    caller_pid: u32,
    raw_path: &[u8],
) -> Result<Vec<u8>, i64> {
    let path = PathResolver::new(k, caller_pid).normalize(raw_path)?;
    // Refresh procfs snapshots so /proc/<N> views reflect the current
    // process table at lookup time, then gate all read-like path
    // surfaces consistently.
    k.publish_proc_snapshots();
    if !k.can_read_proc_path(caller_pid, &path) {
        return Err(-(abi::EPERM as i64));
    }
    Ok(path)
}

/// Follow symlinks at `path` (already normalized) up to SYMLOOP_MAX
/// (40) hops, re-normalizing and re-authorizing each target so a
/// ramfs link cannot bypass procfs access checks. Returns the
/// resolved path, or `-ELOOP` once the hop limit is exceeded (POSIX;
/// #69). Shared by `sys_open` and `stat_path` so the follow
/// semantics — including this errno — cannot drift between them.
fn follow_symlinks(k: &mut Kernel, caller_pid: u32, path: Vec<u8>) -> Result<Vec<u8>, i64> {
    let mut resolved = path;
    let mut hops = 0u32;
    while let Some(target) = k.vfs.readlink(&resolved) {
        hops += 1;
        if hops > 40 {
            // Too many symlink hops: POSIX/Linux errno is ELOOP
            // (SYMLOOP_MAX = 40), not EINVAL.
            return Err(-(abi::ELOOP as i64));
        }
        resolved = normalize_readable_path(k, caller_pid, &target)?;
    }
    Ok(resolved)
}

/// `mkdir(path) -> 0 / -EEXIST / -EROFS`.
pub(super) fn mkdir(caller_pid: u32, request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, request) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        k.vfs.mkdir(&path) as i64
    })
}

/// `rmdir(path) -> 0 / -ENOENT / -ENOTEMPTY / -EROFS`.
pub(super) fn rmdir(caller_pid: u32, request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, request) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        k.vfs.rmdir(&path) as i64
    })
}

/// `readdir(path) -> packed entries`. Response layout:
/// u32 count_le + (u32 name_len_le + name_bytes)*. Truncated when
/// out_cap exceeded; the count reflects only what fit.
pub(super) fn readdir(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, request) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        let entries = match k.vfs.readdir(&path) {
            Some(e) => e,
            None => return -(abi::ENOENT as i64),
        };
        // Pack as count + (u32 name_len, u8 type, name_bytes)*.
        // Type byte is a WASI filetype (0/3/4/7); 0 means the
        // backend doesn't know — userland will stat to find out.
        let mut cursor = 4usize;
        let mut count: u32 = 0;
        let parent: &[u8] = &path;
        for name in &entries {
            let need = 4 + 1 + name.len();
            if cursor + need > response.len() {
                break;
            }
            // Build child absolute path = parent + "/" + name (with
            // root special-cased so we don't end up with "//foo").
            let mut child = Vec::with_capacity(parent.len() + 1 + name.len());
            child.extend_from_slice(parent);
            if parent != b"/" {
                child.push(b'/');
            }
            child.extend_from_slice(name);
            let ty = k.vfs.entry_type(&child);

            response[cursor..cursor + 4].copy_from_slice(&(name.len() as u32).to_le_bytes());
            cursor += 4;
            response[cursor] = ty;
            cursor += 1;
            response[cursor..cursor + name.len()].copy_from_slice(name);
            cursor += name.len();
            count += 1;
        }
        response[0..4].copy_from_slice(&count.to_le_bytes());
        cursor as i64
    })
}

/// `symlink(target_len, target, link_path)`. Request: u32 target_len
/// LE + target_bytes + link_path_bytes. Returns 0 on success or
/// negated POSIX errno from the backend.
pub(super) fn symlink(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let target_len = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
    let Ok((target, link_path_raw)) = take_bytes(request, 4, target_len) else {
        return -(abi::EINVAL as i64);
    };
    if link_path_raw.is_empty() {
        return -(abi::EINVAL as i64);
    }
    // Symlink target stays verbatim — it's content, not a path
    // resolved at install time. Only link_path goes through the
    // /proc/self rewrite.
    with_kernel(|k| {
        let link_path = match PathResolver::new(k, caller_pid).normalize(link_path_raw) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        k.vfs.symlink(target, &link_path) as i64
    })
}

/// `rename(old_len, old, new)`. Wire shape mirrors symlink/link.
/// Routes to `MountTable::rename`, which enforces same-mount.
pub(super) fn rename(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let old_len = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
    let Ok((old_raw, new_raw)) = take_bytes(request, 4, old_len) else {
        return -(abi::EINVAL as i64);
    };
    if new_raw.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let old_path = match PathResolver::new(k, caller_pid).normalize(old_raw) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        let new_path = match PathResolver::new(k, caller_pid).normalize(new_raw) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        k.vfs.rename(&old_path, &new_path) as i64
    })
}

/// `link(target_len, target, link_path)`. Same wire format as
/// `symlink` so both can share request decoding shape. Routes to
/// `MountTable::link`, which enforces same-mount and refcount.
pub(super) fn hard_link(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let target_len = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
    let Ok((target_raw, link_raw)) = take_bytes(request, 4, target_len) else {
        return -(abi::EINVAL as i64);
    };
    if link_raw.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let target = match PathResolver::new(k, caller_pid).normalize(target_raw) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        let link_path = match PathResolver::new(k, caller_pid).normalize(link_raw) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        k.vfs.link(&target, &link_path) as i64
    })
}

/// `readlink(path) -> bytes-written or -ENOENT/-EINVAL`. Writes
/// the symlink target into the response. Path that doesn't resolve
/// to a symlink returns -EINVAL (POSIX) or -ENOENT (no such path).
pub(super) fn readlink(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, request) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        let Some(target) = k.vfs.readlink(&path) else {
            return -(abi::EINVAL as i64);
        };
        let n = target.len().min(response.len());
        response[..n].copy_from_slice(&target[..n]);
        n as i64
    })
}

/// `realpath(path) -> canonical absolute path + NUL`. The response
/// mirrors the transitional `host_realpath` contract: return the
/// required byte count, including the trailing NUL, even when the
/// caller's output buffer is too small.
pub(super) fn realpath(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    with_kernel(|k| {
        let resolved = match PathResolver::new(k, caller_pid).realpath(request) {
            Ok(path) => path,
            Err(errno) => return -(errno as i64),
        };
        k.publish_proc_snapshots();
        if !k.can_read_proc_path(caller_pid, &resolved) {
            return -(abi::EPERM as i64);
        }
        let required = resolved.len() + 1;
        if response.len() < required {
            return required as i64;
        }
        response[..resolved.len()].copy_from_slice(&resolved);
        response[resolved.len()] = 0;
        required as i64
    })
}

/// `unlink(path) -> 0 / -ENOENT / -EROFS`. Path-based delete; the
/// active backend's `unlink` does the work, including overlay
/// whiteouts.
pub(super) fn unlink(caller_pid: u32, request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, request) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        let removed_socket = k.unlink_unix_socket_inode(&path);
        let rc = k.vfs.unlink(&path);
        if rc == -(abi::ENOENT) && removed_socket {
            0
        } else {
            rc as i64
        }
    })
}

/// Type `path` (already normalized; the caller decides whether
/// symlinks were followed) into the shared 16-byte fstat-shaped
/// record: u64 size + u32 filetype + u32 mode. `stat_path` follows
/// the link chain before calling this; `lstat_path` does not — that
/// follow step is the *only* difference between the two, so they
/// cannot drift on how an entry is typed. Returns 16, or -ENOENT
/// when the path doesn't resolve to an entry.
///
/// Precondition: `response.len() >= 16`. Both callers enforce the
/// `< 16 → -EINVAL` guard before calling; the assert documents the
/// invariant and traps a future third caller in debug/test builds.
fn write_stat_record(k: &mut Kernel, path: &[u8], response: &mut [u8]) -> i64 {
    debug_assert!(
        response.len() >= 16,
        "write_stat_record needs a >=16-byte response; callers must guard"
    );
    if k.has_unix_socket_inode(path) {
        response[0..8].copy_from_slice(&0u64.to_le_bytes());
        response[8..12].copy_from_slice(&6u32.to_le_bytes());
        response[12..16].copy_from_slice(&0o140_666u32.to_le_bytes());
        return 16;
    }
    let filetype = k.vfs.entry_type(path) as u32;
    if filetype == 0 {
        return -(abi::ENOENT as i64);
    }
    let (size, mode) = if filetype == 4 {
        let (mount_id, inode) = match k.vfs.open(path, 0) {
            Some(pair) => pair,
            None => return -(abi::ENOENT as i64),
        };
        let size = k.vfs.size(mount_id, inode).unwrap_or(0);
        let meta = k.resolve_metadata(mount_id, inode);
        (size, meta.mode)
    } else {
        let mode = match filetype {
            3 => 0o040_755,
            7 => 0o120_777,
            6 => 0o140_666,
            _ => 0o100_644,
        };
        (0, mode)
    };
    response[0..8].copy_from_slice(&size.to_le_bytes());
    response[8..12].copy_from_slice(&filetype.to_le_bytes());
    response[12..16].copy_from_slice(&mode.to_le_bytes());
    16
}

/// `stat(path) -> 16-byte fstat-shaped record`. Same wire format as
/// sys_fstat: u64 size + u32 filetype + u32 mode. Doesn't require an
/// open fd. Returns 16 on success, -ENOENT for unresolvable path.
pub(super) fn stat_path(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, request) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        // POSIX: stat() follows symlinks (unlike lstat). Resolve
        // through the link chain before typing the entry, sharing
        // sys_open's follow helper so the two cannot diverge.
        let path = match follow_symlinks(k, caller_pid, path) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        write_stat_record(k, &path, response)
    })
}

/// `lstat(path) -> 16-byte fstat-shaped record`. Identical to
/// `stat_path` EXCEPT it does not follow a terminal symlink (POSIX
/// lstat): `normalize_readable_path` is lexical/no-follow and
/// `entry_type` does not resolve links, so a symlink — whether it
/// points at a dir, a file, or a missing target — reports S_IFLNK
/// and returns 16 (a dangling link still exists; only an absent
/// path is -ENOENT). This is the no-follow lexical path #67
/// deliberately preserved. Issue #81.
pub(super) fn lstat_path(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, request) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        write_stat_record(k, &path, response)
    })
}

/// `chown(uid, gid, path) -> 0 or -ENOENT`. Request: u32 uid + u32
/// gid + path bytes. Sandbox-view only — underlying host storage's
/// owner is unchanged.
pub(super) fn chown(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let uid = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let gid = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let raw = &request[8..];
    if raw.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match PathResolver::new(k, caller_pid).normalize(raw) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        let (mount_id, inode) = match k.vfs.open(&path, 0) {
            Some(pair) => pair,
            None => return -(abi::ENOENT as i64),
        };
        let caller_credentials = k.process_mut(caller_pid).credentials;
        if caller_credentials.euid != 0 {
            return -(abi::EPERM as i64);
        }
        let mut meta = k.resolve_metadata(mount_id, inode);
        if uid != ID_NO_CHANGE {
            meta.uid = uid;
        }
        if gid != ID_NO_CHANGE {
            meta.gid = gid;
        }
        k.set_metadata_override(mount_id, inode, meta);
        0
    })
}

/// `fchown(fd, uid, gid) -> 0 or -errno`. Request: u32 fd + u32 uid + u32 gid.
pub(super) fn fchown(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() != 12 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let uid = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let gid = u32::from_le_bytes(request[8..12].try_into().expect("4 bytes"));
    with_kernel(|k| {
        let ofd_id = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(crate::kernel::FdEntry::File { ofd_id }) => *ofd_id,
            _ => return -(abi::EBADF as i64),
        };
        let (mount_id, inode) = match k.ofd(ofd_id) {
            Some(ofd) => (ofd.mount_id, ofd.inode),
            None => return -(abi::EBADF as i64),
        };
        let caller_credentials = k.process_mut(caller_pid).credentials;
        if caller_credentials.euid != 0 {
            return -(abi::EPERM as i64);
        }
        let mut meta = k.resolve_metadata(mount_id, inode);
        if uid != ID_NO_CHANGE {
            meta.uid = uid;
        }
        if gid != ID_NO_CHANGE {
            meta.gid = gid;
        }
        k.set_metadata_override(mount_id, inode, meta);
        0
    })
}

/// `utimens(mtime_ns, path) -> 0 or -ENOENT`. Phase 6 surfaces
/// mtime only; atime tracking lands later.
pub(super) fn utimens(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let mtime_ns = u64::from_le_bytes(request[0..8].try_into().expect("8 bytes"));
    let raw = &request[8..];
    if raw.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match PathResolver::new(k, caller_pid).normalize(raw) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        let (mount_id, inode) = match k.vfs.open(&path, 0) {
            Some(pair) => pair,
            None => return -(abi::ENOENT as i64),
        };
        let mut meta = k.resolve_metadata(mount_id, inode);
        let caller_credentials = k.process_mut(caller_pid).credentials;
        if !can_modify_owned_metadata(caller_credentials, meta.uid) {
            return -(abi::EPERM as i64);
        }
        meta.mtime_ns = mtime_ns;
        k.set_metadata_override(mount_id, inode, meta);
        0
    })
}

/// `chmod(mode, path) -> 0 or -ENOENT`. Request: u32 mode LE +
/// path bytes. Writes to the kernel's MetadataOverlay; subsequent
/// fstat sees the new mode. Caller must be root or the file owner.
pub(super) fn chmod(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let mode = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let raw = &request[4..];
    if raw.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match PathResolver::new(k, caller_pid).normalize(raw) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        let (mount_id, inode) = match k.vfs.open(&path, 0) {
            Some(pair) => pair,
            None => return -(abi::ENOENT as i64),
        };
        let mut meta = k.resolve_metadata(mount_id, inode);
        let caller_credentials = k.process_mut(caller_pid).credentials;
        if !can_modify_owned_metadata(caller_credentials, meta.uid) {
            return -(abi::EPERM as i64);
        }
        // Only update permission bits — high nibble (file type)
        // is fixed by the backend, not the user.
        meta.mode = (meta.mode & 0o170_000) | (mode & 0o007_777);
        k.set_metadata_override(mount_id, inode, meta);
        0
    })
}
