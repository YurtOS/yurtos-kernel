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

/// Host-control export: serialize the kernel-owned process table.
///
/// The microkernel may expose this to embedders for observability, but
/// the table is authored here in kernel.wasm.
///
/// # Safety
///
/// The microkernel guarantees `out_ptr..out_ptr+out_cap` is a valid
/// writable range in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_list_processes(out_ptr: *mut u8, out_cap: usize) -> i64 {
    let response = if out_ptr.is_null() || out_cap == 0 {
        &mut [][..]
    } else {
        core::slice::from_raw_parts_mut(out_ptr, out_cap)
    };
    dispatch::list_processes_response(response)
}

/// Host-control export: send a signal through kernel-owned process state.
///
/// # Safety
///
/// No pointer arguments. Marked unsafe to keep the exported host-control API
/// uniform with the other raw C ABI entry points.
#[no_mangle]
pub unsafe extern "C" fn kernel_kill(pid: u32, signal: u32) -> i64 {
    dispatch::kill_pid(pid, signal)
}

/// Host-control export: wait/reap a child according to kernel process rules.
///
/// `caller_pid` is the process whose child set is being waited on. `child_pid`
/// is `0` for any child or a specific child pid. `flags` uses the same bit
/// layout as `sys_wait`; bit 0 is WNOHANG.
///
/// # Safety
///
/// The microkernel guarantees `out_ptr..out_ptr+out_cap` is a valid writable
/// range in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_wait(
    caller_pid: u32,
    child_pid: u32,
    flags: u32,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    let mut request = [0u8; 8];
    request[0..4].copy_from_slice(&child_pid.to_le_bytes());
    request[4..8].copy_from_slice(&flags.to_le_bytes());
    let response = if out_ptr.is_null() || out_cap == 0 {
        &mut [][..]
    } else {
        core::slice::from_raw_parts_mut(out_ptr, out_cap)
    };
    dispatch::wait_response(caller_pid, &request, response)
}

/// Host-control export: record process exit status in kernel-owned state.
///
/// This is the KH adapter notification used after a process instance returns
/// or traps with an exit status. The next kernel-owned wait can reap it.
///
/// # Safety
///
/// No pointer arguments. Marked unsafe to keep the exported host-control API
/// uniform with the other raw C ABI entry points.
#[no_mangle]
pub unsafe extern "C" fn kernel_record_exit(pid: u32, exit_status: i32) -> i64 {
    let mut request = [0u8; 8];
    request[0..4].copy_from_slice(&pid.to_le_bytes());
    request[4..8].copy_from_slice(&exit_status.to_le_bytes());
    dispatch::record_exit(&request)
}

/// Host-control export: drain the next kernel-staged user `sys_spawn`.
///
/// # Safety
///
/// The microkernel guarantees `out_ptr..out_ptr+out_cap` is a valid writable
/// range in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_drain_spawn(out_ptr: *mut u8, out_cap: usize) -> i64 {
    let response = if out_ptr.is_null() || out_cap == 0 {
        &mut [][..]
    } else {
        core::slice::from_raw_parts_mut(out_ptr, out_cap)
    };
    dispatch::drain_spawn(response)
}

/// Host-control export: ask the kernel to spawn a cached process module.
///
/// The module id names a wasm module already cached in the KH adapter. The
/// kernel allocates the pid before calling `kh_spawn_process`, passes that pid
/// in `spawn_context_v1`, records the returned opaque instance handle in its
/// process table, stores argv, and returns the pid.
///
/// # Safety
///
/// The microkernel guarantees both pointer/length pairs are valid readable
/// ranges in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_spawn_process(
    parent_pid: u32,
    module_id_ptr: *const u8,
    module_id_len: usize,
    argv_ptr: *const u8,
    argv_len: usize,
) -> i64 {
    let module_id = if module_id_ptr.is_null() || module_id_len == 0 {
        &[][..]
    } else {
        core::slice::from_raw_parts(module_id_ptr, module_id_len)
    };
    let argv = if argv_ptr.is_null() || argv_len == 0 {
        &[][..]
    } else {
        core::slice::from_raw_parts(argv_ptr, argv_len)
    };
    dispatch::spawn_cached_process(parent_pid, module_id, argv)
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

    #[test]
    fn kernel_wait_export_reaps_kernel_owned_child() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = 1_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(&7_u32.to_le_bytes());
        assert_eq!(dispatch::register_child(&reg), 0);

        assert_eq!(unsafe { kernel_record_exit(7, 23) }, 0);

        let mut out = [0u8; 8];
        let rc = unsafe { kernel_wait(1, 0, 0, out.as_mut_ptr(), out.len()) };
        assert_eq!(rc, 8);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 7);
        assert_eq!(i32::from_le_bytes(out[4..8].try_into().unwrap()), 23);
    }

    #[test]
    fn kernel_kill_export_uses_kernel_signal_validation() {
        let _g = crate::kernel::TestGuard::acquire();
        crate::kernel::with_kernel(|k| {
            k.process_mut(7);
        });
        assert_eq!(unsafe { kernel_kill(7, 15) }, 0);
        assert_eq!(unsafe { kernel_kill(7, 64) }, -(abi::EINVAL as i64));
    }
}
