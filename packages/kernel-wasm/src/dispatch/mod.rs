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
use crate::path::PathResolver;

mod socket;

use socket::{
    socket_recv_id, socket_send_id, sys_socket_accept, sys_socket_addr, sys_socket_bind,
    sys_socket_close, sys_socket_connect, sys_socket_info, sys_socket_listen, sys_socket_open,
    sys_socket_recv, sys_socket_recvfrom, sys_socket_recvmsg, sys_socket_send, sys_socket_sendmsg,
    sys_socket_sendto, sys_socketpair,
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

pub fn dispatch(method_id: u32, caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
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
        METHOD_SYS_CLOSE => close_fd(caller_pid, request),
        METHOD_SYS_DUP => dup_fd(caller_pid, request),
        METHOD_SYS_DUP2 => dup2_fd(caller_pid, request),
        METHOD_SYS_PIPE => pipe(caller_pid, response),
        METHOD_SYS_READ => read_fd(caller_pid, request, response),
        METHOD_SYS_WRITE => write_fd(caller_pid, request),
        METHOD_SYS_POLL => poll_fds(caller_pid, request, response),
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

fn requested_id_allowed(requested: u32, allowed: &[u32]) -> bool {
    requested == ID_NO_CHANGE || allowed.contains(&requested)
}

fn can_modify_owned_metadata(credentials: crate::state::Credentials, owner_uid: u32) -> bool {
    credentials.euid == 0 || credentials.euid == owner_uid
}

fn setresuid(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([ruid, euid, suid]) = read_u32_args::<3>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let p = k.process_mut(caller_pid);
        let current = p.credentials;
        if current.euid != 0 {
            let allowed = [current.uid, current.euid, current.suid];
            if ![ruid, euid, suid]
                .iter()
                .all(|id| requested_id_allowed(*id, &allowed))
            {
                return -(abi::EPERM as i64);
            }
        }
        if ruid != ID_NO_CHANGE {
            p.credentials.uid = ruid;
        }
        if euid != ID_NO_CHANGE {
            p.credentials.euid = euid;
        }
        if suid != ID_NO_CHANGE {
            p.credentials.suid = suid;
        }
        0
    })
}

fn setresgid(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([rgid, egid, sgid]) = read_u32_args::<3>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let p = k.process_mut(caller_pid);
        let current = p.credentials;
        if current.euid != 0 {
            let allowed = [current.gid, current.egid, current.sgid];
            if ![rgid, egid, sgid]
                .iter()
                .all(|id| requested_id_allowed(*id, &allowed))
            {
                return -(abi::EPERM as i64);
            }
        }
        if rgid != ID_NO_CHANGE {
            p.credentials.gid = rgid;
        }
        if egid != ID_NO_CHANGE {
            p.credentials.egid = egid;
        }
        if sgid != ID_NO_CHANGE {
            p.credentials.sgid = sgid;
        }
        0
    })
}

const PRIO_PROCESS: u32 = 0;
const NICE_MIN: i32 = -20;
const NICE_MAX: i32 = 19;
const SCHED_OTHER: i32 = 0;

fn normalize_nice(nice: i32) -> i32 {
    nice.clamp(NICE_MIN, NICE_MAX)
}

fn read_i32_at(request: &[u8], offset: usize) -> Option<i32> {
    (request.len() >= offset + 4)
        .then(|| i32::from_le_bytes(request[offset..offset + 4].try_into().expect("4 bytes")))
}

fn priority_target_pid(caller_pid: u32, which: u32, who: u32) -> Result<u32, i64> {
    if which != PRIO_PROCESS {
        return Err(-(abi::EINVAL as i64));
    }
    Ok(if who == 0 { caller_pid } else { who })
}

fn getpriority(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([which, who]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    let target = match priority_target_pid(caller_pid, which, who) {
        Ok(pid) => pid,
        Err(rc) => return rc,
    };
    with_kernel(|k| {
        if who == 0 || target == caller_pid {
            k.process_mut(target).nice as i64
        } else {
            k.process_existing(target)
                .map(|p| p.nice as i64)
                .unwrap_or(-(abi::ESRCH as i64))
        }
    })
}

fn setpriority(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([which, who]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    let Some(raw_nice) = read_i32_at(request, 8) else {
        return -(abi::EINVAL as i64);
    };
    let target = match priority_target_pid(caller_pid, which, who) {
        Ok(pid) => pid,
        Err(rc) => return rc,
    };
    with_kernel(|k| {
        let requested = normalize_nice(raw_nice);
        let caller_euid = k.process_mut(caller_pid).credentials.euid;
        let Some(target_process) = (if who == 0 || target == caller_pid {
            Some(k.process_mut(target))
        } else {
            k.process_existing_mut(target)
        }) else {
            return -(abi::ESRCH as i64);
        };
        if target != caller_pid
            && caller_euid != 0
            && caller_euid != target_process.credentials.uid
            && caller_euid != target_process.credentials.euid
        {
            return -(abi::EPERM as i64);
        }
        if requested < target_process.nice && caller_euid != 0 {
            return -(abi::EPERM as i64);
        }
        target_process.nice = requested;
        0
    })
}

fn scheduler_target_pid(caller_pid: u32, pid: u32) -> u32 {
    if pid == 0 {
        caller_pid
    } else {
        pid
    }
}

fn scheduler_target_exists(caller_pid: u32, target: u32) -> bool {
    target == caller_pid || with_kernel(|k| k.has_process(target))
}

fn sched_getscheduler(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    let target = scheduler_target_pid(caller_pid, pid);
    if !scheduler_target_exists(caller_pid, target) {
        return -(abi::ESRCH as i64);
    }
    with_kernel(|k| k.process_mut(target).scheduler_policy as i64)
}

fn sched_getparam(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    let target = scheduler_target_pid(caller_pid, pid);
    if !scheduler_target_exists(caller_pid, target) {
        return -(abi::ESRCH as i64);
    }
    with_kernel(|k| k.process_mut(target).scheduler_priority as i64)
}

fn validate_scheduler(policy: i32, priority: i32) -> Result<(), i64> {
    if policy != SCHED_OTHER {
        return Err(-(abi::EPERM as i64));
    }
    if priority != 0 {
        return Err(-(abi::EINVAL as i64));
    }
    Ok(())
}

fn sched_setscheduler(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    let Some(policy) = read_i32_at(request, 4) else {
        return -(abi::EINVAL as i64);
    };
    let Some(priority) = read_i32_at(request, 8) else {
        return -(abi::EINVAL as i64);
    };
    let target = scheduler_target_pid(caller_pid, pid);
    if !scheduler_target_exists(caller_pid, target) {
        return -(abi::ESRCH as i64);
    }
    if let Err(rc) = validate_scheduler(policy, priority) {
        return rc;
    }
    with_kernel(|k| {
        let p = k.process_mut(target);
        p.scheduler_policy = policy;
        p.scheduler_priority = priority;
    });
    0
}

fn sched_setparam(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    let Some(priority) = read_i32_at(request, 4) else {
        return -(abi::EINVAL as i64);
    };
    let target = scheduler_target_pid(caller_pid, pid);
    if !scheduler_target_exists(caller_pid, target) {
        return -(abi::ESRCH as i64);
    }
    let policy = with_kernel(|k| k.process_mut(target).scheduler_policy);
    if let Err(rc) = validate_scheduler(policy, priority) {
        return rc;
    }
    with_kernel(|k| {
        k.process_mut(target).scheduler_priority = priority;
    });
    0
}

fn chdir(caller_pid: u32, request: &[u8]) -> i64 {
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

/// `kernel_provide_stdin(target_pid, payload)`. KernelHostInterface-only;
/// appends bytes to the target process's stdin buffer.
fn provide_stdin(request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let pid = u32::from_le_bytes([request[0], request[1], request[2], request[3]]);
    let payload = &request[4..];
    with_kernel(|k| {
        let Some(p) = k.process_existing_mut(pid) else {
            return -(abi::ESRCH as i64);
        };
        if !has_buffer_capacity(p.stdin_buffer.len(), payload.len()) {
            return -(abi::EAGAIN as i64);
        }
        p.stdin_buffer.extend(payload);
        payload.len() as i64
    })
}

/// `kernel_drain_stdout|stderr(target_pid)`. KernelHostInterface-only;
/// drains the target process's stdout (or stderr) buffer into the
/// response. Returns bytes read.
fn drain_stream(request: &[u8], response: &mut [u8], stdout: bool) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let Some(p) = k.process_existing_mut(pid) else {
            return -(abi::ESRCH as i64);
        };
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

/// `kernel_close_stdin(target_pid)`. KernelHostInterface-only; marks the
/// target process's stdin as EOF.
fn close_stdin(request: &[u8]) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let Some(p) = k.process_existing_mut(pid) else {
            return -(abi::ESRCH as i64);
        };
        p.stdin_eof = true;
        0
    })
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

fn encode_thread_list(entries: &[crate::kernel::ThreadRecord]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + entries.len() * 16);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in entries {
        out.extend_from_slice(&entry.tid.to_le_bytes());
        out.push(match entry.state {
            crate::kernel::ThreadState::Runnable => 1,
            crate::kernel::ThreadState::Blocked => 2,
            crate::kernel::ThreadState::Exited => 3,
        });
        out.push(u8::from(entry.detached));
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&entry.exit_value.unwrap_or(-1).to_le_bytes());
        out.extend_from_slice(&entry.host_thread_handle.unwrap_or(-1).to_le_bytes());
    }
    out
}

pub fn list_threads_response(request: &[u8], response: &mut [u8]) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    with_kernel(|k| {
        let encoded = encode_thread_list(&k.list_threads(pid));
        if response.len() < encoded.len() {
            return encoded.len() as i64;
        }
        response[..encoded.len()].copy_from_slice(&encoded);
        encoded.len() as i64
    })
}

pub fn schedule_next_response(response: &mut [u8]) -> i64 {
    const NEED: usize = 24;
    if response.len() < NEED {
        return NEED as i64;
    }
    with_kernel(|k| {
        let Some(decision) = k.schedule_next() else {
            return -(abi::EAGAIN as i64);
        };
        response[0..4].copy_from_slice(&decision.pid.to_le_bytes());
        response[4..8].copy_from_slice(&decision.tid.to_le_bytes());
        response[8..12].copy_from_slice(&decision.host_thread_handle.unwrap_or(-1).to_le_bytes());
        response[12..16].copy_from_slice(&0u32.to_le_bytes());
        response[16..24].copy_from_slice(&decision.budget_ns.to_le_bytes());
        NEED as i64
    })
}

const SNAPSHOT_MAGIC: &[u8; 8] = b"YURTSNP\0";
const SNAPSHOT_VERSION: u16 = 1;
const SNAPSHOT_SECTION_PROCESSES: u32 = 1;
const SNAPSHOT_SECTION_THREAD_GROUPS: u32 = 2;
const SNAPSHOT_SECTION_WAITS: u32 = 3;
const SNAPSHOT_SECTION_RUNNABLE_THREADS: u32 = 4;

fn wait_reason_code(reason: crate::kernel::WaitReason) -> u32 {
    match reason {
        crate::kernel::WaitReason::HostBlock => 1,
    }
}

fn encode_thread_groups(
    k: &crate::kernel::Kernel,
    processes: &[crate::kernel::ProcessListEntry],
) -> Vec<u8> {
    let mut groups = Vec::new();
    groups.extend_from_slice(&(processes.len() as u32).to_le_bytes());
    for process in processes {
        let threads = encode_thread_list(&k.list_threads(process.pid));
        groups.extend_from_slice(&process.pid.to_le_bytes());
        groups.extend_from_slice(&(threads.len() as u32).to_le_bytes());
        groups.extend_from_slice(&threads);
    }
    groups
}

fn encode_wait_records(entries: &[crate::kernel::WaitRecord]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + entries.len() * 16);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in entries {
        out.extend_from_slice(&entry.pid.to_le_bytes());
        out.extend_from_slice(&entry.tid.to_le_bytes());
        out.extend_from_slice(&wait_reason_code(entry.reason).to_le_bytes());
        out.extend_from_slice(&entry.detail.to_le_bytes());
    }
    out
}

fn encode_runnable_threads(entries: &[crate::kernel::RunnableThread]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + entries.len() * 8);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in entries {
        out.extend_from_slice(&entry.pid.to_le_bytes());
        out.extend_from_slice(&entry.tid.to_le_bytes());
    }
    out
}

fn push_snapshot_section(out: &mut Vec<u8>, section_type: u32, body: &[u8]) {
    out.extend_from_slice(&section_type.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
}

pub fn snapshot_response(response: &mut [u8]) -> i64 {
    with_kernel(|k| {
        let processes = k.list_processes();
        let process_section = encode_process_list(&processes);
        let thread_section = encode_thread_groups(k, &processes);
        let wait_section = encode_wait_records(&k.list_waits());
        let runnable_section = encode_runnable_threads(&k.list_runnable_threads());
        let mut encoded = Vec::with_capacity(
            16 + 8
                + process_section.len()
                + 8
                + thread_section.len()
                + 8
                + wait_section.len()
                + 8
                + runnable_section.len(),
        );
        encoded.extend_from_slice(SNAPSHOT_MAGIC);
        encoded.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
        encoded.extend_from_slice(&4u16.to_le_bytes());
        encoded.extend_from_slice(&0u32.to_le_bytes());
        push_snapshot_section(&mut encoded, SNAPSHOT_SECTION_PROCESSES, &process_section);
        push_snapshot_section(
            &mut encoded,
            SNAPSHOT_SECTION_THREAD_GROUPS,
            &thread_section,
        );
        push_snapshot_section(&mut encoded, SNAPSHOT_SECTION_WAITS, &wait_section);
        push_snapshot_section(
            &mut encoded,
            SNAPSHOT_SECTION_RUNNABLE_THREADS,
            &runnable_section,
        );
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
        let Some(p) = (if target_arg == 0 || target == caller_pid {
            Some(k.process_mut(target))
        } else {
            k.process_existing_mut(target)
        }) else {
            return -(abi::ESRCH as i64);
        };
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
        let Some(p) = (if target_arg == 0 || target == caller_pid {
            Some(k.process_mut(target))
        } else {
            k.process_existing_mut(target)
        }) else {
            return -(abi::ESRCH as i64);
        };
        p.pgid = new_pgid;
        0
    })
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
        let Some(p) = (if target_arg == 0 || target == caller_pid {
            Some(k.process_mut(target))
        } else {
            k.process_existing_mut(target)
        }) else {
            return -(abi::ESRCH as i64);
        };
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
    with_kernel(|k| {
        let p = k.process_mut(target);
        p.pending_signals |= 1u64 << (sig - 1);
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
    let Some(pid) = with_kernel(|k| k.try_alloc_host_pid()) else {
        return -(abi::EAGAIN as i64);
    };
    let mut context = Vec::with_capacity(12 + argv_request.len());
    context.extend_from_slice(&1_u16.to_le_bytes()); // spawn_context_v1
    context.extend_from_slice(&0_u16.to_le_bytes()); // flags
    context.extend_from_slice(&pid.to_le_bytes());
    context.extend_from_slice(&(argv_request.len() as u32).to_le_bytes());
    context.extend_from_slice(argv_request);
    let handle = kh::spawn_process(module_id, &context);
    if handle < 0 {
        with_kernel(|k| k.release_host_pid_reservation(pid));
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

/// `kernel_record_exit(pid, exit_status)`. KernelHostInterface-only; marks
/// `pid` as zombie with the given exit status. The next sys_wait
/// from its parent will reap it.
pub fn record_exit(request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let pid = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let status = i32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    with_kernel(|k| {
        if !k.has_process(pid) {
            return -(abi::ESRCH as i64);
        }
        k.process_mut(pid).exit_status = Some(status);
        0
    })
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

/// `mkdir(path) -> 0 / -EEXIST / -EROFS`.
fn mkdir(caller_pid: u32, request: &[u8]) -> i64 {
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
fn rmdir(caller_pid: u32, request: &[u8]) -> i64 {
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
fn readdir(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
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
    with_kernel(|k| {
        let link_path = match PathResolver::new(k, caller_pid).normalize(link_path_raw) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        k.vfs.symlink(target, &link_path) as i64
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

/// `sys_spawn(path_len, path, (arg_len, arg)*)`. Reads the wasm
/// image from the VFS, allocates a child pid (kernel range starts
/// at 1000), records the parent/child relationship, and stages a
/// PendingSpawn for the host to run. Returns the child pid.
fn sys_spawn(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let path_len = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
    let Some(path_end) = 4usize.checked_add(path_len) else {
        return -(abi::EINVAL as i64);
    };
    if request.len() < path_end {
        return -(abi::EINVAL as i64);
    }
    let raw_path = &request[4..path_end];
    if raw_path.is_empty() {
        return -(abi::EINVAL as i64);
    }
    // Decode argv list from the trailing bytes.
    let mut argv: Vec<Vec<u8>> = Vec::new();
    let mut cursor = path_end;
    while cursor
        .checked_add(4)
        .is_some_and(|end| end <= request.len())
    {
        let alen =
            u32::from_le_bytes(request[cursor..cursor + 4].try_into().expect("4 bytes")) as usize;
        cursor += 4;
        let Some(arg_end) = cursor.checked_add(alen) else {
            return -(abi::EINVAL as i64);
        };
        if arg_end > request.len() {
            return -(abi::EINVAL as i64);
        }
        argv.push(request[cursor..arg_end].to_vec());
        cursor = arg_end;
    }

    with_kernel(|k| {
        let path = match PathResolver::new(k, caller_pid).normalize(raw_path) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        // Read the image bytes from VFS.
        let mut exec_path: Vec<u8> = path;
        let mut hops = 0u32;
        while let Some(target) = k.vfs.readlink(&exec_path) {
            hops += 1;
            if hops > 40 {
                return -(abi::EINVAL as i64);
            }
            exec_path = target;
        }
        let Some((mount_id, inode)) = k.vfs.open(&exec_path, 0) else {
            return -(abi::ENOENT as i64);
        };
        let size = k.vfs.size(mount_id, inode).unwrap_or(0) as usize;
        let mut wasm = vec![0u8; size];
        let n = k.vfs.read(mount_id, inode, 0, &mut wasm);
        if n < 0 {
            return n;
        }
        wasm.truncate(n as usize);

        let Some(child_pid) = k.try_alloc_spawn_pid() else {
            return -(abi::EAGAIN as i64);
        };
        // Wire POSIX fork-like inheritance before exec: cwd,
        // credentials, resource limits, signal dispositions, process
        // group/session, scheduler state, and the open fd table all
        // come from the parent. The executable image and argv are
        // then replaced by exec semantics.
        let (
            parent_umask,
            parent_credentials,
            parent_cwd,
            parent_rlimits,
            parent_fd_entries,
            parent_nice,
            parent_policy,
            parent_priority,
            parent_pgid,
            parent_sid,
            parent_signal_dispositions,
        ) = {
            let parent = k.process_mut(caller_pid);
            (
                parent.umask,
                parent.credentials,
                parent.cwd.clone(),
                parent.rlimits,
                parent.fd_table.entries(),
                parent.nice,
                parent.scheduler_policy,
                parent.scheduler_priority,
                parent.pgid,
                parent.sid,
                parent.signal_dispositions,
            )
        };
        for (_, entry) in &parent_fd_entries {
            inc_entry_ref(k, entry);
        }
        {
            let child = k.process_mut(child_pid);
            child.ppid = caller_pid;
            child.argv = argv.clone();
            child.umask = parent_umask;
            child.credentials = parent_credentials;
            child.cwd = parent_cwd;
            child.rlimits = parent_rlimits;
            child.fd_table = crate::kernel::FdTable::from_entries(parent_fd_entries);
            child.nice = parent_nice;
            child.scheduler_policy = parent_policy;
            child.scheduler_priority = parent_priority;
            child.pgid = parent_pgid;
            child.sid = parent_sid;
            child.signal_dispositions = parent_signal_dispositions;
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
            return need as i64;
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
fn readlink(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
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
fn realpath(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
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
fn unlink(caller_pid: u32, request: &[u8]) -> i64 {
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
fn stat_path(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
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
fn utimens(caller_pid: u32, request: &[u8]) -> i64 {
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
fn chmod(caller_pid: u32, request: &[u8]) -> i64 {
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
