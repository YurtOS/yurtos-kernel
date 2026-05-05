//! Wrapper for `dup2(2)` (§Runtime Semantics > File Descriptors).

use core::ffi::c_int;

/// Read the current `errno` value in a platform-portable way.
#[inline]
fn errno() -> c_int {
    // SAFETY: both accessors return a valid pointer to thread-local errno.
    unsafe {
        #[cfg(target_os = "linux")]
        { *libc::__errno_location() }
        #[cfg(not(target_os = "linux"))]
        { *libc::__error() }
    }
}

/// Renumber the open guest-visible fd `oldfd` onto `newfd`. Returns the
/// new fd on success; on failure returns the captured `errno` value
/// (POSIX numbering — WASI's EBADF is 8).
pub fn dup2(oldfd: c_int, newfd: c_int) -> Result<c_int, c_int> {
    // SAFETY: libc::dup2 is FFI; both args are integers and validation
    // happens in the runtime impl.
    let rc = unsafe { libc::dup2(oldfd, newfd) };
    if rc < 0 {
        Err(errno())
    } else {
        Ok(rc)
    }
}
