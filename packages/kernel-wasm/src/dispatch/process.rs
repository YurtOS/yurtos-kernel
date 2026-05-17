use crate::abi;
use crate::kernel::with_kernel;
use crate::kh;
use crate::path::PathResolver;

use super::{has_buffer_capacity, inc_entry_ref, read_u32_args, ID_NO_CHANGE};

fn requested_id_allowed(requested: u32, allowed: &[u32]) -> bool {
    requested == ID_NO_CHANGE || allowed.contains(&requested)
}

pub(super) fn setresuid(caller_pid: u32, request: &[u8]) -> i64 {
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

pub(super) fn setresgid(caller_pid: u32, request: &[u8]) -> i64 {
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

pub(super) fn getpriority(caller_pid: u32, request: &[u8]) -> i64 {
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

pub(super) fn setpriority(caller_pid: u32, request: &[u8]) -> i64 {
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

pub(super) fn sched_getscheduler(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([pid]) = read_u32_args::<1>(request) else {
        return -(abi::EINVAL as i64);
    };
    let target = scheduler_target_pid(caller_pid, pid);
    if !scheduler_target_exists(caller_pid, target) {
        return -(abi::ESRCH as i64);
    }
    with_kernel(|k| k.process_mut(target).scheduler_policy as i64)
}

pub(super) fn sched_getparam(caller_pid: u32, request: &[u8]) -> i64 {
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

pub(super) fn sched_setscheduler(caller_pid: u32, request: &[u8]) -> i64 {
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

pub(super) fn sched_setparam(caller_pid: u32, request: &[u8]) -> i64 {
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

pub(super) fn sched_getaffinity(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    let Some([pid, cpusetsize]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    let target = scheduler_target_pid(caller_pid, pid);
    if !scheduler_target_exists(caller_pid, target) {
        return -(abi::ESRCH as i64);
    }
    if cpusetsize < 4 {
        return -(abi::EINVAL as i64);
    }
    let cpusetsize = cpusetsize as usize;
    if response.len() < cpusetsize {
        return cpusetsize as i64;
    }
    response[..cpusetsize].fill(0);
    response[0] = 1;
    cpusetsize as i64
}

pub(super) fn sched_setaffinity(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([pid, cpusetsize]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    let target = scheduler_target_pid(caller_pid, pid);
    if !scheduler_target_exists(caller_pid, target) {
        return -(abi::ESRCH as i64);
    }
    if cpusetsize < 4 {
        return -(abi::EINVAL as i64);
    }
    let cpusetsize = cpusetsize as usize;
    let Some(end) = 8usize.checked_add(cpusetsize) else {
        return -(abi::EINVAL as i64);
    };
    if request.len() < end {
        return -(abi::EINVAL as i64);
    }
    let mask = &request[8..end];
    if mask.first().copied() != Some(1) || mask[1..].iter().any(|byte| *byte != 0) {
        return -(abi::EINVAL as i64);
    }
    0
}

/// `getrlimit(resource: u32) -> (soft, hard) as 16 bytes LE`.
pub(super) fn getrlimit(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
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
pub(super) fn provide_stdin(request: &[u8]) -> i64 {
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
pub(super) fn drain_stream(request: &[u8], response: &mut [u8], stdout: bool) -> i64 {
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
pub(super) fn close_stdin(request: &[u8]) -> i64 {
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
        out.extend_from_slice(
            &entry
                .exit_value
                .map(|exit_value| exit_value as i32)
                .unwrap_or(-1)
                .to_le_bytes(),
        );
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
pub(crate) const SNAPSHOT_SECTION_PROCESSES: u32 = 1;
pub(crate) const SNAPSHOT_SECTION_THREAD_GROUPS: u32 = 2;
pub(crate) const SNAPSHOT_SECTION_WAITS: u32 = 3;
pub(crate) const SNAPSHOT_SECTION_RUNNABLE_THREADS: u32 = 4;

fn wait_reason_code(reason: crate::kernel::WaitReason) -> u32 {
    match reason {
        crate::kernel::WaitReason::HostBlock => 1,
        crate::kernel::WaitReason::ThreadJoin { .. } => 2,
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

/// `setrlimit(resource: u32, soft: u64, hard: u64) -> 0 / -EINVAL / -EPERM`.
/// POSIX rule: a process may not raise its hard limit, only lower it;
/// soft must not exceed hard.
pub(super) fn setrlimit(caller_pid: u32, request: &[u8]) -> i64 {
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

pub(super) fn umask(caller_pid: u32, request: &[u8]) -> i64 {
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

/// Return the target's pgid. POSIX: a pgid of 0 in *the request* means
/// "the calling process". Per-pid pgid defaults to the pid itself on
/// first observation — a freshly-spawned process is its own group leader
/// until `setpgid` moves it.
pub(super) fn getpgid(caller_pid: u32, request: &[u8]) -> i64 {
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
/// make the target a new group leader).
pub(super) fn setpgid(caller_pid: u32, request: &[u8]) -> i64 {
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
        let Some((target_sid, is_session_leader)) = (if target_arg == 0 || target == caller_pid {
            let p = k.process_mut(target);
            Some((if p.sid == 0 { target } else { p.sid }, p.sid == target))
        } else {
            k.process_existing(target)
                .map(|p| (if p.sid == 0 { target } else { p.sid }, p.sid == target))
        }) else {
            return -(abi::ESRCH as i64);
        };
        if is_session_leader {
            return -(abi::EPERM as i64);
        }
        if new_pgid != target {
            match k.process_group_session(new_pgid) {
                Some(group_sid) if group_sid == target_sid => {}
                _ => return -(abi::EPERM as i64),
            }
        }
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

pub(super) fn getsid(caller_pid: u32, request: &[u8]) -> i64 {
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
pub(super) fn setsid(caller_pid: u32) -> i64 {
    with_kernel(|k| {
        let p = k.process_mut(caller_pid);
        if p.sid == caller_pid || p.pgid == caller_pid {
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

/// `sigqueue(pid, sig, value)` — POSIX real-time signal enqueue. The
/// caller (`caller_pid`) is the sender. Separated-producer model: the
/// RT signal lives ONLY in the target's `pending_rt` queue — it does
/// NOT touch `pending_signals` (the kill/SIGCHLD bitmask), so a bit
/// set by `kill()` for the same signo is never clobbered when the RT
/// queue later drains. `sigpending()` reports the union of both.
/// Consumption (`sigwaitinfo`/delivery) is gate-deferred.
pub(super) fn sigqueue(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 12 {
        return -(abi::EINVAL as i64);
    }
    let target = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let sig = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let value = i32::from_le_bytes(request[8..12].try_into().expect("4 bytes"));
    if sig > 63 {
        return -(abi::EINVAL as i64);
    }
    if !with_kernel(|k| k.has_process(target)) {
        return -(abi::ESRCH as i64);
    }
    if sig == 0 {
        // Existence probe only — POSIX performs error checking but
        // does not enqueue for sig 0.
        return 0;
    }
    with_kernel(|k| {
        let p = k.process_mut(target);
        // Bound the queue (Linux RLIMIT_SIGPENDING). The consumer
        // (sigwaitinfo/delivery) is gate-deferred, so without this an
        // unprivileged guest looping sigqueue would grow kernel memory
        // without bound.
        if p.pending_rt.len() >= crate::kernel::KERNEL_RT_SIGNAL_QUEUE_CAP {
            return -(abi::EAGAIN as i64);
        }
        p.pending_rt.push_back(crate::kernel::RtSignal {
            signo: sig,
            value,
            sender_pid: caller_pid,
        });
        // RT signals live ONLY in pending_rt — do not touch
        // pending_signals (the kill/SIGCHLD bitmask). sigpending()
        // reports the union, so a bit set by kill() for the same signo
        // is never clobbered when the RT queue later drains.
        0
    })
}

/// `sigwaitinfo(set)` — non-blocking RT-signal dequeue (B1.8-b).
/// Returns the oldest queued signal whose bit is in `set` and its
/// siginfo, removing it from the RT queue only. The kill/SIGCHLD
/// bitmask is left untouched (separate producer). True blocking
/// (suspend until a signal arrives) is gate-deferred — absent a
/// pending match this is -EAGAIN.
pub(super) fn sigwaitinfo(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 8 || response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    let set = u64::from_le_bytes(request[0..8].try_into().expect("8 bytes"));
    with_kernel(|k| {
        if !k.has_process(caller_pid) {
            return -(abi::ESRCH as i64);
        }
        let p = k.process_mut(caller_pid);
        // The `1..=63` guard is defensive only: the sole producer
        // (`sigqueue`) rejects signo>63 before push_back, so a stored
        // entry is always in range — it can never reject a real entry.
        let Some(idx) = p
            .pending_rt
            .iter()
            .position(|s| (1..=63).contains(&s.signo) && (set & (1u64 << (s.signo - 1))) != 0)
        else {
            return -(abi::EAGAIN as i64);
        };
        let sig = p.pending_rt.remove(idx).expect("idx from position");
        // Do NOT clear pending_signals here: that bitmask is owned by
        // kill()/SIGCHLD, not by the RT queue. The same signo set by
        // kill() must stay pending after the RT entry drains.
        // sigpending() derives RT-pending from pending_rt directly.
        const SI_QUEUE: i32 = -1;
        response[0..4].copy_from_slice(&(sig.signo as i32).to_le_bytes());
        response[4..8].copy_from_slice(&SI_QUEUE.to_le_bytes());
        response[8..12].copy_from_slice(&sig.sender_pid.to_le_bytes());
        response[12..16].copy_from_slice(&sig.value.to_le_bytes());
        16
    })
}

/// `sigpending()` — the caller's pending-signal set as a u64 bitmask
/// (bit sig-1): the union of the kill/SIGCHLD bitmask and the RT
/// queue (`pending_rt`). Pure read.
pub(super) fn sigpending(caller_pid: u32, response: &mut [u8]) -> i64 {
    if response.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        if !k.has_process(caller_pid) {
            return -(abi::ESRCH as i64);
        }
        let p = k.process_mut(caller_pid);
        // Union of the kill/SIGCHLD bitmask and RT-queued signals.
        // RT pending is derived from pending_rt so it never collides
        // with bits other producers set for the same signo.
        let mut mask = p.pending_signals;
        for s in &p.pending_rt {
            // Defensive only — `sigqueue` enforces signo in 1..=63 at
            // enqueue, so stored entries are always in range.
            if (1..=63).contains(&s.signo) {
                mask |= 1u64 << (s.signo - 1);
            }
        }
        response[0..8].copy_from_slice(&mask.to_le_bytes());
        8
    })
}

pub(super) fn kill_request(request: &[u8]) -> i64 {
    let Some([target, sig]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    kill_pid(target, sig)
}

pub(super) fn killpg_request(caller_pid: u32, request: &[u8]) -> i64 {
    let Some([pgid_arg, sig]) = read_u32_args::<2>(request) else {
        return -(abi::EINVAL as i64);
    };
    if sig > 63 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let pgid = if pgid_arg == 0 {
            let caller = k.process_mut(caller_pid);
            if caller.pgid == 0 {
                caller.pgid = caller_pid;
            }
            caller.pgid
        } else {
            pgid_arg
        };
        match k.kill_process_group(pgid, sig) {
            Ok(()) => 0,
            Err(errno) => -(errno as i64),
        }
    })
}

/// `sigaction(sig, disposition) -> previous_disposition`. Disposition
/// encoding is opaque to the kernel: 0/1 are SIG_DFL/SIG_IGN by
/// convention, anything else is a user-side handler value (typically
/// a wasm function table index). The kernel stores per-pid; user-side
/// libc wraps invocation when delivery lands.
pub(super) fn sigaction(caller_pid: u32, request: &[u8]) -> i64 {
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
pub(super) fn sched_yield(caller_pid: u32) -> i64 {
    with_kernel(|k| k.process_mut(caller_pid).yield_count += 1);
    0
}

/// `nanosleep(req: u64 ns)`. Phase 2: records the requested duration
/// per-pid and returns 0 immediately. Real wall-clock blocking needs
/// the AsyncBridge to suspend the process.
pub(super) fn nanosleep(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let ns = u64::from_le_bytes(request[..8].try_into().expect("8 bytes"));
    with_kernel(|k| k.process_mut(caller_pid).last_nanosleep_ns = ns);
    0
}

/// Test-only argv patch helper. Runtime spawn paths set Process.argv
/// when the process is created.
#[cfg(test)]
pub(crate) fn set_argv(request: &[u8]) -> i64 {
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
/// POSIX signal number for child termination. Signal numbers are used
/// as literals across this module (matching the kill path); the pending
/// bitmask packs them as `1 << (sig - 1)`.
const SIGCHLD: u32 = 17;

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
        // POSIX: the parent receives SIGCHLD when a child terminates.
        // ppid == 0 means "no parent / kernel is parent" — nothing to
        // signal. Same pending-bit convention as kill_pid.
        let ppid = k.process_mut(pid).ppid;
        if ppid != 0 && k.has_process(ppid) {
            k.process_mut(ppid).pending_signals |= 1u64 << (SIGCHLD - 1);
        }
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

/// `waitid(idtype, id, infop, options)` — POSIX siginfo-returning wait.
/// Request: u32 idtype LE (0=P_ALL, 1=P_PID, 2=P_PGID) + u32 id LE +
/// u32 options LE. Response: 20 bytes — i32 si_signo + i32 si_code +
/// u32 si_pid + u32 si_uid + i32 si_status, all LE.
///
/// First pass: terminated children only. The kernel decodes the current
/// $?-style status convention: 129..=192 is CLD_KILLED with
/// si_status = status - 128, and every other status is CLD_EXITED with
/// si_status = status. This remains lossy until #99 carries an explicit
/// exit-vs-signal discriminator, so literal exit codes 129..=192 are
/// reported as signal deaths and CLD_DUMPED is not expressible.
/// WSTOPPED/WCONTINUED are out of scope here. Blocking behaves like the
/// sys_wait path — no AsyncBridge yet, so "would block" is -EAGAIN.
/// Effective process group of `pid` under the lazy-zero model: a
/// stored `pgid` of 0 means "inherited", not "own group". A process
/// spawned before its parent materialized a group inherits 0, and is
/// in the *parent's* group — so walk parents until a concrete pgid is
/// found; a process with no live parent (kernel-parented) is its own
/// group leader. Non-vivifying (`process_existing`) so it never
/// auto-creates a `Process`, and depth-bounded (ppid chains are
/// shallow and acyclic).
fn effective_pgid(k: &crate::kernel::Kernel, pid: u32) -> u32 {
    let mut cur = pid;
    for _ in 0..64 {
        match k.process_existing(cur) {
            Some(p) if p.pgid != 0 => return p.pgid,
            Some(p) if p.ppid != 0 && p.ppid != cur => cur = p.ppid,
            _ => return cur,
        }
    }
    cur
}

pub(super) fn waitid(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    // Linux idtype values and option bits. P_ALL (0) is the `_` arm.
    const P_PID: u32 = 1;
    const P_PGID: u32 = 2;
    const WNOHANG: u32 = 1;
    const WEXITED: u32 = 4;
    const WNOWAIT: u32 = 0x0100_0000;
    const CLD_EXITED: i32 = 1;
    const CLD_KILLED: i32 = 2;

    let Some([idtype, id, options]) = read_u32_args::<3>(request) else {
        return -(abi::EINVAL as i64);
    };
    if response.len() < 20 {
        return -(abi::EINVAL as i64);
    }
    if idtype > P_PGID {
        return -(abi::EINVAL as i64);
    }
    // We only produce terminated-child events; POSIX requires at least
    // one wait-type bit, and ours must be WEXITED.
    if options & WEXITED == 0 {
        return -(abi::EINVAL as i64);
    }
    // Reject any bit outside the supported set. WSTOPPED/WCONTINUED are
    // real POSIX options we don't implement, and stale adapter garbage
    // must not be silently accepted and reap a child — the contract
    // promises -EINVAL for bad options (PR #54 review P2).
    if options & !(WNOHANG | WEXITED | WNOWAIT) != 0 {
        return -(abi::EINVAL as i64);
    }
    let nowait = options & WNOWAIT != 0;
    with_kernel(|k| {
        let children = k.process_mut(caller_pid).children.clone();
        if children.is_empty() {
            return -(abi::ECHILD as i64);
        }
        // POSIX: for P_PGID, id == 0 means the caller's own process
        // group. Resolve both the wanted group and each child's group
        // through the same lazy-zero-aware helper so a default-inherited
        // child (pgid still 0) is matched to the caller's group instead
        // of being treated as its own leader (PR #54 review P2).
        let want_pgid = if idtype == P_PGID && id == 0 {
            effective_pgid(k, caller_pid)
        } else {
            id
        };
        let candidates: Vec<u32> = match idtype {
            P_PID => {
                if children.contains(&id) {
                    vec![id]
                } else {
                    return -(abi::ECHILD as i64);
                }
            }
            P_PGID => children
                .iter()
                .copied()
                .filter(|&c| effective_pgid(k, c) == want_pgid)
                .collect(),
            _ => children, // P_ALL
        };
        if candidates.is_empty() {
            return -(abi::ECHILD as i64);
        }
        let Some((pid, status)) = candidates.iter().find_map(|&c| {
            // Non-vivifying, consistent with effective_pgid (PR #54
            // review nit). Entries come from `children` so they always
            // have a record; this just avoids the auto-vivify footgun.
            k.process_existing(c)
                .and_then(|p| p.exit_status)
                .map(|s| (c, s))
        }) else {
            // No matching child is in a waitable state. POSIX waitid:
            // with WNOHANG, return success with a zeroed siginfo
            // (si_signo == 0) — NOT an error. Without WNOHANG this
            // would block; absent an AsyncBridge we report would-block
            // as -EAGAIN, matching sys_wait.
            if options & WNOHANG != 0 {
                response[0..20].fill(0);
                return 20;
            }
            return -(abi::EAGAIN as i64);
        };
        let uid = k
            .process_existing(pid)
            .map(|p| p.credentials.uid)
            .unwrap_or(0);
        if !nowait {
            // Reap = detach from the parent's children list, exactly as
            // sys_wait/wait_response does. The zombie `Process` record
            // intentionally persists (shared pre-existing design); don't
            // "fix" this asymmetry here without changing sys_wait too.
            k.process_mut(caller_pid).children.retain(|&c| c != pid);
        }
        // Decode the kernel/host $?-style status: values 129..=192
        // are "killed by signal (status - 128)" for signals 1..=64.
        // Anything else is a normal exit with that code. CLD_DUMPED is
        // not expressible — the 8-byte wait record carries no
        // core-dump bit (tracked in the B1.2 follow-up).
        let (si_code, si_status) = if (129..=192).contains(&status) {
            (CLD_KILLED, status - 128)
        } else {
            (CLD_EXITED, status)
        };
        response[0..4].copy_from_slice(&(SIGCHLD as i32).to_le_bytes());
        response[4..8].copy_from_slice(&si_code.to_le_bytes());
        response[8..12].copy_from_slice(&pid.to_le_bytes());
        response[12..16].copy_from_slice(&uid.to_le_bytes());
        response[16..20].copy_from_slice(&si_status.to_le_bytes());
        20
    })
}

/// `sys_spawn(path_len, path, (arg_len, arg)*)`. Reads the wasm
/// image from the VFS, allocates a child pid (kernel range starts
/// at 1000), records the parent/child relationship, and stages a
/// PendingSpawn for the host to run. Returns the child pid.
pub(super) fn sys_spawn(caller_pid: u32, request: &[u8]) -> i64 {
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
                parent.fd_table.inheritable_entries(),
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
