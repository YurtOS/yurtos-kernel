#[cfg(test)]
pub mod mock {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    use crate::host::{FetchResult, HostError, HostInterface, SpawnResult, StatInfo, WriteMode};

    /// Mutex to serialize dup2 operations on fd 1 across test threads.
    pub static FD_MUTEX: Mutex<()> = Mutex::new(());

    /// A recorded spawn invocation, for test assertions.
    #[derive(Debug, Clone)]
    pub struct SpawnCall {
        pub program: String,
        pub argv0: Option<String>,
        pub args: Vec<String>,
        pub stdin: String,
    }

    /// Mock-only spawn output that carries stdout/stderr data for piping,
    /// plus the exit code. `SpawnResult` itself only has `exit_code`.
    #[derive(Debug, Clone)]
    pub struct MockSpawnOutput {
        pub exit_code: i32,
        pub stdout: String,
        pub stderr: String,
    }

    /// An in-memory mock implementation of `HostInterface` for testing.
    ///
    /// Uses `RefCell` for the files map so that `write_file` can mutate state
    /// through a `&self` reference (as required by the `HostInterface` trait).
    pub struct MockHost {
        files: RefCell<HashMap<String, Vec<u8>>>,
        dirs: HashSet<String>,
        tools: HashSet<String>,
        spawn_results: HashMap<String, MockSpawnOutput>,
        glob_results: HashMap<String, Vec<String>>,
        /// Records every spawn invocation for later assertion.
        spawn_calls: RefCell<Vec<SpawnCall>>,
        /// Optional dynamic spawn handler: receives (program, args, stdin) and
        /// returns a MockSpawnOutput. When set, this takes priority over
        /// `spawn_results`.
        spawn_handler: Option<Box<dyn Fn(&str, &[&str], &str) -> MockSpawnOutput>>,
        /// Pre-configured fetch results keyed by URL.
        fetch_results: HashMap<String, FetchResult>,
        /// Records register_tool calls for test assertions.
        registered_tools: RefCell<Vec<(String, String)>>,
        /// Next PID to allocate for spawn.
        next_pid: RefCell<i32>,
        /// Stored spawn results keyed by PID, for waitpid to return exit codes.
        pid_results: RefCell<HashMap<i32, SpawnResult>>,
    }

    impl Default for MockHost {
        fn default() -> Self {
            Self::new()
        }
    }

    impl MockHost {
        pub fn new() -> Self {
            Self {
                files: RefCell::new(HashMap::new()),
                dirs: HashSet::new(),
                tools: HashSet::new(),
                spawn_results: HashMap::new(),
                glob_results: HashMap::new(),
                spawn_calls: RefCell::new(Vec::new()),
                spawn_handler: None,
                fetch_results: HashMap::new(),
                registered_tools: RefCell::new(Vec::new()),
                next_pid: RefCell::new(100),
                pid_results: RefCell::new(HashMap::new()),
            }
        }

        /// Register a tool name as available.
        pub fn with_tool(mut self, name: &str) -> Self {
            self.tools.insert(name.to_string());
            self
        }

        /// Register a pre-configured spawn result for a command name.
        pub fn with_spawn_result(mut self, cmd: &str, result: MockSpawnOutput) -> Self {
            self.spawn_results.insert(cmd.to_string(), result);
            self
        }

        /// Add a file with the given content.
        pub fn with_file(self, path: &str, content: &[u8]) -> Self {
            self.files
                .borrow_mut()
                .insert(path.to_string(), content.to_vec());
            self
        }

        /// Add a directory.
        pub fn with_dir(mut self, path: &str) -> Self {
            self.dirs.insert(path.to_string());
            self
        }

        /// Register pre-configured glob results for a pattern.
        pub fn with_glob_result(mut self, pattern: &str, matches: Vec<String>) -> Self {
            self.glob_results.insert(pattern.to_string(), matches);
            self
        }

        /// Register a dynamic spawn handler that receives (program, args, stdin)
        /// and returns a MockSpawnOutput. Takes priority over `spawn_results`.
        pub fn with_spawn_handler<F>(mut self, handler: F) -> Self
        where
            F: Fn(&str, &[&str], &str) -> MockSpawnOutput + 'static,
        {
            self.spawn_handler = Some(Box::new(handler));
            self
        }

        /// Read a file's content from the mock filesystem (for test assertions).
        pub fn get_file(&self, path: &str) -> Option<String> {
            self.files
                .borrow()
                .get(path)
                .and_then(|data| String::from_utf8(data.clone()).ok())
        }

        /// Retrieve all recorded spawn calls for test assertions.
        pub fn get_spawn_calls(&self) -> Vec<SpawnCall> {
            self.spawn_calls.borrow().clone()
        }

        /// Register a pre-configured fetch result for a URL.
        pub fn with_fetch_result(mut self, url: &str, result: FetchResult) -> Self {
            self.fetch_results.insert(url.to_string(), result);
            self
        }

        /// Retrieve all recorded register_tool calls for test assertions.
        pub fn get_registered_tools(&self) -> Vec<(String, String)> {
            self.registered_tools.borrow().clone()
        }
    }

    impl HostInterface for MockHost {
        fn spawn(
            &self,
            program: &str,
            argv0: Option<&str>,
            args: &[&str],
            _env: &[(&str, &str)],
            _cwd: &str,
            stdin_data: &str,
            stdin_fd: i32,
            stdout_fd: i32,
            _stderr_fd: i32,
            _nice: u8,
        ) -> Result<i32, HostError> {
            // In streaming pipeline mode, stdin comes from a pipe fd, not the
            // stdin_data string. Read from stdin_fd if stdin_data is empty.
            let effective_stdin = if stdin_data.is_empty() && stdin_fd > 2 {
                // Read from the pipe fd
                let data = self.read_fd(stdin_fd).unwrap_or_default();
                String::from_utf8_lossy(&data).to_string()
            } else {
                stdin_data.to_string()
            };

            // Record the call for later assertion.
            self.spawn_calls.borrow_mut().push(SpawnCall {
                program: program.to_string(),
                argv0: argv0.map(|s| s.to_string()),
                args: args.iter().map(|s| s.to_string()).collect(),
                stdin: effective_stdin.clone(),
            });

            // Resolve the mock spawn output from handler or static map.
            let output = if let Some(ref handler) = self.spawn_handler {
                handler(program, args, &effective_stdin)
            } else if let Some(r) = self.spawn_results.get(program) {
                r.clone()
            } else {
                MockSpawnOutput {
                    exit_code: 127,
                    stdout: String::new(),
                    stderr: format!("{program}: command not found"),
                }
            };

            // Write mock stdout to the pipe fd so streaming pipelines work.
            if !output.stdout.is_empty() && stdout_fd > 2 {
                let data = output.stdout.as_bytes();
                unsafe {
                    libc::write(
                        stdout_fd as libc::c_int,
                        data.as_ptr() as *const libc::c_void,
                        data.len(),
                    );
                }
            }

            // Allocate a PID and store the exit code for waitpid.
            let mut pid_ref = self.next_pid.borrow_mut();
            let pid = *pid_ref;
            *pid_ref += 1;
            self.pid_results.borrow_mut().insert(
                pid,
                SpawnResult {
                    exit_code: output.exit_code,
                },
            );
            Ok(pid)
        }

        fn has_tool(&self, name: &str) -> bool {
            self.tools.contains(name)
        }

        fn time(&self) -> f64 {
            1700000000.0
        }

        fn stat(&self, path: &str) -> Result<StatInfo, HostError> {
            let files = self.files.borrow();
            if let Some(data) = files.get(path) {
                Ok(StatInfo {
                    exists: true,
                    is_file: true,
                    is_dir: false,
                    is_symlink: false,
                    size: data.len() as u64,
                    mode: 0o644,
                    mtime_ms: 0,
                })
            } else if self.dirs.contains(path) {
                Ok(StatInfo {
                    exists: true,
                    is_file: false,
                    is_dir: true,
                    is_symlink: false,
                    size: 0,
                    mode: 0o755,
                    mtime_ms: 0,
                })
            } else {
                Ok(StatInfo {
                    exists: false,
                    is_file: false,
                    is_dir: false,
                    is_symlink: false,
                    size: 0,
                    mode: 0,
                    mtime_ms: 0,
                })
            }
        }

        fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError> {
            match self.files.borrow().get(path) {
                Some(data) => Ok(data.clone()),
                None => Err(HostError::NotFound(path.to_string())),
            }
        }

        fn write_file(&self, path: &str, data: &[u8], mode: WriteMode) -> Result<(), HostError> {
            let mut files = self.files.borrow_mut();
            match mode {
                WriteMode::Truncate => {
                    files.insert(path.to_string(), data.to_vec());
                }
                WriteMode::Append => {
                    let entry = files.entry(path.to_string()).or_default();
                    entry.extend_from_slice(data);
                }
            }
            Ok(())
        }

        fn readdir(&self, path: &str) -> Result<Vec<String>, HostError> {
            let prefix = if path.ends_with('/') {
                path.to_string()
            } else {
                format!("{path}/")
            };
            let files = self.files.borrow();
            let mut entries = HashSet::new();
            for key in files.keys() {
                if let Some(rest) = key.strip_prefix(&prefix) {
                    if let Some(name) = rest.split('/').next() {
                        if !name.is_empty() {
                            entries.insert(name.to_string());
                        }
                    }
                }
            }
            for key in &self.dirs {
                if let Some(rest) = key.strip_prefix(&prefix) {
                    if let Some(name) = rest.split('/').next() {
                        if !name.is_empty() {
                            entries.insert(name.to_string());
                        }
                    }
                }
            }
            let mut result: Vec<String> = entries.into_iter().collect();
            result.sort();
            Ok(result)
        }

        fn mkdir(&self, _path: &str) -> Result<(), HostError> {
            Ok(())
        }

        fn remove(&self, _path: &str, _recursive: bool) -> Result<(), HostError> {
            Ok(())
        }

        fn chmod(&self, _path: &str, _mode: u32) -> Result<(), HostError> {
            Ok(())
        }

        fn glob(&self, pattern: &str) -> Result<Vec<String>, HostError> {
            Ok(self.glob_results.get(pattern).cloned().unwrap_or_default())
        }

        fn rename(&self, _from: &str, _to: &str) -> Result<(), HostError> {
            Ok(())
        }

        fn symlink(&self, _target: &str, _link_path: &str) -> Result<(), HostError> {
            Ok(())
        }

        fn readlink(&self, path: &str) -> Result<String, HostError> {
            Err(HostError::NotFound(path.to_string()))
        }

        fn fetch(
            &self,
            url: &str,
            _method: &str,
            _headers: &[(&str, &str)],
            _body: Option<&str>,
        ) -> FetchResult {
            if let Some(result) = self.fetch_results.get(url) {
                return result.clone();
            }
            FetchResult {
                ok: false,
                status: 0,
                headers: Default::default(),
                body: String::new(),
                body_base64: None,
                error: Some("networking not configured".to_string()),
            }
        }

        fn register_tool(&self, name: &str, wasm_path: &str) -> Result<(), HostError> {
            self.registered_tools
                .borrow_mut()
                .push((name.to_string(), wasm_path.to_string()));
            Ok(())
        }

        fn pipe(&self) -> Result<(i32, i32), HostError> {
            let mut fds = [0 as libc::c_int; 2];
            if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
                return Err(HostError::IoError("pipe failed".into()));
            }
            Ok((fds[0] as i32, fds[1] as i32))
        }

        fn waitpid(&self, pid: i32) -> Result<SpawnResult, HostError> {
            match self.pid_results.borrow().get(&pid) {
                Some(result) => Ok(result.clone()),
                None => Err(HostError::Other(format!("waitpid: unknown pid {pid}"))),
            }
        }

        fn close_fd(&self, fd: i32) -> Result<(), HostError> {
            unsafe {
                libc::close(fd as libc::c_int);
            }
            Ok(())
        }

        fn dup(&self, fd: i32) -> Result<i32, HostError> {
            let r = unsafe { libc::dup(fd as libc::c_int) };
            if r < 0 {
                return Err(HostError::IoError(format!("dup({fd}) failed")));
            }
            Ok(r as i32)
        }

        fn dup2(&self, src_fd: i32, dst_fd: i32) -> Result<(), HostError> {
            if unsafe { libc::dup2(src_fd as libc::c_int, dst_fd as libc::c_int) } < 0 {
                return Err(HostError::IoError(format!(
                    "dup2({src_fd}, {dst_fd}) failed"
                )));
            }
            Ok(())
        }

        fn read_fd(&self, fd: i32) -> Result<Vec<u8>, HostError> {
            let mut result = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = unsafe {
                    libc::read(
                        fd as libc::c_int,
                        buf.as_mut_ptr() as *mut libc::c_void,
                        buf.len(),
                    )
                };
                if n <= 0 {
                    break;
                }
                result.extend_from_slice(&buf[..n as usize]);
            }
            Ok(result)
        }

        fn write_fd(&self, fd: i32, data: &[u8]) -> Result<(), HostError> {
            let n = unsafe {
                libc::write(
                    fd as libc::c_int,
                    data.as_ptr() as *const libc::c_void,
                    data.len(),
                )
            };
            if n < 0 {
                return Err(HostError::IoError(format!("write_fd({fd}) failed")));
            }
            Ok(())
        }

        fn yield_now(&self) -> Result<(), HostError> {
            Ok(())
        }

        fn waitpid_nohang(&self, pid: i32) -> Result<i32, HostError> {
            // In tests, spawned processes complete immediately
            let results = self.pid_results.borrow();
            match results.get(&pid) {
                Some(result) => Ok(result.exit_code),
                None => Ok(-1),
            }
        }

        fn list_processes(&self) -> Result<String, HostError> {
            Ok("[]".to_string())
        }

        fn socket_connect(&self, _host: &str, _port: u16, _tls: bool) -> Result<u32, HostError> {
            Err(HostError::IoError("sockets not available in test".into()))
        }

        fn socket_send(&self, _socket_id: u32, _data: &[u8]) -> Result<usize, HostError> {
            Err(HostError::IoError("sockets not available in test".into()))
        }

        fn socket_recv(&self, _socket_id: u32, _max_bytes: usize) -> Result<Vec<u8>, HostError> {
            Err(HostError::IoError("sockets not available in test".into()))
        }

        fn socket_close(&self, _socket_id: u32) -> Result<(), HostError> {
            Err(HostError::IoError("sockets not available in test".into()))
        }
    }
}
