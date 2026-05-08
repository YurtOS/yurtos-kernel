//! Process spawning for yurt coreutils via the `yurt` host ABI.
//!
//! Provides a [`Command`] builder that wraps `host_spawn_async` +
//! `host_waitpid`, routing the child's stdout/stderr back through the
//! calling process's own output pipes by setting `stdout_fd=1, stderr_fd=2`
//! in the [`SpawnRequest`].
//!
//! Supports an optional `nice` value (0–19) which is forwarded to the host
//! so the child runs at the requested epoch quantum.

use std::io;

// ── Host ABI ──────────────────────────────────────────────────────────────────

#[link(wasm_import_module = "yurt")]
extern "C" {
    /// Spawn a child process. `req_ptr/req_len` point to a UTF-8 JSON
    /// [`SpawnRequest`]. Returns a PID (>= 0) on success, negative on error.
    fn host_spawn_async(req_ptr: *const u8, req_len: usize) -> i32;

    /// Block until child `pid` exits. Writes `{"exit_code":N}` JSON into
    /// `out_ptr/out_cap`. Returns the number of bytes written, or negative
    /// on error.
    fn host_waitpid(pid: i32, out_ptr: *mut u8, out_cap: usize) -> i32;
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
        // Serialize SpawnRequest JSON without pulling in serde_json.
        // stdout_fd=1 and stderr_fd=2 route child output to our own pipes.
        let args_json = json_string_array(&self.args);
        let req = format!(
            r#"{{"prog":{},"args":{},"stdout_fd":1,"stderr_fd":2,"nice":{}}}"#,
            json_escape(&self.program),
            args_json,
            self.nice,
        );
        let req_bytes = req.as_bytes();

        let pid = unsafe { host_spawn_async(req_bytes.as_ptr(), req_bytes.len()) };
        if pid < 0 {
            return Err(io::Error::other(format!("host_spawn_async failed: {pid}")));
        }

        // Wait for child; read exit code from JSON response.
        let mut out = [0u8; 64];
        let n = unsafe { host_waitpid(pid, out.as_mut_ptr(), out.len()) };
        let exit_code = if n > 0 {
            parse_exit_code(&out[..n as usize])
        } else {
            1
        };

        Ok(ExitStatus(exit_code))
    }
}

// ── JSON helpers (no-alloc-friendly) ─────────────────────────────────────────

/// Minimal JSON string escaping (backslash and double-quote only).
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str(r#"\""#),
            '\\' => out.push_str(r"\\"),
            '\n' => out.push_str(r"\n"),
            '\r' => out.push_str(r"\r"),
            '\t' => out.push_str(r"\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Serialize a `&[String]` as a JSON array of strings.
fn json_string_array(items: &[String]) -> String {
    let mut out = String::from("[");
    for (i, s) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&json_escape(s));
    }
    out.push(']');
    out
}

/// Extract `exit_code` from `{"exit_code":N}` without pulling in serde.
fn parse_exit_code(json: &[u8]) -> i32 {
    let s = std::str::from_utf8(json).unwrap_or("");
    // Find `"exit_code":` then parse the integer that follows.
    if let Some(pos) = s.find("\"exit_code\":") {
        let rest = s[pos + 12..].trim_start();
        let end = rest
            .find(|c: char| !c.is_ascii_digit() && c != '-')
            .unwrap_or(rest.len());
        rest[..end].parse().unwrap_or(1)
    } else {
        1
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
