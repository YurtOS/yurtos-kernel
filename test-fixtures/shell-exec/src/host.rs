use serde::{Deserialize, Serialize};
#[cfg(target_arch = "wasm32")]
use yurt_process::{build_spawn_request, SpawnRequest as YurtSpawnRequest};

// ---------------------------------------------------------------------------
// Types shared between trait and WASM host
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnResult {
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchResult {
    pub ok: bool,
    pub status: u16,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    /// Base64-encoded response body for lossless binary content.
    #[serde(default)]
    pub body_base64: Option<String>,
    pub error: Option<String>,
}

#[cfg(target_arch = "wasm32")]
const YURT_WAIT_NOHANG: i32 = 1;

#[cfg(target_arch = "wasm32")]
#[repr(C)]
struct YurtPipeResult {
    read_fd: i32,
    write_fd: i32,
}

#[cfg(target_arch = "wasm32")]
#[repr(C)]
struct YurtWaitResult {
    pid: i32,
    exit_code: i32,
    signal: i32,
    flags: i32,
}

#[cfg(target_arch = "wasm32")]
#[repr(C)]
struct YurtSpawnResult {
    pid: i32,
}

impl FetchResult {
    /// Decode the response body as raw bytes (lossless).
    /// Uses body_base64 if available, falls back to body.as_bytes().
    pub fn body_bytes(&self) -> Vec<u8> {
        if let Some(ref b64) = self.body_base64 {
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
                .unwrap_or_else(|_| self.body.as_bytes().to_vec())
        } else {
            self.body.as_bytes().to_vec()
        }
    }
}

#[cfg(target_arch = "wasm32")]
const YURT_FETCH_REDIRECT_MANUAL: u32 = 1;

#[cfg(target_arch = "wasm32")]
const YURT_AF_INET: i32 = 1;

#[cfg(target_arch = "wasm32")]
const YURT_SOCK_STREAM: i32 = 6;

#[cfg(target_arch = "wasm32")]
const YURT_SOCKET_FLAG_TLS: i32 = 1;

#[cfg(target_arch = "wasm32")]
const YURT_MSG_NONE: i32 = 0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatInfo {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mode: u32,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone)]
pub enum HostError {
    NotFound(String),
    PermissionDenied(String),
    IoError(String),
    Other(String),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(msg) => write!(f, "{msg}: No such file or directory"),
            Self::PermissionDenied(msg) => write!(f, "permission denied: {msg}"),
            Self::IoError(msg) => write!(f, "I/O error: {msg}"),
            Self::Other(msg) => write!(f, "{msg}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Truncate,
    Append,
}

// ---------------------------------------------------------------------------
// HostInterface trait — implemented by WasmHost (Task 2) or test stubs
// ---------------------------------------------------------------------------

pub trait HostInterface {
    /// Spawn a child process. Returns the child PID.
    ///
    /// `program` is the tool-lookup key (resolved against the registered
    /// tool registry and VFS /usr/bin).
    ///
    /// `argv0` optionally overrides `argv[0]` that the child sees.  When
    /// `None`, the child receives `argv[0] = program` (the common POSIX
    /// case). When `Some`, the child receives the override — required
    /// for multicall binaries (e.g. BusyBox) where a symlink
    /// `/tmp/bin/grep -> /usr/bin/busybox` must run the busybox tool
    /// with `argv[0] = "grep"` so it dispatches the grep applet.
    ///
    /// `stdin_data` is piped to the child's stdin (via a static fd target on
    /// the host side). stdout/stderr flow through the kernel fd table entries
    /// identified by `stdin_fd`, `stdout_fd`, `stderr_fd`.
    ///
    /// Caller must call `waitpid()` to collect the exit code.
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &self,
        program: &str,
        argv0: Option<&str>,
        args: &[&str],
        env: &[(&str, &str)],
        cwd: &str,
        stdin_data: &str,
        stdin_fd: i32,
        stdout_fd: i32,
        stderr_fd: i32,
        nice: u8,
    ) -> Result<i32, HostError>;

    fn has_tool(&self, name: &str) -> bool;

    fn time(&self) -> f64;

    fn stat(&self, path: &str) -> Result<StatInfo, HostError>;

    fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError>;

    fn write_file(&self, path: &str, data: &[u8], mode: WriteMode) -> Result<(), HostError>;

    /// Convenience: read a file as a UTF-8 string.
    fn read_file_str(&self, path: &str) -> Result<String, HostError> {
        let bytes = self.read_file(path)?;
        String::from_utf8(bytes).map_err(|e| HostError::Other(format!("invalid UTF-8: {e}")))
    }

    /// Convenience: write a UTF-8 string to a file.
    fn write_file_str(&self, path: &str, data: &str, mode: WriteMode) -> Result<(), HostError> {
        self.write_file(path, data.as_bytes(), mode)
    }

    fn readdir(&self, path: &str) -> Result<Vec<String>, HostError>;

    fn mkdir(&self, path: &str) -> Result<(), HostError>;

    fn remove(&self, path: &str, recursive: bool) -> Result<(), HostError>;

    fn chmod(&self, path: &str, mode: u32) -> Result<(), HostError>;

    fn glob(&self, pattern: &str) -> Result<Vec<String>, HostError>;

    fn rename(&self, from: &str, to: &str) -> Result<(), HostError>;

    fn symlink(&self, target: &str, link_path: &str) -> Result<(), HostError>;

    fn readlink(&self, path: &str) -> Result<String, HostError>;

    /// Perform an HTTP fetch via the host. All arg parsing and response
    /// formatting happens in Rust; only the actual I/O crosses to the host.
    fn fetch(
        &self,
        url: &str,
        method: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> FetchResult;

    /// Register a pkg-installed tool with the host process manager.
    fn register_tool(&self, name: &str, wasm_path: &str) -> Result<(), HostError>;

    /// Create a pipe, returning `(read_fd, write_fd)`.
    fn pipe(&self) -> Result<(i32, i32), HostError>;

    /// Wait for a child process to exit (blocking).
    ///
    /// Returns a `SpawnResult` with the exit code. On wasm32 (production),
    /// stdout/stderr are empty because output flows through kernel fd targets.
    /// On MockHost (tests), stdout/stderr contain the mock data so tests
    /// can verify output without a real fd system.
    fn waitpid(&self, pid: i32) -> Result<SpawnResult, HostError>;

    /// Close a host-side file descriptor.
    fn close_fd(&self, fd: i32) -> Result<(), HostError>;

    /// Duplicate a file descriptor: creates a new fd pointing to the same target as `fd`.
    fn dup(&self, fd: i32) -> Result<i32, HostError>;

    /// Duplicate a file descriptor: makes `dst_fd` point to the same target as `src_fd`.
    fn dup2(&self, src_fd: i32, dst_fd: i32) -> Result<(), HostError>;

    /// Read all available data from a file descriptor (drains pipe until EOF).
    fn read_fd(&self, fd: i32) -> Result<Vec<u8>, HostError>;

    /// Write data to a file descriptor.
    fn write_fd(&self, fd: i32, data: &[u8]) -> Result<(), HostError>;

    /// Yield to the scheduler (cooperative scheduling: sleep(0)).
    fn yield_now(&self) -> Result<(), HostError>;

    /// Check if a process has exited without blocking.
    /// Returns exit code if done, -1 if still running.
    fn waitpid_nohang(&self, pid: i32) -> Result<i32, HostError>;

    /// Get a JSON-encoded list of all processes in the kernel.
    fn list_processes(&self) -> Result<String, HostError>;

    // ----- Socket operations (full mode) -----

    /// Open a TCP or TLS socket to host:port. Returns a socket_id.
    fn socket_connect(&self, host: &str, port: u16, tls: bool) -> Result<u32, HostError>;

    /// Send data on an open socket. Returns bytes sent.
    fn socket_send(&self, socket_id: u32, data: &[u8]) -> Result<usize, HostError>;

    /// Receive data from an open socket. Returns received bytes (empty = EOF).
    fn socket_recv(&self, socket_id: u32, max_bytes: usize) -> Result<Vec<u8>, HostError>;

    /// Close an open socket.
    fn socket_close(&self, socket_id: u32) -> Result<(), HostError>;
}

// ---------------------------------------------------------------------------
// Raw WASM host imports (wasm32 only)
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "yurt")]
extern "C" {
    /// Spawn a process on the host.
    /// `req_ptr`/`req_len` — pointer and length of a native spawn request.
    /// `out_ptr`/`out_cap` — pointer and capacity of a caller-allocated output buffer.
    /// Returns the number of bytes written to `out_ptr`, or a negative error code.
    pub fn host_spawn(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Check whether a named tool/binary is available.
    /// Returns 1 for true, 0 for false.
    pub fn host_has_tool(name_ptr: *const u8, name_len: u32) -> i32;

    /// Get current wall-clock time in seconds (f64).
    pub fn host_time() -> f64;

    /// Stat a path.
    pub fn host_stat(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Read file contents.
    pub fn host_read_file(
        path_ptr: *const u8,
        path_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    /// Write data to a file.
    /// `mode`: 0 = truncate, 1 = append.
    pub fn host_write_file(
        path_ptr: *const u8,
        path_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        mode: u32,
    ) -> i32;

    /// List directory entries (JSON array of strings).
    pub fn host_readdir(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Create a directory (and parents).
    pub fn host_mkdir(path_ptr: *const u8, path_len: u32) -> i32;

    /// Remove a path. `recursive`: 0 = single, 1 = recursive.
    pub fn host_remove(path_ptr: *const u8, path_len: u32, recursive: u32) -> i32;

    /// Set file mode bits.
    pub fn host_chmod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32;

    /// Glob pattern match (JSON array of matching paths).
    pub fn host_glob(
        pattern_ptr: *const u8,
        pattern_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    /// Rename / move a path.
    pub fn host_rename(from_ptr: *const u8, from_len: u32, to_ptr: *const u8, to_len: u32) -> i32;

    /// Create a symbolic link.
    pub fn host_symlink(
        target_ptr: *const u8,
        target_len: u32,
        link_ptr: *const u8,
        link_len: u32,
    ) -> i32;

    /// Read symbolic link target.
    pub fn host_readlink(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32)
        -> i32;

    /// Perform an HTTP fetch. Native request/response via output buffer.
    /// Async on the host side; JSPI suspends/resumes WASM transparently.
    pub fn host_network_fetch(
        req_ptr: *const u8,
        req_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    /// Register a pkg-installed tool with the host.
    pub fn host_register_tool(
        name_ptr: *const u8,
        name_len: u32,
        path_ptr: *const u8,
        path_len: u32,
    ) -> i32;

    /// Read the next command from the host session loop.
    pub fn host_read_command(out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Write a JSON-encoded RunResult back to the host.
    pub fn host_write_result(data_ptr: *const u8, data_len: u32);

    // ----- Process management syscalls (Task 5) -----

    /// Create a pipe. Writes yurt_pipe_result_v1 into the output buffer.
    /// Returns bytes written, or negative error code.
    fn host_pipe(out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Wait for a child process to exit (BLOCKING — JSPI suspends the WASM
    /// stack while the host awaits the child).
    /// Writes yurt_wait_result_v1 into the output buffer.
    /// Returns bytes written, or negative error code.
    fn host_wait(pid: i32, flags: i32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Close a host-side file descriptor. Returns 0 on success, negative on error.
    fn host_close_fd(fd: i32) -> i32;

    /// Duplicate fd: creates a new fd pointing to the same target.
    /// Writes one int32_t fd into the output buffer, or negative error code.
    fn host_dup(fd: i32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Duplicate fd: makes dst_fd point to the same target as src_fd.
    /// Returns 0 on success, negative on error.
    fn host_dup2(src_fd: i32, dst_fd: i32) -> i32;

    /// Read all available data from a file descriptor. Writes the data into
    /// the output buffer. Returns bytes written, or negative error code.
    fn host_read_fd(fd: i32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Write data to a file descriptor. Returns bytes written, or negative error code.
    fn host_write_fd(fd: i32, data_ptr: i32, data_len: i32) -> i32;

    /// Yield to the JS microtask queue (cooperative scheduling: sleep(0)).
    /// JSPI-suspending — allows other WASM stacks to run.
    fn host_yield();

    /// List all processes. Writes yurt_process_list_response_v1 to output buffer.
    fn host_list_processes(out_ptr: *mut u8, out_cap: u32) -> i32;

    // ----- Socket syscalls (full mode) -----

    /// Open a socket and return a host fd.
    fn host_socket_open(domain: i32, type_: i32, protocol: i32) -> i32;

    /// Connect a socket fd.
    fn host_socket_connect(
        fd: i32,
        host_ptr: *const u8,
        host_len: u32,
        port: u32,
        flags: u32,
    ) -> i32;

    /// Send raw bytes on a socket.
    fn host_socket_send(fd: i32, data_ptr: *const u8, data_len: u32, flags: i32) -> i32;

    /// Receive raw bytes from a socket.
    fn host_socket_recv(fd: i32, out_ptr: *mut u8, out_cap: u32, flags: i32) -> i32;

    /// Close a socket fd.
    fn host_socket_close(fd: i32) -> i32;
}

// ---------------------------------------------------------------------------
// Error-code helper
// ---------------------------------------------------------------------------

/// Convert a negative host return code to a typed `HostError`.
///
/// Convention: -1 = NotFound, -2 = PermissionDenied, -3 = IoError.
#[cfg(target_arch = "wasm32")]
fn rc_to_error(rc: i32, context: &str) -> HostError {
    match rc {
        -1 => HostError::NotFound(context.into()),
        -2 => HostError::PermissionDenied(context.into()),
        -3 => HostError::IoError(context.into()),
        other => HostError::Other(format!("{context}: host error code {other}")),
    }
}

// ---------------------------------------------------------------------------
// Helper: call a host function that writes into an output buffer
// ---------------------------------------------------------------------------

/// Default starting capacity for output buffers.
#[cfg(target_arch = "wasm32")]
const DEFAULT_OUTBUF_CAP: usize = 4096;

/// Call a host FFI function that follows the pattern:
///   fn(args..., out_ptr, out_cap) -> i32
/// where a negative return is an error code and a positive return is the
/// number of bytes written.  Returns the output as a `String`.
///
/// `context` is used to produce meaningful error messages (typically the
/// path or operation name).
#[cfg(target_arch = "wasm32")]
fn call_with_outbuf<F>(context: &str, f: F) -> Result<String, HostError>
where
    F: Fn(*mut u8, u32) -> i32,
{
    let buf = call_with_outbuf_bytes(context, f)?;
    String::from_utf8(buf).map_err(|e| HostError::Other(format!("invalid UTF-8 from host: {e}")))
}

#[cfg(target_arch = "wasm32")]
fn call_with_outbuf_bytes<F>(context: &str, f: F) -> Result<Vec<u8>, HostError>
where
    F: Fn(*mut u8, u32) -> i32,
{
    let mut buf: Vec<u8> = vec![0u8; DEFAULT_OUTBUF_CAP];
    let n = f(buf.as_mut_ptr(), buf.len() as u32);
    if n < 0 {
        return Err(rc_to_error(n, context));
    }
    let n = n as usize;
    if n > buf.len() {
        // Host indicated it needs more space; retry with the returned size.
        buf.resize(n, 0);
        let n2 = f(buf.as_mut_ptr(), buf.len() as u32);
        if n2 < 0 {
            return Err(rc_to_error(n2, context));
        }
        buf.truncate(n2 as usize);
    } else {
        buf.truncate(n);
    }
    Ok(buf)
}

#[cfg(target_arch = "wasm32")]
fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes
        .get(offset..offset + 2)
        .map(|v| u16::from_le_bytes([v[0], v[1]]))
}

#[cfg(target_arch = "wasm32")]
fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)
        .map(|v| u32::from_le_bytes([v[0], v[1], v[2], v[3]]))
}

#[cfg(target_arch = "wasm32")]
fn read_i32_le(bytes: &[u8], offset: usize) -> Option<i32> {
    bytes
        .get(offset..offset + 4)
        .map(|v| i32::from_le_bytes([v[0], v[1], v[2], v[3]]))
}

#[cfg(target_arch = "wasm32")]
fn write_u16_le(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

#[cfg(target_arch = "wasm32")]
fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

#[cfg(target_arch = "wasm32")]
fn native_span(bytes: &[u8], offset: u32, len: u32) -> Option<&[u8]> {
    let start = usize::try_from(offset).ok()?;
    let len = usize::try_from(len).ok()?;
    let end = start.checked_add(len)?;
    bytes.get(start..end)
}

#[cfg(target_arch = "wasm32")]
fn native_span_str(bytes: &[u8], offset: u32, len: u32) -> Option<String> {
    let span = native_span(bytes, offset, len)?;
    Some(String::from_utf8_lossy(span).into_owned())
}

#[cfg(target_arch = "wasm32")]
fn build_native_fetch_request(
    url: &str,
    method: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Vec<u8> {
    const FETCH_REQUEST_HEADER_SIZE: usize = 44;
    const FETCH_HEADER_PAIR_SIZE: usize = 16;

    let body_bytes = body.unwrap_or_default().as_bytes();
    let headers_offset = FETCH_REQUEST_HEADER_SIZE;
    let string_offset = headers_offset + headers.len() * FETCH_HEADER_PAIR_SIZE;
    let total_size = string_offset
        + url.len()
        + method.len()
        + body_bytes.len()
        + headers
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>();

    let mut req = vec![0u8; total_size];
    write_u32_le(&mut req, 0, total_size as u32);
    write_u16_le(&mut req, 4, 1);
    write_u16_le(&mut req, 6, 0);
    write_u32_le(&mut req, 24, headers_offset as u32);
    write_u32_le(&mut req, 28, headers.len() as u32);
    write_u32_le(&mut req, 40, YURT_FETCH_REDIRECT_MANUAL);

    let mut cursor = string_offset;
    let mut write_span = |req: &mut [u8], data: &[u8]| -> (u32, u32) {
        let start = cursor;
        req[start..start + data.len()].copy_from_slice(data);
        cursor += data.len();
        (start as u32, data.len() as u32)
    };

    let (url_offset, url_length) = write_span(&mut req, url.as_bytes());
    let (method_offset, method_length) = write_span(&mut req, method.as_bytes());
    let (body_offset, body_length) = write_span(&mut req, body_bytes);
    write_u32_le(&mut req, 8, url_offset);
    write_u32_le(&mut req, 12, url_length);
    write_u32_le(&mut req, 16, method_offset);
    write_u32_le(&mut req, 20, method_length);
    write_u32_le(&mut req, 32, body_offset);
    write_u32_le(&mut req, 36, body_length);

    for (idx, (key, value)) in headers.iter().enumerate() {
        let pair_offset = headers_offset + idx * FETCH_HEADER_PAIR_SIZE;
        let (key_offset, key_length) = write_span(&mut req, key.as_bytes());
        let (value_offset, value_length) = write_span(&mut req, value.as_bytes());
        write_u32_le(&mut req, pair_offset, key_offset);
        write_u32_le(&mut req, pair_offset + 4, key_length);
        write_u32_le(&mut req, pair_offset + 8, value_offset);
        write_u32_le(&mut req, pair_offset + 12, value_length);
    }

    req
}

#[cfg(target_arch = "wasm32")]
fn decode_native_fetch_response(bytes: &[u8]) -> Result<FetchResult, HostError> {
    const FETCH_RESPONSE_HEADER_SIZE: usize = 36;
    const FETCH_HEADER_PAIR_SIZE: usize = 16;

    if bytes.len() < FETCH_RESPONSE_HEADER_SIZE || read_u16_le(bytes, 4) != Some(1) {
        return Err(HostError::IoError("fetch: invalid native response".into()));
    }

    let status = read_u16_le(bytes, 8).unwrap_or(0);
    let headers_offset = read_u32_le(bytes, 12).unwrap_or(0);
    let headers_count = read_u32_le(bytes, 16).unwrap_or(0);
    let body_offset = read_u32_le(bytes, 20).unwrap_or(0);
    let body_length = read_u32_le(bytes, 24).unwrap_or(0);
    let error_offset = read_u32_le(bytes, 28).unwrap_or(0);
    let error_length = read_u32_le(bytes, 32).unwrap_or(0);

    let mut headers = std::collections::HashMap::new();
    let headers_offset = usize::try_from(headers_offset)
        .map_err(|_| HostError::IoError("fetch: invalid headers offset".into()))?;
    let headers_count = usize::try_from(headers_count)
        .map_err(|_| HostError::IoError("fetch: invalid headers count".into()))?;
    for idx in 0..headers_count {
        let pair_offset = headers_offset + idx * FETCH_HEADER_PAIR_SIZE;
        let key_offset = read_u32_le(bytes, pair_offset)
            .ok_or_else(|| HostError::IoError("fetch: truncated header pair".into()))?;
        let key_length = read_u32_le(bytes, pair_offset + 4)
            .ok_or_else(|| HostError::IoError("fetch: truncated header pair".into()))?;
        let value_offset = read_u32_le(bytes, pair_offset + 8)
            .ok_or_else(|| HostError::IoError("fetch: truncated header pair".into()))?;
        let value_length = read_u32_le(bytes, pair_offset + 12)
            .ok_or_else(|| HostError::IoError("fetch: truncated header pair".into()))?;
        let key = native_span_str(bytes, key_offset, key_length)
            .ok_or_else(|| HostError::IoError("fetch: invalid header key span".into()))?;
        let value = native_span_str(bytes, value_offset, value_length)
            .ok_or_else(|| HostError::IoError("fetch: invalid header value span".into()))?;
        headers.insert(key, value);
    }

    let body_bytes = native_span(bytes, body_offset, body_length)
        .ok_or_else(|| HostError::IoError("fetch: invalid body span".into()))?;
    let error = if error_length == 0 {
        None
    } else {
        Some(
            native_span_str(bytes, error_offset, error_length)
                .ok_or_else(|| HostError::IoError("fetch: invalid error span".into()))?,
        )
    };
    let ok = error.is_none() && (200..400).contains(&status);
    Ok(FetchResult {
        ok,
        status,
        headers,
        body: String::from_utf8_lossy(body_bytes).into_owned(),
        body_base64: Some(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            body_bytes,
        )),
        error,
    })
}

#[cfg(target_arch = "wasm32")]
fn decode_native_process_list(bytes: &[u8]) -> Result<String, HostError> {
    const PROCESS_LIST_HEADER_SIZE: usize = 16;
    const PROCESS_ENTRY_SIZE: usize = 20;

    if bytes.len() < PROCESS_LIST_HEADER_SIZE || read_u16_le(bytes, 4) != Some(1) {
        return Err(HostError::IoError(
            "list_processes: invalid native response".into(),
        ));
    }
    let entries_offset = read_u32_le(bytes, 8)
        .ok_or_else(|| HostError::IoError("list_processes: missing entries offset".into()))?;
    let entries_count = read_u32_le(bytes, 12)
        .ok_or_else(|| HostError::IoError("list_processes: missing entries count".into()))?;
    let entries_offset = usize::try_from(entries_offset)
        .map_err(|_| HostError::IoError("list_processes: invalid entries offset".into()))?;
    let entries_count = usize::try_from(entries_count)
        .map_err(|_| HostError::IoError("list_processes: invalid entries count".into()))?;

    let mut processes = Vec::with_capacity(entries_count);
    for idx in 0..entries_count {
        let entry_offset = entries_offset + idx * PROCESS_ENTRY_SIZE;
        let pid = read_i32_le(bytes, entry_offset)
            .ok_or_else(|| HostError::IoError("list_processes: truncated entry".into()))?;
        let ppid = read_i32_le(bytes, entry_offset + 4)
            .ok_or_else(|| HostError::IoError("list_processes: truncated entry".into()))?;
        let state_raw = read_u32_le(bytes, entry_offset + 8)
            .ok_or_else(|| HostError::IoError("list_processes: truncated entry".into()))?;
        let command_offset = read_u32_le(bytes, entry_offset + 12)
            .ok_or_else(|| HostError::IoError("list_processes: truncated entry".into()))?;
        let command_length = read_u32_le(bytes, entry_offset + 16)
            .ok_or_else(|| HostError::IoError("list_processes: truncated entry".into()))?;
        let state = match state_raw {
            1 => "running",
            2 => "exited",
            _ => "unknown",
        };
        let command = native_span_str(bytes, command_offset, command_length).unwrap_or_default();
        processes.push(serde_json::json!({
            "pid": pid,
            "ppid": ppid,
            "state": state,
            "command": command,
        }));
    }

    serde_json::to_string(&processes)
        .map_err(|e| HostError::IoError(format!("list_processes: encode json: {e}")))
}

// ---------------------------------------------------------------------------
// WasmHost — production HostInterface bridge (wasm32 only)
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
pub struct WasmHost;

#[cfg(target_arch = "wasm32")]
impl HostInterface for WasmHost {
    fn spawn(
        &self,
        program: &str,
        argv0: Option<&str>,
        args: &[&str],
        env: &[(&str, &str)],
        cwd: &str,
        stdin_data: &str,
        stdin_fd: i32,
        stdout_fd: i32,
        stderr_fd: i32,
        nice: u8,
    ) -> Result<i32, HostError> {
        let req_bytes = build_spawn_request(&YurtSpawnRequest {
            program,
            argv0,
            args,
            env,
            cwd: if cwd.is_empty() { None } else { Some(cwd) },
            stdin_data: if stdin_data.is_empty() {
                None
            } else {
                Some(stdin_data)
            },
            stdin_fd,
            stdout_fd,
            stderr_fd,
            pass_fds: &[],
            fd_map: &[],
            nice: i32::from(nice),
        });
        let mut result = YurtSpawnResult { pid: -1 };
        let rc = unsafe {
            host_spawn(
                req_bytes.as_ptr(),
                req_bytes.len() as u32,
                (&mut result as *mut YurtSpawnResult).cast::<u8>(),
                std::mem::size_of::<YurtSpawnResult>() as u32,
            )
        };
        if rc != std::mem::size_of::<YurtSpawnResult>() as i32 || result.pid < 0 {
            return Err(HostError::IoError(format!(
                "spawn({}): host error code {}",
                program, rc
            )));
        }
        Ok(result.pid)
    }

    fn has_tool(&self, name: &str) -> bool {
        unsafe { host_has_tool(name.as_ptr(), name.len() as u32) != 0 }
    }

    fn time(&self) -> f64 {
        unsafe { host_time() }
    }

    fn stat(&self, path: &str) -> Result<StatInfo, HostError> {
        let output = call_with_outbuf(path, |out_ptr, out_cap| unsafe {
            host_stat(path.as_ptr(), path.len() as u32, out_ptr, out_cap)
        })?;
        serde_json::from_str(&output).map_err(|e| HostError::IoError(format!("stat {path}: {e}")))
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError> {
        let s = call_with_outbuf(path, |out_ptr, out_cap| unsafe {
            host_read_file(path.as_ptr(), path.len() as u32, out_ptr, out_cap)
        })?;
        Ok(s.into_bytes())
    }

    fn write_file(&self, path: &str, data: &[u8], mode: WriteMode) -> Result<(), HostError> {
        let mode_u32 = match mode {
            WriteMode::Truncate => 0,
            WriteMode::Append => 1,
        };
        let rc = unsafe {
            host_write_file(
                path.as_ptr(),
                path.len() as u32,
                data.as_ptr(),
                data.len() as u32,
                mode_u32,
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, path))
        } else {
            Ok(())
        }
    }

    fn readdir(&self, path: &str) -> Result<Vec<String>, HostError> {
        let output = call_with_outbuf(path, |out_ptr, out_cap| unsafe {
            host_readdir(path.as_ptr(), path.len() as u32, out_ptr, out_cap)
        })?;
        serde_json::from_str(&output)
            .map_err(|e| HostError::IoError(format!("readdir {path}: {e}")))
    }

    fn mkdir(&self, path: &str) -> Result<(), HostError> {
        let rc = unsafe { host_mkdir(path.as_ptr(), path.len() as u32) };
        if rc < 0 {
            Err(rc_to_error(rc, path))
        } else {
            Ok(())
        }
    }

    fn remove(&self, path: &str, recursive: bool) -> Result<(), HostError> {
        let rc = unsafe {
            host_remove(
                path.as_ptr(),
                path.len() as u32,
                if recursive { 1 } else { 0 },
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, path))
        } else {
            Ok(())
        }
    }

    fn chmod(&self, path: &str, mode: u32) -> Result<(), HostError> {
        let rc = unsafe { host_chmod(path.as_ptr(), path.len() as u32, mode) };
        if rc < 0 {
            Err(rc_to_error(rc, path))
        } else {
            Ok(())
        }
    }

    fn glob(&self, pattern: &str) -> Result<Vec<String>, HostError> {
        let output = call_with_outbuf(pattern, |out_ptr, out_cap| unsafe {
            host_glob(pattern.as_ptr(), pattern.len() as u32, out_ptr, out_cap)
        })?;
        serde_json::from_str(&output)
            .map_err(|e| HostError::IoError(format!("glob {pattern}: {e}")))
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), HostError> {
        let rc = unsafe {
            host_rename(
                from.as_ptr(),
                from.len() as u32,
                to.as_ptr(),
                to.len() as u32,
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, from))
        } else {
            Ok(())
        }
    }

    fn symlink(&self, target: &str, link_path: &str) -> Result<(), HostError> {
        let rc = unsafe {
            host_symlink(
                target.as_ptr(),
                target.len() as u32,
                link_path.as_ptr(),
                link_path.len() as u32,
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, link_path))
        } else {
            Ok(())
        }
    }

    fn readlink(&self, path: &str) -> Result<String, HostError> {
        call_with_outbuf(path, |out_ptr, out_cap| unsafe {
            host_readlink(path.as_ptr(), path.len() as u32, out_ptr, out_cap)
        })
    }

    fn fetch(
        &self,
        url: &str,
        method: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> FetchResult {
        let req = build_native_fetch_request(url, method, headers, body);
        let output = call_with_outbuf_bytes("fetch", |out_ptr, out_cap| unsafe {
            host_network_fetch(req.as_ptr(), req.len() as u32, out_ptr, out_cap)
        });
        match output {
            Ok(bytes) => decode_native_fetch_response(&bytes).unwrap_or_else(|e| FetchResult {
                ok: false,
                status: 0,
                headers: Default::default(),
                body: String::new(),
                body_base64: None,
                error: Some(format!("fetch: failed to deserialize response: {e}")),
            }),
            Err(e) => FetchResult {
                ok: false,
                status: 0,
                headers: Default::default(),
                body: String::new(),
                body_base64: None,
                error: Some(format!("fetch: host error: {e}")),
            },
        }
    }

    fn register_tool(&self, name: &str, wasm_path: &str) -> Result<(), HostError> {
        let rc = unsafe {
            host_register_tool(
                name.as_ptr(),
                name.len() as u32,
                wasm_path.as_ptr(),
                wasm_path.len() as u32,
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, name))
        } else {
            Ok(())
        }
    }

    // ----- Process management (Task 5) -----

    fn pipe(&self) -> Result<(i32, i32), HostError> {
        let mut result = YurtPipeResult {
            read_fd: -1,
            write_fd: -1,
        };
        let rc = unsafe {
            host_pipe(
                (&mut result as *mut YurtPipeResult).cast::<u8>(),
                std::mem::size_of::<YurtPipeResult>() as u32,
            )
        };
        if rc != std::mem::size_of::<YurtPipeResult>() as i32
            || result.read_fd < 0
            || result.write_fd < 0
        {
            return Err(HostError::IoError(format!("pipe: host error code {rc}")));
        }
        Ok((result.read_fd, result.write_fd))
    }

    fn waitpid(&self, pid: i32) -> Result<SpawnResult, HostError> {
        let mut result = YurtWaitResult {
            pid: -1,
            exit_code: -1,
            signal: 0,
            flags: 0,
        };
        let rc = unsafe {
            host_wait(
                pid,
                0,
                (&mut result as *mut YurtWaitResult).cast::<u8>(),
                std::mem::size_of::<YurtWaitResult>() as u32,
            )
        };
        if rc != std::mem::size_of::<YurtWaitResult>() as i32
            || result.pid < 0
            || result.exit_code < 0
        {
            return Err(HostError::IoError(format!(
                "waitpid({pid}): host error code {rc}"
            )));
        }
        Ok(SpawnResult {
            exit_code: result.exit_code,
        })
    }

    fn close_fd(&self, fd: i32) -> Result<(), HostError> {
        let rc = unsafe { host_close_fd(fd) };
        if rc < 0 {
            return Err(HostError::IoError(format!(
                "close_fd({}): host error code {}",
                fd, rc
            )));
        }
        Ok(())
    }

    fn dup(&self, fd: i32) -> Result<i32, HostError> {
        let mut new_fd = -1i32;
        let rc = unsafe {
            host_dup(
                fd,
                (&mut new_fd as *mut i32).cast::<u8>(),
                std::mem::size_of::<i32>() as u32,
            )
        };
        if rc != std::mem::size_of::<i32>() as i32 {
            return Err(HostError::IoError(format!(
                "dup({fd}): host error code {rc}"
            )));
        }
        if new_fd < 0 {
            return Err(HostError::IoError(format!("dup({}): invalid fd", fd)));
        }
        Ok(new_fd)
    }

    fn dup2(&self, src_fd: i32, dst_fd: i32) -> Result<(), HostError> {
        let rc = unsafe { host_dup2(src_fd, dst_fd) };
        if rc < 0 {
            return Err(HostError::IoError(format!(
                "dup2({}, {}): host error code {}",
                src_fd, dst_fd, rc
            )));
        }
        Ok(())
    }

    fn read_fd(&self, fd: i32) -> Result<Vec<u8>, HostError> {
        let result_str = call_with_outbuf("read_fd", |out_ptr, out_cap| unsafe {
            host_read_fd(fd, out_ptr, out_cap)
        })?;
        Ok(result_str.into_bytes())
    }

    fn write_fd(&self, fd: i32, data: &[u8]) -> Result<(), HostError> {
        let rc = unsafe { host_write_fd(fd, data.as_ptr() as i32, data.len() as i32) };
        if rc < 0 {
            return Err(HostError::IoError(format!("write_fd({fd}): error {rc}")));
        }
        Ok(())
    }

    fn yield_now(&self) -> Result<(), HostError> {
        unsafe { host_yield() };
        Ok(())
    }

    fn waitpid_nohang(&self, pid: i32) -> Result<i32, HostError> {
        let mut result = YurtWaitResult {
            pid: -1,
            exit_code: -1,
            signal: 0,
            flags: 0,
        };
        let rc = unsafe {
            host_wait(
                pid,
                YURT_WAIT_NOHANG,
                (&mut result as *mut YurtWaitResult).cast::<u8>(),
                std::mem::size_of::<YurtWaitResult>() as u32,
            )
        };
        if rc == -11 {
            return Ok(-1);
        }
        if rc == -10 {
            return Ok(-2);
        }
        if rc != std::mem::size_of::<YurtWaitResult>() as i32 {
            return Ok(-2);
        }
        Ok(result.exit_code)
    }

    fn list_processes(&self) -> Result<String, HostError> {
        let bytes = call_with_outbuf_bytes("list_processes", |out_ptr, out_cap| unsafe {
            host_list_processes(out_ptr, out_cap)
        })?;
        decode_native_process_list(&bytes)
    }

    // ----- Socket operations (full mode) -----

    fn socket_connect(&self, host: &str, port: u16, tls: bool) -> Result<u32, HostError> {
        let fd = unsafe { host_socket_open(YURT_AF_INET, YURT_SOCK_STREAM, 0) };
        if fd < 0 {
            return Err(HostError::IoError(format!(
                "socket_open: host error code {fd}"
            )));
        }
        let flags = if tls { YURT_SOCKET_FLAG_TLS as u32 } else { 0 };
        let rc = unsafe {
            host_socket_connect(fd, host.as_ptr(), host.len() as u32, u32::from(port), flags)
        };
        if rc < 0 {
            let _ = unsafe { host_socket_close(fd) };
            return Err(HostError::IoError(format!(
                "socket_connect: host error code {rc}"
            )));
        }
        Ok(fd as u32)
    }

    fn socket_send(&self, socket_id: u32, data: &[u8]) -> Result<usize, HostError> {
        let rc = unsafe {
            host_socket_send(
                socket_id as i32,
                data.as_ptr(),
                data.len() as u32,
                YURT_MSG_NONE,
            )
        };
        if rc < 0 {
            return Err(HostError::IoError(format!(
                "socket_send: host error code {rc}"
            )));
        }
        Ok(rc as usize)
    }

    fn socket_recv(&self, socket_id: u32, max_bytes: usize) -> Result<Vec<u8>, HostError> {
        let mut buf = vec![0u8; max_bytes];
        let rc = unsafe {
            host_socket_recv(
                socket_id as i32,
                buf.as_mut_ptr(),
                buf.len() as u32,
                YURT_MSG_NONE,
            )
        };
        if rc < 0 {
            return Err(HostError::IoError(format!(
                "socket_recv: host error code {rc}"
            )));
        }
        buf.truncate(rc as usize);
        Ok(buf)
    }

    fn socket_close(&self, socket_id: u32) -> Result<(), HostError> {
        let rc = unsafe { host_socket_close(socket_id as i32) };
        if rc < 0 {
            return Err(HostError::IoError(format!("socket_close: error {rc}")));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Session functions (wasm32 only) — not on the trait
// ---------------------------------------------------------------------------

/// Read the next command string from the host session loop.
#[cfg(target_arch = "wasm32")]
pub fn read_command() -> String {
    call_with_outbuf("read_command", |ptr, cap| unsafe {
        host_read_command(ptr, cap)
    })
    .unwrap_or_default()
}

/// Write a `RunResult` back to the host as JSON.
#[cfg(target_arch = "wasm32")]
pub fn write_result(result: &crate::control::RunResult) {
    let json = serde_json::to_vec(result).unwrap();
    unsafe { host_write_result(json.as_ptr(), json.len() as u32) };
}

// ---------------------------------------------------------------------------
// WASI P1 fd I/O wrappers (wasm32 only) — used by builtins for direct fd I/O
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    fn fd_write(fd: i32, iovs: *const WasiIovec, iovs_len: u32, nwritten: *mut u32) -> u32;
    fn fd_read(fd: i32, iovs: *const WasiIovec, iovs_len: u32, nread: *mut u32) -> u32;
}

#[cfg(target_arch = "wasm32")]
#[repr(C)]
struct WasiIovec {
    buf: *const u8,
    buf_len: u32,
}

/// Write `data` to a host file descriptor via WASI `fd_write`.
#[cfg(target_arch = "wasm32")]
pub fn write_to_fd(fd: i32, data: &[u8]) -> Result<usize, HostError> {
    let iov = WasiIovec {
        buf: data.as_ptr(),
        buf_len: data.len() as u32,
    };
    let mut nwritten: u32 = 0;
    let errno = unsafe { fd_write(fd, &iov, 1, &mut nwritten) };
    if errno != 0 {
        return Err(HostError::IoError(format!("fd_write errno {}", errno)));
    }
    Ok(nwritten as usize)
}

/// Read from a host file descriptor via WASI `fd_read`.
#[cfg(target_arch = "wasm32")]
pub fn read_from_fd(fd: i32, buf: &mut [u8]) -> Result<usize, HostError> {
    let iov = WasiIovec {
        buf: buf.as_mut_ptr(),
        buf_len: buf.len() as u32,
    };
    let mut nread: u32 = 0;
    let errno = unsafe { fd_read(fd, &iov, 1, &mut nread) };
    if errno != 0 {
        return Err(HostError::IoError(format!("fd_read errno {}", errno)));
    }
    Ok(nread as usize)
}
