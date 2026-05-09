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
        METHOD_SYS_EXTENSION_INVOKE => kh::extension_invoke(request, response),
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
