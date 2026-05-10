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
    fn kh_real_open(path_ptr: *const u8, path_len: usize, flags: u32, mode: u32) -> i32;
    fn kh_real_read(fd: i32, out_ptr: *mut u8, len: usize) -> i64;
    fn kh_real_write(fd: i32, data_ptr: *const u8, data_len: usize) -> i64;
    fn kh_real_close(fd: i32) -> i32;
    fn kh_real_stat(
        path_ptr: *const u8,
        path_len: usize,
        out_ptr: *mut u8,
        out_cap: usize,
    ) -> i64;
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

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_open(
    _path_ptr: *const u8,
    _path_len: usize,
    _flags: u32,
    _mode: u32,
) -> i32 {
    -38 // -ENOSYS
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_read(_fd: i32, _out_ptr: *mut u8, _len: usize) -> i64 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_write(_fd: i32, _data_ptr: *const u8, _data_len: usize) -> i64 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_close(_fd: i32) -> i32 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_stat(
    _path_ptr: *const u8,
    _path_len: usize,
    _out_ptr: *mut u8,
    _out_cap: usize,
) -> i64 {
    -38
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

/// Open a host-fs path via the microkernel. Returns a non-negative
/// host-fd handle or a negated POSIX errno (e.g. -EACCES from the
/// policy gate, -ENOENT from the host filesystem). flags / mode use
/// POSIX values; bit 0 = writable, identical to sys_open.
pub fn real_open(path: &[u8], flags: u32, mode: u32) -> i32 {
    unsafe { kh_real_open(path.as_ptr(), path.len(), flags, mode) }
}

/// Read up to `buf.len()` bytes from a host-fd. Returns bytes read
/// (0 = EOF) or negated errno.
pub fn real_read(fd: i32, buf: &mut [u8]) -> i64 {
    unsafe { kh_real_read(fd, buf.as_mut_ptr(), buf.len()) }
}

/// Write `bytes` to a host-fd. Returns bytes written or negated
/// errno (-EBADF for unwritable fds, -EACCES if policy denies, etc.).
pub fn real_write(fd: i32, bytes: &[u8]) -> i64 {
    unsafe { kh_real_write(fd, bytes.as_ptr(), bytes.len()) }
}

/// Close a host-fd. Best-effort; failures are surfaced but most
/// callers ignore.
pub fn real_close(fd: i32) -> i32 {
    unsafe { kh_real_close(fd) }
}

/// Stat a host path. Returns the file size on success (in bytes),
/// or a negated POSIX errno. The microkernel writes a kh_stat_v1
/// record into `out`; this helper only surfaces the size field
/// since that's what HostFsBackend currently needs.
pub fn real_stat_size(path: &[u8]) -> Result<u64, i32> {
    // kh_stat_v1 layout (matches abi/contract/kernel_host_abi.toml):
    //   u16 version, u16 _pad, u32 mode, u64 size, u64 mtime_ns,
    //   u8 is_dir, u8 is_symlink, u8[6] _reserved
    // Total = 32 bytes; size is at offset 8.
    let mut buf = [0u8; 32];
    let rc = unsafe {
        kh_real_stat(path.as_ptr(), path.len(), buf.as_mut_ptr(), buf.len())
    };
    if rc < 0 {
        return Err(rc as i32);
    }
    let size = u64::from_le_bytes(buf[8..16].try_into().expect("8 bytes"));
    Ok(size)
}
