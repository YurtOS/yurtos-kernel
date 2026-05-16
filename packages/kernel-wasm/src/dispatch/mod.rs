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
//!                only by the kernel_host_interface to validate trampoline
//!                plumbing)
//!   0x1_0000+  — `host_*` syscalls from `yurt_abi.toml`

use crate::abi;
use crate::kernel::{with_kernel, FdEntry, Kernel, PipeEnd, SocketKind};
use crate::kh;

mod fs;
mod process;
mod socket;
mod thread;

use fs::{
    chdir, chmod, chown, getcwd, hard_link, mkdir, readdir, readlink, realpath, rename, rmdir,
    stat_path, symlink, sys_open, unlink, utimens,
};
use process::{
    close_stdin, drain_stream, getpgid, getpriority, getrlimit, getsid, kill_request,
    killpg_request, nanosleep, provide_stdin, sched_getaffinity, sched_getparam,
    sched_getscheduler, sched_setaffinity, sched_setparam, sched_setscheduler, sched_yield,
    setpgid, setpriority, setresgid, setresuid, setrlimit, setsid, sigaction, sys_spawn, umask,
};
pub use process::{
    drain_spawn, kill_pid, list_processes_response, list_threads_response, record_exit,
    schedule_next_response, snapshot_response, spawn_cached_process, wait_response,
};
#[cfg(test)]
pub(crate) use process::{
    register_child, set_argv, SNAPSHOT_SECTION_PROCESSES, SNAPSHOT_SECTION_RUNNABLE_THREADS,
    SNAPSHOT_SECTION_THREAD_GROUPS, SNAPSHOT_SECTION_WAITS,
};
use socket::{
    socket_recv_id, socket_send_id, sys_socket_accept, sys_socket_addr, sys_socket_bind,
    sys_socket_close, sys_socket_connect, sys_socket_info, sys_socket_listen, sys_socket_open,
    sys_socket_option, sys_socket_recv, sys_socket_recvfrom, sys_socket_recvmsg, sys_socket_send,
    sys_socket_sendmsg, sys_socket_sendto, sys_socketpair,
};

include!(concat!(env!("OUT_DIR"), "/methods_generated.rs"));

const MSG_PEEK: u32 = 0x2;
const ID_NO_CHANGE: u32 = u32::MAX;

/// Reserved pid for direct calls from outside any user process — i.e.
/// the kernel-host interface itself driving the kernel for tests, bootstrapping,
/// or its own bookkeeping. Real user processes start at pid 1.
#[allow(dead_code)]
pub const KERNEL_PID: u32 = 0;

fn has_buffer_capacity(current: usize, additional: usize) -> bool {
    additional <= crate::kernel::KERNEL_BUFFER_CAP
        && current <= crate::kernel::KERNEL_BUFFER_CAP - additional
}

fn kernel_only(caller_pid: u32, f: impl FnOnce() -> i64) -> i64 {
    if caller_pid != KERNEL_PID {
        return -(abi::EPERM as i64);
    }
    f()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DispatchContext {
    pub caller_pid: u32,
    pub caller_tid: u32,
}

impl DispatchContext {
    pub const fn main_thread(caller_pid: u32) -> Self {
        Self {
            caller_pid,
            caller_tid: crate::kernel::MAIN_THREAD_TID,
        }
    }
}

pub fn dispatch_with_context(
    method_id: u32,
    ctx: DispatchContext,
    request: &[u8],
    response: &mut [u8],
) -> i64 {
    let caller_pid = ctx.caller_pid;
    match method_id {
        METHOD_KERNEL_ECHO => echo(request, response),
        METHOD_KERNEL_NOW_REALTIME => now_realtime(response),
        METHOD_KERNEL_LOG_TEST => {
            kh::log(kh::LogSeverity::Info, "kernel.wasm hello via kh_log");
            0
        }
        METHOD_KERNEL_PROVIDE_STDIN => kernel_only(caller_pid, || provide_stdin(request)),
        METHOD_KERNEL_CLOSE_STDIN => kernel_only(caller_pid, || close_stdin(request)),
        METHOD_KERNEL_DRAIN_STDOUT => kernel_only(caller_pid, || {
            drain_stream(request, response, /*stdout=*/ true)
        }),
        METHOD_KERNEL_DRAIN_STDERR => kernel_only(caller_pid, || {
            drain_stream(request, response, /*stdout=*/ false)
        }),
        METHOD_KERNEL_REGISTER_FILE => kernel_only(caller_pid, || register_file(request)),
        METHOD_KERNEL_INSTALL_TAR_LAYER => kernel_only(caller_pid, || install_tar_layer(request)),
        METHOD_KERNEL_INSTALL_HOST_FS_MOUNT => {
            kernel_only(caller_pid, || install_host_fs_mount(request))
        }
        METHOD_KERNEL_INSTALL_YURTFS => kernel_only(caller_pid, || install_yurtfs(request)),
        METHOD_KERNEL_LIST_PROCESSES => {
            kernel_only(caller_pid, || list_processes_response(response))
        }
        METHOD_KERNEL_LIST_THREADS => {
            kernel_only(caller_pid, || list_threads_response(request, response))
        }
        METHOD_KERNEL_SCHEDULE_NEXT => kernel_only(caller_pid, || schedule_next_response(response)),
        METHOD_SYS_THREAD_SPAWN => thread::sys_thread_spawn(ctx, request),
        METHOD_SYS_THREAD_SELF => thread::sys_thread_self(ctx, request),
        METHOD_SYS_THREAD_JOIN => thread::sys_thread_join(ctx, request, response),
        METHOD_SYS_THREAD_DETACH => thread::sys_thread_detach(ctx, request),
        METHOD_SYS_THREAD_EXIT => thread::sys_thread_exit(ctx, request),
        METHOD_SYS_THREAD_YIELD => thread::sys_thread_yield(ctx, request),
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
        METHOD_SYS_GETPRIORITY => getpriority(caller_pid, request),
        METHOD_SYS_SETPRIORITY => setpriority(caller_pid, request),
        METHOD_SYS_SCHED_GETSCHEDULER => sched_getscheduler(caller_pid, request),
        METHOD_SYS_SCHED_GETPARAM => sched_getparam(caller_pid, request),
        METHOD_SYS_SCHED_SETSCHEDULER => sched_setscheduler(caller_pid, request),
        METHOD_SYS_SCHED_SETPARAM => sched_setparam(caller_pid, request),
        METHOD_SYS_SCHED_GETAFFINITY => sched_getaffinity(caller_pid, request, response),
        METHOD_SYS_SCHED_SETAFFINITY => sched_setaffinity(caller_pid, request),
        METHOD_SYS_CLOSE => close_fd(caller_pid, request),
        METHOD_SYS_DUP => dup_fd(caller_pid, request),
        METHOD_SYS_DUP2 => dup2_fd(caller_pid, request),
        METHOD_SYS_DUP_MIN => dup_min_fd(caller_pid, request),
        METHOD_SYS_SET_FD_DESCRIPTOR_FLAGS => set_fd_descriptor_flags(caller_pid, request),
        METHOD_SYS_PIPE => pipe(caller_pid, response),
        METHOD_SYS_READ => read_fd(caller_pid, request, response),
        METHOD_SYS_WRITE => write_fd(caller_pid, request),
        METHOD_SYS_POLL => poll_fds(caller_pid, request, response),
        METHOD_SYS_ISATTY => isatty(caller_pid, request),
        METHOD_SYS_TCGETPGRP => tcgetpgrp(caller_pid, request),
        METHOD_SYS_TCSETPGRP => tcsetpgrp(caller_pid, request),
        METHOD_SYS_TCGETATTR => tcgetattr(caller_pid, request, response),
        METHOD_SYS_TCSETATTR => tcsetattr(caller_pid, request),
        METHOD_SYS_WINSIZE => winsize(caller_pid, request, response),
        METHOD_SYS_TIOCSCTTY => tiocsctty(caller_pid, request),
        METHOD_SYS_CLOCK_GETTIME => clock_gettime(request, response),
        METHOD_SYS_EXTENSION_INVOKE => kh::extension_invoke(request, response),
        METHOD_SYS_GETPGID => getpgid(caller_pid, request),
        METHOD_SYS_SETPGID => setpgid(caller_pid, request),
        METHOD_SYS_GETSID => getsid(caller_pid, request),
        METHOD_SYS_SETSID => setsid(caller_pid),
        METHOD_SYS_KILL => kill_request(request),
        METHOD_SYS_KILLPG => killpg_request(caller_pid, request),
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
        METHOD_SYS_REALPATH => realpath(caller_pid, request, response),
        METHOD_SYS_LINK => hard_link(caller_pid, request),
        METHOD_SYS_RENAME => rename(caller_pid, request),
        METHOD_SYS_SPAWN => sys_spawn(caller_pid, request),
        METHOD_SYS_FETCH => sys_fetch(request, response),
        METHOD_SYS_SOCKET_CONNECT => sys_socket_connect(caller_pid, request),
        METHOD_SYS_SOCKET_SEND => sys_socket_send(caller_pid, request),
        METHOD_SYS_SOCKET_RECV => sys_socket_recv(caller_pid, request, response),
        METHOD_SYS_SOCKET_CLOSE => sys_socket_close(caller_pid, request),
        METHOD_SYS_SOCKETPAIR => sys_socketpair(caller_pid, request, response),
        METHOD_SYS_SOCKET_OPEN => sys_socket_open(caller_pid, request),
        METHOD_SYS_SOCKET_BIND => sys_socket_bind(caller_pid, request),
        METHOD_SYS_SOCKET_OPTION => sys_socket_option(caller_pid, request),
        METHOD_SYS_SOCKET_SENDTO => sys_socket_sendto(caller_pid, request),
        METHOD_SYS_SOCKET_SENDMSG => sys_socket_sendmsg(caller_pid, request),
        METHOD_SYS_SOCKET_RECVMSG => sys_socket_recvmsg(caller_pid, request, response),
        METHOD_SYS_IDB_GET => sys_idb_get(request, response),
        METHOD_SYS_IDB_PUT => sys_idb_put(request),
        METHOD_SYS_IDB_DELETE => sys_idb_delete(request),
        METHOD_SYS_IDB_LIST => sys_idb_list(request, response),
        METHOD_SYS_SOCKET_LISTEN => sys_socket_listen(caller_pid, request),
        METHOD_SYS_SOCKET_ACCEPT => sys_socket_accept(caller_pid, request),
        METHOD_SYS_SOCKET_ADDR => sys_socket_addr(caller_pid, request, response),
        METHOD_SYS_SOCKET_INFO => sys_socket_info(caller_pid, request, response),
        METHOD_SYS_SOCKET_RECVFROM => sys_socket_recvfrom(caller_pid, request, response),
        _ => -(abi::ENOSYS as i64),
    }
}

pub fn dispatch(method_id: u32, caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    dispatch_with_context(
        method_id,
        DispatchContext::main_thread(caller_pid),
        request,
        response,
    )
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

/// `close(fd: u32) -> 0 / -EBADF`. Decrements pipe refcounts when
/// the closed entry is a pipe end.
fn close_fd(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([fd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    close_fd_number(caller_pid, fd)
}

fn close_entry(k: &mut Kernel, entry: FdEntry) -> Option<i32> {
    match entry {
        crate::kernel::FdEntry::Pipe { id, end } => {
            k.pipe_dec_ref(id, end);
            None
        }
        crate::kernel::FdEntry::File { ofd_id } => {
            k.ofd_dec_ref(ofd_id);
            None
        }
        crate::kernel::FdEntry::Socket { id } => k.socket_dec_ref(id),
        _ => None,
    }
}

fn close_fd_number(caller_pid: u32, fd: u32) -> i64 {
    match with_kernel(|k| {
        let removed = k.process_mut(caller_pid).fd_table.remove(fd);
        removed
            .map(|entry| close_entry(k, entry))
            .ok_or(-(abi::EBADF as i64))
    }) {
        Err(rc) => rc,
        Ok(Some(handle)) => kh::socket_close(handle) as i64,
        Ok(None) => 0,
    }
}

fn inc_entry_ref(k: &mut Kernel, entry: &FdEntry) {
    match entry {
        crate::kernel::FdEntry::Pipe { id, end } => {
            if let Some(buf) = k.pipe_buf_mut(*id) {
                buf.inc_ref(*end);
            }
        }
        crate::kernel::FdEntry::File { ofd_id } => k.ofd_inc_ref(*ofd_id),
        crate::kernel::FdEntry::Socket { id } => k.socket_inc_ref(*id),
        _ => {}
    }
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
        inc_entry_ref(k, &entry);
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
        let close_handle = k
            .process_mut(caller_pid)
            .fd_table
            .entry(newfd)
            .cloned()
            .and_then(|prev| close_entry(k, prev));
        // Increment the refcount for the new alias.
        inc_entry_ref(k, &entry);
        k.process_mut(caller_pid).fd_table.install(newfd, entry);
        if let Some(handle) = close_handle {
            let _ = kh::socket_close(handle);
        }
        newfd as i64
    })
}

/// `dup_min(oldfd: u32, minfd: u32) -> newfd / -EBADF / -EINVAL`.
fn dup_min_fd(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([oldfd, minfd]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let entry = match k.process_mut(caller_pid).fd_table.entry(oldfd) {
            Some(e) => e.clone(),
            None => return -(abi::EBADF as i64),
        };
        let Some(newfd) = k.process_mut(caller_pid).fd_table.lowest_free_fd_at(minfd) else {
            return -(abi::EINVAL as i64);
        };
        inc_entry_ref(k, &entry);
        k.process_mut(caller_pid).fd_table.install(newfd, entry);
        newfd as i64
    })
}

fn set_fd_descriptor_flags(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([fd, flags]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        match k
            .process_mut(caller_pid)
            .fd_table
            .set_descriptor_flags(fd, flags)
        {
            Ok(()) => 0,
            Err(errno) => -(errno as i64),
        }
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
            crate::kernel::FdEntry::Pipe {
                id,
                end: crate::kernel::PipeEnd::Read,
            } => {
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
            crate::kernel::FdEntry::Pipe {
                end: crate::kernel::PipeEnd::Write,
                ..
            } => -(abi::EBADF as i64),
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
            crate::kernel::FdEntry::Socket { id } => socket_recv_id(k, id, response, 0),
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
                let p = k.process_mut(caller_pid);
                if !has_buffer_capacity(p.stdout_buffer.len(), payload.len()) {
                    return -(abi::EAGAIN as i64);
                }
                p.stdout_buffer.extend_from_slice(payload);
                payload.len() as i64
            }
            crate::kernel::FdEntry::Stderr => {
                let p = k.process_mut(caller_pid);
                if !has_buffer_capacity(p.stderr_buffer.len(), payload.len()) {
                    return -(abi::EAGAIN as i64);
                }
                p.stderr_buffer.extend_from_slice(payload);
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
                if !has_buffer_capacity(buf.bytes.len(), payload.len()) {
                    return -(abi::EAGAIN as i64);
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
            crate::kernel::FdEntry::Socket { id } => socket_send_id(k, id, payload),
        }
    })
}

const POLLIN: i16 = 0x0001;
const POLLOUT: i16 = 0x0002;
const POLLERR: i16 = 0x0008;
const POLLHUP: i16 = 0x0010;
const POLLNVAL: i16 = 0x0020;
const POLLFD_SIZE: usize = 8;

fn poll_fds(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 4 || !(request.len() - 4).is_multiple_of(POLLFD_SIZE) {
        return -(abi::EINVAL as i64);
    }
    let records = &request[4..];
    if response.len() < records.len() {
        return -(abi::EINVAL as i64);
    }

    response[..records.len()].copy_from_slice(records);
    with_kernel(|k| {
        let mut ready = 0;
        for (index, record) in records.chunks_exact(POLLFD_SIZE).enumerate() {
            let fd = i32::from_le_bytes(record[0..4].try_into().expect("poll fd"));
            let events = i16::from_le_bytes(record[4..6].try_into().expect("poll events"));
            let revents = if fd < 0 {
                0
            } else {
                poll_revents_for_fd(k, caller_pid, fd as u32, events)
            };
            let out = index * POLLFD_SIZE + 6;
            response[out..out + 2].copy_from_slice(&revents.to_le_bytes());
            if revents != 0 {
                ready += 1;
            }
        }
        ready
    })
}

fn poll_revents_for_fd(k: &mut Kernel, caller_pid: u32, fd: u32, events: i16) -> i16 {
    let wants_read = events & POLLIN != 0;
    let wants_write = events & POLLOUT != 0;
    let entry = match k.process_mut(caller_pid).fd_table.entry(fd) {
        Some(e) => e.clone(),
        None => return POLLNVAL,
    };

    match entry {
        FdEntry::Stdin => {
            let p = k.process_mut(caller_pid);
            if wants_read && (!p.stdin_buffer.is_empty() || p.stdin_eof) {
                POLLIN
            } else {
                0
            }
        }
        FdEntry::Stdout | FdEntry::Stderr => {
            if wants_write {
                POLLOUT
            } else {
                0
            }
        }
        FdEntry::File { .. } => {
            let mut revents = 0;
            if wants_read {
                revents |= POLLIN;
            }
            if wants_write {
                revents |= POLLOUT;
            }
            revents
        }
        FdEntry::Pipe {
            id,
            end: PipeEnd::Read,
        } => {
            let Some(buf) = k.pipe_buf_mut(id) else {
                return POLLNVAL;
            };
            if wants_read && !buf.bytes.is_empty() {
                POLLIN
            } else if buf.write_ends == 0 {
                POLLHUP
            } else {
                0
            }
        }
        FdEntry::Pipe {
            id,
            end: PipeEnd::Write,
        } => {
            let Some(buf) = k.pipe_buf_mut(id) else {
                return POLLNVAL;
            };
            if buf.read_ends == 0 {
                POLLERR
            } else if wants_write {
                POLLOUT
            } else {
                0
            }
        }
        FdEntry::Socket { id } => {
            let Some(socket) = k.socket(id) else {
                return POLLNVAL;
            };
            match &socket.kind {
                SocketKind::Open { .. } => {
                    if wants_write {
                        POLLOUT
                    } else {
                        0
                    }
                }
                SocketKind::Host { .. } => {
                    if wants_write {
                        POLLOUT
                    } else {
                        0
                    }
                }
                SocketKind::UnixListener { pending, .. } => {
                    if wants_read && !pending.is_empty() {
                        POLLIN
                    } else {
                        0
                    }
                }
                SocketKind::UnixStream { rx, peer_open, .. } => {
                    let mut revents = 0;
                    if wants_read && !rx.is_empty() {
                        revents |= POLLIN;
                    }
                    if wants_write && *peer_open {
                        revents |= POLLOUT;
                    }
                    if !*peer_open && rx.is_empty() {
                        revents |= POLLHUP;
                    }
                    revents
                }
                SocketKind::UnixDatagram { rx, peer_open, .. } => {
                    let mut revents = 0;
                    if wants_read && !rx.is_empty() {
                        revents |= POLLIN;
                    }
                    if wants_write && *peer_open {
                        revents |= POLLOUT;
                    }
                    if !*peer_open && rx.is_empty() {
                        revents |= POLLHUP;
                    }
                    revents
                }
            }
        }
    }
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

fn is_tty_entry(entry: &FdEntry) -> bool {
    matches!(entry, FdEntry::Stdin | FdEntry::Stdout | FdEntry::Stderr)
}

fn require_tty_fd(k: &mut Kernel, caller_pid: u32, fd: u32) -> Result<(), i32> {
    match k.process_mut(caller_pid).fd_table.entry(fd) {
        None => Err(abi::EBADF),
        Some(entry) if is_tty_entry(entry) => Ok(()),
        Some(_) => Err(abi::ENOTTY),
    }
}

fn process_session_id(pid: u32, process: &crate::kernel::Process) -> u32 {
    if process.sid == 0 {
        pid
    } else {
        process.sid
    }
}

fn tcgetpgrp(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([fd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| match require_tty_fd(k, caller_pid, fd) {
        Ok(()) => k.tty_foreground_pgid() as i64,
        Err(errno) => -(errno as i64),
    })
}

fn tcsetpgrp(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([fd, pgid]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        if let Err(errno) = require_tty_fd(k, caller_pid, fd) {
            return -(errno as i64);
        }
        let caller_sid = {
            let caller = k.process_mut(caller_pid);
            process_session_id(caller_pid, caller)
        };
        match k.process_group_session(pgid) {
            Some(group_sid) if group_sid == caller_sid => {
                k.set_tty_foreground_pgid(pgid);
                0
            }
            _ => -(abi::ENOTTY as i64),
        }
    })
}

fn tcgetattr(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    let Some([fd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        if let Err(errno) = require_tty_fd(k, caller_pid, fd) {
            return -(errno as i64);
        }
        let termios = default_termios();
        if response.len() < termios.len() {
            return termios.len() as i64;
        }
        response[..termios.len()].copy_from_slice(&termios);
        termios.len() as i64
    })
}

fn tcsetattr(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([fd, _actions]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| match require_tty_fd(k, caller_pid, fd) {
        Ok(()) => 0,
        Err(errno) => -(errno as i64),
    })
}

fn winsize(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    let Some([fd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        if let Err(errno) = require_tty_fd(k, caller_pid, fd) {
            return -(errno as i64);
        }
        let winsize = default_winsize();
        if response.len() < winsize.len() {
            return winsize.len() as i64;
        }
        response[..winsize.len()].copy_from_slice(&winsize);
        winsize.len() as i64
    })
}

fn tiocsctty(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([fd]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        if let Err(errno) = require_tty_fd(k, caller_pid, fd) {
            return -(errno as i64);
        }
        let caller = k.process_mut(caller_pid);
        if caller.sid != caller_pid || caller.pgid != caller_pid {
            return -(abi::EPERM as i64);
        }
        caller.has_controlling_tty = true;
        k.set_tty_foreground_pgid(caller_pid);
        0
    })
}

fn default_termios() -> [u8; 60] {
    let mut buf = [0u8; 60];
    buf[0..4].copy_from_slice(&0x0600_u32.to_le_bytes());
    buf[4..8].copy_from_slice(&0x0005_u32.to_le_bytes());
    buf[8..12].copy_from_slice(&0x08BF_u32.to_le_bytes());
    buf[12..16].copy_from_slice(&0x8A3B_u32.to_le_bytes());
    buf[17] = 3;
    buf[18] = 28;
    buf[19] = 127;
    buf[20] = 21;
    buf[21] = 4;
    buf[22] = 0;
    buf[23] = 1;
    buf[25] = 17;
    buf[26] = 19;
    buf[27] = 26;
    buf[40..44].copy_from_slice(&15_u32.to_le_bytes());
    buf[44..48].copy_from_slice(&15_u32.to_le_bytes());
    buf
}

fn default_winsize() -> [u8; 8] {
    let mut buf = [0u8; 8];
    buf[0..2].copy_from_slice(&24_u16.to_le_bytes());
    buf[2..4].copy_from_slice(&80_u16.to_le_bytes());
    buf
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

/// `kernel_register_file(path_len: u32, path_bytes, content_bytes)`.
/// KernelHostInterface-only; installs (or replaces) a file at `path`. Returns
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
        // KernelHostInterface-only: install or replace the file at `path`.
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

/// `kernel_install_host_fs_mount(prefix)`. KernelHostInterface-only; mounts
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
/// KernelHostInterface-only; mounts an [`OverlayBackend`] composing a
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
/// KernelHostInterface-only; mounts a [`TarLayerBackend`] at `prefix`. The
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
            crate::kernel::FdEntry::Socket { .. } => (0, 6, 0o140_666),
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

/// `sys_fetch(yurt_fetch_request_v1) -> yurt_fetch_response_v1`. Forwards the
/// request bytes verbatim to `kh_fetch_blocking` and writes the response bytes
/// back.
fn sys_fetch(request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    kh::fetch_blocking(request, response)
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
mod tests;
