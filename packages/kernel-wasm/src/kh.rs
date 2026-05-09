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
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_now_realtime(out_ptr: *mut u64) -> i32 {
    // Deterministic stub for native unit tests. Picks a fixed point in
    // time well clear of zero so callers can detect "wasn't written".
    *out_ptr = 1_700_000_000_000_000_000_u64;
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
