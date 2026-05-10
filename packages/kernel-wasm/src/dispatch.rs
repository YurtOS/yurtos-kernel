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
        METHOD_KERNEL_SET_ARGV => set_argv(request),
        METHOD_KERNEL_INSTALL_TAR_LAYER => install_tar_layer(request),
        METHOD_KERNEL_INSTALL_HOST_FS_MOUNT => install_host_fs_mount(request),
        METHOD_KERNEL_INSTALL_YURTFS => install_yurtfs(request),
        METHOD_SYS_GETUID => with_kernel(|k| k.process(caller_pid).credentials.uid as i64),
        METHOD_SYS_GETEUID => with_kernel(|k| k.process(caller_pid).credentials.euid as i64),
        METHOD_SYS_GETGID => with_kernel(|k| k.process(caller_pid).credentials.gid as i64),
        METHOD_SYS_GETEGID => with_kernel(|k| k.process(caller_pid).credentials.egid as i64),
        METHOD_SYS_GETPID => caller_pid as i64,
        // No process tree yet: every process's parent is the kernel
        // itself. Once the spawn syscall lands and the kernel tracks a
        // real Process map, this reads ppid from that map.
        METHOD_SYS_GETPPID => KERNEL_PID as i64,
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
        METHOD_SYS_KILL => kill(request),
        METHOD_SYS_SIGACTION => sigaction(caller_pid, request),
        METHOD_SYS_SCHED_YIELD => sched_yield(caller_pid),
        METHOD_SYS_NANOSLEEP => nanosleep(caller_pid, request),
        METHOD_SYS_OPEN => sys_open(caller_pid, request),
        METHOD_SYS_LSEEK => lseek(caller_pid, request, response),
        METHOD_SYS_FSTAT => fstat(caller_pid, request, response),
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
    let target = if target_arg == 0 { caller_pid } else { target_arg };
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
    let target = if target_arg == 0 { caller_pid } else { target_arg };
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
    let target = if target_arg == 0 { caller_pid } else { target_arg };
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
/// "is the pid alive?" probe; with no process tree we always say yes.
fn kill(request: &[u8]) -> i64 {
    let Some([target, sig]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    if sig == 0 {
        return 0;
    }
    if !(1..=63).contains(&sig) {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        k.process_mut(target).pending_signals |= 1u64 << (sig - 1);
    });
    0
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
    let path_len =
        u32::from_le_bytes([request[0], request[1], request[2], request[3]]) as usize;
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

/// `kernel_set_argv(target_pid, [(arg_len, arg_bytes)…])`. Microkernel-
/// only; populates Process.argv so /proc/<pid>/cmdline + comm have
/// content to serve.
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

/// `kernel_install_host_fs_mount(prefix)`. Microkernel-only; mounts
/// a fresh [`HostFsBackend`] at `prefix`. Embedders pick where the
/// host fs lives. Returns 0 on success, -EINVAL for empty prefix.
fn install_host_fs_mount(request: &[u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        k.vfs.add_mount(
            request.to_vec(),
            Box::new(crate::vfs::HostFsBackend::new()),
        );
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
    let prefix_len =
        u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
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
    let prefix_len =
        u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
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
        k.vfs.add_mount(
            prefix,
            Box::new(crate::vfs::TarLayerBackend::new(archive)),
        );
    });
    0
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
    // /proc/self/<x> → /proc/<caller_pid>/<x>. Linux convention; the
    // expansion happens at the dispatch layer so ProcBackend doesn't
    // need to know the caller. Path bytes are not guaranteed UTF-8;
    // we rewrite as raw bytes.
    let path_owned: Vec<u8>;
    let path: &[u8] = if let Some(suffix) = raw_path.strip_prefix(b"/proc/self") {
        let prefix = format!("/proc/{caller_pid}");
        let mut buf = prefix.into_bytes();
        buf.extend_from_slice(suffix);
        path_owned = buf;
        &path_owned
    } else {
        raw_path
    };
    let writable = flags & 0b001 != 0;
    let create = flags & 0b010 != 0;
    let trunc = flags & 0b100 != 0;
    with_kernel(|k| {
        // Refresh procfs snapshots so /proc/<N>/status reflects the
        // current process table at open time.
        k.publish_proc_snapshots();
        // open() handles both lookup and create-if-missing in one
        // call. The flags bits propagate to the backend so it knows
        // the caller's intent (writable opens vs read-only).
        let (mount_id, inode) = match k.vfs.open(path, flags) {
            Some(pair) => pair,
            None => {
                // Distinguish "create wasn't allowed" from "no such
                // file": read-only backends (Tar, Proc, Dev) refuse
                // the create bit and return None regardless. Phase 5
                // surfaces both as ENOENT (no create) / EPERM (with
                // create) — embedders that want richer signals plumb
                // them later.
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
        let (size, filetype): (u64, u32) = match entry {
            crate::kernel::FdEntry::Stdin
            | crate::kernel::FdEntry::Stdout
            | crate::kernel::FdEntry::Stderr => (0, 2),
            crate::kernel::FdEntry::Pipe { .. } => (0, 6),
            crate::kernel::FdEntry::File { ofd_id } => {
                let (mount_id, inode) = match k.ofd(ofd_id) {
                    Some(o) => (o.mount_id, o.inode),
                    None => return -(abi::EBADF as i64),
                };
                let sz = k.vfs.size(mount_id, inode).unwrap_or(0);
                (sz, 4)
            }
        };
        response[0..8].copy_from_slice(&size.to_le_bytes());
        response[8..12].copy_from_slice(&filetype.to_le_bytes());
        response[12..16].copy_from_slice(&0u32.to_le_bytes());
        16
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
        let mut req = Vec::new();
        req.extend_from_slice(&5_u32.to_le_bytes()); // target
        req.extend_from_slice(&0_u32.to_le_bytes()); // sig 0 = probe
        assert_eq!(dispatch(METHOD_SYS_KILL, 1, &req, &mut []), 0);
    }

    #[test]
    fn kill_records_signal_in_pending_mask() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut req = Vec::new();
        req.extend_from_slice(&5_u32.to_le_bytes()); // target pid
        req.extend_from_slice(&15_u32.to_le_bytes()); // SIGTERM
        assert_eq!(dispatch(METHOD_SYS_KILL, 1, &req, &mut []), 0);
        // Bit 14 (sig 15 - 1) should now be set on pid 5.
        let pending = crate::kernel::with_kernel(|k| k.process_mut(5).pending_signals);
        assert_eq!(pending, 1u64 << 14);
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
        let n = dispatch(
            METHOD_SYS_READ,
            1,
            &(fd as u32).to_le_bytes(),
            &mut buf,
        );
        assert_eq!(n as usize, b"hi from ramfs".len());
        assert_eq!(&buf[..n as usize], b"hi from ramfs");

        // Subsequent read at EOF returns 0.
        let n = dispatch(
            METHOD_SYS_READ,
            1,
            &(fd as u32).to_le_bytes(),
            &mut buf,
        );
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
        assert_eq!(
            dispatch(METHOD_SYS_CLOSE, 1, &fd.to_le_bytes(), &mut []),
            0
        );
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
        assert_eq!(dispatch(METHOD_SYS_FSTAT, 1, &fd.to_le_bytes(), &mut out), 16);
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 5);
        assert_eq!(u32::from_le_bytes(out[8..12].try_into().unwrap()), 4); // REGULAR_FILE

        // fstat on stdin (fd 0) reports filetype=2 CHARACTER_DEVICE.
        let mut out2 = [0u8; 16];
        assert_eq!(dispatch(METHOD_SYS_FSTAT, 1, &0_u32.to_le_bytes(), &mut out2), 16);
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
        assert!(text.contains("Uid:\t1000"), "expected default uid in: {text}");
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
        let fd = dispatch(
            METHOD_SYS_OPEN,
            5,
            &open_req(0, b"/proc/5/status"),
            &mut [],
        );
        let mut buf = [0u8; 256];
        let n = dispatch(METHOD_SYS_READ, 5, &(fd as u32).to_le_bytes(), &mut buf);
        let text = std::str::from_utf8(&buf[..n as usize]).unwrap();
        assert!(text.contains("Uid:\t500\t501"), "uid update missing: {text}");
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

    /// Helper for set_argv: pack pid + (u32 len + bytes)* like the
    /// kernel_set_argv wire format expects.
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
        assert_eq!(dispatch(METHOD_KERNEL_SET_ARGV, 0, &req, &mut []), 0);

        let fd = dispatch(METHOD_SYS_OPEN, 4, &open_req(0, b"/proc/4/cmdline"), &mut []);
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
        dispatch(METHOD_KERNEL_SET_ARGV, 0, &req, &mut []);

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
        dispatch(METHOD_KERNEL_SET_ARGV, 0, &req, &mut []);

        let fd = dispatch(METHOD_SYS_OPEN, 6, &open_req(0, b"/proc/6/status"), &mut []);
        let mut buf = [0u8; 256];
        let n = dispatch(METHOD_SYS_READ, 6, &(fd as u32).to_le_bytes(), &mut buf);
        let text = std::str::from_utf8(&buf[..n as usize]).unwrap();
        assert!(text.contains("Name:\tls\n"), "expected Name:\\tls in: {text}");
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

        let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/img3/counts"), &mut [])
            as u32;
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
}
