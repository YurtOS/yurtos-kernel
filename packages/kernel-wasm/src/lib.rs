//! Yurt kernel, sandboxed.
//!
//! Compiled to `wasm32-wasip1` and instantiated by any kernel-host-interface host
//! (`kernel-host-interface-wasmtime`, `kernel-host-interface-js`, `kernel-host-interface-deno`,
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
mod path;
mod state;
mod vfs;

pub use dispatch::dispatch;

/// Kernel-host-interface-shared scratch buffer.
///
/// The kernel-host interface uses this region to stage syscall request and response
/// bytes for [`kernel_dispatch`] without needing a kernel-side allocator
/// in the hot path. Capacity is intentionally generous; individual
/// syscalls cap their own usage. See the trampoline protocol in
/// `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.
const SCRATCH_LEN: usize = 1024 * 1024;
static mut SCRATCH: [u8; SCRATCH_LEN] = [0; SCRATCH_LEN];

fn raw_input<'a>(ptr: *const u8, len: usize) -> Result<&'a [u8], i64> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err(-(abi::EFAULT as i64));
    }
    // SAFETY: The exported C ABI caller guarantees that `ptr..ptr+len`
    // is readable within this kernel instance's linear memory. We reject
    // null for nonzero lengths above; the host/runtime enforces bounds.
    Ok(unsafe { core::slice::from_raw_parts(ptr, len) })
}

fn raw_output<'a>(ptr: *mut u8, len: usize) -> Result<&'a mut [u8], i64> {
    if len == 0 {
        return Ok(&mut []);
    }
    if ptr.is_null() {
        return Err(-(abi::EFAULT as i64));
    }
    // SAFETY: The exported C ABI caller guarantees that `ptr..ptr+len`
    // is writable within this kernel instance's linear memory and not
    // aliased for the duration of the call. We reject null for nonzero
    // lengths above; the host/runtime enforces bounds.
    Ok(unsafe { core::slice::from_raw_parts_mut(ptr, len) })
}

fn scratch_bounds() -> (usize, usize) {
    let start = (&raw const SCRATCH) as usize;
    (start, SCRATCH_LEN)
}

fn range_within(start: usize, len: usize, base: usize, cap: usize) -> Result<bool, i64> {
    if len == 0 {
        return Ok(true);
    }
    let end = start.checked_add(len).ok_or(-(abi::EINVAL as i64))?;
    let limit = base.checked_add(cap).ok_or(-(abi::EINVAL as i64))?;
    Ok(start >= base && end <= limit)
}

fn validate_scratch_range(ptr: usize, len: usize) -> Result<(), i64> {
    let (base, cap) = scratch_bounds();
    if range_within(ptr, len, base, cap)? {
        Ok(())
    } else {
        Err(-(abi::EINVAL as i64))
    }
}

fn ranges_overlap(a_ptr: usize, a_len: usize, b_ptr: usize, b_len: usize) -> Result<bool, i64> {
    if a_len == 0 || b_len == 0 {
        return Ok(false);
    }
    let a_end = a_ptr.checked_add(a_len).ok_or(-(abi::EINVAL as i64))?;
    let b_end = b_ptr.checked_add(b_len).ok_or(-(abi::EINVAL as i64))?;
    Ok(a_ptr < b_end && b_ptr < a_end)
}

/// Offset of [`SCRATCH`] within this kernel instance's linear memory.
#[no_mangle]
pub extern "C" fn kernel_scratch_ptr() -> u32 {
    // No Rust reference to SCRATCH is ever formed outside the dispatch
    // path, where the kernel-host interface passes its bounds back explicitly via
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
/// originating user process — `0` is reserved for the kernel-host interface
/// itself (direct calls from outside any user process); user processes
/// start at `1`. `(in_ptr, in_len)` points at the request bytes the
/// kernel-host interface copied out of the caller; the kernel writes the
/// response into `(out_ptr, out_cap)`. Return value is the syscall
/// scalar (`>= 0` success / `< 0` negated POSIX errno).
///
/// # Safety
///
/// The kernel-host interface guarantees both slices live entirely inside this
/// kernel instance's linear memory. The export rejects overlapping request and
/// response ranges before forming Rust references.
#[no_mangle]
pub unsafe extern "C" fn kernel_dispatch(
    method_id: u32,
    caller_pid: u32,
    in_ptr: *const u8,
    in_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    if let Err(rc) = validate_scratch_range(in_ptr as usize, in_len) {
        return rc;
    }
    if let Err(rc) = validate_scratch_range(out_ptr as usize, out_cap) {
        return rc;
    }
    match ranges_overlap(in_ptr as usize, in_len, out_ptr as usize, out_cap) {
        Ok(false) => {}
        Ok(true) => return -(abi::EINVAL as i64),
        Err(rc) => return rc,
    }
    let request = match raw_input(in_ptr, in_len) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    let response = match raw_output(out_ptr, out_cap) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    dispatch::dispatch(method_id, caller_pid, request, response)
}

/// Host-callable entry point for thread-aware syscalls.
///
/// This has the same memory contract as [`kernel_dispatch`], but the host also
/// supplies the authenticated caller thread id. Guest request bytes are not
/// trusted to identify the calling thread.
///
/// # Safety
///
/// The kernel-host interface guarantees both slices live entirely inside this
/// kernel instance's linear memory. The export rejects overlapping request and
/// response ranges before forming Rust references.
#[no_mangle]
pub unsafe extern "C" fn kernel_dispatch_thread(
    method_id: u32,
    caller_pid: u32,
    caller_tid: u32,
    in_ptr: *const u8,
    in_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    if let Err(rc) = validate_scratch_range(in_ptr as usize, in_len) {
        return rc;
    }
    if let Err(rc) = validate_scratch_range(out_ptr as usize, out_cap) {
        return rc;
    }
    match ranges_overlap(in_ptr as usize, in_len, out_ptr as usize, out_cap) {
        Ok(false) => {}
        Ok(true) => return -(abi::EINVAL as i64),
        Err(rc) => return rc,
    }
    let request = match raw_input(in_ptr, in_len) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    let response = match raw_output(out_ptr, out_cap) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    dispatch::dispatch_with_context(
        method_id,
        dispatch::DispatchContext {
            caller_pid,
            caller_tid,
        },
        request,
        response,
    )
}

/// Host-control export: serialize the kernel-owned process table.
///
/// The kernel_host_interface may expose this to embedders for observability, but
/// the table is authored here in kernel.wasm.
///
/// # Safety
///
/// The kernel_host_interface guarantees `out_ptr..out_ptr+out_cap` is a valid
/// writable range in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_list_processes(out_ptr: *mut u8, out_cap: usize) -> i64 {
    let response = match raw_output(out_ptr, out_cap) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    dispatch::list_processes_response(response)
}

/// Host-control export: serialize one kernel-owned thread group.
///
/// # Safety
///
/// The kernel_host_interface guarantees `out_ptr..out_ptr+out_cap` is a valid writable
/// range in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_list_threads(pid: u32, out_ptr: *mut u8, out_cap: usize) -> i64 {
    let request = pid.to_le_bytes();
    let response = match raw_output(out_ptr, out_cap) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    dispatch::list_threads_response(&request, response)
}

/// Host-control export: serialize a versioned kernel-state snapshot envelope.
///
/// V1 contains kernel-authored process and thread records. Later sections add
/// scheduler queues, wait records, VFS state, and portable process memory.
///
/// # Safety
///
/// The kernel_host_interface guarantees `out_ptr..out_ptr+out_cap` is a valid writable
/// range in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_snapshot(out_ptr: *mut u8, out_cap: usize) -> i64 {
    let response = match raw_output(out_ptr, out_cap) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    dispatch::snapshot_response(response)
}

/// Host-control export: ask the kernel scheduler for the next runnable thread.
///
/// The response is a binary schedule decision: `u32 pid`, `u32 tid`, `i32
/// host_thread_handle`, `u32 flags`, `u64 budget_ns`. Hosts translate
/// `budget_ns` into their own preemption mechanism.
///
/// # Safety
///
/// The kernel_host_interface guarantees `out_ptr..out_ptr+out_cap` is a valid writable
/// range in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_schedule_next(out_ptr: *mut u8, out_cap: usize) -> i64 {
    let response = match raw_output(out_ptr, out_cap) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    dispatch::schedule_next_response(response)
}

/// Host-control export: register a host-created thread in kernel-owned state.
///
/// `host_thread_handle` is an opaque adapter handle. Pass a negative value when
/// the adapter has no durable handle to persist in snapshots.
///
#[no_mangle]
pub extern "C" fn kernel_spawn_thread(pid: u32, host_thread_handle: i32) -> i64 {
    crate::kernel::with_kernel(|k| {
        k.spawn_thread(
            pid,
            if host_thread_handle < 0 {
                None
            } else {
                Some(host_thread_handle)
            },
        )
        .map(i64::from)
        .unwrap_or(-(abi::ESRCH as i64))
    })
}

/// Host-control export: mark a thread detached in kernel-owned state.
///
#[no_mangle]
pub extern "C" fn kernel_detach_thread(pid: u32, tid: u32) -> i64 {
    crate::kernel::with_kernel(|k| {
        k.detach_thread(pid, tid)
            .map(|()| 0)
            .unwrap_or(-(abi::ESRCH as i64))
    })
}

/// Host-control export: record a thread exit value in kernel-owned state.
///
#[no_mangle]
pub extern "C" fn kernel_record_thread_exit(pid: u32, tid: u32, exit_value: i32) -> i64 {
    crate::kernel::with_kernel(|k| {
        k.exit_thread(pid, tid, exit_value)
            .map(|()| 0)
            .unwrap_or(-(abi::ESRCH as i64))
    })
}

/// Host-control export: record thread exit after validating the live host
/// execution handle for `(pid, tid)`.
#[no_mangle]
pub extern "C" fn kernel_record_thread_exit_authenticated(
    pid: u32,
    tid: u32,
    host_thread_handle: i32,
    exit_value: u32,
) -> i64 {
    let (result, release_handles) = crate::kernel::with_kernel(|k| {
        let result = k.record_thread_exit_authenticated(pid, tid, host_thread_handle, exit_value);
        let release_handles = k.drain_thread_releases();
        (result, release_handles)
    });
    for handle in release_handles {
        let _ = kh::thread_release(handle);
    }
    result.map_or_else(|errno| -(errno as i64), |_| 0)
}

/// Host-control export: mark a thread blocked in kernel-owned state.
///
#[no_mangle]
pub extern "C" fn kernel_block_thread(pid: u32, tid: u32) -> i64 {
    crate::kernel::with_kernel(|k| {
        k.block_thread(pid, tid)
            .map(|()| 0)
            .unwrap_or(-(abi::ESRCH as i64))
    })
}

/// Host-control export: mark a blocked thread runnable in kernel-owned state.
///
#[no_mangle]
pub extern "C" fn kernel_unblock_thread(pid: u32, tid: u32) -> i64 {
    crate::kernel::with_kernel(|k| {
        k.unblock_thread(pid, tid)
            .map(|()| 0)
            .unwrap_or(-(abi::ESRCH as i64))
    })
}

/// Host-control export: send a signal through kernel-owned process state.
///
#[no_mangle]
pub extern "C" fn kernel_kill(pid: u32, signal: u32) -> i64 {
    dispatch::kill_pid(pid, signal)
}

/// Host-control export: wait/reap a child according to kernel process rules.
///
/// `caller_pid` is the process whose child set is being waited on. `child_pid`
/// is `0` for any child or a specific child pid. `flags` uses the same bit
/// layout as `sys_wait`; bit 0 is WNOHANG.
///
/// This host-control export is currently a nonblocking kernel state query:
/// when a matching child exists but has not recorded exit yet, it returns
/// `-EAGAIN` even without WNOHANG. Embedders that need POSIX blocking wait
/// must suspend at the adapter layer and retry after child progress/exit.
///
/// # Safety
///
/// The kernel_host_interface guarantees `out_ptr..out_ptr+out_cap` is a valid writable
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
    let response = match raw_output(out_ptr, out_cap) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    dispatch::wait_response(caller_pid, &request, response)
}

/// Host-control export: record process exit status in kernel-owned state.
///
/// This is the KH adapter notification used after a process instance returns
/// or traps with an exit status. The next kernel-owned wait can reap it.
///
#[no_mangle]
pub extern "C" fn kernel_record_exit(pid: u32, exit_status: i32) -> i64 {
    let mut request = [0u8; 8];
    request[0..4].copy_from_slice(&pid.to_le_bytes());
    request[4..8].copy_from_slice(&exit_status.to_le_bytes());
    dispatch::record_exit(&request)
}

/// Host-control export: drain the next kernel-staged user `sys_spawn`.
///
/// # Safety
///
/// The kernel_host_interface guarantees `out_ptr..out_ptr+out_cap` is a valid writable
/// range in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_drain_spawn(out_ptr: *mut u8, out_cap: usize) -> i64 {
    let response = match raw_output(out_ptr, out_cap) {
        Ok(slice) => slice,
        Err(rc) => return rc,
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
/// The kernel_host_interface guarantees both pointer/length pairs are valid readable
/// ranges in this kernel instance's linear memory.
#[no_mangle]
pub unsafe extern "C" fn kernel_spawn_process(
    parent_pid: u32,
    module_id_ptr: *const u8,
    module_id_len: usize,
    argv_ptr: *const u8,
    argv_len: usize,
) -> i64 {
    if let Err(rc) = validate_scratch_range(module_id_ptr as usize, module_id_len) {
        return rc;
    }
    if let Err(rc) = validate_scratch_range(argv_ptr as usize, argv_len) {
        return rc;
    }
    let module_id = match raw_input(module_id_ptr, module_id_len) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    let argv = match raw_input(argv_ptr, argv_len) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    dispatch::spawn_cached_process(parent_pid, module_id, argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_method_returns_negated_enosys() {
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
    fn kernel_dispatch_rejects_overlapping_request_and_response() {
        let mut buf = [0u8; 16];
        let rc = unsafe {
            kernel_dispatch(
                0xDEAD_BEEF,
                0,
                buf.as_ptr(),
                8,
                buf.as_mut_ptr().wrapping_add(4),
                8,
            )
        };
        assert_eq!(rc, -(abi::EINVAL as i64));
    }

    #[test]
    fn kernel_dispatch_rejects_non_scratch_ranges() {
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
        assert_eq!(rc, -(abi::EINVAL as i64));
    }

    #[test]
    fn kernel_spawn_process_rejects_non_scratch_ranges() {
        let module = *b"module";
        let rc =
            unsafe { kernel_spawn_process(1, module.as_ptr(), module.len(), core::ptr::null(), 0) };
        assert_eq!(rc, -(abi::EINVAL as i64));
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
    fn null_pointer_with_nonzero_len_is_efault() {
        let mut out = [0u8; 16];
        let rc = unsafe {
            kernel_dispatch(
                0xDEAD_BEEF,
                0,
                core::ptr::null(),
                1,
                out.as_mut_ptr(),
                out.len(),
            )
        };
        assert_eq!(rc, -(abi::EINVAL as i64));

        let rc = unsafe { kernel_list_processes(core::ptr::null_mut(), 1) };
        assert_eq!(rc, -(abi::EFAULT as i64));
    }

    #[test]
    fn kernel_wait_export_reaps_kernel_owned_child() {
        let _g = crate::kernel::TestGuard::acquire();
        let mut reg = 1_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(&7_u32.to_le_bytes());
        assert_eq!(dispatch::register_child(&reg), 0);

        assert_eq!(kernel_record_exit(7, 23), 0);

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
        assert_eq!(kernel_kill(7, 15), 0);
        assert_eq!(kernel_kill(7, 64), -(abi::EINVAL as i64));
    }

    #[test]
    fn record_thread_exit_authenticated_rejects_wrong_host_handle() {
        let _g = crate::kernel::TestGuard::acquire();
        crate::kernel::with_kernel(|k| {
            k.insert_host_process(9, 0, vec![b"/bin/threaded".to_vec()], Some(10));
            assert_eq!(k.spawn_thread(9, Some(44)), Some(2));
        });

        assert_eq!(
            kernel_record_thread_exit_authenticated(9, 2, 45, 0x1234),
            -(abi::EPERM as i64)
        );
    }

    #[test]
    fn record_thread_exit_authenticated_accepts_matching_host_handle() {
        let _g = crate::kernel::TestGuard::acquire();
        crate::kernel::with_kernel(|k| {
            k.insert_host_process(9, 0, vec![b"/bin/threaded".to_vec()], Some(10));
            assert_eq!(k.spawn_thread(9, Some(44)), Some(2));
        });

        assert_eq!(
            kernel_record_thread_exit_authenticated(9, 2, 44, 0x8000_0001),
            0
        );
        let thread =
            crate::kernel::with_kernel(|k| k.process(9).threads.get(&2).expect("thread").clone());
        assert_eq!(thread.exit_value, Some(0x8000_0001));
    }
}
