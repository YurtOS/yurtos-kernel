//! Process spawning for yurt coreutils via the `yurt` host ABI.
//!
//! Provides a [`Command`] builder that wraps `host_spawn` +
//! `host_wait`, routing the child's stdout/stderr back through the
//! calling process's own output pipes by setting `stdout_fd=1, stderr_fd=2`
//! in the native spawn request.
//!
//! Supports an optional `nice` value (0–19) which is forwarded to the host
//! so the child runs at the requested epoch quantum.

use std::io;

// ── Host ABI ──────────────────────────────────────────────────────────────────

#[link(wasm_import_module = "yurt")]
extern "C" {
    /// Spawn a child process from a native spawn request.
    fn host_spawn(req_ptr: *const u8, req_len: usize, out_ptr: *mut u8, out_cap: usize) -> i32;

    /// Block until child `pid` exits. Writes yurt_wait_result_v1 into
    /// `out_ptr/out_cap`. Returns the number of bytes written, or negative
    /// on error.
    fn host_wait(pid: i32, flags: i32, out_ptr: *mut u8, out_cap: usize) -> i32;
}

#[repr(C)]
struct YurtWaitResult {
    pid: i32,
    exit_code: i32,
    signal: i32,
    flags: i32,
}

#[repr(C)]
struct YurtSpawnResult {
    pid: i32,
}

const SPAWN_REQUEST_V1_SIZE: usize = 88;
const RECORD_VERSION_1: u16 = 1;
const PROG_OFF: usize = 8;
const ARGV0_OFF: usize = 16;
const ARGS_VEC_OFF: usize = 24;
const ARGS_COUNT_OFF: usize = 28;
const ENV_VEC_OFF: usize = 32;
const ENV_COUNT_OFF: usize = 36;
const CWD_OFF: usize = 40;
const STDIN_FD_OFF: usize = 48;
const STDOUT_FD_OFF: usize = 52;
const STDERR_FD_OFF: usize = 56;
const PASS_FDS_OFF: usize = 60;
const PASS_FDS_COUNT_OFF: usize = 64;
const STDIN_DATA_OFF: usize = 68;
const NICE_OFF: usize = 76;
const FD_MAP_OFF: usize = 80;
const FD_MAP_COUNT_OFF: usize = 84;
const SPAN_SIZE: usize = 8;
const ENV_PAIR_SIZE: usize = 16;

pub struct SpawnRequest<'a> {
    pub program: &'a str,
    pub argv0: Option<&'a str>,
    pub args: &'a [&'a str],
    pub env: &'a [(&'a str, &'a str)],
    pub cwd: Option<&'a str>,
    pub stdin_data: Option<&'a str>,
    pub stdin_fd: i32,
    pub stdout_fd: i32,
    pub stderr_fd: i32,
    pub pass_fds: &'a [i32],
    pub fd_map: &'a [(i32, i32)],
    pub nice: i32,
}

pub fn build_spawn_request(req: &SpawnRequest<'_>) -> Vec<u8> {
    let mut builder = SpawnRecordBuilder {
        bytes: vec![0; SPAWN_REQUEST_V1_SIZE],
    };
    builder.span(PROG_OFF, req.program);
    if let Some(argv0) = req.argv0 {
        builder.span(ARGV0_OFF, argv0);
    }
    builder.string_vec(ARGS_VEC_OFF, ARGS_COUNT_OFF, req.args);
    builder.env_vec(req.env);
    if let Some(cwd) = req.cwd {
        builder.span(CWD_OFF, cwd);
    }
    put_i32(&mut builder.bytes, STDIN_FD_OFF, req.stdin_fd);
    put_i32(&mut builder.bytes, STDOUT_FD_OFF, req.stdout_fd);
    put_i32(&mut builder.bytes, STDERR_FD_OFF, req.stderr_fd);
    builder.i32_vec(PASS_FDS_OFF, PASS_FDS_COUNT_OFF, req.pass_fds);
    builder.fd_map_vec(req.fd_map);
    if let Some(stdin_data) = req.stdin_data {
        builder.span(STDIN_DATA_OFF, stdin_data);
    }
    put_i32(&mut builder.bytes, NICE_OFF, req.nice);
    builder.finish()
}

struct SpawnRecordBuilder {
    bytes: Vec<u8>,
}

impl SpawnRecordBuilder {
    fn finish(mut self) -> Vec<u8> {
        let size = self.bytes.len() as u32;
        put_u32(&mut self.bytes, 0, size);
        put_u16(&mut self.bytes, 4, RECORD_VERSION_1);
        self.bytes
    }

    fn align4(&mut self) {
        while !self.bytes.len().is_multiple_of(4) {
            self.bytes.push(0);
        }
    }

    fn span(&mut self, field_off: usize, value: &str) {
        if value.is_empty() {
            return;
        }
        self.align4();
        let off = self.bytes.len();
        self.bytes.extend_from_slice(value.as_bytes());
        put_u32(&mut self.bytes, field_off, off as u32);
        put_u32(&mut self.bytes, field_off + 4, value.len() as u32);
    }

    fn string_vec(&mut self, vec_field_off: usize, count_field_off: usize, values: &[&str]) {
        if values.is_empty() {
            return;
        }
        self.align4();
        let vec_off = self.bytes.len();
        self.bytes.resize(vec_off + values.len() * SPAN_SIZE, 0);
        for (index, value) in values.iter().enumerate() {
            self.span(vec_off + index * SPAN_SIZE, value);
        }
        put_u32(&mut self.bytes, vec_field_off, vec_off as u32);
        put_u32(&mut self.bytes, count_field_off, values.len() as u32);
    }

    fn env_vec(&mut self, values: &[(&str, &str)]) {
        if values.is_empty() {
            return;
        }
        self.align4();
        let vec_off = self.bytes.len();
        self.bytes.resize(vec_off + values.len() * ENV_PAIR_SIZE, 0);
        for (index, (key, value)) in values.iter().enumerate() {
            let off = vec_off + index * ENV_PAIR_SIZE;
            self.span(off, key);
            self.span(off + SPAN_SIZE, value);
        }
        put_u32(&mut self.bytes, ENV_VEC_OFF, vec_off as u32);
        put_u32(&mut self.bytes, ENV_COUNT_OFF, values.len() as u32);
    }

    fn i32_vec(&mut self, vec_field_off: usize, count_field_off: usize, values: &[i32]) {
        if values.is_empty() {
            return;
        }
        self.align4();
        let vec_off = self.bytes.len();
        for value in values {
            self.bytes.extend_from_slice(&value.to_le_bytes());
        }
        put_u32(&mut self.bytes, vec_field_off, vec_off as u32);
        put_u32(&mut self.bytes, count_field_off, values.len() as u32);
    }

    fn fd_map_vec(&mut self, values: &[(i32, i32)]) {
        if values.is_empty() {
            return;
        }
        self.align4();
        let vec_off = self.bytes.len();
        for (parent_fd, child_fd) in values {
            self.bytes.extend_from_slice(&parent_fd.to_le_bytes());
            self.bytes.extend_from_slice(&child_fd.to_le_bytes());
        }
        put_u32(&mut self.bytes, FD_MAP_OFF, vec_off as u32);
        put_u32(&mut self.bytes, FD_MAP_COUNT_OFF, values.len() as u32);
    }
}

fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
    bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
    bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_i32(bytes: &mut [u8], off: usize, value: i32) {
    bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
}

// ── ExitStatus ────────────────────────────────────────────────────────────────

/// Exit status of a completed child process.
#[derive(Debug, Clone, Copy)]
pub struct ExitStatus(i32);

impl ExitStatus {
    /// Returns the raw exit code.
    pub fn code(self) -> Option<i32> {
        Some(self.0)
    }

    /// Returns `true` if the exit code is zero.
    pub fn success(self) -> bool {
        self.0 == 0
    }
}

// ── Command ───────────────────────────────────────────────────────────────────

/// Builder for spawning a child command via the yurt host ABI.
///
/// The child's stdout and stderr are forwarded to the caller's own
/// stdout/stderr automatically (`stdout_fd=1, stderr_fd=2`).
///
/// # Example
/// ```no_run
/// use yurt_process::Command;
/// let status = Command::new("echo").arg("hello").status().unwrap();
/// assert!(status.success());
/// ```
pub struct Command {
    program: String,
    args: Vec<String>,
    nice: u8,
}

impl Command {
    /// Create a new command for `program`.
    pub fn new(program: impl Into<String>) -> Self {
        Command {
            program: program.into(),
            args: Vec::new(),
            nice: 0,
        }
    }

    /// Append a single argument.
    pub fn arg(&mut self, arg: impl Into<String>) -> &mut Self {
        self.args.push(arg.into());
        self
    }

    /// Append multiple arguments.
    pub fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        for a in args {
            self.args.push(a.into());
        }
        self
    }

    /// Set the CPU scheduling priority (0 = default, 19 = lowest).
    /// Values above 19 are clamped to 19.
    pub fn nice(&mut self, n: u8) -> &mut Self {
        self.nice = n.min(19);
        self
    }

    /// Spawn the command and wait for it to finish. Returns the exit status.
    pub fn status(&self) -> io::Result<ExitStatus> {
        // stdout_fd=1 and stderr_fd=2 route child output to our own pipes.
        let args = self.args.iter().map(String::as_str).collect::<Vec<_>>();
        let req_bytes = build_spawn_request(&SpawnRequest {
            program: &self.program,
            argv0: None,
            args: &args,
            env: &[],
            cwd: None,
            stdin_data: None,
            stdin_fd: 0,
            stdout_fd: 1,
            stderr_fd: 2,
            pass_fds: &[],
            fd_map: &[],
            nice: i32::from(self.nice),
        });
        let mut spawn = YurtSpawnResult { pid: -1 };
        let rc = unsafe {
            host_spawn(
                req_bytes.as_ptr(),
                req_bytes.len(),
                (&mut spawn as *mut YurtSpawnResult).cast::<u8>(),
                std::mem::size_of::<YurtSpawnResult>(),
            )
        };
        if rc != std::mem::size_of::<YurtSpawnResult>() as i32 || spawn.pid < 0 {
            return Err(io::Error::other(format!("host_spawn failed: {rc}")));
        }

        let mut wait = YurtWaitResult {
            pid: -1,
            exit_code: 1,
            signal: 0,
            flags: 0,
        };
        let n = unsafe {
            host_wait(
                spawn.pid,
                0,
                (&mut wait as *mut YurtWaitResult).cast::<u8>(),
                std::mem::size_of::<YurtWaitResult>(),
            )
        };
        let exit_code = if n == std::mem::size_of::<YurtWaitResult>() as i32 {
            wait.exit_code
        } else {
            1
        };

        Ok(ExitStatus(exit_code))
    }
}

// ── Compatibility shim ────────────────────────────────────────────────────────

/// Allow `ExitStatus` to be used where `std::process::ExitStatus` is expected
/// via `.code()` / `.success()` — same surface API.
impl From<ExitStatus> for Option<i32> {
    fn from(s: ExitStatus) -> Self {
        s.code()
    }
}
