use crate::abi;
use crate::kernel::{with_kernel, Kernel};
use crate::path::PathResolver;

use super::ID_NO_CHANGE;

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
    with_kernel(|k| {
        let path = match normalize_readable_path(k, caller_pid, raw_path) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        // Symlink resolution: walk the path through readlink up to
        // 40 hops (POSIX SYMLOOP_MAX). Each target is normalized and
        // re-authorized before the next lookup so ramfs links cannot
        // bypass procfs access checks.
        let mut resolved: Vec<u8> = path;
        let mut hops = 0u32;
        while let Some(target) = k.vfs.readlink(&resolved) {
            hops += 1;
            if hops > 40 {
                return -(abi::EINVAL as i64); // -ELOOP shape
            }
            resolved = match normalize_readable_path(k, caller_pid, &target) {
                Ok(path) => path,
                Err(rc) => return rc,
            };
        }
        let path: &[u8] = &resolved;
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
    if request.len() < 4 + target_len {
        return -(abi::EINVAL as i64);
    }
    let target = &request[4..4 + target_len];
    let link_path_raw = &request[4 + target_len..];
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
    if request.len() < 4 + old_len {
        return -(abi::EINVAL as i64);
    }
    let old_raw = &request[4..4 + old_len];
    let new_raw = &request[4 + old_len..];
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
    if request.len() < 4 + target_len {
        return -(abi::EINVAL as i64);
    }
    let target_raw = &request[4..4 + target_len];
    let link_raw = &request[4 + target_len..];
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
        if k.has_unix_socket_inode(&path) {
            response[0..8].copy_from_slice(&0u64.to_le_bytes());
            response[8..12].copy_from_slice(&6u32.to_le_bytes());
            response[12..16].copy_from_slice(&0o140_666u32.to_le_bytes());
            return 16;
        }
        let filetype = k.vfs.entry_type(&path) as u32;
        if filetype == 0 {
            return -(abi::ENOENT as i64);
        }
        let (size, mode) = if filetype == 4 {
            let (mount_id, inode) = match k.vfs.open(&path, 0) {
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
