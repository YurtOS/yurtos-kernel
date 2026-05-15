#![cfg_attr(not(test), no_std)]

use core::ffi::{c_int, c_void};

const YURT_RS_SOCKET_IOV_OK: c_int = 0;
const YURT_RS_SOCKET_IOV_EFAULT: c_int = -1;
const YURT_RS_SOCKET_IOV_EOVERFLOW: c_int = -2;

#[repr(C)]
pub struct YurtIovec {
    base: *mut c_void,
    len: usize,
}

fn iovecs<'a>(iov: *const YurtIovec, iovlen: usize) -> Result<&'a [YurtIovec], c_int> {
    if iovlen == 0 {
        return Ok(&[]);
    }
    if iov.is_null() {
        return Err(YURT_RS_SOCKET_IOV_EFAULT);
    }
    // SAFETY: The C POSIX shim passes the caller-owned iovec array and length.
    // We reject null for nonzero lengths and only read the array descriptors.
    Ok(unsafe { core::slice::from_raw_parts(iov, iovlen) })
}

fn read_iovec_bytes<'a>(iov: &YurtIovec) -> Result<&'a [u8], c_int> {
    if iov.len == 0 {
        return Ok(&[]);
    }
    if iov.base.is_null() {
        return Err(YURT_RS_SOCKET_IOV_EFAULT);
    }
    // SAFETY: POSIX iovec entries with nonzero `iov_len` must point at readable
    // storage for that many bytes. The shim validates null before constructing
    // the slice and does not retain it after the call.
    Ok(unsafe { core::slice::from_raw_parts(iov.base.cast::<u8>(), iov.len) })
}

fn write_iovec_bytes<'a>(iov: &YurtIovec) -> Result<&'a mut [u8], c_int> {
    if iov.len == 0 {
        return Ok(&mut []);
    }
    if iov.base.is_null() {
        return Err(YURT_RS_SOCKET_IOV_EFAULT);
    }
    // SAFETY: POSIX iovec entries supplied to recvmsg with nonzero `iov_len`
    // must point at writable storage. The shim validates null before
    // constructing the temporary slice.
    Ok(unsafe { core::slice::from_raw_parts_mut(iov.base.cast::<u8>(), iov.len) })
}

fn write_usize(out: *mut usize, value: usize) -> Result<(), c_int> {
    if out.is_null() {
        return Err(YURT_RS_SOCKET_IOV_EFAULT);
    }
    // SAFETY: The C shim passes a valid pointer to one `usize` result slot.
    unsafe {
        *out = value;
    }
    Ok(())
}

fn total_iov_len(iov: &[YurtIovec]) -> Result<usize, c_int> {
    let mut total = 0usize;
    for item in iov {
        if item.len > 0 && item.base.is_null() {
            return Err(YURT_RS_SOCKET_IOV_EFAULT);
        }
        total = total
            .checked_add(item.len)
            .ok_or(YURT_RS_SOCKET_IOV_EOVERFLOW)?;
    }
    Ok(total)
}

#[no_mangle]
pub extern "C" fn yurt_rs_socket_iov_total(
    iov: *const YurtIovec,
    iovlen: usize,
    out_total: *mut usize,
) -> c_int {
    let iov = match iovecs(iov, iovlen) {
        Ok(iov) => iov,
        Err(rc) => return rc,
    };
    let total = match total_iov_len(iov) {
        Ok(total) => total,
        Err(rc) => return rc,
    };
    match write_usize(out_total, total) {
        Ok(()) => YURT_RS_SOCKET_IOV_OK,
        Err(rc) => rc,
    }
}

#[no_mangle]
pub extern "C" fn yurt_rs_socket_iov_gather(
    iov: *const YurtIovec,
    iovlen: usize,
    dst: *mut u8,
    dst_cap: usize,
    out_total: *mut usize,
) -> c_int {
    let iov = match iovecs(iov, iovlen) {
        Ok(iov) => iov,
        Err(rc) => return rc,
    };
    let total = match total_iov_len(iov) {
        Ok(total) => total,
        Err(rc) => return rc,
    };
    if total > dst_cap {
        return YURT_RS_SOCKET_IOV_EOVERFLOW;
    }
    if total > 0 && dst.is_null() {
        return YURT_RS_SOCKET_IOV_EFAULT;
    }
    let mut offset = 0usize;
    for item in iov {
        let bytes = match read_iovec_bytes(item) {
            Ok(bytes) => bytes,
            Err(rc) => return rc,
        };
        if !bytes.is_empty() {
            // SAFETY: `total <= dst_cap`, `dst` is non-null when total is
            // nonzero, and `offset..offset+bytes.len()` is within dst.
            unsafe {
                core::ptr::copy_nonoverlapping(bytes.as_ptr(), dst.add(offset), bytes.len());
            }
        }
        offset += bytes.len();
    }
    match write_usize(out_total, total) {
        Ok(()) => YURT_RS_SOCKET_IOV_OK,
        Err(rc) => rc,
    }
}

#[no_mangle]
pub extern "C" fn yurt_rs_socket_iov_scatter(
    iov: *const YurtIovec,
    iovlen: usize,
    src: *const u8,
    src_len: usize,
    out_copied: *mut usize,
) -> c_int {
    if src_len > 0 && src.is_null() {
        return YURT_RS_SOCKET_IOV_EFAULT;
    }
    let iov = match iovecs(iov, iovlen) {
        Ok(iov) => iov,
        Err(rc) => return rc,
    };
    let mut copied = 0usize;
    for item in iov {
        if copied >= src_len {
            break;
        }
        let dst = match write_iovec_bytes(item) {
            Ok(dst) => dst,
            Err(rc) => return rc,
        };
        let copy = dst.len().min(src_len - copied);
        if copy > 0 {
            // SAFETY: `src` is non-null for nonzero `src_len`, and
            // `copied..copied+copy` stays within `src_len`.
            unsafe {
                core::ptr::copy_nonoverlapping(src.add(copied), dst.as_mut_ptr(), copy);
            }
        }
        copied += copy;
    }
    match write_usize(out_copied, copied) {
        Ok(()) => YURT_RS_SOCKET_IOV_OK,
        Err(rc) => rc,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gathers_iovecs_with_checked_total() {
        let mut left = *b"ab";
        let mut right = *b"cde";
        let iov = [
            YurtIovec {
                base: left.as_mut_ptr().cast(),
                len: left.len(),
            },
            YurtIovec {
                base: right.as_mut_ptr().cast(),
                len: right.len(),
            },
        ];
        let mut dst = [0u8; 5];
        let mut total = 0usize;
        assert_eq!(
            yurt_rs_socket_iov_gather(
                iov.as_ptr(),
                iov.len(),
                dst.as_mut_ptr(),
                dst.len(),
                &mut total,
            ),
            0
        );
        assert_eq!(total, 5);
        assert_eq!(&dst, b"abcde");
    }

    #[test]
    fn scatter_stops_at_source_length() {
        let mut left = [0u8; 2];
        let mut right = [0u8; 3];
        let iov = [
            YurtIovec {
                base: left.as_mut_ptr().cast(),
                len: left.len(),
            },
            YurtIovec {
                base: right.as_mut_ptr().cast(),
                len: right.len(),
            },
        ];
        let mut copied = 0usize;
        assert_eq!(
            yurt_rs_socket_iov_scatter(iov.as_ptr(), iov.len(), b"xyz".as_ptr(), 3, &mut copied,),
            0
        );
        assert_eq!(copied, 3);
        assert_eq!(&left, b"xy");
        assert_eq!(&right, b"z\0\0");
    }

    #[test]
    fn rejects_null_iovec_base_for_nonzero_len() {
        let iov = [YurtIovec {
            base: core::ptr::null_mut(),
            len: 1,
        }];
        let mut dst = [0u8; 1];
        let mut total = 0usize;
        assert_eq!(
            yurt_rs_socket_iov_gather(
                iov.as_ptr(),
                iov.len(),
                dst.as_mut_ptr(),
                dst.len(),
                &mut total,
            ),
            YURT_RS_SOCKET_IOV_EFAULT
        );
    }
}
