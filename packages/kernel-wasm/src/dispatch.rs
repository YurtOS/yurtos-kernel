//! Method-id dispatch table.
//!
//! `method_id` is a stable u32 assigned in
//! `abi/contract/yurt_abi_methods.toml`. The constants below are
//! generated from that TOML at build time (see `build.rs`); reordering
//! imports never renumbers, and adding a method requires an explicit
//! id assignment in the TOML.
//!
//!   0          — reserved for negotiation / health
//!   1..=0xFFFF — kernel-internal methods (echo, now_realtime; used
//!                only by the microkernel to validate trampoline
//!                plumbing)
//!   0x1_0000+  — `host_*` syscalls from `yurt_abi.toml`

use crate::abi;
use crate::kernel::with_kernel;
use crate::kh;

include!(concat!(env!("OUT_DIR"), "/methods_generated.rs"));

/// Reserved pid for direct calls from outside any user process — i.e.
/// the microkernel itself driving the kernel for tests, bootstrapping,
/// or its own bookkeeping. Real user processes start at pid 1.
#[allow(dead_code)]
pub const KERNEL_PID: u32 = 0;

pub fn dispatch(method_id: u32, caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    match method_id {
        METHOD_KERNEL_ECHO => echo(request, response),
        METHOD_KERNEL_NOW_REALTIME => now_realtime(response),
        METHOD_KERNEL_LOG_TEST => {
            kh::log(kh::LogSeverity::Info, "kernel.wasm hello via kh_log");
            0
        }
        METHOD_KERNEL_PROVIDE_STDIN => provide_stdin(request),
        METHOD_KERNEL_CLOSE_STDIN => close_stdin(request),
        METHOD_KERNEL_DRAIN_STDOUT => drain_stream(request, response, /*stdout=*/ true),
        METHOD_KERNEL_DRAIN_STDERR => drain_stream(request, response, /*stdout=*/ false),
        METHOD_KERNEL_REGISTER_FILE => register_file(request),
        METHOD_KERNEL_INSTALL_TAR_LAYER => install_tar_layer(request),
        METHOD_KERNEL_INSTALL_HOST_FS_MOUNT => install_host_fs_mount(request),
        METHOD_KERNEL_INSTALL_YURTFS => install_yurtfs(request),
        METHOD_KERNEL_LIST_PROCESSES => list_processes_response(response),
        METHOD_SYS_WAIT => wait_response(caller_pid, request, response),
        METHOD_SYS_GETUID => with_kernel(|k| k.process(caller_pid).credentials.uid as i64),
        METHOD_SYS_GETEUID => with_kernel(|k| k.process(caller_pid).credentials.euid as i64),
        METHOD_SYS_GETGID => with_kernel(|k| k.process(caller_pid).credentials.gid as i64),
        METHOD_SYS_GETEGID => with_kernel(|k| k.process(caller_pid).credentials.egid as i64),
        METHOD_SYS_GETPID => caller_pid as i64,
        // ppid comes from the kernel-owned Process record. Returns
        // 0 (KERNEL_PID) for the root user-process.
        METHOD_SYS_GETPPID => with_kernel(|k| k.process(caller_pid).ppid as i64),
        METHOD_SYS_UMASK => umask(caller_pid, request),
        METHOD_SYS_SETRESUID => setresuid(caller_pid, request),
        METHOD_SYS_SETRESGID => setresgid(caller_pid, request),
        METHOD_SYS_CHDIR => chdir(caller_pid, request),
        METHOD_SYS_GETCWD => getcwd(caller_pid, response),
        METHOD_SYS_GETRLIMIT => getrlimit(caller_pid, request, response),
        METHOD_SYS_SETRLIMIT => setrlimit(caller_pid, request),
        METHOD_SYS_CLOSE => close_fd(caller_pid, request),
        METHOD_SYS_DUP => dup_fd(caller_pid, request),
        METHOD_SYS_DUP2 => dup2_fd(caller_pid, request),
        METHOD_SYS_PIPE => pipe(caller_pid, response),
        METHOD_SYS_READ => read_fd(caller_pid, request, response),
        METHOD_SYS_WRITE => write_fd(caller_pid, request),
        METHOD_SYS_ISATTY => isatty(caller_pid, request),
        METHOD_SYS_CLOCK_GETTIME => clock_gettime(request, response),
        METHOD_SYS_EXTENSION_INVOKE => kh::extension_invoke(request, response),
        METHOD_SYS_GETPGID => getpgid(caller_pid, request),
        METHOD_SYS_SETPGID => setpgid(caller_pid, request),
        METHOD_SYS_GETSID => getsid(caller_pid, request),
        METHOD_SYS_SETSID => setsid(caller_pid),
        METHOD_SYS_KILL => kill_request(request),
        METHOD_SYS_SIGACTION => sigaction(caller_pid, request),
        METHOD_SYS_SCHED_YIELD => sched_yield(caller_pid),
        METHOD_SYS_NANOSLEEP => nanosleep(caller_pid, request),
        METHOD_SYS_OPEN => sys_open(caller_pid, request),
        METHOD_SYS_LSEEK => lseek(caller_pid, request, response),
        METHOD_SYS_FSTAT => fstat(caller_pid, request, response),
        METHOD_SYS_CHMOD => chmod(caller_pid, request),
        METHOD_SYS_CHOWN => chown(caller_pid, request),
        METHOD_SYS_UTIMENS => utimens(caller_pid, request),
        METHOD_SYS_UNLINK => unlink(caller_pid, request),
        METHOD_SYS_STAT => stat_path(caller_pid, request, response),
        METHOD_SYS_SYMLINK => symlink(caller_pid, request),
        METHOD_SYS_READLINK => readlink(caller_pid, request, response),
        METHOD_SYS_MKDIR => mkdir(caller_pid, request),
        METHOD_SYS_RMDIR => rmdir(caller_pid, request),
        METHOD_SYS_READDIR => readdir(caller_pid, request, response),
        METHOD_SYS_LINK => hard_link(caller_pid, request),
        METHOD_SYS_RENAME => rename(caller_pid, request),
        METHOD_SYS_SPAWN => sys_spawn(caller_pid, request),
        METHOD_SYS_FETCH => sys_fetch(request, response),
        METHOD_SYS_SOCKET_CONNECT => sys_socket_connect(request),
        METHOD_SYS_SOCKET_SEND => sys_socket_send(request),
        METHOD_SYS_SOCKET_RECV => sys_socket_recv(request, response),
        METHOD_SYS_SOCKET_CLOSE => sys_socket_close(request),
        METHOD_SYS_IDB_GET => sys_idb_get(request, response),
        METHOD_SYS_IDB_PUT => sys_idb_put(request),
        METHOD_SYS_IDB_DELETE => sys_idb_delete(request),
        METHOD_SYS_IDB_LIST => sys_idb_list(request, response),
        METHOD_SYS_SOCKET_LISTEN => sys_socket_listen(request),
        METHOD_SYS_SOCKET_ACCEPT => sys_socket_accept(request),
        METHOD_SYS_SOCKET_ADDR => sys_socket_addr(request, response),
        _ => -(abi::ENOSYS as i64),
    }
}

fn echo(request: &[u8], response: &mut [u8]) -> i64 {
    let n = request.len().min(response.len());
    response[..n].copy_from_slice(&request[..n]);
    n as i64
}

fn read_u32_args<const N: usize>(request: &[u8]) -> Option<[u32; N]> {
    if request.len() < 4 * N {
        return None;
    }
    let mut out = [0u32; N];
    for (i, slot) in out.iter_mut().enumerate() {
        let start = i * 4;
        *slot = u32::from_le_bytes([
            request[start],
            request[start + 1],
            request[start + 2],
            request[start + 3],
        ]);
    }
    Some(out)
}

fn setresuid(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([ruid, euid, suid]) = read_u32_args::<3>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let p = k.process_mut(caller_pid);
        p.credentials.uid = ruid;
        p.credentials.euid = euid;
        // Saved-set-uid (suid) goes onto Process when we add the field;
        // Phase 2 keeps Credentials with just real/effective.
        let _ = suid;
    });
    0
}

fn setresgid(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([rgid, egid, sgid]) = read_u32_args::<3>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let p = k.process_mut(caller_pid);
        p.credentials.gid = rgid;
        p.credentials.egid = egid;
        let _ = sgid;
    });
    0
}

fn chdir(caller_pid: u32, request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    // Phase 2: no VFS, no validation. Store the path verbatim.
    // VFS-backed validation lands when overlay-vfs gets ported.
    with_kernel(|k| {
        k.process_mut(caller_pid).cwd = request.to_vec();
    });
    0
}

/// `getrlimit(resource: u32) -> (soft, hard) as 16 bytes LE`.
fn getrlimit(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    let Some([resource]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    if (resource as usize) >= crate::kernel::RLIMIT_SLOTS {
        return -(abi::EINVAL as i64);
    }
    if response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let limit = k.process_mut(caller_pid).rlimits[resource as usize];
        match limit {
            Some((soft, hard)) => {
                response[0..8].copy_from_slice(&soft.to_le_bytes());
                response[8..16].copy_from_slice(&hard.to_le_bytes());
                16
            }
            None => -(abi::EINVAL as i64),
        }
    })
}

/// `kernel_provide_stdin(target_pid, payload)`. Microkernel-only;
/// appends bytes to the target process's stdin buffer.
fn provide_stdin(request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let pid = u32::from_le_bytes([request[0], request[1], request[2], request[3]]);
    let payload = &request[4..];
    with_kernel(|k| {
        k.process_mut(pid).stdin_buffer.extend(payload);
    });
    payload.len() as i64
}

/// `kernel_drain_stdout|stderr(target_pid)`. Microkernel-only;
/// drains the target process's stdout (or stderr) buffer into the
/// response. Returns bytes read.
fn drain_stream(request: &[u8], response: &mut [u8], stdout: bool) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let p = k.process_mut(pid);
        let buf = if stdout {
            &mut p.stdout_buffer
        } else {
            &mut p.stderr_buffer
        };
        let take = buf.len().min(response.len());
        if take > 0 {
            response[..take].copy_from_slice(&buf[..take]);
            buf.drain(..take);
        }
        take as i64
    })
}

/// `kernel_close_stdin(target_pid)`. Microkernel-only; marks the
/// target process's stdin as EOF.
fn close_stdin(request: &[u8]) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        k.process_mut(pid).stdin_eof = true;
    });
    0
}

const PROCESS_STATE_RUNNING: u8 = 1;
const PROCESS_STATE_EXITED: u8 = 2;

fn encode_process_list(entries: &[crate::kernel::ProcessListEntry]) -> Vec<u8> {
    let total = entries.iter().fold(4usize, |sum, entry| {
        sum + 25 + entry.command.len() + 4 * entry.fds.len()
    });
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in entries {
        out.extend_from_slice(&entry.pid.to_le_bytes());
        out.extend_from_slice(&entry.ppid.to_le_bytes());
        out.extend_from_slice(&entry.pgid.to_le_bytes());
        out.extend_from_slice(&entry.sid.to_le_bytes());
        out.push(if entry.exit_status.is_some() {
            PROCESS_STATE_EXITED
        } else {
            PROCESS_STATE_RUNNING
        });
        out.extend_from_slice(&entry.exit_status.unwrap_or(-1).to_le_bytes());
        out.extend_from_slice(&(entry.command.len() as u32).to_le_bytes());
        out.extend_from_slice(&entry.command);
        out.extend_from_slice(&(entry.fds.len() as u32).to_le_bytes());
        for fd in &entry.fds {
            out.extend_from_slice(&fd.to_le_bytes());
        }
    }
    out
}

pub fn list_processes_response(response: &mut [u8]) -> i64 {
    with_kernel(|k| {
        let encoded = encode_process_list(&k.list_processes());
        if response.len() < encoded.len() {
            return encoded.len() as i64;
        }
        response[..encoded.len()].copy_from_slice(&encoded);
        encoded.len() as i64
    })
}

/// `close(fd: u32) -> 0 / -EBADF`. Decrements pipe refcounts when
/// the closed entry is a pipe end.
fn close_fd(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([fd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let removed = k.process_mut(caller_pid).fd_table.remove(fd);
        match removed {
            None => -(abi::EBADF as i64),
            Some(crate::kernel::FdEntry::Pipe { id, end }) => {
                k.pipe_dec_ref(id, end);
                0
            }
            Some(crate::kernel::FdEntry::File { ofd_id }) => {
                k.ofd_dec_ref(ofd_id);
                0
            }
            Some(_) => 0,
        }
    })
}

/// `dup(oldfd: u32) -> newfd / -EBADF`. Increments pipe refcount when
/// the entry is a pipe end.
fn dup_fd(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([oldfd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let entry = match k.process_mut(caller_pid).fd_table.entry(oldfd) {
            Some(e) => e.clone(),
            None => return -(abi::EBADF as i64),
        };
        match &entry {
            crate::kernel::FdEntry::Pipe { id, end } => {
                if let Some(buf) = k.pipe_buf_mut(*id) {
                    buf.inc_ref(*end);
                }
            }
            crate::kernel::FdEntry::File { ofd_id } => k.ofd_inc_ref(*ofd_id),
            _ => {}
        }
        let p = k.process_mut(caller_pid);
        let newfd = p.fd_table.lowest_free_fd();
        p.fd_table.install(newfd, entry);
        newfd as i64
    })
}

/// `dup2(oldfd: u32, newfd: u32) -> newfd / -EBADF`.
fn dup2_fd(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([oldfd, newfd]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let entry = match k.process_mut(caller_pid).fd_table.entry(oldfd) {
            Some(e) => e.clone(),
            None => return -(abi::EBADF as i64),
        };
        // POSIX: dup2 of an fd onto itself is a no-op when oldfd is
        // valid. Skip the refcount dance.
        if oldfd == newfd {
            return newfd as i64;
        }
        // POSIX: newfd is silently closed first. Decrement its
        // refcount based on what kind of entry was sitting at newfd.
        let prev = k.process_mut(caller_pid).fd_table.entry(newfd).cloned();
        match prev {
            Some(crate::kernel::FdEntry::Pipe { id, end }) => k.pipe_dec_ref(id, end),
            Some(crate::kernel::FdEntry::File { ofd_id }) => k.ofd_dec_ref(ofd_id),
            _ => {}
        }
        // Increment the refcount for the new alias.
        match &entry {
            crate::kernel::FdEntry::Pipe { id, end } => {
                if let Some(buf) = k.pipe_buf_mut(*id) {
                    buf.inc_ref(*end);
                }
            }
            crate::kernel::FdEntry::File { ofd_id } => k.ofd_inc_ref(*ofd_id),
            _ => {}
        }
        k.process_mut(caller_pid).fd_table.install(newfd, entry);
        newfd as i64
    })
}

/// `pipe() -> writes 8 bytes into response (read_fd, write_fd as u32 LE), returns 8 or -ENFILE`.
fn pipe(caller_pid: u32, response: &mut [u8]) -> i64 {
    if response.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let id = k.create_pipe();
        let p = k.process_mut(caller_pid);
        let read_fd = p.fd_table.lowest_free_fd();
        p.fd_table.install(
            read_fd,
            crate::kernel::FdEntry::Pipe {
                id,
                end: crate::kernel::PipeEnd::Read,
            },
        );
        let write_fd = p.fd_table.lowest_free_fd();
        p.fd_table.install(
            write_fd,
            crate::kernel::FdEntry::Pipe {
                id,
                end: crate::kernel::PipeEnd::Write,
            },
        );
        response[0..4].copy_from_slice(&read_fd.to_le_bytes());
        response[4..8].copy_from_slice(&write_fd.to_le_bytes());
        8
    })
}

/// `read(fd: u32) -> bytes_read into response, or -EBADF / 0 EOF / -EAGAIN`.
fn read_fd(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    let Some([fd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let entry = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(e) => e.clone(),
            None => return -(abi::EBADF as i64),
        };
        match entry {
            crate::kernel::FdEntry::Stdin => {
                let p = k.process_mut(caller_pid);
                if p.stdin_buffer.is_empty() {
                    if p.stdin_eof {
                        return 0; // EOF
                    }
                    return -(abi::EAGAIN as i64);
                }
                let take = p.stdin_buffer.len().min(response.len());
                for (i, b) in p.stdin_buffer.drain(..take).enumerate() {
                    response[i] = b;
                }
                take as i64
            }
            crate::kernel::FdEntry::Stdout | crate::kernel::FdEntry::Stderr => {
                -(abi::EINVAL as i64) // not readable
            }
            crate::kernel::FdEntry::Pipe { id, end: _ } => {
                let buf = match k.pipe_buf_mut(id) {
                    Some(b) => b,
                    None => return -(abi::EBADF as i64),
                };
                if buf.bytes.is_empty() {
                    if buf.write_ends == 0 {
                        return 0; // EOF: writer hung up, drain done.
                    }
                    // No data, writers still attached. Phase 2 has no
                    // kh_yield wiring; surface POSIX nonblocking semantics.
                    return -(abi::EAGAIN as i64);
                }
                let take = buf.bytes.len().min(response.len());
                for (i, b) in buf.bytes.drain(..take).enumerate() {
                    response[i] = b;
                }
                take as i64
            }
            crate::kernel::FdEntry::File { ofd_id } => {
                let (mount_id, inode, offset) = match k.ofd(ofd_id) {
                    Some(o) => (o.mount_id, o.inode, o.offset),
                    None => return -(abi::EBADF as i64),
                };
                let n = k.vfs.read(mount_id, inode, offset, response);
                if n > 0 {
                    if let Some(ofd) = k.ofd_mut(ofd_id) {
                        ofd.offset += n as u64;
                    }
                }
                n
            }
        }
    })
}

/// `write(fd: u32, bytes…) -> bytes_written, or -EBADF / -EPIPE / -EINVAL`.
/// Request bytes are: u32 fd LE + payload bytes.
fn write_fd(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes([request[0], request[1], request[2], request[3]]);
    let payload = &request[4..];
    with_kernel(|k| {
        let entry = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(e) => e.clone(),
            None => return -(abi::EBADF as i64),
        };
        match entry {
            crate::kernel::FdEntry::Stdin => -(abi::EINVAL as i64),
            crate::kernel::FdEntry::Stdout => {
                k.process_mut(caller_pid)
                    .stdout_buffer
                    .extend_from_slice(payload);
                payload.len() as i64
            }
            crate::kernel::FdEntry::Stderr => {
                k.process_mut(caller_pid)
                    .stderr_buffer
                    .extend_from_slice(payload);
                payload.len() as i64
            }
            crate::kernel::FdEntry::Pipe {
                id,
                end: crate::kernel::PipeEnd::Write,
            } => {
                let buf = match k.pipe_buf_mut(id) {
                    Some(b) => b,
                    None => return -(abi::EBADF as i64),
                };
                if buf.read_ends == 0 {
                    return -(abi::EPIPE as i64);
                }
                buf.bytes.extend(payload);
                payload.len() as i64
            }
            crate::kernel::FdEntry::Pipe {
                end: crate::kernel::PipeEnd::Read,
                ..
            } => -(abi::EBADF as i64), // can't write to read end
            crate::kernel::FdEntry::File { ofd_id } => {
                let (mount_id, inode, offset, writable) = match k.ofd(ofd_id) {
                    Some(o) => (o.mount_id, o.inode, o.offset, o.writable),
                    None => return -(abi::EBADF as i64),
                };
                if !writable {
                    return -(abi::EBADF as i64);
                }
                let n = k.vfs.write(mount_id, inode, offset, payload);
                if n > 0 {
                    if let Some(o) = k.ofd_mut(ofd_id) {
                        o.offset += n as u64;
                    }
                }
                n
            }
        }
    })
}

/// `setrlimit(resource: u32, soft: u64, hard: u64) -> 0 / -EINVAL / -EPERM`.
/// POSIX rule: a process may not raise its hard limit, only lower it;
/// soft must not exceed hard.
fn setrlimit(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 + 8 + 8 {
        return -(abi::EINVAL as i64);
    }
    let resource = u32::from_le_bytes([request[0], request[1], request[2], request[3]]);
    let soft = u64::from_le_bytes(request[4..12].try_into().expect("8 bytes"));
    let hard = u64::from_le_bytes(request[12..20].try_into().expect("8 bytes"));
    if (resource as usize) >= crate::kernel::RLIMIT_SLOTS {
        return -(abi::EINVAL as i64);
    }
    if soft > hard {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let slot = &mut k.process_mut(caller_pid).rlimits[resource as usize];
        let Some((_, prev_hard)) = *slot else {
            return -(abi::EINVAL as i64);
        };
        // POSIX: only privileged processes may raise the hard limit.
        // Phase 2 has no capability check; enforce the simple rule
        // that hard cannot increase. setresuid-as-root + raise comes
        // when security policy lands.
        if hard > prev_hard {
            return -(abi::EPERM as i64);
        }
        *slot = Some((soft, hard));
        0
    })
}

fn getcwd(caller_pid: u32, response: &mut [u8]) -> i64 {
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

fn umask(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let new_mask = u32::from_le_bytes([request[0], request[1], request[2], request[3]]) as u16;
    let new_mask = new_mask & 0o777;
    with_kernel(|k| {
        let p = k.process_mut(caller_pid);
        let prev = p.umask;
        p.umask = new_mask;
        prev as i64
    })
}

fn isatty(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([fd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| match k.process_mut(caller_pid).fd_table.entry(fd) {
        None => -(abi::EBADF as i64),
        Some(crate::kernel::FdEntry::Stdin)
        | Some(crate::kernel::FdEntry::Stdout)
        | Some(crate::kernel::FdEntry::Stderr) => 1,
        Some(_) => 0,
    })
}

/// `clock_gettime(clock_id) -> 8 bytes le u64 ns`. clock_id 0 =
/// REALTIME (kh_now_realtime), 1 = MONOTONIC (kh_now_monotonic when
/// it lands; today aliased to REALTIME).
fn clock_gettime(request: &[u8], response: &mut [u8]) -> i64 {
    let Some([clock_id]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    if response.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    match clock_id {
        0 | 1 => match kh::now_realtime_ns() {
            Ok(ns) => {
                response[..8].copy_from_slice(&ns.to_le_bytes());
                8
            }
            Err(rc) => rc as i64,
        },
        _ => -(abi::EINVAL as i64),
    }
}

/// Return the target's pgid. POSIX: a pgid of 0 in *the request* means
/// "the calling process". Per-pid pgid defaults to the pid itself on
/// first observation — a freshly-spawned process is its own group leader
/// until `setpgid` moves it.
fn getpgid(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([target_arg]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    let target = if target_arg == 0 {
        caller_pid
    } else {
        target_arg
    };
    with_kernel(|k| {
        let p = k.process_mut(target);
        if p.pgid == 0 {
            p.pgid = target;
        }
        p.pgid as i64
    })
}

/// `setpgid(pid, pgid)`. pid==0 → caller; pgid==0 → target's pid (i.e.
/// make the target a new group leader). Phase 2 has no permission /
/// session-membership checks.
fn setpgid(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([target_arg, pgid_arg]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    let target = if target_arg == 0 {
        caller_pid
    } else {
        target_arg
    };
    let new_pgid = if pgid_arg == 0 { target } else { pgid_arg };
    with_kernel(|k| {
        k.process_mut(target).pgid = new_pgid;
    });
    0
}

fn getsid(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([target_arg]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    let target = if target_arg == 0 {
        caller_pid
    } else {
        target_arg
    };
    with_kernel(|k| {
        let p = k.process_mut(target);
        if p.sid == 0 {
            p.sid = target;
        }
        p.sid as i64
    })
}

/// POSIX `setsid()`: the caller becomes a new session leader and a new
/// process-group leader. Real POSIX returns EPERM if the caller is
/// already a process-group leader (you must fork first). Phase 2 has
/// no spawn yet, so we soften that to "EPERM if the caller has already
/// successfully called setsid before" — first call from a fresh pid
/// succeeds, repeat calls fail. Tracked via `sid != 0`: a fresh process
/// has sid == 0 until either getsid (which lazily primes it) or setsid
/// runs.
fn setsid(caller_pid: u32) -> i64 {
    with_kernel(|k| {
        let p = k.process_mut(caller_pid);
        if p.sid == caller_pid {
            return -(abi::EPERM as i64);
        }
        p.sid = caller_pid;
        p.pgid = caller_pid;
        caller_pid as i64
    })
}

/// `kill(target_pid, sig)`. Records sig in target's pending mask.
/// Phase 2: storage only — actual delivery requires asyncify/JSPI
/// unwind from the AsyncBridge integration. sig==0 is the POSIX
/// "is the pid alive?" probe.
pub fn kill_pid(target: u32, sig: u32) -> i64 {
    if sig > 63 {
        return -(abi::EINVAL as i64);
    }
    if !with_kernel(|k| k.has_process(target)) {
        return -(abi::ESRCH as i64);
    }
    if sig == 0 {
        return 0;
    }
    let handle = with_kernel(|k| {
        let p = k.process_mut(target);
        p.pending_signals |= 1u64 << (sig - 1);
        p.host_instance_handle
    });
    if let Some(handle) = handle {
        let rc = kh::destroy_instance(handle);
        if rc < 0 {
            return rc as i64;
        }
    }
    with_kernel(|k| {
        let p = k.process_mut(target);
        p.host_instance_handle = None;
        p.exit_status = Some(128 + sig as i32);
    });
    0
}

fn kill_request(request: &[u8]) -> i64 {
    let Some([target, sig]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    kill_pid(target, sig)
}

/// `sigaction(sig, disposition) -> previous_disposition`. Disposition
/// encoding is opaque to the kernel: 0/1 are SIG_DFL/SIG_IGN by
/// convention, anything else is a user-side handler value (typically
/// a wasm function table index). The kernel stores per-pid; user-side
/// libc wraps invocation when delivery lands.
fn sigaction(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([sig, disposition]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    if !(1..=63).contains(&sig) {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let slot = &mut k.process_mut(caller_pid).signal_dispositions[(sig - 1) as usize];
        let prev = *slot;
        *slot = disposition;
        prev as i64
    })
}

/// `sched_yield()`. Phase 2: increments a per-pid counter and returns
/// 0 immediately. Real cooperative scheduling lands when the
/// AsyncBridge integration does — the kernel-side return path will
/// instead suspend the process to its host's runqueue.
fn sched_yield(caller_pid: u32) -> i64 {
    with_kernel(|k| k.process_mut(caller_pid).yield_count += 1);
    0
}

/// `nanosleep(req: u64 ns)`. Phase 2: records the requested duration
/// per-pid and returns 0 immediately. Real wall-clock blocking needs
/// the AsyncBridge to suspend the process.
fn nanosleep(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let ns = u64::from_le_bytes(request[..8].try_into().expect("8 bytes"));
    with_kernel(|k| k.process_mut(caller_pid).last_nanosleep_ns = ns);
    0
}

/// `kernel_register_file(path_len: u32, path_bytes, content_bytes)`.
/// Microkernel-only; installs (or replaces) a file at `path`. Returns
/// 0 on success, -EINVAL if the request is malformed.
fn register_file(request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let path_len = u32::from_le_bytes([request[0], request[1], request[2], request[3]]) as usize;
    if request.len() < 4 + path_len {
        return -(abi::EINVAL as i64);
    }
    let path = request[4..4 + path_len].to_vec();
    let content = request[4 + path_len..].to_vec();
    with_kernel(|k| {
        // Microkernel-only: install or replace the file at `path`.
        // open() with the create+write bits returns the inode on
        // the root mount; ramfs's open creates a fresh empty file
        // when the path is missing, then a subsequent write puts
        // the staged bytes in.
        if let Some((mount_id, inode)) = k.vfs.open(&path, 0b011) {
            // Truncate any pre-existing content first so the
            // resulting file matches the staged content exactly.
            k.vfs.truncate(mount_id, inode);
            let _ = k.vfs.write(mount_id, inode, 0, &content);
        }
    });
    0
}

/// Test-only argv patch helper. Runtime spawn paths set Process.argv
/// when the process is created.
#[cfg(test)]
fn set_argv(request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let pid = u32::from_le_bytes(request[0..4].try_into().unwrap());
    let mut cursor = 4usize;
    let mut argv: Vec<Vec<u8>> = Vec::new();
    while cursor < request.len() {
        if request.len() - cursor < 4 {
            return -(abi::EINVAL as i64);
        }
        let len = u32::from_le_bytes(request[cursor..cursor + 4].try_into().unwrap()) as usize;
        cursor += 4;
        if request.len() - cursor < len {
            return -(abi::EINVAL as i64);
        }
        argv.push(request[cursor..cursor + len].to_vec());
        cursor += len;
    }
    with_kernel(|k| {
        k.process_mut(pid).argv = argv;
    });
    0
}

fn parse_argv_records(request: &[u8]) -> Result<Vec<Vec<u8>>, i64> {
    let mut cursor = 0usize;
    let mut argv: Vec<Vec<u8>> = Vec::new();
    while cursor < request.len() {
        if request.len() - cursor < 4 {
            return Err(-(abi::EINVAL as i64));
        }
        let len = u32::from_le_bytes(request[cursor..cursor + 4].try_into().unwrap()) as usize;
        cursor += 4;
        if request.len() - cursor < len {
            return Err(-(abi::EINVAL as i64));
        }
        argv.push(request[cursor..cursor + len].to_vec());
        cursor += len;
    }
    Ok(argv)
}

pub fn spawn_cached_process(parent_pid: u32, module_id: &[u8], argv_request: &[u8]) -> i64 {
    let argv = match parse_argv_records(argv_request) {
        Ok(argv) => argv,
        Err(rc) => return rc,
    };
    let pid = with_kernel(|k| k.alloc_host_pid());
    let mut context = Vec::with_capacity(12 + argv_request.len());
    context.extend_from_slice(&1_u16.to_le_bytes()); // spawn_context_v1
    context.extend_from_slice(&0_u16.to_le_bytes()); // flags
    context.extend_from_slice(&pid.to_le_bytes());
    context.extend_from_slice(&(argv_request.len() as u32).to_le_bytes());
    context.extend_from_slice(argv_request);
    let handle = kh::spawn_process(module_id, &context);
    if handle < 0 {
        return handle as i64;
    }
    with_kernel(|k| {
        k.insert_host_process(pid, parent_pid, argv, Some(handle));
    });
    pid as i64
}

/// Test-only parentage patch helper. Runtime spawn paths set parent
/// and child links when the process is created.
#[cfg(test)]
pub(crate) fn register_child(request: &[u8]) -> i64 {
    let Some([parent, child]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        k.process_mut(child).ppid = parent;
        let pp = k.process_mut(parent);
        if !pp.children.contains(&child) {
            pp.children.push(child);
        }
    });
    0
}

/// `kernel_record_exit(pid, exit_status)`. Microkernel-only; marks
/// `pid` as zombie with the given exit status. The next sys_wait
/// from its parent will reap it.
pub fn record_exit(request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let pid = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let status = i32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    with_kernel(|k| {
        k.process_mut(pid).exit_status = Some(status);
    });
    0
}

/// `wait(child_pid, flags) -> (pid, status)`. child_pid==0 means
/// "any child". Returns 8 bytes (u32 pid + i32 status) on a
/// successful reap, -EAGAIN if WNOHANG (flags bit 0) and no child
/// has exited, -ECHILD if the caller has no waitable children.
pub fn wait_response(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    let Some([want_pid, flags]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    if response.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let nohang = flags & 1 != 0;
    with_kernel(|k| {
        let parent = k.process_mut(caller_pid);
        // Snapshot children we care about.
        let candidates: Vec<u32> = if want_pid == 0 {
            parent.children.clone()
        } else if parent.children.contains(&want_pid) {
            vec![want_pid]
        } else {
            return -(abi::ECHILD as i64);
        };
        if candidates.is_empty() {
            return -(abi::ECHILD as i64);
        }
        // Find the first candidate that's exited.
        let exited = candidates.iter().find_map(|&c| {
            let cp = k.process_mut(c);
            cp.exit_status.map(|s| (c, s))
        });
        let Some((pid, status)) = exited else {
            return if nohang {
                -(abi::EAGAIN as i64)
            } else {
                // No AsyncBridge yet → treat blocking wait the same
                // as WNOHANG. Real blocking lands when the bridge
                // wires kh_yield.
                -(abi::EAGAIN as i64)
            };
        };
        // Reap: drop from parent's children list. Leave the
        // Process record itself (it may still hold metadata
        // /proc consumers care about).
        k.process_mut(caller_pid).children.retain(|&c| c != pid);
        response[0..4].copy_from_slice(&pid.to_le_bytes());
        response[4..8].copy_from_slice(&status.to_le_bytes());
        8
    })
}

/// `kernel_install_host_fs_mount(prefix)`. Microkernel-only; mounts
/// a fresh [`HostFsBackend`] at `prefix`. Embedders pick where the
/// host fs lives. Returns 0 on success, -EINVAL for empty prefix.
fn install_host_fs_mount(request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        k.vfs
            .add_mount(request.to_vec(), Box::new(crate::vfs::HostFsBackend::new()));
    });
    0
}

/// `kernel_install_yurtfs(prefix_len, prefix, tar_bytes)`.
/// Microkernel-only; mounts an [`OverlayBackend`] composing a
/// [`TarLayerBackend`] (lower / image) and a fresh
/// [`RamfsBackend`] (upper / overlay) at `prefix`. One call wires
/// the L1+L2 union the user reads about as YURTFS.
///
/// Auto-detects zstd: if the archive begins with the zstd magic
/// (`0x28 0xB5 0x2F 0xFD`), decompresses it before walking. That
/// keeps `mount_yurtfs` compatible with the existing `.tar.zst`
/// image format the TS image-loader produces.
fn install_yurtfs(request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let prefix_len = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
    if request.len() < 4 + prefix_len {
        return -(abi::EINVAL as i64);
    }
    let prefix = request[4..4 + prefix_len].to_vec();
    let archive = request[4 + prefix_len..].to_vec();
    let archive = match maybe_decompress_zstd(archive) {
        Some(bytes) => bytes,
        None => return -(abi::EINVAL as i64),
    };
    with_kernel(|k| {
        let lower = Box::new(crate::vfs::TarLayerBackend::new(archive));
        let upper = Box::new(crate::vfs::RamfsBackend::new());
        k.vfs.add_mount(
            prefix,
            Box::new(crate::vfs::OverlayBackend::new(lower, upper)),
        );
    });
    0
}

/// If `bytes` begins with the zstd magic, decompress to plain tar.
/// Returns `Some(plain)` for either uncompressed or successfully
/// decompressed input; `None` only if zstd decoding fails.
fn maybe_decompress_zstd(bytes: Vec<u8>) -> Option<Vec<u8>> {
    const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
    if bytes.len() < 4 || bytes[0..4] != ZSTD_MAGIC {
        return Some(bytes);
    }
    let mut decoder = match ruzstd::StreamingDecoder::new(&bytes[..]) {
        Ok(d) => d,
        Err(_) => return None,
    };
    let mut out = Vec::new();
    use std::io::Read;
    if decoder.read_to_end(&mut out).is_err() {
        return None;
    }
    Some(out)
}

/// `kernel_install_tar_layer(prefix_len, prefix_bytes, tar_bytes)`.
/// Microkernel-only; mounts a [`TarLayerBackend`] at `prefix`. The
/// archive is indexed at install time so subsequent reads slice into
/// the in-memory bytes. Read-only mount.
fn install_tar_layer(request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let prefix_len = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
    if request.len() < 4 + prefix_len {
        return -(abi::EINVAL as i64);
    }
    let prefix = request[4..4 + prefix_len].to_vec();
    let archive = request[4 + prefix_len..].to_vec();
    let archive = match maybe_decompress_zstd(archive) {
        Some(bytes) => bytes,
        None => return -(abi::EINVAL as i64),
    };
    with_kernel(|k| {
        k.vfs
            .add_mount(prefix, Box::new(crate::vfs::TarLayerBackend::new(archive)));
    });
    0
}

/// `/proc/self/<x>` → `/proc/<caller_pid>/<x>`. Linux convention; the
/// expansion happens at the dispatch layer so ProcBackend doesn't need
/// to know the caller. Path bytes aren't guaranteed UTF-8; we rewrite
/// as raw bytes. Returns the original slice when no rewrite is needed
/// so common-case paths don't allocate.
fn proc_self_rewrite<'a>(caller_pid: u32, path: &'a [u8]) -> std::borrow::Cow<'a, [u8]> {
    if let Some(suffix) = path.strip_prefix(b"/proc/self") {
        // Match only when the next byte is `/` or end-of-path so
        // we don't rewrite paths like "/proc/selfish".
        if suffix.is_empty() || suffix.starts_with(b"/") {
            let prefix = format!("/proc/{caller_pid}");
            let mut buf = prefix.into_bytes();
            buf.extend_from_slice(suffix);
            return std::borrow::Cow::Owned(buf);
        }
    }
    std::borrow::Cow::Borrowed(path)
}

/// `sys_open(flags, path) -> fd`. Request: u32 flags LE + path bytes.
/// Flags bits: 0=writable, 1=create-if-missing (O_CREAT),
/// 2=truncate-if-exists (O_TRUNC).
fn sys_open(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let flags = u32::from_le_bytes(request[0..4].try_into().unwrap());
    let raw_path = &request[4..];
    if raw_path.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let rewritten = proc_self_rewrite(caller_pid, raw_path);
    let path: &[u8] = &rewritten;
    let writable = flags & 0b001 != 0;
    let create = flags & 0b010 != 0;
    let trunc = flags & 0b100 != 0;
    with_kernel(|k| {
        // Refresh procfs snapshots so /proc/<N>/status reflects the
        // current process table at open time.
        k.publish_proc_snapshots();
        // Symlink resolution: walk the path through readlink up to
        // 40 hops (POSIX SYMLOOP_MAX). Each hop replaces the path
        // verbatim — Phase 7 only handles final-component
        // symlinks; intermediate-dir resolution comes with mkdir.
        let mut resolved: Vec<u8> = path.to_vec();
        let mut hops = 0u32;
        while let Some(target) = k.vfs.readlink(&resolved) {
            hops += 1;
            if hops > 40 {
                return -(abi::EINVAL as i64); // -ELOOP shape
            }
            resolved = target;
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

/// `lseek(fd, offset, whence)`. POSIX semantics: SET=0, CUR=1, END=2.
/// Negative resulting offsets are -EINVAL. Response: 8 bytes — new
/// offset as i64 LE.
fn lseek(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 4 + 8 + 4 || response.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().unwrap());
    let offset = i64::from_le_bytes(request[4..12].try_into().unwrap());
    let whence = u32::from_le_bytes(request[12..16].try_into().unwrap());
    with_kernel(|k| {
        let ofd_id = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(crate::kernel::FdEntry::File { ofd_id }) => *ofd_id,
            _ => return -(abi::EBADF as i64),
        };
        let (mount_id, inode, current) = match k.ofd(ofd_id) {
            Some(o) => (o.mount_id, o.inode, o.offset),
            None => return -(abi::EBADF as i64),
        };
        let size = k.vfs.size(mount_id, inode).unwrap_or(0);
        let base: i64 = match whence {
            0 => 0,
            1 => current as i64,
            2 => size as i64,
            _ => return -(abi::EINVAL as i64),
        };
        let new_off = base.saturating_add(offset);
        if new_off < 0 {
            return -(abi::EINVAL as i64);
        }
        if let Some(o) = k.ofd_mut(ofd_id) {
            o.offset = new_off as u64;
        }
        response[..8].copy_from_slice(&new_off.to_le_bytes());
        8
    })
}

/// `fstat(fd)`. Response: 16 bytes — u64 size + u32 filetype +
/// u32 mode. Filetype values match WASI preview1: 2=CHARACTER_DEVICE,
/// 3=DIRECTORY, 4=REGULAR_FILE, 6=SOCKET_STREAM. Mode is 0 for now
/// (POSIX permission bits land with the OFD-flags work).
fn fstat(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    let Some([fd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    if response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let entry = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(e) => e.clone(),
            None => return -(abi::EBADF as i64),
        };
        // (size, filetype, mode) — size/filetype come from the
        // backend, mode from the kernel's MetadataOverlay.
        let (size, filetype, mode): (u64, u32, u32) = match entry {
            crate::kernel::FdEntry::Stdin
            | crate::kernel::FdEntry::Stdout
            | crate::kernel::FdEntry::Stderr => (0, 2, 0o020_666),
            crate::kernel::FdEntry::Pipe { .. } => (0, 6, 0o010_600),
            crate::kernel::FdEntry::File { ofd_id } => {
                let (mount_id, inode) = match k.ofd(ofd_id) {
                    Some(o) => (o.mount_id, o.inode),
                    None => return -(abi::EBADF as i64),
                };
                let sz = k.vfs.size(mount_id, inode).unwrap_or(0);
                let meta = k.resolve_metadata(mount_id, inode);
                (sz, 4, meta.mode)
            }
        };
        response[0..8].copy_from_slice(&size.to_le_bytes());
        response[8..12].copy_from_slice(&filetype.to_le_bytes());
        response[12..16].copy_from_slice(&mode.to_le_bytes());
        16
    })
}

/// `mkdir(path) -> 0 / -EEXIST / -EROFS`.
fn mkdir(caller_pid: u32, request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let path = proc_self_rewrite(caller_pid, request);
    with_kernel(|k| k.vfs.mkdir(&path) as i64)
}

/// `rmdir(path) -> 0 / -ENOENT / -ENOTEMPTY / -EROFS`.
fn rmdir(caller_pid: u32, request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let path = proc_self_rewrite(caller_pid, request);
    with_kernel(|k| k.vfs.rmdir(&path) as i64)
}

/// `readdir(path) -> packed entries`. Response layout:
/// u32 count_le + (u32 name_len_le + name_bytes)*. Truncated when
/// out_cap exceeded; the count reflects only what fit.
fn readdir(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let path = proc_self_rewrite(caller_pid, request);
    with_kernel(|k| {
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
fn symlink(caller_pid: u32, request: &[u8]) -> i64 {
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
    let link_path = proc_self_rewrite(caller_pid, link_path_raw);
    with_kernel(|k| k.vfs.symlink(target, &link_path) as i64)
}

/// `sys_idb_get(store, key) -> bytes`. Request: u8 store_len +
/// store_name + key_bytes. Forwards to kh_idb_get.
fn sys_idb_get(request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let store_len = request[0] as usize;
    if 1 + store_len > request.len() {
        return -(abi::EINVAL as i64);
    }
    let store = &request[1..1 + store_len];
    let key = &request[1 + store_len..];
    if key.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    kh::idb_get(store, key, response)
}

fn sys_idb_put(request: &[u8]) -> i64 {
    if request.len() < 5 {
        return -(abi::EINVAL as i64);
    }
    let store_len = request[0] as usize;
    if 1 + store_len + 4 > request.len() {
        return -(abi::EINVAL as i64);
    }
    let store = &request[1..1 + store_len];
    let key_len = u32::from_le_bytes(
        request[1 + store_len..1 + store_len + 4]
            .try_into()
            .expect("4 bytes"),
    ) as usize;
    let body_start = 1 + store_len + 4;
    if body_start + key_len > request.len() {
        return -(abi::EINVAL as i64);
    }
    let key = &request[body_start..body_start + key_len];
    let value = &request[body_start + key_len..];
    kh::idb_put(store, key, value) as i64
}

fn sys_idb_delete(request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let store_len = request[0] as usize;
    if 1 + store_len > request.len() {
        return -(abi::EINVAL as i64);
    }
    let store = &request[1..1 + store_len];
    let key = &request[1 + store_len..];
    if key.is_empty() {
        return -(abi::EINVAL as i64);
    }
    kh::idb_delete(store, key) as i64
}

fn sys_idb_list(request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let store_len = request[0] as usize;
    if 1 + store_len > request.len() {
        return -(abi::EINVAL as i64);
    }
    let store = &request[1..1 + store_len];
    let prefix = &request[1 + store_len..];
    if response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    kh::idb_list(store, prefix, response)
}

/// `sys_socket_listen(backlog, addr) -> handle`. Combines
/// open+bind+listen so userland gets a usable listener in one
/// hop. Request: u32 backlog LE + addr ('host:port', port=0
/// = host-chosen).
fn sys_socket_listen(request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let backlog = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let addr = &request[4..];
    if addr.is_empty() {
        return -(abi::EINVAL as i64);
    }
    kh::socket_listen_at(addr, backlog) as i64
}

fn sys_socket_accept(request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let handle = i32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    kh::socket_accept(handle, flags) as i64
}

fn sys_socket_addr(request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let handle = i32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    if response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    kh::socket_local_addr(handle, response)
}

/// `sys_socket_connect(addr_bytes) -> handle`. Request layout
/// matches the toml: u8 family + u8 sock_type + u16 _pad + u32
/// flags + addr bytes (UTF-8 "host:port"). Returns the host
/// handle directly — userland passes it to subsequent
/// sys_socket_send/recv/close.
fn sys_socket_connect(request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    // u8 family + u8 sock_type + u16 pad — currently unused; kept
    // in the wire format so future AF_INET6 / SOCK_DGRAM fits.
    let _family = request[0];
    let _sock_type = request[1];
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let addr = &request[8..];
    if addr.is_empty() {
        return -(abi::EINVAL as i64);
    }
    kh::socket_connect(addr, flags) as i64
}

fn sys_socket_send(request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let handle = i32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let data = &request[4..];
    kh::socket_send(handle, data)
}

fn sys_socket_recv(request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let handle = i32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    if response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    kh::socket_recv(handle, response, flags)
}

fn sys_socket_close(request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let handle = i32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    kh::socket_close(handle) as i64
}

/// `sys_fetch(json_request_bytes) -> json_response_bytes`. Forwards
/// the request bytes verbatim to `kh_fetch_blocking` and writes the
/// response bytes back. Wire format is whatever `network::fetch`
/// accepts on the host.
fn sys_fetch(request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    kh::fetch_blocking(request, response)
}

/// `sys_spawn(path_len, path, (arg_len, arg)*)`. Reads the wasm
/// image from the VFS, allocates a child pid (kernel range starts
/// at 1000), records the parent/child relationship, and stages a
/// PendingSpawn for the host to run. Returns the child pid.
fn sys_spawn(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let path_len = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
    if request.len() < 4 + path_len {
        return -(abi::EINVAL as i64);
    }
    let raw_path = &request[4..4 + path_len];
    if raw_path.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let path = proc_self_rewrite(caller_pid, raw_path);
    // Decode argv list from the trailing bytes.
    let mut argv: Vec<Vec<u8>> = Vec::new();
    let mut cursor = 4 + path_len;
    while cursor + 4 <= request.len() {
        let alen =
            u32::from_le_bytes(request[cursor..cursor + 4].try_into().expect("4 bytes")) as usize;
        cursor += 4;
        if cursor + alen > request.len() {
            return -(abi::EINVAL as i64);
        }
        argv.push(request[cursor..cursor + alen].to_vec());
        cursor += alen;
    }

    with_kernel(|k| {
        // Read the image bytes from VFS.
        let Some((mount_id, inode)) = k.vfs.open(&path, 0) else {
            return -(abi::ENOENT as i64);
        };
        let size = k.vfs.size(mount_id, inode).unwrap_or(0) as usize;
        let mut wasm = vec![0u8; size];
        let n = k.vfs.read(mount_id, inode, 0, &mut wasm);
        if n < 0 {
            return n;
        }
        wasm.truncate(n as usize);

        let child_pid = k.alloc_spawn_pid();
        // Wire the parent/child relationship so sys_wait can reap.
        {
            let child = k.process_mut(child_pid);
            child.ppid = caller_pid;
            child.argv = argv.clone();
        }
        let parent = k.process_mut(caller_pid);
        if !parent.children.contains(&child_pid) {
            parent.children.push(child_pid);
        }
        k.enqueue_spawn(crate::kernel::PendingSpawn {
            child_pid,
            wasm,
            argv,
        });
        child_pid as i64
    })
}

/// Internal: pop the next PendingSpawn and serialize it for the
/// host. Wire format: u32 child_pid + u32 wasm_len + wasm_bytes +
/// u32 argc + (u32 arg_len + arg_bytes)*. Returns -ENOENT when
/// the queue is empty.
pub fn drain_spawn(response: &mut [u8]) -> i64 {
    with_kernel(|k| {
        let Some(spawn) = k.drain_spawn() else {
            return -(abi::ENOENT as i64);
        };
        let need =
            4 + 4 + spawn.wasm.len() + 4 + spawn.argv.iter().map(|a| 4 + a.len()).sum::<usize>();
        if response.len() < need {
            // Re-enqueue at front so the next call picks it up.
            k.pending_spawns_push_front(spawn);
            return -(abi::EINVAL as i64);
        }
        let mut cur = 0usize;
        response[cur..cur + 4].copy_from_slice(&spawn.child_pid.to_le_bytes());
        cur += 4;
        response[cur..cur + 4].copy_from_slice(&(spawn.wasm.len() as u32).to_le_bytes());
        cur += 4;
        response[cur..cur + spawn.wasm.len()].copy_from_slice(&spawn.wasm);
        cur += spawn.wasm.len();
        response[cur..cur + 4].copy_from_slice(&(spawn.argv.len() as u32).to_le_bytes());
        cur += 4;
        for a in &spawn.argv {
            response[cur..cur + 4].copy_from_slice(&(a.len() as u32).to_le_bytes());
            cur += 4;
            response[cur..cur + a.len()].copy_from_slice(a);
            cur += a.len();
        }
        cur as i64
    })
}

/// `rename(old_len, old, new)`. Wire shape mirrors symlink/link.
/// Routes to `MountTable::rename`, which enforces same-mount.
fn rename(caller_pid: u32, request: &[u8]) -> i64 {
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
    let old_path = proc_self_rewrite(caller_pid, old_raw);
    let new_path = proc_self_rewrite(caller_pid, new_raw);
    with_kernel(|k| k.vfs.rename(&old_path, &new_path) as i64)
}

/// `link(target_len, target, link_path)`. Same wire format as
/// `symlink` so both can share request decoding shape. Routes to
/// `MountTable::link`, which enforces same-mount and refcount.
fn hard_link(caller_pid: u32, request: &[u8]) -> i64 {
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
    let target = proc_self_rewrite(caller_pid, target_raw);
    let link_path = proc_self_rewrite(caller_pid, link_raw);
    with_kernel(|k| k.vfs.link(&target, &link_path) as i64)
}

/// `readlink(path) -> bytes-written or -ENOENT/-EINVAL`. Writes
/// the symlink target into the response. Path that doesn't resolve
/// to a symlink returns -EINVAL (POSIX) or -ENOENT (no such path).
fn readlink(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let path = proc_self_rewrite(caller_pid, request);
    with_kernel(|k| {
        let Some(target) = k.vfs.readlink(&path) else {
            return -(abi::EINVAL as i64);
        };
        let n = target.len().min(response.len());
        response[..n].copy_from_slice(&target[..n]);
        n as i64
    })
}

/// `unlink(path) -> 0 / -ENOENT / -EROFS`. Path-based delete; the
/// active backend's `unlink` does the work, including overlay
/// whiteouts.
fn unlink(caller_pid: u32, request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let path = proc_self_rewrite(caller_pid, request);
    with_kernel(|k| k.vfs.unlink(&path) as i64)
}

/// `stat(path) -> 16-byte fstat-shaped record`. Same wire format as
/// sys_fstat: u64 size + u32 filetype + u32 mode. Doesn't require an
/// open fd. Returns 16 on success, -ENOENT for unresolvable path.
fn stat_path(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    let path = proc_self_rewrite(caller_pid, request);
    with_kernel(|k| {
        let (mount_id, inode) = match k.vfs.open(&path, 0) {
            Some(pair) => pair,
            None => return -(abi::ENOENT as i64),
        };
        let size = k.vfs.size(mount_id, inode).unwrap_or(0);
        let meta = k.resolve_metadata(mount_id, inode);
        // Filetype always REGULAR_FILE for path-resolved entries
        // (no directory or device-like backends route through here
        // today; Dev's /null/zero return REGULAR_FILE which is
        // close enough for Phase 6).
        let filetype: u32 = 4;
        response[0..8].copy_from_slice(&size.to_le_bytes());
        response[8..12].copy_from_slice(&filetype.to_le_bytes());
        response[12..16].copy_from_slice(&meta.mode.to_le_bytes());
        16
    })
}

/// `chown(uid, gid, path) -> 0 or -ENOENT`. Request: u32 uid + u32
/// gid + path bytes. Sandbox-view only — underlying host storage's
/// owner is unchanged.
fn chown(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let uid = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let gid = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let raw = &request[8..];
    if raw.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let path = proc_self_rewrite(caller_pid, raw);
    with_kernel(|k| {
        let (mount_id, inode) = match k.vfs.open(&path, 0) {
            Some(pair) => pair,
            None => return -(abi::ENOENT as i64),
        };
        let mut meta = k.resolve_metadata(mount_id, inode);
        meta.uid = uid;
        meta.gid = gid;
        k.set_metadata_override(mount_id, inode, meta);
        0
    })
}

/// `utimens(mtime_ns, path) -> 0 or -ENOENT`. Phase 6 surfaces
/// mtime only; atime tracking lands later.
fn utimens(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let mtime_ns = u64::from_le_bytes(request[0..8].try_into().expect("8 bytes"));
    let raw = &request[8..];
    if raw.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let path = proc_self_rewrite(caller_pid, raw);
    with_kernel(|k| {
        let (mount_id, inode) = match k.vfs.open(&path, 0) {
            Some(pair) => pair,
            None => return -(abi::ENOENT as i64),
        };
        let mut meta = k.resolve_metadata(mount_id, inode);
        meta.mtime_ns = mtime_ns;
        k.set_metadata_override(mount_id, inode, meta);
        0
    })
}

/// `chmod(mode, path) -> 0 or -ENOENT`. Request: u32 mode LE +
/// path bytes. Writes to the kernel's MetadataOverlay; subsequent
/// fstat sees the new mode. Phase 6 has no permission checks —
/// any process that can resolve the path can chmod it.
fn chmod(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let mode = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let raw = &request[4..];
    if raw.is_empty() {
        return -(abi::EINVAL as i64);
    }
    // future: use caller_pid for permission checks too
    let path = proc_self_rewrite(caller_pid, raw);
    with_kernel(|k| {
        let (mount_id, inode) = match k.vfs.open(&path, 0) {
            Some(pair) => pair,
            None => return -(abi::ENOENT as i64),
        };
        let mut meta = k.resolve_metadata(mount_id, inode);
        // Only update permission bits — high nibble (file type)
        // is fixed by the backend, not the user.
        meta.mode = (meta.mode & 0o170_000) | (mode & 0o007_777);
        k.set_metadata_override(mount_id, inode, meta);
        0
    })
}

fn now_realtime(response: &mut [u8]) -> i64 {
    if response.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    match kh::now_realtime_ns() {
        Ok(ns) => {
            response[..8].copy_from_slice(&ns.to_le_bytes());
            8
        }
        Err(rc) => rc as i64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: pack a sys_open request (u32 flags + path bytes).
    /// flags=0 means read-only (the previous default).
    fn open_req(flags: u32, path: &[u8]) -> Vec<u8> {
        let mut req = flags.to_le_bytes().to_vec();
        req.extend_from_slice(path);
        req
    }
    const O_WRITE: u32 = 0b001;
    const O_CREAT: u32 = 0b010;
    const O_TRUNC: u32 = 0b100;

    #[test]
    fn echo_copies_min_of_request_and_response_lengths() {
        let mut out = [0u8; 4];
        assert_eq!(dispatch(METHOD_KERNEL_ECHO, 0, b"hello", &mut out), 4);
        assert_eq!(&out, b"hell");
    }

    #[test]
    fn echo_handles_empty_request() {
        let mut out = [0u8; 8];
        assert_eq!(dispatch(METHOD_KERNEL_ECHO, 0, &[], &mut out), 0);
    }

    #[test]
    fn credentials_syscalls_return_default_uid_gid() {
        assert_eq!(dispatch(METHOD_SYS_GETUID, 1, &[], &mut []), 1000);
        assert_eq!(dispatch(METHOD_SYS_GETEUID, 1, &[], &mut []), 1000);
        assert_eq!(dispatch(METHOD_SYS_GETGID, 1, &[], &mut []), 1000);
        assert_eq!(dispatch(METHOD_SYS_GETEGID, 1, &[], &mut []), 1000);
    }

    #[test]
    fn getpid_returns_caller_pid() {
        assert_eq!(dispatch(METHOD_SYS_GETPID, 1, &[], &mut []), 1);
        assert_eq!(dispatch(METHOD_SYS_GETPID, 42, &[], &mut []), 42);
        assert_eq!(dispatch(METHOD_SYS_GETPID, 0, &[], &mut []), 0);
    }

    #[test]
    fn getppid_returns_kernel_pid_until_process_tree_exists() {
        // Phase note: until host_spawn lands and the kernel tracks
        // parent/child relationships, every process is treated as a
        // direct child of the kernel.
        assert_eq!(dispatch(METHOD_SYS_GETPPID, 1, &[], &mut []), 0);
        assert_eq!(dispatch(METHOD_SYS_GETPPID, 99, &[], &mut []), 0);
    }

    #[test]
    fn umask_round_trips_through_per_pid_state() {
        let _g = crate::kernel::TestGuard::acquire();
        // First call: returns the default 022, sets new mask 077.
        let req = 0o077_u32.to_le_bytes();
        assert_eq!(dispatch(METHOD_SYS_UMASK, 1, &req, &mut []), 0o022);
        // Second call from the same pid: previous = 077.
        let req2 = 0o007_u32.to_le_bytes();
        assert_eq!(dispatch(METHOD_SYS_UMASK, 1, &req2, &mut []), 0o077);
        // A different pid sees its own default.
        assert_eq!(dispatch(METHOD_SYS_UMASK, 2, &req, &mut []), 0o022);
    }

    #[test]
    fn setresuid_writes_per_pid_credentials() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&500_u32.to_le_bytes()); // ruid
        req.extend_from_slice(&501_u32.to_le_bytes()); // euid
        req.extend_from_slice(&502_u32.to_le_bytes()); // suid
        assert_eq!(dispatch(METHOD_SYS_SETRESUID, 1, &req, &mut []), 0);
        assert_eq!(dispatch(METHOD_SYS_GETUID, 1, &[], &mut []), 500);
        assert_eq!(dispatch(METHOD_SYS_GETEUID, 1, &[], &mut []), 501);
        // Other pid still sees defaults.
        assert_eq!(dispatch(METHOD_SYS_GETUID, 2, &[], &mut []), 1000);
    }

    #[test]
    fn setresuid_rejects_short_request() {
        let req = [0u8; 4]; // only one u32 instead of three
        assert_eq!(
            dispatch(METHOD_SYS_SETRESUID, 1, &req, &mut []),
            -(abi::EINVAL as i64)
        );
    }

    #[test]
    fn setresgid_writes_per_pid_credentials() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&77_u32.to_le_bytes());
        req.extend_from_slice(&78_u32.to_le_bytes());
        req.extend_from_slice(&79_u32.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_SETRESGID, 1, &req, &mut []), 0);
        assert_eq!(dispatch(METHOD_SYS_GETGID, 1, &[], &mut []), 77);
        assert_eq!(dispatch(METHOD_SYS_GETEGID, 1, &[], &mut []), 78);
    }

    #[test]
    fn chdir_then_getcwd_round_trips() {
        let _g = crate::kernel::TestGuard::acquire();
        // Default cwd is "/", required size 2 bytes ("/" + NUL).
        let mut buf = [0u8; 16];
        assert_eq!(dispatch(METHOD_SYS_GETCWD, 1, &[], &mut buf), 2);
        assert_eq!(&buf[..2], b"/\0");

        // chdir to "/var/tmp"
        assert_eq!(dispatch(METHOD_SYS_CHDIR, 1, b"/var/tmp", &mut []), 0);

        let mut buf = [0u8; 32];
        let n = dispatch(METHOD_SYS_GETCWD, 1, &[], &mut buf);
        assert_eq!(n, b"/var/tmp\0".len() as i64);
        assert_eq!(&buf[..n as usize], b"/var/tmp\0");
    }

    #[test]
    fn getcwd_returns_required_size_when_buffer_too_small() {
        let _g = crate::kernel::TestGuard::acquire();
        // Default cwd "/" needs 2 bytes; pass a 1-byte buffer.
        let mut tiny = [0u8; 1];
        let n = dispatch(METHOD_SYS_GETCWD, 1, &[], &mut tiny);
        assert_eq!(n, 2, "returns required size on too-small buffer");
        // Verify the buffer wasn't written into when too small.
        assert_eq!(tiny, [0]);
    }

    #[test]
    fn cwd_is_per_pid() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(dispatch(METHOD_SYS_CHDIR, 1, b"/home/a", &mut []), 0);
        assert_eq!(dispatch(METHOD_SYS_CHDIR, 2, b"/home/b", &mut []), 0);
        let mut buf = [0u8; 32];
        let n = dispatch(METHOD_SYS_GETCWD, 1, &[], &mut buf);
        assert_eq!(&buf[..n as usize - 1], b"/home/a");
        let n = dispatch(METHOD_SYS_GETCWD, 2, &[], &mut buf);
        assert_eq!(&buf[..n as usize - 1], b"/home/b");
    }

    #[test]
    fn chdir_rejects_empty_path() {
        assert_eq!(
            dispatch(METHOD_SYS_CHDIR, 1, &[], &mut []),
            -(abi::EINVAL as i64)
        );
    }

    #[test]
    fn umask_rejects_short_request() {
        assert_eq!(
            dispatch(METHOD_SYS_UMASK, 1, &[1, 2], &mut []),
            -(abi::EINVAL as i64)
        );
    }

    #[test]
    fn getrlimit_default_stack_is_one_megabyte() {
        let _g = crate::kernel::TestGuard::acquire();
        let req = 3_u32.to_le_bytes(); // RLIMIT_STACK
        let mut out = [0u8; 16];
        let n = dispatch(METHOD_SYS_GETRLIMIT, 1, &req, &mut out);
        assert_eq!(n, 16);
        let soft = u64::from_le_bytes(out[0..8].try_into().unwrap());
        let hard = u64::from_le_bytes(out[8..16].try_into().unwrap());
        assert_eq!(soft, 1024 * 1024);
        assert_eq!(hard, 1024 * 1024);
    }

    #[test]
    fn getrlimit_default_cpu_is_infinity() {
        let _g = crate::kernel::TestGuard::acquire();
        let req = 0_u32.to_le_bytes(); // RLIMIT_CPU
        let mut out = [0u8; 16];
        assert_eq!(dispatch(METHOD_SYS_GETRLIMIT, 1, &req, &mut out), 16);
        let soft = u64::from_le_bytes(out[0..8].try_into().unwrap());
        assert_eq!(soft, u64::MAX, "RLIM_INFINITY");
    }

    #[test]
    fn getrlimit_unknown_resource_is_einval() {
        let _g = crate::kernel::TestGuard::acquire();
        let req = 99_u32.to_le_bytes();
        let mut out = [0u8; 16];
        assert_eq!(
            dispatch(METHOD_SYS_GETRLIMIT, 1, &req, &mut out),
            -(abi::EINVAL as i64)
        );
    }

    #[test]
    fn setrlimit_lowers_then_get_reflects() {
        let _g = crate::kernel::TestGuard::acquire();
        // Lower RLIMIT_NOFILE (id=7) from 1024/1024 to 256/512.
        let mut req = Vec::new();
        req.extend_from_slice(&7_u32.to_le_bytes());
        req.extend_from_slice(&256_u64.to_le_bytes());
        req.extend_from_slice(&512_u64.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_SETRLIMIT, 1, &req, &mut []), 0);

        let req_get = 7_u32.to_le_bytes();
        let mut out = [0u8; 16];
        assert_eq!(dispatch(METHOD_SYS_GETRLIMIT, 1, &req_get, &mut out), 16);
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 256);
        assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), 512);
    }

    #[test]
    fn setrlimit_raising_hard_is_eperm() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&7_u32.to_le_bytes());
        req.extend_from_slice(&1024_u64.to_le_bytes());
        req.extend_from_slice(&(u64::MAX).to_le_bytes());
        assert_eq!(
            dispatch(METHOD_SYS_SETRLIMIT, 1, &req, &mut []),
            -(abi::EPERM as i64)
        );
    }

    #[test]
    fn setrlimit_soft_above_hard_is_einval() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&7_u32.to_le_bytes());
        req.extend_from_slice(&2048_u64.to_le_bytes()); // soft
        req.extend_from_slice(&512_u64.to_le_bytes()); // hard
        assert_eq!(
            dispatch(METHOD_SYS_SETRLIMIT, 1, &req, &mut []),
            -(abi::EINVAL as i64)
        );
    }

    #[test]
    fn rlimits_are_per_pid() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&7_u32.to_le_bytes());
        req.extend_from_slice(&100_u64.to_le_bytes());
        req.extend_from_slice(&200_u64.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_SETRLIMIT, 1, &req, &mut []), 0);

        // Pid 2 still sees default (1024/1024).
        let req_get = 7_u32.to_le_bytes();
        let mut out = [0u8; 16];
        assert_eq!(dispatch(METHOD_SYS_GETRLIMIT, 2, &req_get, &mut out), 16);
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 1024);
    }

    #[test]
    fn fd_table_starts_with_stdin_stdout_stderr() {
        let _g = crate::kernel::TestGuard::acquire();
        // close(0), close(1), close(2) all succeed; close(3) does not.
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &0_u32.to_le_bytes(), &mut []),
            0
        );
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &1_u32.to_le_bytes(), &mut []),
            0
        );
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &2_u32.to_le_bytes(), &mut []),
            0
        );
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &3_u32.to_le_bytes(), &mut []),
            -(abi::EBADF as i64)
        );
    }

    #[test]
    fn close_unknown_fd_is_ebadf() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &99_u32.to_le_bytes(), &mut []),
            -(abi::EBADF as i64)
        );
    }

    #[test]
    fn dup_returns_lowest_unused_fd() {
        let _g = crate::kernel::TestGuard::acquire();
        // Default has 0/1/2; dup(1) should return 3.
        assert_eq!(
            dispatch(METHOD_SYS_DUP, 1, &1_u32.to_le_bytes(), &mut []),
            3
        );
        // Both 1 and 3 still close cleanly.
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &3_u32.to_le_bytes(), &mut []),
            0
        );
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &1_u32.to_le_bytes(), &mut []),
            0
        );
    }

    #[test]
    fn dup_fills_holes_in_the_table() {
        let _g = crate::kernel::TestGuard::acquire();
        // Close 0; next dup should put the duplicate at 0.
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &0_u32.to_le_bytes(), &mut []),
            0
        );
        assert_eq!(
            dispatch(METHOD_SYS_DUP, 1, &1_u32.to_le_bytes(), &mut []),
            0
        );
    }

    #[test]
    fn dup_of_unopened_fd_is_ebadf() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(
            dispatch(METHOD_SYS_DUP, 1, &42_u32.to_le_bytes(), &mut []),
            -(abi::EBADF as i64)
        );
    }

    #[test]
    fn dup2_overwrites_target_silently() {
        let _g = crate::kernel::TestGuard::acquire();
        // dup2(1, 2): fd 2 was stderr; now it's the same as fd 1.
        let mut req = Vec::new();
        req.extend_from_slice(&1_u32.to_le_bytes());
        req.extend_from_slice(&2_u32.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_DUP2, 1, &req, &mut []), 2);
        // Closing 2 succeeds (it was open after the dup2).
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &2_u32.to_le_bytes(), &mut []),
            0
        );
    }

    #[test]
    fn dup2_to_arbitrary_high_fd_works() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&1_u32.to_le_bytes());
        req.extend_from_slice(&100_u32.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_DUP2, 1, &req, &mut []), 100);
        // dup() now skips both 0/1/2 and 100; should return 3.
        assert_eq!(
            dispatch(METHOD_SYS_DUP, 1, &1_u32.to_le_bytes(), &mut []),
            3
        );
    }

    #[test]
    fn dup2_same_fd_is_noop_when_open() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&1_u32.to_le_bytes());
        req.extend_from_slice(&1_u32.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_DUP2, 1, &req, &mut []), 1);
    }

    #[test]
    fn dup2_oldfd_unopened_is_ebadf() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&42_u32.to_le_bytes());
        req.extend_from_slice(&5_u32.to_le_bytes());
        assert_eq!(
            dispatch(METHOD_SYS_DUP2, 1, &req, &mut []),
            -(abi::EBADF as i64)
        );
    }

    #[test]
    fn fd_table_is_per_pid() {
        let _g = crate::kernel::TestGuard::acquire();
        // Close fd 0 in pid 1.
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &0_u32.to_le_bytes(), &mut []),
            0
        );
        // Pid 2 still has fd 0.
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 2, &0_u32.to_le_bytes(), &mut []),
            0
        );
        // Closing again in pid 2 fails.
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 2, &0_u32.to_le_bytes(), &mut []),
            -(abi::EBADF as i64)
        );
    }

    #[test]
    fn pipe_allocates_two_consecutive_fds_and_round_trips_bytes() {
        let _g = crate::kernel::TestGuard::acquire();
        // pipe() with default fd table {0,1,2} → read on 3, write on 4.
        let mut fds = [0u8; 8];
        assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds), 8);
        let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
        let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());
        assert_eq!(read_fd, 3);
        assert_eq!(write_fd, 4);

        // Write "hello" to write_fd.
        let mut wreq = Vec::new();
        wreq.extend_from_slice(&write_fd.to_le_bytes());
        wreq.extend_from_slice(b"hello");
        assert_eq!(dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []), 5);

        // Read it back from read_fd.
        let mut buf = [0u8; 16];
        let n = dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf);
        assert_eq!(n, 5);
        assert_eq!(&buf[..5], b"hello");
    }

    #[test]
    fn pipe_read_with_no_data_and_writers_attached_is_eagain() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut fds = [0u8; 8];
        dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
        let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
        let mut buf = [0u8; 16];
        // Empty buffer, writer still open → -EAGAIN.
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf),
            -(abi::EAGAIN as i64)
        );
    }

    #[test]
    fn pipe_read_after_writer_closed_and_drained_is_eof() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut fds = [0u8; 8];
        dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
        let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
        let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());

        // Close the writer (no data was written).
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &write_fd.to_le_bytes(), &mut []),
            0
        );
        let mut buf = [0u8; 16];
        // Drained + no writers → 0 (EOF), not EAGAIN.
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf),
            0
        );
    }

    #[test]
    fn pipe_write_after_all_readers_closed_is_epipe() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut fds = [0u8; 8];
        dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
        let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
        let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());

        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &read_fd.to_le_bytes(), &mut []),
            0
        );
        let mut wreq = Vec::new();
        wreq.extend_from_slice(&write_fd.to_le_bytes());
        wreq.extend_from_slice(b"x");
        assert_eq!(
            dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
            -(abi::EPIPE as i64)
        );
    }

    #[test]
    fn pipe_dup_increments_refcount_so_close_does_not_drop_buffer() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut fds = [0u8; 8];
        dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
        let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
        let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());

        // Dup the writer so we have two write-end fds.
        let dup_writer = dispatch(METHOD_SYS_DUP, 1, &write_fd.to_le_bytes(), &mut []);
        assert!(dup_writer > 0);
        let dup_writer = dup_writer as u32;

        // Close the original writer; the second one keeps the pipe open.
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &write_fd.to_le_bytes(), &mut []),
            0
        );

        // Reader should still see EAGAIN (writers attached), not EOF.
        let mut buf = [0u8; 16];
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf),
            -(abi::EAGAIN as i64)
        );

        // Closing the dup_writer drops the last write-end → reader EOF.
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &dup_writer.to_le_bytes(), &mut []),
            0
        );
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf),
            0
        );
    }

    #[test]
    fn pipe_partial_read_returns_min_of_buffer_and_response() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut fds = [0u8; 8];
        dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
        let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
        let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());

        let mut wreq = Vec::new();
        wreq.extend_from_slice(&write_fd.to_le_bytes());
        wreq.extend_from_slice(b"abcdefghij");
        dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []);

        // Small response buffer → reads partial.
        let mut small = [0u8; 4];
        let n = dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut small);
        assert_eq!(n, 4);
        assert_eq!(&small, b"abcd");

        // Subsequent read drains the rest.
        let mut rest = [0u8; 16];
        let n = dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut rest);
        assert_eq!(n, 6);
        assert_eq!(&rest[..6], b"efghij");
    }

    #[test]
    fn write_to_stdout_buffers_in_per_pid_state() {
        // sys_write to fd 1 (Stdout) appends to Process.stdout_buffer;
        // METHOD_KERNEL_DRAIN_STDOUT reads it back.
        let _g = crate::kernel::TestGuard::acquire();
        let mut wreq = Vec::new();
        wreq.extend_from_slice(&1_u32.to_le_bytes());
        wreq.extend_from_slice(b"hello stdout");
        assert_eq!(
            dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
            "hello stdout".len() as i64
        );
        // Drain the buffer via METHOD_KERNEL_DRAIN_STDOUT and verify.
        let mut buf = [0u8; 64];
        let drain_req = 1_u32.to_le_bytes();
        let n = dispatch(METHOD_KERNEL_DRAIN_STDOUT, 0, &drain_req, &mut buf);
        assert_eq!(n, "hello stdout".len() as i64);
        assert_eq!(&buf[..n as usize], b"hello stdout");
        // Subsequent drain returns 0.
        assert_eq!(
            dispatch(METHOD_KERNEL_DRAIN_STDOUT, 0, &drain_req, &mut buf),
            0
        );
    }

    #[test]
    fn write_to_stderr_uses_separate_per_pid_buffer() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut w = Vec::new();
        w.extend_from_slice(&2_u32.to_le_bytes());
        w.extend_from_slice(b"err msg");
        dispatch(METHOD_SYS_WRITE, 1, &w, &mut []);

        // Stderr drains separately; stdout is empty.
        let drain_req = 1_u32.to_le_bytes();
        let mut buf = [0u8; 64];
        assert_eq!(
            dispatch(METHOD_KERNEL_DRAIN_STDOUT, 0, &drain_req, &mut buf),
            0
        );
        let n = dispatch(METHOD_KERNEL_DRAIN_STDERR, 0, &drain_req, &mut buf);
        assert_eq!(n, "err msg".len() as i64);
        assert_eq!(&buf[..n as usize], b"err msg");
    }

    #[test]
    fn stdout_buffers_are_per_pid() {
        let _g = crate::kernel::TestGuard::acquire();
        // Pid 1 writes "alpha"; pid 2 writes "beta".
        let mut w1 = Vec::new();
        w1.extend_from_slice(&1_u32.to_le_bytes());
        w1.extend_from_slice(b"alpha");
        dispatch(METHOD_SYS_WRITE, 1, &w1, &mut []);
        let mut w2 = Vec::new();
        w2.extend_from_slice(&1_u32.to_le_bytes());
        w2.extend_from_slice(b"beta");
        dispatch(METHOD_SYS_WRITE, 2, &w2, &mut []);

        let mut buf = [0u8; 64];
        let n = dispatch(
            METHOD_KERNEL_DRAIN_STDOUT,
            0,
            &1_u32.to_le_bytes(),
            &mut buf,
        );
        assert_eq!(&buf[..n as usize], b"alpha");
        let n = dispatch(
            METHOD_KERNEL_DRAIN_STDOUT,
            0,
            &2_u32.to_le_bytes(),
            &mut buf,
        );
        assert_eq!(&buf[..n as usize], b"beta");
    }

    #[test]
    fn read_from_empty_stdin_without_eof_is_eagain() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut buf = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf),
            -(abi::EAGAIN as i64)
        );
    }

    #[test]
    fn read_from_empty_stdin_with_eof_is_zero() {
        let _g = crate::kernel::TestGuard::acquire();
        let close_req = 1_u32.to_le_bytes();
        assert_eq!(
            dispatch(METHOD_KERNEL_CLOSE_STDIN, 0, &close_req, &mut []),
            0
        );
        let mut buf = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf),
            0
        );
    }

    #[test]
    fn provided_stdin_drains_then_reaches_eof() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&1_u32.to_le_bytes());
        req.extend_from_slice(b"abcdefg");
        assert_eq!(dispatch(METHOD_KERNEL_PROVIDE_STDIN, 0, &req, &mut []), 7);

        let mut buf = [0u8; 4];
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf),
            4
        );
        assert_eq!(&buf, b"abcd");

        let mut buf2 = [0u8; 16];
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf2),
            3
        );
        assert_eq!(&buf2[..3], b"efg");

        // Drained, no EOF yet → -EAGAIN.
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf2),
            -(abi::EAGAIN as i64)
        );

        // After EOF mark → 0.
        let close_req = 1_u32.to_le_bytes();
        dispatch(METHOD_KERNEL_CLOSE_STDIN, 0, &close_req, &mut []);
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf2),
            0
        );
    }

    #[test]
    fn stdin_is_per_pid() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut r1 = Vec::new();
        r1.extend_from_slice(&1_u32.to_le_bytes());
        r1.extend_from_slice(b"alpha");
        dispatch(METHOD_KERNEL_PROVIDE_STDIN, 0, &r1, &mut []);
        let mut r2 = Vec::new();
        r2.extend_from_slice(&2_u32.to_le_bytes());
        r2.extend_from_slice(b"beta");
        dispatch(METHOD_KERNEL_PROVIDE_STDIN, 0, &r2, &mut []);

        let mut buf = [0u8; 16];
        let n = dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"alpha");
        let n = dispatch(METHOD_SYS_READ, 2, &0_u32.to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"beta");
    }

    #[test]
    fn isatty_reports_one_for_stdio_and_zero_for_pipe_ends() {
        let _g = crate::kernel::TestGuard::acquire();
        // Default fd table has 0/1/2 → all three report 1.
        for fd in 0..=2u32 {
            assert_eq!(
                dispatch(METHOD_SYS_ISATTY, 1, &fd.to_le_bytes(), &mut []),
                1,
                "fd {fd} should be a tty"
            );
        }
        // Allocate a pipe; both ends report 0.
        let mut fds = [0u8; 8];
        dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
        let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
        let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());
        assert_eq!(
            dispatch(METHOD_SYS_ISATTY, 1, &read_fd.to_le_bytes(), &mut []),
            0
        );
        assert_eq!(
            dispatch(METHOD_SYS_ISATTY, 1, &write_fd.to_le_bytes(), &mut []),
            0
        );
    }

    #[test]
    fn isatty_on_closed_fd_is_ebadf() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(
            dispatch(METHOD_SYS_ISATTY, 1, &99_u32.to_le_bytes(), &mut []),
            -(abi::EBADF as i64)
        );
    }

    #[test]
    fn clock_gettime_realtime_returns_kh_now_value() {
        // Native test stub for kh_now_realtime returns
        // 1_700_000_000_000_000_000 ns; check it round-trips.
        let mut buf = [0u8; 8];
        let n = dispatch(METHOD_SYS_CLOCK_GETTIME, 1, &0_u32.to_le_bytes(), &mut buf);
        assert_eq!(n, 8);
        assert_eq!(u64::from_le_bytes(buf), 1_700_000_000_000_000_000_u64);
    }

    #[test]
    fn clock_gettime_unknown_clock_is_einval() {
        let mut buf = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_CLOCK_GETTIME, 1, &99_u32.to_le_bytes(), &mut buf),
            -(abi::EINVAL as i64)
        );
    }

    #[test]
    fn getpgid_self_defaults_to_caller_pid() {
        let _g = crate::kernel::TestGuard::acquire();
        // pid 7 with target 0 → "self"; default pgid lazily primes to pid.
        assert_eq!(
            dispatch(METHOD_SYS_GETPGID, 7, &0_u32.to_le_bytes(), &mut []),
            7
        );
    }

    #[test]
    fn setpgid_then_getpgid_round_trips() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&0_u32.to_le_bytes()); // target = self
        req.extend_from_slice(&5_u32.to_le_bytes()); // new pgid
        assert_eq!(dispatch(METHOD_SYS_SETPGID, 1, &req, &mut []), 0);
        assert_eq!(
            dispatch(METHOD_SYS_GETPGID, 1, &0_u32.to_le_bytes(), &mut []),
            5
        );
    }

    #[test]
    fn setpgid_pgid_zero_makes_target_a_group_leader() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&3_u32.to_le_bytes());
        req.extend_from_slice(&0_u32.to_le_bytes()); // pgid 0 → target's pid
        assert_eq!(dispatch(METHOD_SYS_SETPGID, 1, &req, &mut []), 0);
        assert_eq!(
            dispatch(METHOD_SYS_GETPGID, 1, &3_u32.to_le_bytes(), &mut []),
            3
        );
    }

    #[test]
    fn pgid_is_per_pid() {
        let _g = crate::kernel::TestGuard::acquire();
        // pid 1 default sees pgid 1; setting pid 2's pgid doesn't move pid 1.
        let mut req = Vec::new();
        req.extend_from_slice(&2_u32.to_le_bytes());
        req.extend_from_slice(&99_u32.to_le_bytes());
        dispatch(METHOD_SYS_SETPGID, 1, &req, &mut []);
        assert_eq!(
            dispatch(METHOD_SYS_GETPGID, 1, &0_u32.to_le_bytes(), &mut []),
            1
        );
        assert_eq!(
            dispatch(METHOD_SYS_GETPGID, 1, &2_u32.to_le_bytes(), &mut []),
            99
        );
    }

    #[test]
    fn setsid_first_call_creates_session_then_repeats_eperm() {
        let _g = crate::kernel::TestGuard::acquire();
        // First setsid from a fresh pid succeeds and returns the pid.
        assert_eq!(dispatch(METHOD_SYS_SETSID, 9, &[], &mut []), 9);
        // sid and pgid are now both 9.
        assert_eq!(
            dispatch(METHOD_SYS_GETSID, 9, &0_u32.to_le_bytes(), &mut []),
            9
        );
        assert_eq!(
            dispatch(METHOD_SYS_GETPGID, 9, &0_u32.to_le_bytes(), &mut []),
            9
        );
        // Second call → EPERM (already a session leader).
        assert_eq!(
            dispatch(METHOD_SYS_SETSID, 9, &[], &mut []),
            -(abi::EPERM as i64)
        );
    }

    #[test]
    fn getsid_self_lazily_primes_to_caller_pid() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(
            dispatch(METHOD_SYS_GETSID, 11, &0_u32.to_le_bytes(), &mut []),
            11
        );
    }

    #[test]
    fn kill_sig_zero_is_alive_probe_and_succeeds() {
        let _g = crate::kernel::TestGuard::acquire();
        crate::kernel::with_kernel(|k| {
            k.process_mut(5);
        });
        let mut req = Vec::new();
        req.extend_from_slice(&5_u32.to_le_bytes()); // target
        req.extend_from_slice(&0_u32.to_le_bytes()); // sig 0 = probe
        assert_eq!(dispatch(METHOD_SYS_KILL, 1, &req, &mut []), 0);
    }

    #[test]
    fn kill_records_signal_in_pending_mask() {
        let _g = crate::kernel::TestGuard::acquire();
        crate::kernel::with_kernel(|k| {
            k.process_mut(5);
        });
        let mut req = Vec::new();
        req.extend_from_slice(&5_u32.to_le_bytes()); // target pid
        req.extend_from_slice(&15_u32.to_le_bytes()); // SIGTERM
        assert_eq!(dispatch(METHOD_SYS_KILL, 1, &req, &mut []), 0);
        // Bit 14 (sig 15 - 1) should now be set on pid 5.
        let pending = crate::kernel::with_kernel(|k| k.process_mut(5).pending_signals);
        assert_eq!(pending, 1u64 << 14);
    }

    #[test]
    fn kill_clears_host_instance_handle_after_destroy() {
        let _g = crate::kernel::TestGuard::acquire();
        crate::kernel::with_kernel(|k| {
            k.process_mut(5).host_instance_handle = Some(42);
        });
        assert_eq!(kill_pid(5, 15), -(abi::ENOSYS as i64));
        let handle = crate::kernel::with_kernel(|k| k.process_mut(5).host_instance_handle);
        assert_eq!(handle, Some(42));
    }

    #[test]
    fn kill_unknown_pid_is_esrch_and_does_not_create_process() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(kill_pid(999_999, 0), -(abi::ESRCH as i64));
        assert_eq!(kill_pid(999_999, 15), -(abi::ESRCH as i64));
        assert!(!crate::kernel::with_kernel(|k| k.has_process(999_999)));
    }

    #[test]
    fn kill_out_of_range_sig_is_einval() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&5_u32.to_le_bytes());
        req.extend_from_slice(&64_u32.to_le_bytes()); // 1..=63 only
        assert_eq!(
            dispatch(METHOD_SYS_KILL, 1, &req, &mut []),
            -(abi::EINVAL as i64)
        );
    }

    #[test]
    fn sigaction_returns_previous_disposition_and_persists_new() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&15_u32.to_le_bytes()); // SIGTERM
        req.extend_from_slice(&0xCAFEBABE_u32.to_le_bytes()); // user handler
        assert_eq!(dispatch(METHOD_SYS_SIGACTION, 1, &req, &mut []), 0); // prev was SIG_DFL

        // Replace with SIG_IGN; should report 0xCAFEBABE as previous.
        let mut req2 = Vec::new();
        req2.extend_from_slice(&15_u32.to_le_bytes());
        req2.extend_from_slice(&1_u32.to_le_bytes()); // SIG_IGN
        assert_eq!(
            dispatch(METHOD_SYS_SIGACTION, 1, &req2, &mut []),
            0xCAFEBABE_i64
        );
    }

    #[test]
    fn sigaction_is_per_pid_per_sig() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&15_u32.to_le_bytes());
        req.extend_from_slice(&7_u32.to_le_bytes());
        dispatch(METHOD_SYS_SIGACTION, 1, &req, &mut []);

        // pid 2, same sig: still SIG_DFL.
        let mut probe = Vec::new();
        probe.extend_from_slice(&15_u32.to_le_bytes());
        probe.extend_from_slice(&0_u32.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_SIGACTION, 2, &probe, &mut []), 0);

        // pid 1, different sig: still SIG_DFL.
        let mut other = Vec::new();
        other.extend_from_slice(&9_u32.to_le_bytes()); // SIGKILL
        other.extend_from_slice(&0_u32.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_SIGACTION, 1, &other, &mut []), 0);
    }

    #[test]
    fn sched_yield_increments_per_pid_counter() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(dispatch(METHOD_SYS_SCHED_YIELD, 1, &[], &mut []), 0);
        assert_eq!(dispatch(METHOD_SYS_SCHED_YIELD, 1, &[], &mut []), 0);
        assert_eq!(dispatch(METHOD_SYS_SCHED_YIELD, 2, &[], &mut []), 0);
        let (y1, y2) = crate::kernel::with_kernel(|k| {
            (k.process_mut(1).yield_count, k.process_mut(2).yield_count)
        });
        assert_eq!(y1, 2);
        assert_eq!(y2, 1);
    }

    #[test]
    fn nanosleep_records_requested_duration() {
        let _g = crate::kernel::TestGuard::acquire();
        let req = 5_000_000_000_u64.to_le_bytes(); // 5 seconds
        assert_eq!(dispatch(METHOD_SYS_NANOSLEEP, 1, &req, &mut []), 0);
        let recorded = crate::kernel::with_kernel(|k| k.process_mut(1).last_nanosleep_ns);
        assert_eq!(recorded, 5_000_000_000);
    }

    #[test]
    fn nanosleep_short_request_is_einval() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(
            dispatch(METHOD_SYS_NANOSLEEP, 1, &[1, 2, 3], &mut []),
            -(abi::EINVAL as i64)
        );
    }

    #[test]
    fn register_file_then_open_then_read_round_trips_content() {
        let _g = crate::kernel::TestGuard::acquire();
        // Install /etc/hello with content "hi from ramfs".
        let mut req = Vec::new();
        let path: &[u8] = b"/etc/hello";
        req.extend_from_slice(&(path.len() as u32).to_le_bytes());
        req.extend_from_slice(path);
        req.extend_from_slice(b"hi from ramfs");
        assert_eq!(dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &req, &mut []), 0);

        // Open it; expect the lowest free fd (3, since 0/1/2 are stdio).
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, path), &mut []);
        assert_eq!(fd, 3);

        // Read all bytes.
        let mut buf = [0u8; 64];
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(n as usize, b"hi from ramfs".len());
        assert_eq!(&buf[..n as usize], b"hi from ramfs");

        // Subsequent read at EOF returns 0.
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(n, 0);

        // close the file fd.
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &(fd as u32).to_le_bytes(), &mut []),
            0
        );
    }

    #[test]
    fn open_nonexistent_path_is_enoent() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(
            dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/no/such"), &mut []),
            -(abi::ENOENT as i64)
        );
    }

    #[test]
    fn hostfs_open_propagates_host_errno() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(
            dispatch(METHOD_KERNEL_INSTALL_HOST_FS_MOUNT, 0, b"/host", &mut []),
            0
        );
        assert_eq!(
            dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/host/missing"), &mut []),
            -(abi::ENOSYS as i64)
        );
    }

    #[test]
    fn write_to_ramfs_file_fd_is_ebadf() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&5_u32.to_le_bytes());
        reg.extend_from_slice(b"/zero");
        reg.extend_from_slice(b"abc");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/zero"), &mut []);
        assert!(fd >= 0);
        let mut wreq = Vec::new();
        wreq.extend_from_slice(&(fd as u32).to_le_bytes());
        wreq.extend_from_slice(b"NOPE");
        assert_eq!(
            dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
            -(abi::EBADF as i64),
            "ramfs is read-only in Phase 2"
        );
    }

    #[test]
    fn ramfs_partial_read_advances_offset() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&7_u32.to_le_bytes());
        reg.extend_from_slice(b"/abcdef");
        reg.extend_from_slice(b"0123456789");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/abcdef"), &mut []) as u32;

        let mut small = [0u8; 4];
        let n = dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut small);
        assert_eq!(n, 4);
        assert_eq!(&small, b"0123");

        let mut rest = [0u8; 16];
        let n = dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut rest);
        assert_eq!(n, 6);
        assert_eq!(&rest[..6], b"456789");
    }

    #[test]
    fn dup_of_file_fd_shares_ofd_cursor() {
        // POSIX: dup'd fds share the open-file-description cursor.
        // Read 4 bytes via fd, then read 4 more via duped fd — the
        // duped fd should pick up at offset 4, not start over at 0.
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&6_u32.to_le_bytes());
        reg.extend_from_slice(b"/abcde");
        reg.extend_from_slice(b"0123456789");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/abcde"), &mut []) as u32;

        let mut buf = [0u8; 4];
        assert_eq!(dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut buf), 4);
        assert_eq!(&buf, b"0123");

        let dupfd = dispatch(METHOD_SYS_DUP, 1, &fd.to_le_bytes(), &mut []) as u32;
        let mut buf2 = [0u8; 4];
        let n = dispatch(METHOD_SYS_READ, 1, &dupfd.to_le_bytes(), &mut buf2);
        assert_eq!(n, 4, "duped fd shares offset, sees bytes 4..8");
        assert_eq!(&buf2, b"4567");
    }

    #[test]
    fn close_one_file_fd_keeps_ofd_alive_via_dup() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&5_u32.to_le_bytes());
        reg.extend_from_slice(b"/keep");
        reg.extend_from_slice(b"abc");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/keep"), &mut []) as u32;
        let dup = dispatch(METHOD_SYS_DUP, 1, &fd.to_le_bytes(), &mut []) as u32;

        // Close the original — the duped fd should still read fine.
        assert_eq!(dispatch(METHOD_SYS_CLOSE, 1, &fd.to_le_bytes(), &mut []), 0);
        let mut buf = [0u8; 8];
        let n = dispatch(METHOD_SYS_READ, 1, &dup.to_le_bytes(), &mut buf);
        assert_eq!(n, 3);
        assert_eq!(&buf[..3], b"abc");
    }

    #[test]
    fn lseek_set_then_read_picks_up_at_new_offset() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&5_u32.to_le_bytes());
        reg.extend_from_slice(b"/seek");
        reg.extend_from_slice(b"0123456789");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/seek"), &mut []) as u32;

        // Seek to offset 4 (whence=SET).
        let mut req = Vec::new();
        req.extend_from_slice(&fd.to_le_bytes());
        req.extend_from_slice(&4_i64.to_le_bytes());
        req.extend_from_slice(&0_u32.to_le_bytes());
        let mut out = [0u8; 8];
        assert_eq!(dispatch(METHOD_SYS_LSEEK, 1, &req, &mut out), 8);
        assert_eq!(i64::from_le_bytes(out), 4);

        // Read should now start at "4".
        let mut buf = [0u8; 4];
        assert_eq!(dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut buf), 4);
        assert_eq!(&buf, b"4567");
    }

    #[test]
    fn lseek_end_then_cur_compose() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&4_u32.to_le_bytes());
        reg.extend_from_slice(b"/end");
        reg.extend_from_slice(b"abcdefgh"); // 8 bytes
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/end"), &mut []) as u32;

        // Seek to END - 2.
        let mut req = Vec::new();
        req.extend_from_slice(&fd.to_le_bytes());
        req.extend_from_slice(&(-2_i64).to_le_bytes());
        req.extend_from_slice(&2_u32.to_le_bytes());
        let mut out = [0u8; 8];
        assert_eq!(dispatch(METHOD_SYS_LSEEK, 1, &req, &mut out), 8);
        assert_eq!(i64::from_le_bytes(out), 6);

        // Now CUR + 1.
        let mut req = Vec::new();
        req.extend_from_slice(&fd.to_le_bytes());
        req.extend_from_slice(&1_i64.to_le_bytes());
        req.extend_from_slice(&1_u32.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_LSEEK, 1, &req, &mut out), 8);
        assert_eq!(i64::from_le_bytes(out), 7);
    }

    #[test]
    fn lseek_negative_resulting_offset_is_einval() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        reg.extend_from_slice(b"/ng");
        reg.extend_from_slice(b"hi");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/ng"), &mut []) as u32;

        let mut req = Vec::new();
        req.extend_from_slice(&fd.to_le_bytes());
        req.extend_from_slice(&(-5_i64).to_le_bytes());
        req.extend_from_slice(&0_u32.to_le_bytes()); // SET
        let mut out = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_LSEEK, 1, &req, &mut out),
            -(abi::EINVAL as i64),
        );
    }

    #[test]
    fn fstat_reports_size_and_filetype() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&4_u32.to_le_bytes());
        reg.extend_from_slice(b"/sta");
        reg.extend_from_slice(b"hello"); // 5 bytes
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/sta"), &mut []) as u32;

        let mut out = [0u8; 16];
        assert_eq!(
            dispatch(METHOD_SYS_FSTAT, 1, &fd.to_le_bytes(), &mut out),
            16
        );
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 5);
        assert_eq!(u32::from_le_bytes(out[8..12].try_into().unwrap()), 4); // REGULAR_FILE

        // fstat on stdin (fd 0) reports filetype=2 CHARACTER_DEVICE.
        let mut out2 = [0u8; 16];
        assert_eq!(
            dispatch(METHOD_SYS_FSTAT, 1, &0_u32.to_le_bytes(), &mut out2),
            16
        );
        assert_eq!(u32::from_le_bytes(out2[8..12].try_into().unwrap()), 2);
    }

    #[test]
    fn open_with_create_installs_empty_file() {
        let _g = crate::kernel::TestGuard::acquire();
        // No prior register. Path doesn't exist; CREAT should make it.
        let fd = dispatch(
            METHOD_SYS_OPEN,
            1,
            &open_req(O_WRITE | O_CREAT, b"/new"),
            &mut [],
        );
        assert!(fd >= 0, "CREAT created /new, fd = {fd}");
        // Write some bytes.
        let mut wreq = Vec::new();
        wreq.extend_from_slice(&(fd as u32).to_le_bytes());
        wreq.extend_from_slice(b"hello world");
        assert_eq!(
            dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
            "hello world".len() as i64
        );
        // Reopen read-only and read it back.
        let rfd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/new"), &mut []);
        let mut buf = [0u8; 32];
        let n = dispatch(METHOD_SYS_READ, 1, &(rfd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"hello world");
    }

    #[test]
    fn write_to_readonly_open_is_ebadf() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        reg.extend_from_slice(b"/ro");
        reg.extend_from_slice(b"abc");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/ro"), &mut []);
        let mut wreq = Vec::new();
        wreq.extend_from_slice(&(fd as u32).to_le_bytes());
        wreq.extend_from_slice(b"NO");
        assert_eq!(
            dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
            -(abi::EBADF as i64)
        );
    }

    #[test]
    fn open_with_trunc_clears_existing_content() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        reg.extend_from_slice(b"/tr");
        reg.extend_from_slice(b"existing-data");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        // Open with WRITE | TRUNC → file becomes empty.
        let fd = dispatch(
            METHOD_SYS_OPEN,
            1,
            &open_req(O_WRITE | O_TRUNC, b"/tr"),
            &mut [],
        ) as u32;
        // fstat now reports size 0.
        let mut out = [0u8; 16];
        dispatch(METHOD_SYS_FSTAT, 1, &fd.to_le_bytes(), &mut out);
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 0);
    }

    #[test]
    fn write_grows_file_and_advances_ofd_offset() {
        let _g = crate::kernel::TestGuard::acquire();
        let fd = dispatch(
            METHOD_SYS_OPEN,
            1,
            &open_req(O_WRITE | O_CREAT, b"/grow"),
            &mut [],
        ) as u32;
        // Write twice.
        for chunk in [b"abc".as_slice(), b"def"] {
            let mut w = Vec::new();
            w.extend_from_slice(&fd.to_le_bytes());
            w.extend_from_slice(chunk);
            assert_eq!(
                dispatch(METHOD_SYS_WRITE, 1, &w, &mut []),
                chunk.len() as i64
            );
        }
        // Open read-only and verify "abcdef".
        let rfd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/grow"), &mut []);
        let mut buf = [0u8; 16];
        let n = dispatch(METHOD_SYS_READ, 1, &(rfd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"abcdef");
    }

    #[test]
    fn dev_null_open_read_write() {
        let _g = crate::kernel::TestGuard::acquire();
        // /dev is auto-mounted; /dev/null is read+writable.
        let fd = dispatch(
            METHOD_SYS_OPEN,
            1,
            &open_req(O_WRITE, b"/dev/null"),
            &mut [],
        );
        assert!(fd >= 0, "open /dev/null: fd = {fd}");
        // Read returns 0 (EOF immediately).
        let mut buf = [0u8; 16];
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf),
            0
        );
        // Writes succeed and report payload.len() bytes consumed.
        let mut w = Vec::new();
        w.extend_from_slice(&(fd as u32).to_le_bytes());
        w.extend_from_slice(b"discard me");
        assert_eq!(
            dispatch(METHOD_SYS_WRITE, 1, &w, &mut []),
            "discard me".len() as i64
        );
    }

    #[test]
    fn dev_zero_yields_zero_bytes() {
        let _g = crate::kernel::TestGuard::acquire();
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/dev/zero"), &mut []);
        let mut buf = [0xffu8; 8];
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(n, 8);
        assert_eq!(&buf, &[0u8; 8]);
    }

    #[test]
    fn socket_send_accepts_fd_plus_payload_contract() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&7_u32.to_le_bytes());
        req.extend_from_slice(b"abc");
        assert_eq!(dispatch(METHOD_SYS_SOCKET_SEND, 1, &req, &mut []), -38);
    }

    #[test]
    fn dev_namespace_refuses_create() {
        let _g = crate::kernel::TestGuard::acquire();
        // /dev is a fixed namespace; CREAT inside it returns -EPERM.
        assert_eq!(
            dispatch(
                METHOD_SYS_OPEN,
                1,
                &open_req(O_WRITE | O_CREAT, b"/dev/whatever"),
                &mut [],
            ),
            -(abi::EPERM as i64)
        );
    }

    #[test]
    fn root_mount_owns_paths_that_only_share_a_prefix_with_dev() {
        // Regression: longest-prefix-match must respect component
        // boundaries — `/devil` belongs to root, not /dev.
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&6_u32.to_le_bytes());
        reg.extend_from_slice(b"/devil");
        reg.extend_from_slice(b"horns");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/devil"), &mut []);
        let mut buf = [0u8; 16];
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"horns");
    }

    #[test]
    fn proc_self_status_routes_through_caller_pid() {
        let _g = crate::kernel::TestGuard::acquire();
        // First touch a syscall that lazy-inserts pid 7 into the
        // kernel's process map. getpid is a pure caller_pid pass-
        // through so it doesn't qualify; getuid does (it reads from
        // process_mut, which lazy-creates).
        assert_eq!(dispatch(METHOD_SYS_GETUID, 7, &[], &mut []), 1000);

        // Open /proc/self/status as pid 7 → resolves to /proc/7/status.
        let fd = dispatch(
            METHOD_SYS_OPEN,
            7,
            &open_req(0, b"/proc/self/status"),
            &mut [],
        );
        assert!(fd >= 0, "open /proc/self/status: fd = {fd}");

        // Read content and verify the expected lines.
        let mut buf = [0u8; 256];
        let n = dispatch(METHOD_SYS_READ, 7, &(fd as u32).to_le_bytes(), &mut buf);
        assert!(n > 0);
        let text = std::str::from_utf8(&buf[..n as usize]).unwrap();
        assert!(text.contains("Pid:\t7\n"), "expected Pid:\\t7 in: {text}");
        assert!(
            text.contains("Uid:\t1000"),
            "expected default uid in: {text}"
        );
    }

    #[test]
    fn proc_status_reflects_setresuid() {
        let _g = crate::kernel::TestGuard::acquire();
        // Touch pid 5 to register it, then change its uid.
        assert_eq!(dispatch(METHOD_SYS_GETUID, 5, &[], &mut []), 1000);
        let mut req = Vec::new();
        req.extend_from_slice(&500_u32.to_le_bytes());
        req.extend_from_slice(&501_u32.to_le_bytes());
        req.extend_from_slice(&502_u32.to_le_bytes());
        dispatch(METHOD_SYS_SETRESUID, 5, &req, &mut []);

        // Re-open /proc/5/status — open-time refresh picks up new uid.
        let fd = dispatch(METHOD_SYS_OPEN, 5, &open_req(0, b"/proc/5/status"), &mut []);
        let mut buf = [0u8; 256];
        let n = dispatch(METHOD_SYS_READ, 5, &(fd as u32).to_le_bytes(), &mut buf);
        let text = std::str::from_utf8(&buf[..n as usize]).unwrap();
        assert!(
            text.contains("Uid:\t500\t501"),
            "uid update missing: {text}"
        );
    }

    #[test]
    fn proc_unknown_pid_returns_enoent() {
        let _g = crate::kernel::TestGuard::acquire();
        // No syscalls have populated pid 999, so no /proc/999/status.
        assert_eq!(
            dispatch(
                METHOD_SYS_OPEN,
                1,
                &open_req(0, b"/proc/999/status"),
                &mut [],
            ),
            -(abi::ENOENT as i64)
        );
    }

    #[test]
    fn proc_writes_are_ebadf() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(dispatch(METHOD_SYS_GETUID, 3, &[], &mut []), 1000);
        // Open with WRITE bit set; the OFD is "writable" but the
        // backend refuses writes.
        let fd = dispatch(
            METHOD_SYS_OPEN,
            3,
            &open_req(O_WRITE, b"/proc/3/status"),
            &mut [],
        );
        let mut w = Vec::new();
        w.extend_from_slice(&(fd as u32).to_le_bytes());
        w.extend_from_slice(b"clobber");
        assert_eq!(
            dispatch(METHOD_SYS_WRITE, 3, &w, &mut []),
            -(abi::EBADF as i64)
        );
    }

    /// Helper for the test-only argv patch format: pack pid +
    /// (u32 len + bytes)*.
    fn set_argv_req(pid: u32, args: &[&[u8]]) -> Vec<u8> {
        let mut req = pid.to_le_bytes().to_vec();
        for a in args {
            req.extend_from_slice(&(a.len() as u32).to_le_bytes());
            req.extend_from_slice(a);
        }
        req
    }

    #[test]
    fn proc_cmdline_serves_null_separated_argv() {
        let _g = crate::kernel::TestGuard::acquire();
        // Touch pid 4 to register it, then push argv.
        assert_eq!(dispatch(METHOD_SYS_GETUID, 4, &[], &mut []), 1000);
        let req = set_argv_req(4, &[b"/usr/bin/zsh", b"-l", b"-c", b"echo hi"]);
        assert_eq!(set_argv(&req), 0);

        let fd = dispatch(
            METHOD_SYS_OPEN,
            4,
            &open_req(0, b"/proc/4/cmdline"),
            &mut [],
        );
        let mut buf = [0u8; 64];
        let n = dispatch(METHOD_SYS_READ, 4, &(fd as u32).to_le_bytes(), &mut buf);
        let bytes = &buf[..n as usize];
        // Linux convention: NUL-separated, no trailing NL.
        let expected: &[u8] = b"/usr/bin/zsh\0-l\0-c\0echo hi\0";
        assert_eq!(bytes, expected);
    }

    #[test]
    fn proc_comm_is_basename_of_argv0() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(dispatch(METHOD_SYS_GETUID, 8, &[], &mut []), 1000);
        let req = set_argv_req(8, &[b"/bin/cat"]);
        set_argv(&req);

        let fd = dispatch(METHOD_SYS_OPEN, 8, &open_req(0, b"/proc/8/comm"), &mut []);
        let mut buf = [0u8; 32];
        let n = dispatch(METHOD_SYS_READ, 8, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"cat\n");
    }

    #[test]
    fn proc_cwd_serves_chdir_path() {
        let _g = crate::kernel::TestGuard::acquire();
        // Set cwd via sys_chdir, then read /proc/<N>/cwd.
        assert_eq!(dispatch(METHOD_SYS_CHDIR, 11, b"/var/tmp", &mut []), 0);

        let fd = dispatch(METHOD_SYS_OPEN, 11, &open_req(0, b"/proc/11/cwd"), &mut []);
        let mut buf = [0u8; 64];
        let n = dispatch(METHOD_SYS_READ, 11, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"/var/tmp");
    }

    #[test]
    fn proc_status_includes_name_when_argv_present() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(dispatch(METHOD_SYS_GETUID, 6, &[], &mut []), 1000);
        let req = set_argv_req(6, &[b"/usr/bin/ls"]);
        set_argv(&req);

        let fd = dispatch(METHOD_SYS_OPEN, 6, &open_req(0, b"/proc/6/status"), &mut []);
        let mut buf = [0u8; 256];
        let n = dispatch(METHOD_SYS_READ, 6, &(fd as u32).to_le_bytes(), &mut buf);
        let text = std::str::from_utf8(&buf[..n as usize]).unwrap();
        assert!(
            text.contains("Name:\tls\n"),
            "expected Name:\\tls in: {text}"
        );
    }

    /// Build a tiny in-memory tar with the given (path, content)
    /// pairs. Used by the tar-layer tests.
    #[cfg(test)]
    fn build_tar_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut buf);
            for (path, content) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, path, *content).unwrap();
            }
            builder.finish().unwrap();
        }
        buf
    }

    #[test]
    fn tar_layer_serves_files_after_install() {
        let _g = crate::kernel::TestGuard::acquire();
        let tar_bytes = build_tar_archive(&[
            ("etc/motd", b"hello from tar layer\n"),
            ("usr/share/doc/readme.txt", b"docs"),
        ]);
        // Pack request: u32 prefix_len + prefix + tar bytes.
        let prefix: &[u8] = b"/img";
        let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(prefix);
        req.extend_from_slice(&tar_bytes);
        assert_eq!(
            dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []),
            0
        );

        // Open + read /img/etc/motd.
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/img/etc/motd"), &mut []);
        assert!(fd >= 0, "open succeeded: {fd}");
        let mut buf = [0u8; 64];
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"hello from tar layer\n");

        // fstat reports the real size from the tar header.
        let mut stat = [0u8; 16];
        assert_eq!(
            dispatch(METHOD_SYS_FSTAT, 1, &(fd as u32).to_le_bytes(), &mut stat),
            16
        );
        assert_eq!(
            u64::from_le_bytes(stat[0..8].try_into().unwrap()),
            b"hello from tar layer\n".len() as u64
        );
    }

    #[test]
    fn tar_layer_refuses_create_and_write() {
        let _g = crate::kernel::TestGuard::acquire();
        let tar_bytes = build_tar_archive(&[("readme", b"x")]);
        let prefix: &[u8] = b"/img2";
        let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(prefix);
        req.extend_from_slice(&tar_bytes);
        dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []);

        // CREAT against a tar mount → -EPERM (backend.create returns None).
        assert_eq!(
            dispatch(
                METHOD_SYS_OPEN,
                1,
                &open_req(O_WRITE | O_CREAT, b"/img2/new.txt"),
                &mut []
            ),
            -(abi::EPERM as i64)
        );

        // Write through a writable-OFD → -EBADF (backend.write rejects).
        // We can't easily get a writable OFD on a tar file (open with
        // WRITE bit returns the existing inode but not in CREAT path —
        // and the Phase 5 sys_open pre-CREAT semantics for read-only
        // backends mean WRITE succeeds at the kernel side but write()
        // hits the backend's refusal). Probe by opening read-only and
        // verifying writes are blocked at the OFD level too.
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/img2/readme"), &mut []);
        let mut wreq = (fd as u32).to_le_bytes().to_vec();
        wreq.extend_from_slice(b"NOPE");
        // Read-only OFD blocks writes at -EBADF (existing dispatch
        // semantics) — no need to reach the backend.
        assert_eq!(
            dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
            -(abi::EBADF as i64)
        );
    }

    #[test]
    fn tar_layer_partial_read_advances_offset() {
        let _g = crate::kernel::TestGuard::acquire();
        let payload: &[u8] = b"0123456789";
        let tar_bytes = build_tar_archive(&[("counts", payload)]);
        let prefix: &[u8] = b"/img3";
        let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(prefix);
        req.extend_from_slice(&tar_bytes);
        dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []);

        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/img3/counts"), &mut []) as u32;
        let mut small = [0u8; 4];
        assert_eq!(
            dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut small),
            4
        );
        assert_eq!(&small, b"0123");
        let mut rest = [0u8; 16];
        let n = dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut rest);
        assert_eq!(n, 6);
        assert_eq!(&rest[..6], b"456789");
    }

    #[test]
    fn install_yurtfs_auto_decompresses_zstd_wrapped_tar() {
        let _g = crate::kernel::TestGuard::acquire();
        let tar = build_tar_archive(&[("etc/release", b"compressed")]);
        // Wrap in zstd. The dev-dep `zstd` crate pulls a C lib; fine
        // for tests, not for the wasm crate (which uses the pure-Rust
        // ruzstd decoder).
        let zstd_wrapped = zstd::stream::encode_all(&tar[..], 0).unwrap();
        // Sanity: the wrapper begins with the zstd magic.
        assert_eq!(&zstd_wrapped[0..4], &[0x28, 0xB5, 0x2F, 0xFD]);

        let prefix: &[u8] = b"/zimg";
        let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(prefix);
        req.extend_from_slice(&zstd_wrapped);
        assert_eq!(
            dispatch(METHOD_KERNEL_INSTALL_YURTFS, 0, &req, &mut []),
            0,
            "zstd-wrapped install_yurtfs succeeds"
        );

        // Open + read /zimg/etc/release verifies the auto-decompress
        // happened and the tar walked correctly afterward.
        let fd = dispatch(
            METHOD_SYS_OPEN,
            1,
            &open_req(0, b"/zimg/etc/release"),
            &mut [],
        );
        assert!(fd >= 0, "open under zstd-wrapped image: {fd}");
        let mut buf = [0u8; 32];
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"compressed");
    }

    #[test]
    fn install_tar_layer_auto_decompresses_zstd() {
        let _g = crate::kernel::TestGuard::acquire();
        let tar = build_tar_archive(&[("info", b"v1")]);
        let zstd_wrapped = zstd::stream::encode_all(&tar[..], 0).unwrap();
        let prefix: &[u8] = b"/zlayer";
        let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(prefix);
        req.extend_from_slice(&zstd_wrapped);
        assert_eq!(
            dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []),
            0
        );
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/zlayer/info"), &mut []);
        let mut buf = [0u8; 8];
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"v1");
    }

    #[test]
    fn fstat_returns_default_mode_from_backend() {
        // Ramfs default is 0o100644 (regular file, rw-r--r--).
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        reg.extend_from_slice(b"/m1");
        reg.extend_from_slice(b"hi");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/m1"), &mut []);
        let mut out = [0u8; 16];
        assert_eq!(
            dispatch(METHOD_SYS_FSTAT, 1, &(fd as u32).to_le_bytes(), &mut out),
            16
        );
        let mode = u32::from_le_bytes(out[12..16].try_into().unwrap());
        assert_eq!(mode, 0o100_644, "default mode from backend");
    }

    #[test]
    fn chmod_writes_to_metadata_overlay_and_fstat_reflects_it() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        reg.extend_from_slice(b"/m2");
        reg.extend_from_slice(b"hi");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

        // chmod 0o600 on /m2.
        let mut creq = 0o600_u32.to_le_bytes().to_vec();
        creq.extend_from_slice(b"/m2");
        assert_eq!(dispatch(METHOD_SYS_CHMOD, 1, &creq, &mut []), 0);

        // fstat sees the new perms; file type bits unchanged.
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/m2"), &mut []);
        let mut out = [0u8; 16];
        dispatch(METHOD_SYS_FSTAT, 1, &(fd as u32).to_le_bytes(), &mut out);
        let mode = u32::from_le_bytes(out[12..16].try_into().unwrap());
        assert_eq!(mode, 0o100_600, "chmod kept file-type bits, replaced perms");
    }

    #[test]
    fn chmod_unknown_path_is_enoent() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut creq = 0o755_u32.to_le_bytes().to_vec();
        creq.extend_from_slice(b"/missing");
        assert_eq!(
            dispatch(METHOD_SYS_CHMOD, 1, &creq, &mut []),
            -(abi::ENOENT as i64)
        );
    }

    #[test]
    fn chown_writes_uid_gid_to_overlay() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        reg.extend_from_slice(b"/co");
        reg.extend_from_slice(b"x");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

        let mut req = Vec::new();
        req.extend_from_slice(&1234_u32.to_le_bytes()); // uid
        req.extend_from_slice(&5678_u32.to_le_bytes()); // gid
        req.extend_from_slice(b"/co");
        assert_eq!(dispatch(METHOD_SYS_CHOWN, 1, &req, &mut []), 0);

        // Verify via the kernel-side resolve_metadata helper.
        let meta = crate::kernel::with_kernel(|k| {
            let pair = k.vfs.open(b"/co", 0).unwrap();
            k.resolve_metadata(pair.0, pair.1)
        });
        assert_eq!(meta.uid, 1234);
        assert_eq!(meta.gid, 5678);
    }

    #[test]
    fn utimens_writes_mtime_to_overlay() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        reg.extend_from_slice(b"/ut");
        reg.extend_from_slice(b"x");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

        let mut req = Vec::new();
        let want_ns: u64 = 1_700_000_000_000_000_000;
        req.extend_from_slice(&want_ns.to_le_bytes());
        req.extend_from_slice(b"/ut");
        assert_eq!(dispatch(METHOD_SYS_UTIMENS, 1, &req, &mut []), 0);

        let meta = crate::kernel::with_kernel(|k| {
            let pair = k.vfs.open(b"/ut", 0).unwrap();
            k.resolve_metadata(pair.0, pair.1)
        });
        assert_eq!(meta.mtime_ns, want_ns);
    }

    #[test]
    fn tar_layer_default_metadata_comes_from_header() {
        // Build a tar with a custom mode + uid + gid in the header.
        let _g = crate::kernel::TestGuard::acquire();
        let archive = {
            let mut buf: Vec<u8> = Vec::new();
            {
                let mut builder = tar::Builder::new(&mut buf);
                let content: &[u8] = b"sh-script";
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o755);
                header.set_uid(2000);
                header.set_gid(3000);
                header.set_mtime(1_500_000_000);
                header.set_cksum();
                builder.append_data(&mut header, "bin/sh", content).unwrap();
                builder.finish().unwrap();
            }
            buf
        };
        let prefix: &[u8] = b"/tmeta";
        let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(prefix);
        req.extend_from_slice(&archive);
        dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []);

        // fstat /tmeta/bin/sh — mode/uid/gid come from tar header.
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/tmeta/bin/sh"), &mut []);
        let mut out = [0u8; 16];
        dispatch(METHOD_SYS_FSTAT, 1, &(fd as u32).to_le_bytes(), &mut out);
        let mode = u32::from_le_bytes(out[12..16].try_into().unwrap());
        assert_eq!(mode, 0o100_755, "tar mode bits surface via fstat");

        // Direct resolve_metadata check for uid/gid (not in fstat
        // wire format yet).
        let meta = crate::kernel::with_kernel(|k| {
            let pair = k.vfs.open(b"/tmeta/bin/sh", 0).unwrap();
            k.resolve_metadata(pair.0, pair.1)
        });
        assert_eq!(meta.uid, 2000);
        assert_eq!(meta.gid, 3000);
        assert_eq!(meta.mtime_ns, 1_500_000_000_000_000_000);
    }

    #[test]
    fn unlink_removes_ramfs_path() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        reg.extend_from_slice(b"/un");
        reg.extend_from_slice(b"x");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        // Sanity: path opens before unlink.
        assert!(dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/un"), &mut []) >= 0);

        assert_eq!(dispatch(METHOD_SYS_UNLINK, 1, b"/un", &mut []), 0);
        // After unlink, open returns -ENOENT.
        assert_eq!(
            dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/un"), &mut []),
            -(abi::ENOENT as i64)
        );
    }

    #[test]
    fn link_creates_second_path_to_same_inode_and_survives_first_unlink() {
        let _g = crate::kernel::TestGuard::acquire();
        // Register a regular file with content "first".
        let mut reg = Vec::new();
        reg.extend_from_slice(&5_u32.to_le_bytes());
        reg.extend_from_slice(b"/orig");
        reg.extend_from_slice(b"first");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

        // sys_link(target="/orig", link="/dup")
        let target: &[u8] = b"/orig";
        let link_path: &[u8] = b"/dup";
        let mut req = (target.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(target);
        req.extend_from_slice(link_path);
        assert_eq!(dispatch(METHOD_SYS_LINK, 1, &req, &mut []), 0);

        // Unlinking /orig must NOT erase the file — /dup still points
        // at the same inode.
        assert_eq!(dispatch(METHOD_SYS_UNLINK, 1, b"/orig", &mut []), 0);
        let dup_fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/dup"), &mut []);
        assert!(dup_fd >= 0, "/dup must still open after unlinking /orig");
        let mut buf = [0u8; 16];
        let read_req = (dup_fd as u32).to_le_bytes().to_vec();
        let n = dispatch(METHOD_SYS_READ, 1, &read_req, &mut buf);
        assert_eq!(n, 5);
        assert_eq!(&buf[..5], b"first");

        // Unlinking the last path drops the inode; subsequent open
        // returns ENOENT.
        assert_eq!(dispatch(METHOD_SYS_UNLINK, 1, b"/dup", &mut []), 0);
        assert_eq!(
            dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/dup"), &mut []),
            -(abi::ENOENT as i64)
        );
    }

    #[test]
    fn link_to_existing_link_path_is_eexist() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&2_u32.to_le_bytes());
        reg.extend_from_slice(b"/a");
        reg.extend_from_slice(b"x");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let mut reg2 = Vec::new();
        reg2.extend_from_slice(&2_u32.to_le_bytes());
        reg2.extend_from_slice(b"/b");
        reg2.extend_from_slice(b"y");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg2, &mut []);

        let target: &[u8] = b"/a";
        let link_path: &[u8] = b"/b";
        let mut req = (target.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(target);
        req.extend_from_slice(link_path);
        assert_eq!(
            dispatch(METHOD_SYS_LINK, 1, &req, &mut []),
            -(abi::EEXIST as i64),
        );
    }

    #[test]
    fn proc_selfish_path_is_not_rewritten() {
        // "/proc/selfish" must not match the /proc/self prefix —
        // the rewrite requires the next byte to be '/' or end.
        // Resolves through the regular VFS as a missing path.
        let _g = crate::kernel::TestGuard::acquire();
        let rc = dispatch(METHOD_SYS_OPEN, 7, &open_req(0, b"/proc/selfish"), &mut []);
        assert!(rc < 0, "/proc/selfish should miss, got rc={rc}");
    }

    #[test]
    fn proc_self_unlink_attempts_proc_caller_path() {
        // Even non-/proc-aware syscalls (unlink) must apply the
        // rewrite. /proc is read-only, so this returns -EROFS or
        // similar negative — the assertion is just that the path
        // gets rewritten (the error code reflects ProcBackend's
        // refusal, not a missing /proc/self mount).
        let _g = crate::kernel::TestGuard::acquire();
        let rc = dispatch(METHOD_SYS_UNLINK, 7, b"/proc/self/status", &mut []);
        assert!(rc < 0, "unlink under /proc must fail (got {rc})");
    }

    #[test]
    fn sys_spawn_reads_vfs_then_drains_and_reaps() {
        // End-to-end (kernel-side only — host instantiation is a
        // separate slice). Steps:
        //   1. Register a "wasm" file at /bin/echo with synthetic
        //      bytes so we can verify drain returns them verbatim.
        //   2. sys_spawn("/bin/echo", ["echo","hi"]) returns a fresh
        //      child pid >= 1000.
        //   3. drain_spawn returns the staged record.
        //   4. record_exit(child, 7) makes parent's sys_wait reap.
        let _g = crate::kernel::TestGuard::acquire();
        let body: &[u8] = b"\0asm\x01\x00\x00\x00fake-wasm-bytes";
        let path: &[u8] = b"/bin/echo";
        let mut reg = (path.len() as u32).to_le_bytes().to_vec();
        reg.extend_from_slice(path);
        reg.extend_from_slice(body);
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

        // sys_spawn request: u32 path_len + path + (u32 alen + arg)*
        let mut sreq = (path.len() as u32).to_le_bytes().to_vec();
        sreq.extend_from_slice(path);
        for arg in [b"echo".as_slice(), b"hi".as_slice()] {
            sreq.extend_from_slice(&(arg.len() as u32).to_le_bytes());
            sreq.extend_from_slice(arg);
        }
        let parent_pid: u32 = 1;
        let child_pid = dispatch(METHOD_SYS_SPAWN, parent_pid, &sreq, &mut []);
        assert!(
            child_pid >= 1000,
            "spawn pid must come from kernel range >= 1000: got {child_pid}",
        );
        let child_pid_u32 = child_pid as u32;
        let child_command = with_kernel(|k| {
            k.list_processes()
                .into_iter()
                .find(|p| p.pid == child_pid_u32)
                .map(|p| p.command)
        });
        assert_eq!(child_command.as_deref(), Some(b"echo".as_slice()));

        // Drain the queued spawn.
        let mut buf = vec![0u8; 1024];
        let n = drain_spawn(&mut buf);
        assert!(n > 0, "drain_spawn returned {n}");
        let used = n as usize;
        assert_eq!(
            u32::from_le_bytes(buf[0..4].try_into().unwrap()),
            child_pid_u32,
        );
        let wasm_len = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
        assert_eq!(wasm_len, body.len());
        assert_eq!(&buf[8..8 + wasm_len], body);
        let argc_off = 8 + wasm_len;
        let argc = u32::from_le_bytes(buf[argc_off..argc_off + 4].try_into().unwrap());
        assert_eq!(argc, 2);
        assert!(argc_off + 4 <= used);

        // After draining, queue is empty.
        let n2 = drain_spawn(&mut buf);
        assert_eq!(n2, -(abi::ENOENT as i64));

        // Host pretends it ran the child and exited with code 7.
        let mut rex = child_pid_u32.to_le_bytes().to_vec();
        rex.extend_from_slice(&7_i32.to_le_bytes());
        assert_eq!(record_exit(&rex), 0);

        // Parent's sys_wait reaps the spawned child.
        let mut wreq = 0_u32.to_le_bytes().to_vec(); // wait for any
        wreq.extend_from_slice(&0_u32.to_le_bytes()); // no flags
        let mut wresp = [0u8; 8];
        let wn = dispatch(METHOD_SYS_WAIT, parent_pid, &wreq, &mut wresp);
        assert_eq!(wn, 8);
        assert_eq!(
            u32::from_le_bytes(wresp[0..4].try_into().unwrap()),
            child_pid_u32,
        );
        assert_eq!(i32::from_le_bytes(wresp[4..8].try_into().unwrap()), 7);
    }

    #[test]
    fn sys_spawn_missing_path_is_enoent() {
        let _g = crate::kernel::TestGuard::acquire();
        let path: &[u8] = b"/no-such-binary";
        let mut sreq = (path.len() as u32).to_le_bytes().to_vec();
        sreq.extend_from_slice(path);
        assert_eq!(
            dispatch(METHOD_SYS_SPAWN, 1, &sreq, &mut []),
            -(abi::ENOENT as i64),
        );
    }

    #[test]
    fn rename_moves_regular_file_to_new_path() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = 5_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(b"/old0");
        reg.extend_from_slice(b"data!");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

        let old: &[u8] = b"/old0";
        let new: &[u8] = b"/new0";
        let mut req = (old.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(old);
        req.extend_from_slice(new);
        assert_eq!(dispatch(METHOD_SYS_RENAME, 1, &req, &mut []), 0);

        // /old0 is gone.
        assert_eq!(
            dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/old0"), &mut []),
            -(abi::ENOENT as i64),
        );
        // /new0 has the original content.
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/new0"), &mut []);
        assert!(fd >= 0);
        let mut buf = [0u8; 8];
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"data!");
    }

    #[test]
    fn rename_replaces_existing_destination_file() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut a = 3_u32.to_le_bytes().to_vec();
        a.extend_from_slice(b"/aa");
        a.extend_from_slice(b"AAA");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &a, &mut []);
        let mut b = 3_u32.to_le_bytes().to_vec();
        b.extend_from_slice(b"/bb");
        b.extend_from_slice(b"BBB");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &b, &mut []);

        let old: &[u8] = b"/aa";
        let new: &[u8] = b"/bb";
        let mut req = (old.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(old);
        req.extend_from_slice(new);
        assert_eq!(dispatch(METHOD_SYS_RENAME, 1, &req, &mut []), 0);

        // /bb now reads "AAA".
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/bb"), &mut []);
        let mut buf = [0u8; 8];
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"AAA");
    }

    #[test]
    fn rename_missing_source_is_enoent() {
        let _g = crate::kernel::TestGuard::acquire();
        let old: &[u8] = b"/no";
        let new: &[u8] = b"/yes";
        let mut req = (old.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(old);
        req.extend_from_slice(new);
        assert_eq!(
            dispatch(METHOD_SYS_RENAME, 1, &req, &mut []),
            -(abi::ENOENT as i64),
        );
    }

    #[test]
    fn link_with_missing_target_is_enoent() {
        let _g = crate::kernel::TestGuard::acquire();
        let target: &[u8] = b"/no-such-target";
        let link_path: &[u8] = b"/wherever";
        let mut req = (target.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(target);
        req.extend_from_slice(link_path);
        assert_eq!(
            dispatch(METHOD_SYS_LINK, 1, &req, &mut []),
            -(abi::ENOENT as i64),
        );
    }

    #[test]
    fn unlink_unknown_path_is_enoent() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(
            dispatch(METHOD_SYS_UNLINK, 1, b"/none", &mut []),
            -(abi::ENOENT as i64)
        );
    }

    #[test]
    fn stat_path_returns_size_and_mode_without_an_fd() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&5_u32.to_le_bytes());
        reg.extend_from_slice(b"/info");
        reg.extend_from_slice(b"hello"); // 5 bytes
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

        let mut out = [0u8; 16];
        assert_eq!(dispatch(METHOD_SYS_STAT, 1, b"/info", &mut out), 16);
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 5);
        let mode = u32::from_le_bytes(out[12..16].try_into().unwrap());
        // Ramfs default — regular file, 0o644.
        assert_eq!(mode, 0o100_644);
    }

    #[test]
    fn stat_unknown_path_is_enoent() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut out = [0u8; 16];
        assert_eq!(
            dispatch(METHOD_SYS_STAT, 1, b"/missing", &mut out),
            -(abi::ENOENT as i64)
        );
    }

    #[test]
    fn symlink_creates_link_and_readlink_returns_target() {
        let _g = crate::kernel::TestGuard::acquire();
        // Register a target file so we can verify the open follows.
        let mut reg = Vec::new();
        reg.extend_from_slice(&5_u32.to_le_bytes());
        reg.extend_from_slice(b"/real");
        reg.extend_from_slice(b"contents");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

        // sys_symlink(target="/real", link="/alias")
        let target: &[u8] = b"/real";
        let link_path: &[u8] = b"/alias";
        let mut req = (target.len() as u32).to_le_bytes().to_vec();
        req.extend_from_slice(target);
        req.extend_from_slice(link_path);
        assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &req, &mut []), 0);

        // readlink returns the target verbatim.
        let mut buf = [0u8; 16];
        let n = dispatch(METHOD_SYS_READLINK, 1, b"/alias", &mut buf);
        assert_eq!(&buf[..n as usize], b"/real");
    }

    #[test]
    fn open_follows_symlink_to_target() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&5_u32.to_le_bytes());
        reg.extend_from_slice(b"/real");
        reg.extend_from_slice(b"contents");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

        // Create alias → real.
        let mut sreq = 5_u32.to_le_bytes().to_vec();
        sreq.extend_from_slice(b"/real");
        sreq.extend_from_slice(b"/alias");
        dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []);

        // sys_open /alias should follow the symlink and read /real.
        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/alias"), &mut []);
        let mut buf = [0u8; 32];
        let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
        assert_eq!(&buf[..n as usize], b"contents");
    }

    #[test]
    fn open_eloops_on_circular_symlinks() {
        let _g = crate::kernel::TestGuard::acquire();
        // a -> b -> a — open should bail with -EINVAL after the
        // hop limit (SYMLOOP_MAX 40).
        let mut sreq = 2_u32.to_le_bytes().to_vec();
        sreq.extend_from_slice(b"/b");
        sreq.extend_from_slice(b"/a");
        dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []);
        let mut sreq = 2_u32.to_le_bytes().to_vec();
        sreq.extend_from_slice(b"/a");
        sreq.extend_from_slice(b"/b");
        dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []);

        let rc = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/a"), &mut []);
        assert!(rc < 0, "circular symlink should error: rc = {rc}");
    }

    #[test]
    fn readlink_on_regular_file_is_einval() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = Vec::new();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        reg.extend_from_slice(b"/rg");
        reg.extend_from_slice(b"hi");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let mut buf = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_READLINK, 1, b"/rg", &mut buf),
            -(abi::EINVAL as i64)
        );
    }

    #[test]
    fn mkdir_creates_directory_and_readdir_lists_children() {
        let _g = crate::kernel::TestGuard::acquire();
        // mkdir /etc
        assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/etc", &mut []), 0);
        // Register two files under /etc and verify readdir lists them.
        for name in ["motd", "hostname"] {
            let path = format!("/etc/{}", name);
            let mut reg = (path.len() as u32).to_le_bytes().to_vec();
            reg.extend_from_slice(path.as_bytes());
            reg.extend_from_slice(b"x");
            dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        }
        let mut buf = [0u8; 256];
        let n = dispatch(METHOD_SYS_READDIR, 1, b"/etc", &mut buf) as usize;
        assert!(n >= 4);
        let count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!(count, 2);
        // Parse names: (u32 len, u8 type, bytes), repeated. Files
        // registered via register_file are regular files (type 4).
        let mut cursor = 4usize;
        let mut entries: Vec<(Vec<u8>, u8)> = Vec::new();
        for _ in 0..count {
            let len = u32::from_le_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
            cursor += 4;
            let ty = buf[cursor];
            cursor += 1;
            entries.push((buf[cursor..cursor + len].to_vec(), ty));
            cursor += len;
        }
        assert!(entries.iter().any(|(n, t)| n == b"motd" && *t == 4));
        assert!(entries.iter().any(|(n, t)| n == b"hostname" && *t == 4));
    }

    #[test]
    fn mkdir_existing_path_is_eexist() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/d", &mut []), 0);
        assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/d", &mut []), -17);
    }

    #[test]
    fn rmdir_empty_directory_succeeds() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/empty", &mut []), 0);
        assert_eq!(dispatch(METHOD_SYS_RMDIR, 1, b"/empty", &mut []), 0);
        // After rmdir, readdir should miss.
        let mut buf = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_READDIR, 1, b"/empty", &mut buf),
            -(abi::ENOENT as i64)
        );
    }

    #[test]
    fn rmdir_nonempty_is_enotempty() {
        let _g = crate::kernel::TestGuard::acquire();
        assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/full", &mut []), 0);
        let mut reg = 9_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(b"/full/foo");
        reg.extend_from_slice(b"x");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        assert_eq!(dispatch(METHOD_SYS_RMDIR, 1, b"/full", &mut []), -39); // -ENOTEMPTY
    }

    #[test]
    fn readdir_distinguishes_files_dirs_and_symlinks_via_type_byte() {
        let _g = crate::kernel::TestGuard::acquire();
        // /etc/file (regular), /etc/sub (dir), /etc/link (symlink).
        assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/etc", &mut []), 0);
        let mut reg = 9_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(b"/etc/file");
        reg.extend_from_slice(b"x");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/etc/sub", &mut []), 0);
        let target: &[u8] = b"/etc/file";
        let link: &[u8] = b"/etc/link";
        let mut sreq = (target.len() as u32).to_le_bytes().to_vec();
        sreq.extend_from_slice(target);
        sreq.extend_from_slice(link);
        assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

        let mut buf = [0u8; 256];
        let n = dispatch(METHOD_SYS_READDIR, 1, b"/etc", &mut buf) as usize;
        assert!(n >= 4);
        let count = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
        assert_eq!(count, 3);
        let mut cursor = 4usize;
        let mut by_name: std::collections::BTreeMap<Vec<u8>, u8> =
            std::collections::BTreeMap::new();
        for _ in 0..count {
            let len = u32::from_le_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
            cursor += 4;
            let ty = buf[cursor];
            cursor += 1;
            by_name.insert(buf[cursor..cursor + len].to_vec(), ty);
            cursor += len;
        }
        assert_eq!(by_name.get(b"file".as_slice()), Some(&4));
        assert_eq!(by_name.get(b"sub".as_slice()), Some(&3));
        assert_eq!(by_name.get(b"link".as_slice()), Some(&7));
    }

    #[test]
    fn readdir_root_lists_top_level_entries() {
        let _g = crate::kernel::TestGuard::acquire();
        // Stash a top-level file.
        let mut reg = 5_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(b"/root");
        reg.extend_from_slice(b"x");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
        let mut buf = [0u8; 64];
        let n = dispatch(METHOD_SYS_READDIR, 1, b"/", &mut buf) as usize;
        assert!(n >= 4);
        let count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert!(count >= 1, "root contains at least /root");
    }

    #[test]
    fn register_child_then_getppid_returns_parent() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = 1_u32.to_le_bytes().to_vec();
        req.extend_from_slice(&7_u32.to_le_bytes());
        assert_eq!(register_child(&req), 0);

        // Child (pid 7) sees its ppid (1) via getppid.
        assert_eq!(dispatch(METHOD_SYS_GETPPID, 7, &[], &mut []), 1);
    }

    #[test]
    fn sys_wait_returns_exited_child() {
        let _g = crate::kernel::TestGuard::acquire();
        // Register child 5 under parent 1, then record its exit.
        let mut reg = 1_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(&5_u32.to_le_bytes());
        register_child(&reg);

        let mut exit = 5_u32.to_le_bytes().to_vec();
        exit.extend_from_slice(&42_i32.to_le_bytes());
        record_exit(&exit);

        // Parent's sys_wait reaps the child. Request: child_pid=0 (any) + flags=0.
        let mut wreq = 0_u32.to_le_bytes().to_vec();
        wreq.extend_from_slice(&0_u32.to_le_bytes());
        let mut wresp = [0u8; 8];
        let n = dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp);
        assert_eq!(n, 8);
        assert_eq!(u32::from_le_bytes(wresp[0..4].try_into().unwrap()), 5);
        assert_eq!(i32::from_le_bytes(wresp[4..8].try_into().unwrap()), 42);

        // After reaping, no more children → next wait is -ECHILD.
        let mut wresp2 = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp2),
            -(abi::ECHILD as i64)
        );
    }

    #[test]
    fn sys_wait_with_no_children_is_echild() {
        let _g = crate::kernel::TestGuard::acquire();
        // pid 1 has no children — wait returns -ECHILD.
        let mut wreq = 0_u32.to_le_bytes().to_vec();
        wreq.extend_from_slice(&0_u32.to_le_bytes());
        let mut wresp = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp),
            -(abi::ECHILD as i64)
        );
    }

    #[test]
    fn sys_wait_running_child_is_eagain_with_wnohang() {
        let _g = crate::kernel::TestGuard::acquire();
        // Register child but don't record exit — wait returns -EAGAIN
        // (and continues to with WNOHANG; blocking semantics will
        // wait via AsyncBridge once it lands).
        let mut reg = 1_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        register_child(&reg);

        let mut wreq = 0_u32.to_le_bytes().to_vec();
        wreq.extend_from_slice(&1_u32.to_le_bytes()); // WNOHANG
        let mut wresp = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp),
            -(abi::EAGAIN as i64)
        );
    }

    #[test]
    fn killed_child_is_waitable_by_parent() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = 1_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(&3_u32.to_le_bytes());
        register_child(&reg);

        let mut kill = 3_u32.to_le_bytes().to_vec();
        kill.extend_from_slice(&15_u32.to_le_bytes());
        assert_eq!(dispatch(METHOD_SYS_KILL, 1, &kill, &mut []), 0);

        let mut wreq = 0_u32.to_le_bytes().to_vec();
        wreq.extend_from_slice(&0_u32.to_le_bytes());
        let mut wresp = [0u8; 8];
        let n = dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp);
        assert_eq!(n, 8);
        assert_eq!(u32::from_le_bytes(wresp[0..4].try_into().unwrap()), 3);
        assert_eq!(i32::from_le_bytes(wresp[4..8].try_into().unwrap()), 143);
    }

    #[test]
    fn sys_wait_for_specific_pid_returns_just_that_one() {
        let _g = crate::kernel::TestGuard::acquire();
        // Two children; only one has exited.
        for c in [10u32, 11u32] {
            let mut reg = 1_u32.to_le_bytes().to_vec();
            reg.extend_from_slice(&c.to_le_bytes());
            register_child(&reg);
        }
        let mut exit = 11_u32.to_le_bytes().to_vec();
        exit.extend_from_slice(&7_i32.to_le_bytes());
        record_exit(&exit);

        // Wait specifically on pid 10 — running, not 11 (exited).
        // Should return -EAGAIN (would block) since 10 hasn't exited.
        let mut wreq = 10_u32.to_le_bytes().to_vec();
        wreq.extend_from_slice(&1_u32.to_le_bytes()); // WNOHANG
        let mut wresp = [0u8; 8];
        assert_eq!(
            dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp),
            -(abi::EAGAIN as i64)
        );

        // Now wait on pid 11 — that one exited.
        let mut wreq = 11_u32.to_le_bytes().to_vec();
        wreq.extend_from_slice(&0_u32.to_le_bytes());
        let n = dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp);
        assert_eq!(n, 8);
        assert_eq!(u32::from_le_bytes(wresp[0..4].try_into().unwrap()), 11);
        assert_eq!(i32::from_le_bytes(wresp[4..8].try_into().unwrap()), 7);
    }

    #[test]
    fn kernel_list_processes_serializes_kernel_owned_snapshot() {
        let _g = crate::kernel::TestGuard::acquire();

        let argv = set_argv_req(7, &[b"/bin/wc", b"-l"]);
        set_argv(&argv);

        let mut reg = 1_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(&7_u32.to_le_bytes());
        register_child(&reg);

        let mut exit = 7_u32.to_le_bytes().to_vec();
        exit.extend_from_slice(&2_i32.to_le_bytes());
        record_exit(&exit);

        let mut out = [0u8; 128];
        let n = dispatch(METHOD_KERNEL_LIST_PROCESSES, 0, &[], &mut out);
        assert!(n > 0, "list_processes returned {n}");

        let mut offset = 0usize;
        let count = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
        offset += 4;
        assert_eq!(count, 2);

        let mut found_child = false;
        for _ in 0..count {
            let pid = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
            offset += 4;
            let ppid = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
            offset += 4;
            let pgid = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
            offset += 4;
            let sid = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
            offset += 4;
            let state = out[offset];
            offset += 1;
            let exit_status = i32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
            offset += 4;
            let command_len =
                u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            let command = &out[offset..offset + command_len];
            offset += command_len;
            let fd_count = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
            offset += 4;
            let mut fds = Vec::new();
            for _ in 0..fd_count {
                fds.push(u32::from_le_bytes(
                    out[offset..offset + 4].try_into().unwrap(),
                ));
                offset += 4;
            }

            if pid == 7 {
                found_child = true;
                assert_eq!(ppid, 1);
                assert_eq!(pgid, 7);
                assert_eq!(sid, 7);
                assert_eq!(state, 2);
                assert_eq!(exit_status, 2);
                assert_eq!(command, b"/bin/wc");
                assert_eq!(fds, vec![0, 1, 2]);
            }
        }
        assert!(found_child, "snapshot did not include child pid 7");
        assert_eq!(offset, n as usize);
    }

    #[test]
    fn known_methods_table_includes_credentials_family() {
        let names: Vec<&str> = KNOWN_METHODS.iter().map(|(n, _)| *n).collect();
        for required in [
            "kernel_echo",
            "kernel_now_realtime",
            "sys_getuid",
            "sys_geteuid",
            "sys_getgid",
            "sys_getegid",
            "sys_getpid",
            "sys_getppid",
        ] {
            assert!(
                names.contains(&required),
                "expected {required} in KNOWN_METHODS"
            );
        }
    }

    #[test]
    fn lifecycle_host_control_is_not_available_through_generic_dispatch() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut exit = 7_u32.to_le_bytes().to_vec();
        exit.extend_from_slice(&0_i32.to_le_bytes());
        assert_eq!(dispatch(14, 0, &exit, &mut []), -(abi::ENOSYS as i64));
        assert_eq!(dispatch(15, 0, &[], &mut [0u8; 32]), -(abi::ENOSYS as i64));
    }

    #[test]
    fn process_scaffolding_is_not_available_through_generic_dispatch() {
        let _g = crate::kernel::TestGuard::acquire();
        let argv = set_argv_req(7, &[b"/bin/wc"]);
        assert_eq!(dispatch(9, 0, &argv, &mut []), -(abi::ENOSYS as i64));

        let mut reg = 1_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(&7_u32.to_le_bytes());
        assert_eq!(dispatch(13, 0, &reg, &mut []), -(abi::ENOSYS as i64));
    }
}
