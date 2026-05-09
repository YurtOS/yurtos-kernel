//! Kernel→Host imports (`kh_*`).
//!
//! Wasm imports are namespaced under `"kh"`; any microkernel must
//! provide them. Native builds (used only for unit tests) supply
//! deterministic stubs so the dispatch layer can be exercised without a
//! wasmtime host. See `abi/contract/kernel_host_abi.toml` for the
//! authoritative contract.

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "kh")]
extern "C" {
    fn kh_now_realtime(out_ptr: *mut u64) -> i32;
    fn kh_extension_invoke(
        req_ptr: *const u8,
        req_len: usize,
        out_ptr: *mut u8,
        out_cap: usize,
    ) -> i64;
    fn kh_log(severity: u32, msg_ptr: *const u8, msg_len: usize) -> i32;
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_now_realtime(out_ptr: *mut u64) -> i32 {
    // Deterministic stub for native unit tests. Picks a fixed point in
    // time well clear of zero so callers can detect "wasn't written".
    *out_ptr = 1_700_000_000_000_000_000_u64;
    0
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_extension_invoke(
    _req_ptr: *const u8,
    _req_len: usize,
    _out_ptr: *mut u8,
    _out_cap: usize,
) -> i64 {
    // Native unit tests don't exercise this path; the wasm trampoline
    // tests cover it end-to-end through a real microkernel.
    -38 // -ENOSYS
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_log(_severity: u32, _msg_ptr: *const u8, _msg_len: usize) -> i32 {
    0
}

/// Wall-clock time in nanoseconds since the Unix epoch.
pub fn now_realtime_ns() -> Result<u64, i32> {
    let mut out: u64 = 0;
    let rc = unsafe { kh_now_realtime(&mut out as *mut u64) };
    if rc == 0 {
        Ok(out)
    } else {
        Err(rc)
    }
}

/// Forward an opaque extension-invoke request to the microkernel
/// registry; the host writes the response bytes into `response`.
/// Returns bytes written (non-negative) or negated POSIX errno.
pub fn extension_invoke(request: &[u8], response: &mut [u8]) -> i64 {
    unsafe {
        kh_extension_invoke(
            request.as_ptr(),
            request.len(),
            response.as_mut_ptr(),
            response.len(),
        )
    }
}

/// Severity levels mirroring `kernel_host_abi.toml`'s `kh_log` doc.
/// Other variants exist for callers that haven't landed yet; allow
/// dead_code so the wasm release build doesn't warn.
#[derive(Clone, Copy, Debug)]
#[repr(u32)]
#[allow(dead_code)]
pub enum LogSeverity {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

/// Emit a diagnostic message via the host. Errors are silently dropped:
/// logging must never affect syscall semantics.
pub fn log(severity: LogSeverity, msg: &str) {
    let bytes = msg.as_bytes();
    unsafe {
        let _ = kh_log(severity as u32, bytes.as_ptr(), bytes.len());
    }
}
