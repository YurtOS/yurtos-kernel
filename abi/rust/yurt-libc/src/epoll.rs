#![cfg_attr(not(test), no_std)]

//! Guest-side epoll request marshalling.
//!
//! `abi/src/yurt_epoll.c` is a thin ABI shim; all request byte-buffer
//! formatting lives here (AGENTS.md: buffer/parse/format logic belongs in
//! safe Rust, C files are thin ABI shims). Wire layouts mirror the
//! kernel-side decoders documented in `abi/contract/yurt_abi_methods.toml`
//! (`sys_epoll_ctl` / `sys_epoll_wait`).

use core::ffi::c_int;

const YURT_RS_EPOLL_OK: c_int = 0;
const YURT_RS_EPOLL_EFAULT: c_int = -1;

/// Pack an `epoll_ctl` request: `u32 epfd | u32 op | u32 fd | 12-byte
/// epoll_event`, little-endian, 24 bytes total. `event` points at the
/// 12-byte packed `epoll_event` wire image, or is null for
/// `EPOLL_CTL_DEL` (the 12-byte slot is then zero-filled). `out` must be
/// writable for 24 bytes. Returns 0, or -1 if `out` is null.
#[no_mangle]
pub extern "C" fn yurt_rs_epoll_pack_ctl(
    out: *mut u8,
    epfd: u32,
    op: u32,
    fd: u32,
    event: *const u8,
) -> c_int {
    if out.is_null() {
        return YURT_RS_EPOLL_EFAULT;
    }
    // SAFETY: the C shim guarantees `out` is writable for 24 bytes (a
    // stack `unsigned char[24]`); the slice is not retained past return.
    let buf = unsafe { core::slice::from_raw_parts_mut(out, 24) };
    buf[0..4].copy_from_slice(&epfd.to_le_bytes());
    buf[4..8].copy_from_slice(&op.to_le_bytes());
    buf[8..12].copy_from_slice(&fd.to_le_bytes());
    if event.is_null() {
        buf[12..24].fill(0);
    } else {
        // SAFETY: when non-null the C shim passes a 12-byte packed
        // `epoll_event` wire image; only those 12 bytes are read.
        let ev = unsafe { core::slice::from_raw_parts(event, 12) };
        buf[12..24].copy_from_slice(ev);
    }
    YURT_RS_EPOLL_OK
}

/// Pack an `epoll_wait` request: `u32 epfd | u32 maxevents | i32
/// timeout`, little-endian, 12 bytes. `out` must be writable for 12
/// bytes. Returns 0, or -1 if `out` is null.
#[no_mangle]
pub extern "C" fn yurt_rs_epoll_pack_wait(
    out: *mut u8,
    epfd: u32,
    maxevents: u32,
    timeout: i32,
) -> c_int {
    if out.is_null() {
        return YURT_RS_EPOLL_EFAULT;
    }
    // SAFETY: the C shim guarantees `out` is writable for 12 bytes (a
    // stack `unsigned char[12]`); the slice is not retained past return.
    let buf = unsafe { core::slice::from_raw_parts_mut(out, 12) };
    buf[0..4].copy_from_slice(&epfd.to_le_bytes());
    buf[4..8].copy_from_slice(&maxevents.to_le_bytes());
    buf[8..12].copy_from_slice(&timeout.to_le_bytes());
    YURT_RS_EPOLL_OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_ctl_with_event() {
        let event = [
            0x01, 0x00, 0x00, 0x00, // events = 1 (LE u32)
            0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x00, // data (LE u64)
        ];
        let mut out = [0xAAu8; 24];
        assert_eq!(
            yurt_rs_epoll_pack_ctl(out.as_mut_ptr(), 3, 1, 7, event.as_ptr()),
            0
        );
        assert_eq!(&out[0..4], &3u32.to_le_bytes());
        assert_eq!(&out[4..8], &1u32.to_le_bytes());
        assert_eq!(&out[8..12], &7u32.to_le_bytes());
        assert_eq!(&out[12..24], &event);
    }

    #[test]
    fn pack_ctl_null_event_zero_fills_slot() {
        let mut out = [0xAAu8; 24];
        assert_eq!(
            yurt_rs_epoll_pack_ctl(out.as_mut_ptr(), 9, 2, 4, core::ptr::null()),
            0
        );
        assert_eq!(&out[0..4], &9u32.to_le_bytes());
        assert_eq!(&out[4..8], &2u32.to_le_bytes());
        assert_eq!(&out[8..12], &4u32.to_le_bytes());
        assert_eq!(&out[12..24], &[0u8; 12]);
    }

    #[test]
    fn pack_ctl_rejects_null_out() {
        assert_eq!(
            yurt_rs_epoll_pack_ctl(core::ptr::null_mut(), 1, 1, 1, core::ptr::null()),
            -1
        );
    }

    #[test]
    fn pack_wait_layout() {
        let mut out = [0u8; 12];
        assert_eq!(yurt_rs_epoll_pack_wait(out.as_mut_ptr(), 5, 64, -1), 0);
        assert_eq!(&out[0..4], &5u32.to_le_bytes());
        assert_eq!(&out[4..8], &64u32.to_le_bytes());
        assert_eq!(&out[8..12], &(-1i32).to_le_bytes());
    }

    #[test]
    fn pack_wait_rejects_null_out() {
        assert_eq!(yurt_rs_epoll_pack_wait(core::ptr::null_mut(), 1, 1, 0), -1);
    }
}
