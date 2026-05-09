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
        if let crate::kernel::FdEntry::Pipe { id, end } = &entry {
            if let Some(buf) = k.pipe_buf_mut(*id) {
                buf.inc_ref(*end);
            }
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
        // If newfd was already a pipe end, decrement it before
        // overwriting (POSIX says newfd is silently closed first).
        let prev = k.process_mut(caller_pid).fd_table.entry(newfd).cloned();
        if let Some(crate::kernel::FdEntry::Pipe { id, end }) = prev {
            k.pipe_dec_ref(id, end);
        }
        // Increment the pipe refcount for the new alias.
        if let crate::kernel::FdEntry::Pipe { id, end } = &entry {
            if let Some(buf) = k.pipe_buf_mut(*id) {
                buf.inc_ref(*end);
            }
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
