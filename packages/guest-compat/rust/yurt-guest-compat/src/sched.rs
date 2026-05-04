//! Wrappers for `sched_getaffinity`, `sched_setaffinity`, `sched_getcpu`
//! (§Runtime Semantics > Affinity).
//!
//! These APIs are Linux-specific. On non-Linux host builds the module is
//! compiled but all public items are `#[cfg(target_os = "linux")]` — this
//! satisfies the host type-check requirement while keeping the code
//! honest about platform availability.

#[cfg(target_os = "linux")]
use core::ffi::c_int;

/// Read the current `errno` value in a platform-portable way.
#[cfg(target_os = "linux")]
#[inline]
fn errno() -> c_int {
    unsafe { *libc::__errno_location() }
}

/// Return the set of CPUs the guest is allowed to run on. The yurt
/// runtime always reports a single visible CPU (CPU 0) per the runtime
/// semantics; callers receive a freshly-zeroed `cpu_set_t` with bit 0 set.
#[cfg(target_os = "linux")]
pub fn get_affinity() -> Result<libc::cpu_set_t, c_int> {
    use core::mem::{size_of, zeroed};
    let mut mask: libc::cpu_set_t = unsafe { zeroed() };
    let rc = unsafe { libc::sched_getaffinity(0, size_of::<libc::cpu_set_t>(), &mut mask) };
    if rc != 0 {
        Err(errno())
    } else {
        Ok(mask)
    }
}

/// Set the CPU mask. Only the mask `{CPU 0}` is accepted; any other
/// mask is rejected with EINVAL.
#[cfg(target_os = "linux")]
pub fn set_affinity(mask: &libc::cpu_set_t) -> Result<(), c_int> {
    use core::mem::size_of;
    let rc = unsafe { libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), mask) };
    if rc != 0 {
        Err(errno())
    } else {
        Ok(())
    }
}

/// Return the running CPU. Always 0 for yurt guests.
#[cfg(target_os = "linux")]
pub fn get_cpu() -> c_int {
    unsafe { libc::sched_getcpu() }
}
