//! Kernel→Host imports (`kh_*`).
//!
//! Wasm imports are namespaced under `"kh"`; any kernel_host_interface must
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
    fn kh_real_stat(path_ptr: *const u8, path_len: usize, out_ptr: *mut u8, out_cap: usize) -> i64;
    fn kh_fetch_blocking(
        req_ptr: *const u8,
        req_len: usize,
        out_ptr: *mut u8,
        out_cap: usize,
    ) -> i64;
    fn kh_real_unlink(path_ptr: *const u8, path_len: usize) -> i32;
    fn kh_real_mkdir(path_ptr: *const u8, path_len: usize, mode: u32) -> i32;
    fn kh_real_symlink(
        target_ptr: *const u8,
        target_len: usize,
        link_ptr: *const u8,
        link_len: usize,
    ) -> i32;
    fn kh_real_rename(
        old_ptr: *const u8,
        old_len: usize,
        new_ptr: *const u8,
        new_len: usize,
    ) -> i32;
    fn kh_socket_connect(addr_ptr: *const u8, addr_len: usize, flags: u32) -> i32;
    fn kh_socket_send(handle: i32, data_ptr: *const u8, data_len: usize) -> i64;
    fn kh_socket_recv(handle: i32, out_ptr: *mut u8, len: usize, flags: u32) -> i64;
    fn kh_socket_close(handle: i32) -> i32;
    fn kh_socket_listen_at(addr_ptr: *const u8, addr_len: usize, backlog: u32) -> i32;
    fn kh_socket_accept_blocking(handle: i32, flags: u32) -> i32;
    fn kh_socket_local_addr(handle: i32, out_ptr: *mut u8, out_cap: usize) -> i64;
    fn kh_socket_peer_addr(handle: i32, out_ptr: *mut u8, out_cap: usize) -> i64;
    fn kh_idb_get(
        store_ptr: *const u8,
        store_len: usize,
        key_ptr: *const u8,
        key_len: usize,
        out_ptr: *mut u8,
        out_cap: usize,
    ) -> i64;
    fn kh_idb_put(
        store_ptr: *const u8,
        store_len: usize,
        key_ptr: *const u8,
        key_len: usize,
        value_ptr: *const u8,
        value_len: usize,
    ) -> i32;
    fn kh_idb_delete(
        store_ptr: *const u8,
        store_len: usize,
        key_ptr: *const u8,
        key_len: usize,
    ) -> i32;
    fn kh_idb_list(
        store_ptr: *const u8,
        store_len: usize,
        prefix_ptr: *const u8,
        prefix_len: usize,
        out_ptr: *mut u8,
        out_cap: usize,
    ) -> i64;
    fn kh_spawn_process(
        module_id_ptr: *const u8,
        module_id_len: usize,
        context_ptr: *const u8,
        context_len: usize,
    ) -> i32;
    fn kh_destroy_instance(handle: i32) -> i32;
    fn kh_process_mem_read(handle: i32, addr: u32, dst_ptr: *mut u8, len: usize) -> i64;
    fn kh_process_mem_write(handle: i32, addr: u32, src_ptr: *const u8, len: usize) -> i64;
    fn kh_process_resume(handle: i32, result: i64, budget_ns: u64) -> i64;
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
    // tests cover it end-to-end through a real kernel_host_interface.
    -38 // -ENOSYS
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_log(_severity: u32, _msg_ptr: *const u8, _msg_len: usize) -> i32 {
    0
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_open(_path_ptr: *const u8, _path_len: usize, _flags: u32, _mode: u32) -> i32 {
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

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_fetch_blocking(
    _req_ptr: *const u8,
    _req_len: usize,
    _out_ptr: *mut u8,
    _out_cap: usize,
) -> i64 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_unlink(_path_ptr: *const u8, _path_len: usize) -> i32 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_mkdir(_path_ptr: *const u8, _path_len: usize, _mode: u32) -> i32 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_symlink(
    _target_ptr: *const u8,
    _target_len: usize,
    _link_ptr: *const u8,
    _link_len: usize,
) -> i32 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_real_rename(
    _old_ptr: *const u8,
    _old_len: usize,
    _new_ptr: *const u8,
    _new_len: usize,
) -> i32 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_socket_connect(_addr_ptr: *const u8, _addr_len: usize, _flags: u32) -> i32 {
    #[cfg(test)]
    {
        let addr = std::slice::from_raw_parts(_addr_ptr, _addr_len);
        test_support::socket_connect(addr, _flags)
    }
    #[cfg(not(test))]
    {
        -38
    }
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_socket_send(_handle: i32, _data_ptr: *const u8, _data_len: usize) -> i64 {
    #[cfg(test)]
    {
        let data = std::slice::from_raw_parts(_data_ptr, _data_len);
        test_support::socket_send(_handle, data)
    }
    #[cfg(not(test))]
    {
        -38
    }
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_socket_recv(_handle: i32, _out_ptr: *mut u8, _len: usize, _flags: u32) -> i64 {
    #[cfg(test)]
    {
        let out = std::slice::from_raw_parts_mut(_out_ptr, _len);
        test_support::socket_recv(_handle, out, _flags)
    }
    #[cfg(not(test))]
    {
        -38
    }
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_socket_close(_handle: i32) -> i32 {
    #[cfg(test)]
    {
        test_support::socket_close(_handle)
    }
    #[cfg(not(test))]
    {
        -38
    }
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_socket_listen_at(_addr_ptr: *const u8, _addr_len: usize, _backlog: u32) -> i32 {
    #[cfg(test)]
    {
        let addr = std::slice::from_raw_parts(_addr_ptr, _addr_len);
        test_support::socket_listen_at(addr, _backlog)
    }
    #[cfg(not(test))]
    {
        -38
    }
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_socket_accept_blocking(_handle: i32, _flags: u32) -> i32 {
    #[cfg(test)]
    {
        test_support::socket_accept(_handle, _flags)
    }
    #[cfg(not(test))]
    {
        -38
    }
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_socket_local_addr(_handle: i32, _out_ptr: *mut u8, _out_cap: usize) -> i64 {
    #[cfg(test)]
    {
        let out = std::slice::from_raw_parts_mut(_out_ptr, _out_cap);
        test_support::socket_local_addr(_handle, out)
    }
    #[cfg(not(test))]
    {
        -38
    }
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_idb_get(
    _store_ptr: *const u8,
    _store_len: usize,
    _key_ptr: *const u8,
    _key_len: usize,
    _out_ptr: *mut u8,
    _out_cap: usize,
) -> i64 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_socket_peer_addr(_handle: i32, _out_ptr: *mut u8, _out_cap: usize) -> i64 {
    #[cfg(test)]
    {
        let out = std::slice::from_raw_parts_mut(_out_ptr, _out_cap);
        test_support::socket_peer_addr(_handle, out)
    }
    #[cfg(not(test))]
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_idb_put(
    _store_ptr: *const u8,
    _store_len: usize,
    _key_ptr: *const u8,
    _key_len: usize,
    _value_ptr: *const u8,
    _value_len: usize,
) -> i32 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_idb_delete(
    _store_ptr: *const u8,
    _store_len: usize,
    _key_ptr: *const u8,
    _key_len: usize,
) -> i32 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_idb_list(
    _store_ptr: *const u8,
    _store_len: usize,
    _prefix_ptr: *const u8,
    _prefix_len: usize,
    _out_ptr: *mut u8,
    _out_cap: usize,
) -> i64 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
unsafe fn kh_spawn_process(
    _module_id_ptr: *const u8,
    _module_id_len: usize,
    _context_ptr: *const u8,
    _context_len: usize,
) -> i32 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
unsafe fn kh_destroy_instance(_handle: i32) -> i32 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
unsafe fn kh_process_mem_read(_handle: i32, _addr: u32, _dst_ptr: *mut u8, _len: usize) -> i64 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
unsafe fn kh_process_mem_write(_handle: i32, _addr: u32, _src_ptr: *const u8, _len: usize) -> i64 {
    -38
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
unsafe fn kh_process_resume(_handle: i32, _result: i64, _budget_ns: u64) -> i64 {
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

/// Forward an opaque extension-invoke request to the kernel_host_interface
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

/// Open a host-fs path via the kernel_host_interface. Returns a non-negative
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

/// Unlink a host-fs path. Same policy gate as `kh_real_open`.
pub fn real_unlink(path: &[u8]) -> i32 {
    unsafe { kh_real_unlink(path.as_ptr(), path.len()) }
}

/// Create a host-fs directory at `path`. `mode` is the POSIX
/// permission bits.
pub fn real_mkdir(path: &[u8], mode: u32) -> i32 {
    unsafe { kh_real_mkdir(path.as_ptr(), path.len(), mode) }
}

/// Create a host-fs symlink at `link_path` pointing at `target`
/// (target stays verbatim).
pub fn real_symlink(target: &[u8], link_path: &[u8]) -> i32 {
    unsafe {
        kh_real_symlink(
            target.as_ptr(),
            target.len(),
            link_path.as_ptr(),
            link_path.len(),
        )
    }
}

/// Rename a host-fs path. POSIX semantics — atomic on most
/// filesystems within a mount; cross-mount renames return -EXDEV
/// from the host.
pub fn real_rename(old_path: &[u8], new_path: &[u8]) -> i32 {
    unsafe {
        kh_real_rename(
            old_path.as_ptr(),
            old_path.len(),
            new_path.as_ptr(),
            new_path.len(),
        )
    }
}

/// Open a TCP socket and connect to a POSIX `sockaddr` byte record. Returns a
/// non-negative socket handle or negated errno.
pub fn socket_connect(addr: &[u8], flags: u32) -> i32 {
    unsafe { kh_socket_connect(addr.as_ptr(), addr.len(), flags) }
}

pub fn socket_send(handle: i32, data: &[u8]) -> i64 {
    unsafe { kh_socket_send(handle, data.as_ptr(), data.len()) }
}

pub fn socket_recv(handle: i32, buf: &mut [u8], flags: u32) -> i64 {
    unsafe { kh_socket_recv(handle, buf.as_mut_ptr(), buf.len(), flags) }
}

pub fn socket_close(handle: i32) -> i32 {
    unsafe { kh_socket_close(handle) }
}

pub fn socket_listen_at(addr: &[u8], backlog: u32) -> i32 {
    unsafe { kh_socket_listen_at(addr.as_ptr(), addr.len(), backlog) }
}

pub fn socket_accept(handle: i32, flags: u32) -> i32 {
    unsafe { kh_socket_accept_blocking(handle, flags) }
}

pub fn socket_local_addr(handle: i32, out: &mut [u8]) -> i64 {
    unsafe { kh_socket_local_addr(handle, out.as_mut_ptr(), out.len()) }
}

pub fn socket_peer_addr(handle: i32, out: &mut [u8]) -> i64 {
    unsafe { kh_socket_peer_addr(handle, out.as_mut_ptr(), out.len()) }
}

#[cfg(test)]
pub mod test_support {
    use std::collections::VecDeque;
    use std::sync::{LazyLock, Mutex};

    #[derive(Default)]
    struct SocketMock {
        connect_results: VecDeque<i32>,
        listen_results: VecDeque<i32>,
        accept_results: VecDeque<i32>,
        recv_results: VecDeque<Vec<u8>>,
        addr_results: VecDeque<Vec<u8>>,
        peer_addr_results: VecDeque<Vec<u8>>,
        connect_calls: Vec<(Vec<u8>, u32)>,
        listen_calls: Vec<(Vec<u8>, u32)>,
        accept_calls: Vec<(i32, u32)>,
        send_calls: Vec<(i32, Vec<u8>)>,
        recv_calls: Vec<(i32, usize, u32)>,
        addr_calls: Vec<(i32, usize)>,
        peer_addr_calls: Vec<(i32, usize)>,
        close_calls: Vec<i32>,
    }

    static SOCKET_MOCK: LazyLock<Mutex<SocketMock>> =
        LazyLock::new(|| Mutex::new(SocketMock::default()));

    pub fn reset_socket_mock() {
        *SOCKET_MOCK.lock().unwrap() = SocketMock::default();
    }

    pub fn push_socket_connect_result(handle: i32) {
        SOCKET_MOCK
            .lock()
            .unwrap()
            .connect_results
            .push_back(handle);
    }

    pub fn push_socket_listen_result(handle: i32) {
        SOCKET_MOCK.lock().unwrap().listen_results.push_back(handle);
    }

    pub fn push_socket_accept_result(handle: i32) {
        SOCKET_MOCK.lock().unwrap().accept_results.push_back(handle);
    }

    pub fn push_socket_recv_result(bytes: &[u8]) {
        SOCKET_MOCK
            .lock()
            .unwrap()
            .recv_results
            .push_back(bytes.to_vec());
    }

    pub fn push_socket_addr_result(bytes: &[u8]) {
        SOCKET_MOCK
            .lock()
            .unwrap()
            .addr_results
            .push_back(bytes.to_vec());
    }

    pub fn push_socket_peer_addr_result(bytes: &[u8]) {
        SOCKET_MOCK
            .lock()
            .unwrap()
            .peer_addr_results
            .push_back(bytes.to_vec());
    }

    pub fn socket_connect_calls() -> Vec<(Vec<u8>, u32)> {
        SOCKET_MOCK.lock().unwrap().connect_calls.clone()
    }

    pub fn socket_listen_calls() -> Vec<(Vec<u8>, u32)> {
        SOCKET_MOCK.lock().unwrap().listen_calls.clone()
    }

    pub fn socket_send_calls() -> Vec<(i32, Vec<u8>)> {
        SOCKET_MOCK.lock().unwrap().send_calls.clone()
    }

    pub fn socket_recv_calls() -> Vec<(i32, usize, u32)> {
        SOCKET_MOCK.lock().unwrap().recv_calls.clone()
    }

    pub fn socket_addr_calls() -> Vec<(i32, usize)> {
        SOCKET_MOCK.lock().unwrap().addr_calls.clone()
    }

    pub fn socket_peer_addr_calls() -> Vec<(i32, usize)> {
        SOCKET_MOCK.lock().unwrap().peer_addr_calls.clone()
    }

    pub fn socket_accept_calls() -> Vec<(i32, u32)> {
        SOCKET_MOCK.lock().unwrap().accept_calls.clone()
    }

    pub fn socket_close_calls() -> Vec<i32> {
        SOCKET_MOCK.lock().unwrap().close_calls.clone()
    }

    pub(super) fn socket_connect(addr: &[u8], flags: u32) -> i32 {
        let mut mock = SOCKET_MOCK.lock().unwrap();
        mock.connect_calls.push((addr.to_vec(), flags));
        mock.connect_results.pop_front().unwrap_or(-38)
    }

    pub(super) fn socket_send(handle: i32, data: &[u8]) -> i64 {
        SOCKET_MOCK
            .lock()
            .unwrap()
            .send_calls
            .push((handle, data.to_vec()));
        data.len() as i64
    }

    pub(super) fn socket_recv(handle: i32, out: &mut [u8], flags: u32) -> i64 {
        let mut mock = SOCKET_MOCK.lock().unwrap();
        mock.recv_calls.push((handle, out.len(), flags));
        let bytes = mock.recv_results.pop_front().unwrap_or_default();
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as i64
    }

    pub(super) fn socket_close(handle: i32) -> i32 {
        SOCKET_MOCK.lock().unwrap().close_calls.push(handle);
        0
    }

    pub(super) fn socket_listen_at(addr: &[u8], backlog: u32) -> i32 {
        let mut mock = SOCKET_MOCK.lock().unwrap();
        mock.listen_calls.push((addr.to_vec(), backlog));
        mock.listen_results.pop_front().unwrap_or(-38)
    }

    pub(super) fn socket_accept(handle: i32, flags: u32) -> i32 {
        let mut mock = SOCKET_MOCK.lock().unwrap();
        mock.accept_calls.push((handle, flags));
        mock.accept_results.pop_front().unwrap_or(-38)
    }

    pub(super) fn socket_local_addr(handle: i32, out: &mut [u8]) -> i64 {
        let mut mock = SOCKET_MOCK.lock().unwrap();
        mock.addr_calls.push((handle, out.len()));
        let bytes = mock.addr_results.pop_front().unwrap_or_default();
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as i64
    }

    pub(super) fn socket_peer_addr(handle: i32, out: &mut [u8]) -> i64 {
        let mut mock = SOCKET_MOCK.lock().unwrap();
        mock.peer_addr_calls.push((handle, out.len()));
        let bytes = mock.peer_addr_results.pop_front().unwrap_or_default();
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as i64
    }
}

pub fn idb_get(store: &[u8], key: &[u8], out: &mut [u8]) -> i64 {
    unsafe {
        kh_idb_get(
            store.as_ptr(),
            store.len(),
            key.as_ptr(),
            key.len(),
            out.as_mut_ptr(),
            out.len(),
        )
    }
}

pub fn idb_put(store: &[u8], key: &[u8], value: &[u8]) -> i32 {
    unsafe {
        kh_idb_put(
            store.as_ptr(),
            store.len(),
            key.as_ptr(),
            key.len(),
            value.as_ptr(),
            value.len(),
        )
    }
}

pub fn idb_delete(store: &[u8], key: &[u8]) -> i32 {
    unsafe { kh_idb_delete(store.as_ptr(), store.len(), key.as_ptr(), key.len()) }
}

pub fn idb_list(store: &[u8], prefix: &[u8], out: &mut [u8]) -> i64 {
    unsafe {
        kh_idb_list(
            store.as_ptr(),
            store.len(),
            prefix.as_ptr(),
            prefix.len(),
            out.as_mut_ptr(),
            out.len(),
        )
    }
}

#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
/// Ask the kernel_host_interface to instantiate a process module already present
/// in the host module cache. `context` is a kernel-authored binary
/// spawn-context record; the host only interprets module ids and
/// engine mechanics.
pub fn spawn_process(module_id: &[u8], context: &[u8]) -> i32 {
    unsafe {
        kh_spawn_process(
            module_id.as_ptr(),
            module_id.len(),
            context.as_ptr(),
            context.len(),
        )
    }
}

#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
/// Release a host wasm instance handle previously returned by
/// `spawn_process`.
pub fn destroy_instance(handle: i32) -> i32 {
    unsafe { kh_destroy_instance(handle) }
}

#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
/// Copy bytes from process linear memory into `dst`.
pub fn process_mem_read(handle: i32, addr: u32, dst: &mut [u8]) -> i64 {
    unsafe { kh_process_mem_read(handle, addr, dst.as_mut_ptr(), dst.len()) }
}

#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
/// Copy bytes from `src` into process linear memory.
pub fn process_mem_write(handle: i32, addr: u32, src: &[u8]) -> i64 {
    unsafe { kh_process_mem_write(handle, addr, src.as_ptr(), src.len()) }
}

#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands.
/// Resume a suspended process instance with the scalar syscall result selected
/// by the kernel and an abstract run budget in nanoseconds. Hosts translate
/// this into their own preemption mechanism; the kernel never speaks fuel or
/// engine-specific epoch counts.
pub fn process_resume(handle: i32, result: i64, budget_ns: u64) -> i64 {
    unsafe { kh_process_resume(handle, result, budget_ns) }
}

/// Forward an HTTP fetch request to the host. The request bytes are a
/// `fetch_record_v1` binary record; the host writes a `fetch_response_v1`
/// binary record into `response`. Returns bytes-written on success or a
/// negated POSIX errno (-EACCES from the policy gate, -E2BIG when the response
/// is larger than `response.len()`).
pub fn fetch_blocking(request: &[u8], response: &mut [u8]) -> i64 {
    unsafe {
        kh_fetch_blocking(
            request.as_ptr(),
            request.len(),
            response.as_mut_ptr(),
            response.len(),
        )
    }
}

/// Stat a host path. Returns the file size on success (in bytes),
/// or a negated POSIX errno. The kernel_host_interface writes a kh_stat_v1
/// record into `out`; this helper only surfaces the size field
/// since that's what HostFsBackend currently needs.
pub fn real_stat_size(path: &[u8]) -> Result<u64, i32> {
    // kh_stat_v1 layout (matches abi/contract/kernel_host_abi.toml):
    //   u16 version, u16 _pad, u32 mode, u64 size, u64 mtime_ns,
    //   u8 is_dir, u8 is_symlink, u8[6] _reserved
    // Total = 32 bytes; size is at offset 8.
    let mut buf = [0u8; 32];
    let rc = unsafe { kh_real_stat(path.as_ptr(), path.len(), buf.as_mut_ptr(), buf.len()) };
    if rc < 0 {
        return Err(rc as i32);
    }
    let size = u64::from_le_bytes(buf[8..16].try_into().expect("8 bytes"));
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi;

    #[test]
    fn native_wasm_engine_ops_are_explicitly_unimplemented() {
        assert_eq!(spawn_process(b"module", b""), -abi::ENOSYS);
        assert_eq!(destroy_instance(7), -abi::ENOSYS);

        let mut dst = [0u8; 4];
        assert_eq!(process_mem_read(7, 1024, &mut dst), -(abi::ENOSYS as i64));
        assert_eq!(process_mem_write(7, 1024, b"data"), -(abi::ENOSYS as i64));
        assert_eq!(process_resume(7, 0, 1_000_000), -(abi::ENOSYS as i64));
    }
}
