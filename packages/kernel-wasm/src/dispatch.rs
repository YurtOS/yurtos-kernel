//! Method-id dispatch table.
//!
//! `method_id` is a stable u32 assigned to each user-syscall import in
//! `abi/contract/yurt_abi.toml`, plus a small reserved range for
//! kernel-internal methods used by the microkernel trampoline. IDs are
//! never reused or renumbered; new methods append.
//!
//!   0          — reserved for negotiation / health
//!   1          — KERNEL_ECHO (kernel-internal; round-trips the request
//!                bytes into the response buffer; lets the microkernel
//!                prove memory-mediated request/response works without
//!                pulling in real syscall semantics)
//!   2          — KERNEL_NOW_REALTIME (kernel-internal; round-trips a
//!                kh_now_realtime call and writes the resulting u64
//!                into the response buffer; lets the microkernel prove
//!                the kernel→host direction works end-to-end without
//!                a real syscall)
//!   3..=0xFFFF — kernel-internal range
//!   0x1_0000+  — generated from yurt_abi.toml (Phase 2+)

use crate::abi;
use crate::kh;

pub const METHOD_ECHO: u32 = 1;
pub const METHOD_NOW_REALTIME: u32 = 2;

pub fn dispatch(method_id: u32, request: &[u8], response: &mut [u8]) -> i64 {
    match method_id {
        METHOD_ECHO => echo(request, response),
        METHOD_NOW_REALTIME => now_realtime(response),
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
        assert_eq!(dispatch(METHOD_ECHO, b"hello", &mut out), 4);
        assert_eq!(&out, b"hell");
    }

    #[test]
    fn echo_handles_empty_request() {
        let mut out = [0u8; 8];
        assert_eq!(dispatch(METHOD_ECHO, &[], &mut out), 0);
    }
}
