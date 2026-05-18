//! Negative fixture: passes a deliberately too-short buffer (10 bytes,
//! well below the 88-byte yurt_spawn_request_v1 minimum) to `host_spawn`
//! and exits with the absolute value of the returned errno so the
//! fixture_parity test can observe it as the process exit code.
//!
//! Expected: host_spawn returns -22 (EINVAL) for req_len < 88.

#[link(wasm_import_module = "yurt")]
extern "C" {
    fn host_spawn(req_ptr: *const u8, req_len: usize, out_ptr: *mut u8, out_cap: usize) -> i32;
}

fn main() {
    // 10-byte buffer — far shorter than the 88-byte minimum the host decoder
    // requires. host_spawn MUST return -22 (EINVAL) without panicking/trapping.
    let bad_req = [0u8; 10];
    let mut out = [0u8; 4];
    let rc = unsafe { host_spawn(bad_req.as_ptr(), bad_req.len(), out.as_mut_ptr(), out.len()) };
    // Exit with the negated errno so the host can observe it as exit code 22.
    std::process::exit(if rc < 0 { -rc } else { 0 });
}
