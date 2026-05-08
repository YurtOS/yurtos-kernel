//! Wrappers for the narrow signal surface (§Runtime Semantics > Signals).
//! Only the helpers most useful from idiomatic Rust are wrapped — the
//! sigset_t bit ops (sigemptyset/sigfillset/sigaddset/sigdelset/sigismember)
//! are kept FFI-direct since they're cheap and Rust users typically reach
//! for `signal-hook` for richer ergonomics.

use core::ffi::c_int;
use core::mem::zeroed;

/// Read the current `errno` value in a platform-portable way.
#[inline]
fn errno() -> c_int {
    // SAFETY: both accessors return a valid pointer to thread-local errno.
    unsafe {
        #[cfg(target_os = "linux")]
        {
            *libc::__errno_location()
        }
        #[cfg(not(target_os = "linux"))]
        {
            *libc::__error()
        }
    }
}

/// `signal(sig, handler)` — install the legacy handler. Returns the
/// previous handler on success; SIG_ERR on failure.
///
/// # Safety
/// The handler runs in async-signal context. It must only call
/// async-signal-safe functions.
pub unsafe fn install_handler(sig: c_int, handler: libc::sighandler_t) -> libc::sighandler_t {
    libc::signal(sig, handler)
}

/// `raise(sig)` — synchronously deliver `sig` to the current process.
pub fn raise(sig: c_int) -> Result<(), c_int> {
    let rc = unsafe { libc::raise(sig) };
    if rc != 0 {
        Err(errno())
    } else {
        Ok(())
    }
}

/// `alarm(seconds)` — return the seconds remaining on the previous alarm.
pub fn alarm(seconds: u32) -> u32 {
    unsafe { libc::alarm(seconds) }
}

/// Build an empty signal set.
pub fn empty_set() -> Result<libc::sigset_t, c_int> {
    let mut set: libc::sigset_t = unsafe { zeroed() };
    let rc = unsafe { libc::sigemptyset(&mut set) };
    if rc != 0 {
        Err(errno())
    } else {
        Ok(set)
    }
}

/// Build a signal set with all signals.
pub fn full_set() -> Result<libc::sigset_t, c_int> {
    let mut set: libc::sigset_t = unsafe { zeroed() };
    let rc = unsafe { libc::sigfillset(&mut set) };
    if rc != 0 {
        Err(errno())
    } else {
        Ok(set)
    }
}

/// Get/set the guest-local signal mask. Note that yurt's signal layer
/// only observes signals raised by the guest itself (§Runtime Semantics
/// > Signals); the mask does not gate external delivery.
pub fn proc_mask(how: c_int, set: Option<&libc::sigset_t>) -> Result<libc::sigset_t, c_int> {
    let mut old: libc::sigset_t = unsafe { zeroed() };
    let set_ptr = set.map(|s| s as *const _).unwrap_or(core::ptr::null());
    let rc = unsafe { libc::sigprocmask(how, set_ptr, &mut old) };
    if rc != 0 {
        Err(errno())
    } else {
        Ok(old)
    }
}
