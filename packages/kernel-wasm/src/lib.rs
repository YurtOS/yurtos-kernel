//! Yurt kernel, sandboxed.
//!
//! Compiled to `wasm32-wasip1` and instantiated by any microkernel host
//! (`microkernel-wasmtime`, `microkernel-js`, `microkernel-deno`,
//! bare `wasmtime run`, …). The host forwards each user `host_*` syscall
//! into [`kernel_dispatch`] after copying the request bytes into kernel
//! linear memory; the kernel writes the response back into the same
//! buffer and returns a scalar following the existing native-syscall
//! convention (`>= 0` success, `< 0` negated POSIX errno).
//!
//! See `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`
//! and `abi/contract/kernel_host_abi.toml`.

#![cfg_attr(target_arch = "wasm32", no_main)]

mod abi;
mod dispatch;
mod kernel;
mod kh;
mod state;
mod vfs;

pub use dispatch::dispatch;

/// Microkernel-shared scratch buffer.
///
/// The microkernel uses this region to stage syscall request and response
/// bytes for [`kernel_dispatch`] without needing a kernel-side allocator
/// in the hot path. Capacity is intentionally generous; individual
/// syscalls cap their own usage. See the trampoline protocol in
/// `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.
const SCRATCH_LEN: usize = 1024 * 1024;
static mut SCRATCH: [u8; SCRATCH_LEN] = [0; SCRATCH_LEN];

/// Offset of [`SCRATCH`] within this kernel instance's linear memory.
#[no_mangle]
pub extern "C" fn kernel_scratch_ptr() -> u32 {
    // No Rust reference to SCRATCH is ever formed outside the dispatch
    // path, where the microkernel passes its bounds back explicitly via
    // (in_ptr, in_len) / (out_ptr, out_cap). `&raw const` produces a
    // pointer without taking a reference and needs no unsafe block.
    (&raw const SCRATCH) as u32
}

/// Capacity of [`SCRATCH`] in bytes.
#[no_mangle]
pub extern "C" fn kernel_scratch_len() -> u32 {
    SCRATCH_LEN as u32
}

/// Host-callable entry point. Stable C ABI.
///
/// `method_id` is the stable u32 assigned in
/// `abi/contract/yurt_abi_methods.toml`. `caller_pid` identifies the
/// originating user process — `0` is reserved for the microkernel
/// itself (direct calls from outside any user process); user processes
/// start at `1`. `(in_ptr, in_len)` points at the request bytes the
/// microkernel copied out of the caller; the kernel writes the
/// response into `(out_ptr, out_cap)`. Return value is the syscall
/// scalar (`>= 0` success / `< 0` negated POSIX errno).
///
/// # Safety
///
/// The microkernel guarantees both slices live entirely inside this
/// kernel instance's linear memory and do not overlap.
#[no_mangle]
pub unsafe extern "C" fn kernel_dispatch(
    method_id: u32,
    caller_pid: u32,
    in_ptr: *const u8,
    in_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    let request = if in_ptr.is_null() || in_len == 0 {
        &[][..]
    } else {
        core::slice::from_raw_parts(in_ptr, in_len)
    };
    let response = if out_ptr.is_null() || out_cap == 0 {
        &mut [][..]
    } else {
        core::slice::from_raw_parts_mut(out_ptr, out_cap)
    };
    dispatch::dispatch(method_id, caller_pid, request, response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_method_returns_negated_enosys() {
        let mut out = [0u8; 16];
        let rc = unsafe {
            kernel_dispatch(
                0xDEAD_BEEF,
                0,
                core::ptr::null(),
                0,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert_eq!(rc, -(abi::ENOSYS as i64));
    }

    #[test]
    fn null_buffers_are_treated_as_empty() {
        let rc = unsafe {
            kernel_dispatch(
                0xDEAD_BEEF,
                0,
                core::ptr::null(),
                0,
                core::ptr::null_mut(),
                0,
            )
        };
        assert_eq!(rc, -(abi::ENOSYS as i64));
    }
}
