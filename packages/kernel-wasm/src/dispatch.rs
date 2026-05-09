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
use crate::kh;
use crate::state::Credentials;

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
        METHOD_SYS_GETUID => Credentials::DEFAULT.uid as i64,
        METHOD_SYS_GETEUID => Credentials::DEFAULT.euid as i64,
        METHOD_SYS_GETGID => Credentials::DEFAULT.gid as i64,
        METHOD_SYS_GETEGID => Credentials::DEFAULT.egid as i64,
        METHOD_SYS_GETPID => caller_pid as i64,
        // No process tree yet: every process's parent is the kernel
        // itself. Once the spawn syscall lands and the kernel tracks a
        // real Process map, this reads ppid from that map.
        METHOD_SYS_GETPPID => KERNEL_PID as i64,
        METHOD_SYS_EXTENSION_INVOKE => kh::extension_invoke(request, response),
        _ => -(abi::ENOSYS as i64),
    }
}

fn echo(request: &[u8], response: &mut [u8]) -> i64 {
    let n = request.len().min(response.len());
    response[..n].copy_from_slice(&request[..n]);
    n as i64
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
