use crate::abi;
use crate::kernel::{with_kernel, Kernel};
use crate::path::PathResolver;

use super::{proc_pid_visible, take_bytes, ID_NO_CHANGE};

fn can_modify_owned_metadata(credentials: crate::state::Credentials, owner_uid: u32) -> bool {
    credentials.euid == 0 || credentials.euid == owner_uid
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
        k.process_mut(caller_pid).cwd = path;
        0
    })
}

pub(super) fn fchdir(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() != 4 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().unwrap());
    with_kernel(|k| {
        let path = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(crate::kernel::FdEntry::Directory { path }) => path.clone(),
            Some(_) => return -(abi::ENOTDIR as i64),
            None => return -(abi::EBADF as i64),
        };
        if k.vfs.entry_type(&path) != 3 {
            return -(abi::ENOENT as i64);
        }
        k.process_mut(caller_pid).cwd = path;
        0
    })
}

pub(super) fn getcwd(caller_pid: u32, response: &mut [u8]) -> i64 {
    // Mirrors the TS host_getcwd contract: returns the *required* size
    // (path length + 1 NUL byte). Caller compares against out_cap.
    with_kernel(|k| {
        let cwd = k.process_mut(caller_pid).cwd.clone();
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
        // Negate-and-widen at the boundary — resolver convention.
        let resolved = match follow_symlinks(k, caller_pid, path) {
            Ok(p) => p,
            Err(errno) => return -(errno as i64),
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
            let p = k.process_mut(caller_pid);
            let fd = p.fd_table.lowest_free_fd();
            p.fd_table.install(
                fd,
                crate::kernel::FdEntry::Directory {
                    path: path.to_vec(),
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
/// Absolute paths and `dirfd == AT_FDCWD` behave exactly like
/// `sys_open` (cwd-relative); otherwise the path is joined onto the
/// directory fd's stored path and handed to `sys_open`, so symlink
/// resolution / create / directory semantics stay identical. (B2.4)
pub(super) fn sys_openat(caller_pid: u32, request: &[u8]) -> i64 {
    const AT_FDCWD: u32 = u32::MAX;
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

    // Resolve the directory fd's path (no nested with_kernel: this
    // closure returns before sys_open takes the lock again).
    //
    // FIXME(#59): not POSIX-faithful — `FdEntry::Directory` stores the
    // path captured at open() time, so `openat(dirfd, "child")` resolves
    // the *stale* path if the directory is renamed/unlinked. A dirfd
    // must track the directory object (inode), which needs a
    // VfsBackend dir-handle API across every backend (VFS rewrite,
    // tracked in #59 — not patched here).
    let dir = match with_kernel(|k| match k.process_mut(caller_pid).fd_table.entry(dirfd) {
        Some(crate::kernel::FdEntry::Directory { path }) => Ok(path.clone()),
        Some(_) => Err(abi::ENOTDIR),
        None => Err(abi::EBADF),
    }) {
        Ok(d) => d,
        Err(errno) => return -(errno as i64),
    };

    // Invariant: a directory fd's stored path is absolute (PathResolver
    // normalizes at open() time). The join below would otherwise be
    // silently treated as cwd-relative by sys_open. Holds until the #59
    // inode-anchored rewrite replaces this path snapshot (PR #55 review).
    debug_assert!(
        dir.first() == Some(&b'/'),
        "dir fd path must be absolute, got {:?}",
        String::from_utf8_lossy(&dir)
    );
    let mut joined = dir;
    if joined.last() != Some(&b'/') {
        joined.push(b'/');
    }
    joined.extend_from_slice(path);
    let mut req = flags.to_le_bytes().to_vec();
    req.extend_from_slice(&joined);
    sys_open(caller_pid, &req)
}

/// #105 / M8: a `/proc/<pid>` path is *reachable* by `caller_pid` iff
/// it is not a per-pid path at all (synthetic entries like `/proc`
/// itself), or the target pid is visible to the caller under #66's
/// ownership model (`proc_pid_visible` → self / same-owner / root).
///
/// Crucially this returns the **same** answer for "pid absent" and
/// "pid present but unauthorized": `proc_pid_visible` is `false` in
/// both cases, so the caller maps both to `-ENOENT` and the
/// pid-existence oracle is closed. Caller's own pid and same-credential
/// pids stay fully visible.
fn proc_path_reachable(k: &mut Kernel, caller_pid: u32, path: &[u8]) -> bool {
    match crate::path::proc_target_pid(path) {
        // Not a /proc/<pid> path (e.g. /proc, /proc/<non-numeric>) —
        // no per-pid gating; synthetic entries are unaffected.
        None => true,
        Some(target) => proc_pid_visible(k, caller_pid, target),
    }
}

fn normalize_readable_path(
    k: &mut Kernel,
    caller_pid: u32,
    raw_path: &[u8],
) -> Result<Vec<u8>, i64> {
    let path = PathResolver::new(k, caller_pid).normalize(raw_path)?;
    // Refresh procfs snapshots so /proc/<N> views reflect the current
    // process table at lookup time, then gate all read-like path
    // surfaces consistently. An unauthorized OR absent /proc/<pid>
    // both yield -ENOENT so presence is uninferrable (#105 / M8 — the
    // uniform errno closes the cross-tenant pid-existence oracle).
    k.publish_proc_snapshots();
    if !proc_path_reachable(k, caller_pid, &path) {
        return Err(-(abi::ENOENT as i64));
    }
    Ok(path)
}

/// Follow symlinks at `path` (already normalized) up to SYMLOOP_MAX
/// (40) hops, re-normalizing and re-authorizing each target so a
/// ramfs link cannot bypass procfs access checks. Returns the
/// resolved path or a **positive POSIX errno** (`ELOOP` once the hop
/// limit is exceeded; whatever `normalize_readable_path` raises
/// otherwise).
///
/// Convention: resolvers return `Result<_, i32>` with a positive POSIX
/// errno. The dispatch boundary calls `.map_err(|e| -(e as i64))` once
/// to negate and widen to the wire-level `i64`. Matches the
/// `path.rs::resolve_realpath` convention. Issue #144 / #69.
///
/// `normalize_readable_path` predates this convention and still
/// returns a pre-negated `i64`; the inline `.map_err` below normalizes
/// at the call boundary while that helper is left untouched (broader
/// rename is out of scope).
fn follow_symlinks(k: &mut Kernel, caller_pid: u32, path: Vec<u8>) -> Result<Vec<u8>, i32> {
    let mut resolved = path;
    let mut hops = 0u32;
    while let Some(target) = k.vfs.readlink(&resolved) {
        hops += 1;
        if hops > 40 {
            // Too many symlink hops: POSIX/Linux errno is ELOOP
            // (SYMLOOP_MAX = 40), not EINVAL.
            return Err(abi::ELOOP);
        }
        resolved =
            normalize_readable_path(k, caller_pid, &target).map_err(|rc_i64| (-rc_i64) as i32)?;
    }
    Ok(resolved)
}

/// Walk the symlink chain at `path` without per-hop re-normalization,
/// up to SYMLOOP_MAX (40) hops. Lighter than `follow_symlinks` — used
/// by `sys_spawn` for executable resolution where the link target is
/// loaded literally. Returns the resolved path or a positive POSIX
/// errno (same convention as `follow_symlinks` and
/// `path.rs::resolve_realpath`). Issue #144.
pub(super) fn follow_symlinks_literal(k: &mut Kernel, path: Vec<u8>) -> Result<Vec<u8>, i32> {
    let mut resolved = path;
    let mut hops = 0u32;
    while let Some(target) = k.vfs.readlink(&resolved) {
        hops += 1;
        if hops > 40 {
            return Err(abi::ELOOP);
        }
        resolved = target;
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
        let mut entries = match k.vfs.readdir(&path) {
            Some(e) => e,
            None => return -(abi::ENOENT as i64),
        };
        // #105 / M8: `readdir("/proc")` must not enumerate pids the
        // caller may not see, or it becomes a process-enumeration
        // leak. Drop numeric /proc/<pid> entries that fail the #66
        // visibility gate; non-numeric synthetic entries (and the
        // caller's own pid, which `proc_pid_visible` always permits)
        // pass through untouched. Only the /proc mount root is
        // filtered — per-pid subdirs are already gated by
        // `normalize_readable_path` above.
        if path == b"/proc" {
            entries.retain(|name| {
                match std::str::from_utf8(name).ok().and_then(|s| s.parse().ok()) {
                    Some(target) => proc_pid_visible(k, caller_pid, target),
                    None => true,
                }
            });
        }
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
        // #105 / M8: realpath must not leak EPERM-vs-ENOENT either —
        // unauthorized and absent /proc/<pid> are indistinguishable.
        if !proc_path_reachable(k, caller_pid, &resolved) {
            return -(abi::ENOENT as i64);
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
        // Negate-and-widen at the boundary — resolver convention.
        let path = match follow_symlinks(k, caller_pid, path) {
            Ok(path) => path,
            Err(errno) => return -(errno as i64),
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

/// `sys_ftruncate(fd, length) -> 0/-errno`. Request bytes: u32 fd LE +
/// u64 length LE (12 bytes). Resizes the file referenced by `fd` to
/// exactly `length` bytes — shrinking discards trailing data, extending
/// zero-fills the gap. POSIX requires `fd` to be writable. Pipe/socket
/// fds are non-truncatable per Linux (EINVAL); directory fds are EISDIR.
/// Issue #87.
pub(super) fn sys_ftruncate(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() != 12 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let length = u64::from_le_bytes(request[4..12].try_into().expect("8 bytes"));
    // Wire-encoded length is unsigned, but C `off_t` is signed (i64).
    // Reject values that would round-trip as negative on the userland
    // side — POSIX returns EINVAL for negative ftruncate length.
    if length > i64::MAX as u64 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let entry = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(e) => e.clone(),
            None => return -(abi::EBADF as i64),
        };
        let ofd_id = match entry {
            crate::kernel::FdEntry::File { ofd_id } => ofd_id,
            crate::kernel::FdEntry::Directory { .. } => return -(abi::EISDIR as i64),
            // Pipes, sockets, ttys, anything else → EINVAL (Linux ftruncate
            // on a non-regular fd surfaces EINVAL, not EBADF).
            _ => return -(abi::EINVAL as i64),
        };
        let Some(ofd) = k.ofd(ofd_id) else {
            return -(abi::EBADF as i64);
        };
        if !ofd.writable {
            return -(abi::EBADF as i64);
        }
        let mount_id = ofd.mount_id;
        let inode = ofd.inode;
        k.vfs.set_len(mount_id, inode, length) as i64
    })
}

/// `sys_truncate(length, path) -> 0/-errno`. Request bytes: u64 length
/// LE + path bytes (path runs to end-of-request). Same semantics as
/// `sys_ftruncate` but takes a path; resolves symlinks first.
/// Issue #87.
pub(super) fn sys_truncate(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let length = u64::from_le_bytes(request[0..8].try_into().expect("8 bytes"));
    if length > i64::MAX as u64 {
        return -(abi::EINVAL as i64);
    }
    let raw_path = &request[8..];
    if raw_path.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, raw_path) {
            Ok(p) => p,
            Err(rc) => return rc,
        };
        // Symlink resolution: 40 hops then -EINVAL (matches sys_open
        // shape today; the ELOOP-vs-EINVAL fix is tracked in #69).
        let mut resolved = path;
        let mut hops = 0u32;
        while let Some(target) = k.vfs.readlink(&resolved) {
            hops += 1;
            if hops > 40 {
                return -(abi::EINVAL as i64);
            }
            resolved = match normalize_readable_path(k, caller_pid, &target) {
                Ok(p) => p,
                Err(rc) => return rc,
            };
        }
        if k.vfs.entry_type(&resolved) == 3 {
            return -(abi::EISDIR as i64);
        }
        // open(path, 0) probes existence without creating; succeeds
        // for any inode that the backend knows about.
        let Some((mount_id, inode)) = k.vfs.open(&resolved, 0) else {
            return -(abi::ENOENT as i64);
        };
        k.vfs.set_len(mount_id, inode, length) as i64
    })
}

/// `sys_fsync(fd)` — POSIX fsync. Request: u32 fd LE.
///
/// In the in-memory ramfs there is no backing device, so the only work
/// is the fd-syncability gate; returning ENOSYS would make sqlite report
/// "disk I/O error" (issue #88). Regular files and directory fds return
/// 0; pipes / sockets / other non-syncable types return -EINVAL (matches
/// Linux's fsync(pipe) → EINVAL). Unknown fd → -EBADF.
pub(super) fn sys_fsync(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() != 4 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    with_kernel(|k| match k.process_mut(caller_pid).fd_table.entry(fd) {
        Some(crate::kernel::FdEntry::File { .. })
        | Some(crate::kernel::FdEntry::Directory { .. }) => 0,
        Some(_) => -(abi::EINVAL as i64),
        None => -(abi::EBADF as i64),
    })
}

/// `sys_fdatasync(fd)` — POSIX fdatasync. Identical semantics to fsync
/// for the in-memory ramfs (no separate data/metadata distinction
/// without a backing device).
pub(super) fn sys_fdatasync(caller_pid: u32, request: &[u8]) -> i64 {
    sys_fsync(caller_pid, request)
}

/// `sys_sync()` — POSIX sync. No request. Always returns 0 (POSIX
/// defines sync(2) as void; emitting 0 lets a host adapter that maps
/// negative-to-errno treat it as success transparently).
pub(super) fn sys_sync(_request: &[u8]) -> i64 {
    0
}

/// `sys_syncfs(fd)` — Linux syncfs. Sync the filesystem containing fd.
/// Ramfs no-op; reuses fsync's fd-validity gate.
pub(super) fn sys_syncfs(caller_pid: u32, request: &[u8]) -> i64 {
    sys_fsync(caller_pid, request)
}

// ── flock(2) — issue #89 (fcntl byte-range locks are follow-up) ────

/// `flock(2)` operation bits.
const LOCK_SH: u32 = 1;
const LOCK_EX: u32 = 2;
const LOCK_NB: u32 = 4;
const LOCK_UN: u32 = 8;
const LOCK_OP_MASK: u32 = LOCK_SH | LOCK_EX | LOCK_NB | LOCK_UN;

/// Linux `EWOULDBLOCK` = `EAGAIN` = 11; the constant we already mirror
/// in `abi.rs` is `EAGAIN`, so use it directly. `flock(2)` returns
/// EWOULDBLOCK on `LOCK_NB` conflict; the two values are identical on
/// Linux so callers comparing either match.
const FLOCK_EWOULDBLOCK: i32 = abi::EAGAIN;

/// `sys_flock(fd, operation)` — POSIX/BSD flock. Request: u32 fd LE +
/// u32 operation LE (8 bytes). Operation: exactly one of LOCK_SH=1,
/// LOCK_EX=2, LOCK_UN=8, OR-able with LOCK_NB=4 (return EWOULDBLOCK on
/// conflict instead of blocking).
///
/// Locks are associated with the **open file description**, so
/// `dup`/`fork` share, a fresh `open()` of the same file does not.
/// Closing the last fd that references an OFD drops its lock (handled
/// in `Kernel::ofd_dec_ref`).
///
/// Single-threaded kernel: blocking variants (no `LOCK_NB`) cannot
/// actually wait, so they also return `-EWOULDBLOCK` on conflict.
/// True blocking is AsyncBridge-gated (issue #89, B1.5). `fcntl`
/// byte-range locks are a separate follow-up.
///
/// Errnos: 0 success, -EINVAL (bad op / no/multiple op bits / short
/// request), -EBADF (unknown fd / non-file fd), -EWOULDBLOCK (lock
/// conflict). Issue #89.
pub(super) fn sys_flock(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() != 8 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let op = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    if op & !LOCK_OP_MASK != 0 {
        return -(abi::EINVAL as i64);
    }
    // Exactly one of SH/EX/UN must be set.
    let kind_bits = op & (LOCK_SH | LOCK_EX | LOCK_UN);
    if kind_bits == 0 || kind_bits.count_ones() != 1 {
        return -(abi::EINVAL as i64);
    }
    let _nb = op & LOCK_NB != 0; // blocking variants are gate-deferred — same
                                 // return shape today, kept for forward compat.
    with_kernel(|k| {
        let ofd_id = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(crate::kernel::FdEntry::File { ofd_id }) => *ofd_id,
            // flock on dir/pipe/socket/tty: Linux returns EINVAL for
            // non-file types; we surface EBADF for the same end-user
            // outcome ("can't lock this fd") with a uniform shape
            // against fsync/ftruncate. Issue #89 doc lists EINVAL on
            // some types; this is the conservative choice for the
            // ramfs-only landing.
            Some(_) => return -(abi::EBADF as i64),
            None => return -(abi::EBADF as i64),
        };
        let Some(ofd) = k.ofd(ofd_id) else {
            return -(abi::EBADF as i64);
        };
        let mount_id = ofd.mount_id;
        let inode = ofd.inode;
        if op & LOCK_UN != 0 {
            k.flock_release(ofd_id, mount_id, inode);
            return 0;
        }
        let exclusive = op & LOCK_EX != 0;
        match k.flock_try_acquire(ofd_id, mount_id, inode, exclusive) {
            Ok(()) => 0,
            Err(()) => -(FLOCK_EWOULDBLOCK as i64),
        }
    })
}

// ── access(2) / faccessat(2) — issue #86 ────────────────────────────

/// `mode` bits (POSIX): F_OK=0 (existence only), X_OK=1, W_OK=2, R_OK=4.
const F_OK: u32 = 0;
const X_OK: u32 = 1;
const W_OK: u32 = 2;
const R_OK: u32 = 4;
const MODE_BITS_MASK: u32 = F_OK | X_OK | W_OK | R_OK;

/// `faccessat` flag bits (Linux): AT_SYMLINK_NOFOLLOW=0x100, AT_EACCESS=0x200.
const AT_SYMLINK_NOFOLLOW: u32 = 0x100;
const AT_EACCESS: u32 = 0x200;
const FACCESSAT_FLAGS_MASK: u32 = AT_SYMLINK_NOFOLLOW | AT_EACCESS;

/// Check the `mode` access request (X/W/R OR-able) against the file's
/// POSIX mode bits and the caller's credentials. POSIX algorithm:
///
/// 1. If checking-uid is 0 (root): R_OK + W_OK always granted; X_OK
///    granted iff at least one execute bit is set on the file.
/// 2. Else if checking-uid == file owner uid: check owner bits.
/// 3. Else if checking-gid == file owner gid: check group bits.
/// 4. Else: check other bits.
///
/// Returns 0 if every requested bit is permitted, `EACCES` otherwise.
/// F_OK (mode=0) is handled by the caller before reaching here — this
/// function presumes the file already exists.
fn check_access_mode(meta: crate::vfs::Metadata, uid: u32, gid: u32, mode: u32) -> i32 {
    if mode == F_OK {
        return 0;
    }
    let perms = meta.mode & 0o777;
    if uid == 0 {
        // Root: R/W unconditional; X iff any execute bit set.
        if (mode & X_OK) != 0 && (perms & 0o111) == 0 {
            return abi::EACCES;
        }
        return 0;
    }
    let (read_bit, write_bit, exec_bit) = if uid == meta.uid {
        (0o400, 0o200, 0o100)
    } else if gid == meta.gid {
        (0o040, 0o020, 0o010)
    } else {
        (0o004, 0o002, 0o001)
    };
    if (mode & R_OK) != 0 && (perms & read_bit) == 0 {
        return abi::EACCES;
    }
    if (mode & W_OK) != 0 && (perms & write_bit) == 0 {
        return abi::EACCES;
    }
    if (mode & X_OK) != 0 && (perms & exec_bit) == 0 {
        return abi::EACCES;
    }
    0
}

/// `sys_access(mode, path)` — POSIX access(path, mode). Request bytes:
/// `u32 mode LE + path bytes` (path runs to end-of-request; mirrors
/// sys_chdir's path convention). Resolves symlinks; tests the
/// requested access against the file's mode bits using the caller's
/// **real** uid/gid (per POSIX; `AT_EACCESS` is the faccessat
/// affordance for effective ids).
///
/// Errnos: 0 success, -EINVAL (bad mode bits, empty path, short
/// request), -ENOENT (path missing), -ELOOP (symlink hop limit),
/// -EACCES (requested access denied). Issue #86.
pub(super) fn sys_access(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let mode = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    if mode & !MODE_BITS_MASK != 0 {
        return -(abi::EINVAL as i64);
    }
    let raw_path = &request[4..];
    if raw_path.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| access_check(k, caller_pid, raw_path, mode, /*flag*/ 0))
}

/// `sys_faccessat(dirfd, mode, flag, path)` — POSIX faccessat. Request
/// bytes: `u32 dirfd LE + u32 mode LE + u32 flag LE + path bytes`
/// (path runs to end-of-request; mirrors sys_openat's wire shape).
/// AT_FDCWD = u32::MAX. Flag bits: AT_SYMLINK_NOFOLLOW (don't follow
/// terminal symlink), AT_EACCESS (check with effective uid/gid).
///
/// Errnos: as sys_access, plus -EBADF (dirfd unknown), -ENOTDIR
/// (dirfd not a directory fd).
pub(super) fn sys_faccessat(caller_pid: u32, request: &[u8]) -> i64 {
    const AT_FDCWD: u32 = u32::MAX;
    if request.len() < 12 {
        return -(abi::EINVAL as i64);
    }
    let dirfd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let mode = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let flag = u32::from_le_bytes(request[8..12].try_into().expect("4 bytes"));
    if mode & !MODE_BITS_MASK != 0 || flag & !FACCESSAT_FLAGS_MASK != 0 {
        return -(abi::EINVAL as i64);
    }
    let path = &request[12..];
    if path.is_empty() {
        return -(abi::EINVAL as i64);
    }

    // Absolute path or AT_FDCWD → resolve cwd-relative.
    if path[0] == b'/' || dirfd == AT_FDCWD {
        return with_kernel(|k| access_check(k, caller_pid, path, mode, flag));
    }

    // Resolve dirfd's stored path (#59 limitation noted in sys_openat).
    let dir = match with_kernel(|k| match k.process_mut(caller_pid).fd_table.entry(dirfd) {
        Some(crate::kernel::FdEntry::Directory { path }) => Ok(path.clone()),
        Some(_) => Err(abi::ENOTDIR),
        None => Err(abi::EBADF),
    }) {
        Ok(d) => d,
        Err(errno) => return -(errno as i64),
    };
    let mut joined = dir;
    if joined.last() != Some(&b'/') {
        joined.push(b'/');
    }
    joined.extend_from_slice(path);
    with_kernel(|k| access_check(k, caller_pid, &joined, mode, flag))
}

/// Shared body for `sys_access` and `sys_faccessat`. Resolves the path
/// (following symlinks unless AT_SYMLINK_NOFOLLOW), then checks the
/// requested mode against the resolved file's metadata with the
/// caller's real (or effective if AT_EACCESS) credentials. Returns
/// the dispatch-boundary i64 errno (already negated/widened).
fn access_check(k: &mut Kernel, caller_pid: u32, raw_path: &[u8], mode: u32, flag: u32) -> i64 {
    let path = match normalize_readable_path(k, caller_pid, raw_path) {
        Ok(path) => path,
        Err(rc) => return rc,
    };
    let resolved = if flag & AT_SYMLINK_NOFOLLOW != 0 {
        path
    } else {
        // follow_symlinks returns positive i32 errno post #144 —
        // negate-and-widen at the boundary, matching sys_open /
        // stat_path. (Bug fix: this site was authored against the
        // pre-#144 Result<_, i64> convention; #86 and #144 merged
        // in quick succession and the integration didn't catch it
        // before guest-compat CI completed.)
        match follow_symlinks(k, caller_pid, path) {
            Ok(p) => p,
            Err(errno) => return -(errno as i64),
        }
    };
    let Some((mount_id, inode)) = k.vfs.open(&resolved, 0) else {
        return -(abi::ENOENT as i64);
    };
    if mode == F_OK {
        // Existence already established by the open(0) probe above.
        return 0;
    }
    let meta = k.resolve_metadata(mount_id, inode);
    let cred = k.process_mut(caller_pid).credentials;
    let (uid, gid) = if flag & AT_EACCESS != 0 {
        (cred.euid, cred.egid)
    } else {
        (cred.uid, cred.gid)
    };
    let rc = check_access_mode(meta, uid, gid, mode);
    if rc == 0 {
        0
    } else {
        -(rc as i64)
    }
}
