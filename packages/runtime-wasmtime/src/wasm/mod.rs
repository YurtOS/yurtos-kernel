#![allow(dead_code)] // Phase 3: wired to dispatcher in Phase 7
//! Wasmtime engine, store setup, and Yurt host function implementations.
//!
//! # Architecture
//!
//! - [`WasmEngine`]: shared singleton (Engine + Linker). Build once per process.
//! - [`StoreData`]: per-sandbox state (WASI context, VFS, stdio pipes).
//! - [`ShellInstance`]: per-sandbox WASM instance wrapping a Store + Module instance.
//!
//! # Host imports
//!
//! The `yurt` namespace provides filesystem operations backed by [`MemVfs`]
//! and stubs for process/network operations (implemented in Phases 4–6).

mod instance;
pub mod kernel;
pub mod network;
pub mod spawn;

#[allow(unused_imports)]
pub use instance::ShellInstance;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use bytes::Bytes;
use serde_json::json;
use wasmtime::{Caller, Config, Engine, Linker};
use wasmtime_wasi::{async_trait, ResourceTable, WasiCtx, WasiCtxBuilder, WasiView};
use wasmtime_wasi::{HostOutputStream, StreamError, StdoutStream, Subscribe};
use wasmtime_wasi::preview1::WasiP1Ctx;

use kernel::{ChildState, ProcessKernel};
use spawn::{SpawnContext, SpawnRequest};

use crate::vfs::{MemVfs, VfsError};

// ── DrainablePipe ─────────────────────────────────────────────────────────────

/// An output pipe whose contents can be atomically taken (drained).
///
/// This is an alternative to `MemoryOutputPipe::contents()` which only clones
/// the buffer. `DrainablePipe::take()` returns the accumulated bytes and clears
/// the internal buffer, so subsequent calls return only new output.
#[derive(Clone)]
pub struct DrainablePipe {
    buf: Arc<Mutex<Vec<u8>>>,
}

impl DrainablePipe {
    pub fn new() -> Self {
        Self { buf: Arc::new(Mutex::new(Vec::new())) }
    }

    /// Return and clear all bytes written since the last `take()` call.
    pub fn take(&self) -> Bytes {
        let mut guard = self.buf.lock().unwrap();
        let out = Bytes::copy_from_slice(&guard);
        guard.clear();
        out
    }

    /// Return the inner `Arc<Mutex<Vec<u8>>>` so it can be used as a `PipeBuf`
    /// target for child-process stdout/stderr forwarding.
    pub fn as_pipe_buf(&self) -> kernel::PipeBuf {
        self.buf.clone()
    }
}

impl HostOutputStream for DrainablePipe {
    fn write(&mut self, bytes: Bytes) -> Result<(), StreamError> {
        self.buf.lock().unwrap().extend_from_slice(&bytes);
        Ok(())
    }

    fn flush(&mut self) -> Result<(), StreamError> {
        Ok(())
    }

    fn check_write(&mut self) -> Result<usize, StreamError> {
        Ok(usize::MAX) // unbounded
    }
}

#[async_trait]
impl Subscribe for DrainablePipe {
    async fn ready(&mut self) {}
}

impl StdoutStream for DrainablePipe {
    fn stream(&self) -> Box<dyn HostOutputStream> {
        Box::new(self.clone())
    }

    fn isatty(&self) -> bool {
        false
    }
}

// ── StoreData ─────────────────────────────────────────────────────────────────

/// Per-sandbox Wasmtime store data.
pub struct StoreData {
    /// WASIp1 context (shim over WASIp2 for yurt-shell-exec.wasm).
    p1_ctx: WasiP1Ctx,
    /// The sandbox's virtual filesystem.
    pub vfs: MemVfs,
    /// Captured stdout output (drainable: each `take()` clears the buffer).
    pub stdout_pipe: DrainablePipe,
    /// Captured stderr output (drainable).
    pub stderr_pipe: DrainablePipe,
    /// Buffer written by the guest via `host_write_result`.
    pub last_result: Vec<u8>,
    /// Command to be returned by the next `host_read_command` call.
    pub pending_command: Option<Vec<u8>>,
    /// Host-managed fd table and child process table.
    pub kernel: ProcessKernel,
    /// Context for spawning child WASM instances (engine + linker + module).
    pub spawn_ctx: Option<Arc<SpawnContext>>,
    /// Current environment variables (passed to spawned children).
    pub env: Vec<(String, String)>,
    /// Scheduling priority for this store's spawned children.
    pub nice: u8,
    /// Host-registered tool names. This is kernel metadata, not a VFS flag.
    pub registered_tools: BTreeSet<String>,
}

impl WasiView for StoreData {
    fn table(&mut self) -> &mut ResourceTable {
        WasiView::table(&mut self.p1_ctx)
    }
    fn ctx(&mut self) -> &mut WasiCtx {
        WasiView::ctx(&mut self.p1_ctx)
    }
}

impl StoreData {
    pub fn new(vfs: MemVfs, stdin: &[u8], env: &[(String, String)]) -> anyhow::Result<Self> {
        Self::new_with_ctx(vfs, stdin, env, None, 0)
    }

    pub fn new_with_ctx(
        vfs: MemVfs,
        stdin: &[u8],
        env: &[(String, String)],
        spawn_ctx: Option<Arc<SpawnContext>>,
        nice: u8,
    ) -> anyhow::Result<Self> {
        let stdout_pipe = DrainablePipe::new();
        let stderr_pipe = DrainablePipe::new();

        let mut builder = WasiCtxBuilder::new();
        builder.stdin(wasmtime_wasi::pipe::MemoryInputPipe::new(Bytes::copy_from_slice(stdin)));
        builder.stdout(stdout_pipe.clone());
        builder.stderr(stderr_pipe.clone());
        for (k, v) in env {
            builder.env(k, v);
        }
        builder.args(&["sh"]);

        Ok(Self {
            p1_ctx: builder.build_p1(),
            vfs,
            stdout_pipe,
            stderr_pipe,
            last_result: Vec::new(),
            pending_command: None,
            kernel: ProcessKernel::default(),
            spawn_ctx,
            env: env.to_vec(),
            nice,
            registered_tools: BTreeSet::new(),
        })
    }
}

// ── WasmEngine ────────────────────────────────────────────────────────────────

/// Shared Wasmtime engine and linker.
///
/// Create once; all sandboxes share the compiled engine and linker.
pub struct WasmEngine {
    pub engine: Arc<Engine>,
    pub linker: Arc<Linker<StoreData>>,
    /// Background epoch ticker task. Aborted when this WasmEngine is dropped.
    ticker: tokio::task::JoinHandle<()>,
}

impl WasmEngine {
    pub fn new() -> anyhow::Result<Self> {
        let mut config = Config::new();
        config.async_support(true);
        // Fuel-based CPU budgeting (used in Phase 6+ for per-command limits).
        config.consume_fuel(true);
        // Epoch-based interruption (used for CPU time limits and nice-level yields).
        config.epoch_interruption(true);

        let engine = Engine::new(&config)?;

        // Ticker: increment epoch every 1ms so epoch-based yields and limits work.
        let ticker_engine = engine.clone();
        let ticker = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                ticker_engine.increment_epoch();
            }
        });

        let mut linker: Linker<StoreData> = Linker::new(&engine);

        // Add all ~40 WASI preview1 functions (fd_read, fd_write, path_open, …)
        wasmtime_wasi::preview1::add_to_linker_async(&mut linker, |data: &mut StoreData| &mut data.p1_ctx)
            .context("adding WASI preview1 to linker")?;

        // Add Yurt namespace host functions
        add_fs_imports(&mut linker)?;
        add_io_imports(&mut linker)?;
        add_process_imports(&mut linker)?;
        add_network_imports(&mut linker)?;
        add_misc_imports(&mut linker)?;

        Ok(Self {
            engine: Arc::new(engine),
            linker: Arc::new(linker),
            ticker,
        })
    }
}

impl Drop for WasmEngine {
    fn drop(&mut self) {
        self.ticker.abort();
    }
}

// ── WASM memory helpers ───────────────────────────────────────────────────────

/// Read `len` bytes from guest linear memory at `ptr`. Returns empty Vec on error.
fn read_mem(caller: &mut Caller<'_, StoreData>, ptr: u32, len: u32) -> Vec<u8> {
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return Vec::new();
    };
    let start = ptr as usize;
    let end = start.saturating_add(len as usize);
    let data = mem.data(caller);
    if end > data.len() {
        Vec::new()
    } else {
        data[start..end].to_vec()
    }
}

/// Read a UTF-8 string from guest memory. Lossily decodes invalid bytes.
fn read_str(caller: &mut Caller<'_, StoreData>, ptr: u32, len: u32) -> String {
    String::from_utf8_lossy(&read_mem(caller, ptr, len)).into_owned()
}

/// Write `data` into guest memory at [out_ptr, out_ptr+data.len()).
///
/// Returns `data.len() as i32` on success. If `out_cap` is too small, returns
/// `data.len() as i32` as a positive "need more space" signal (guest retries).
/// Returns -3 on other errors (OOB, missing memory export).
fn write_out(caller: &mut Caller<'_, StoreData>, out_ptr: u32, out_cap: u32, data: &[u8]) -> i32 {
    if data.len() > out_cap as usize {
        return data.len() as i32; // need bigger buffer
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return -3;
    };
    let start = out_ptr as usize;
    let end = start + data.len();
    let dst = mem.data_mut(caller);
    if end > dst.len() {
        return -3;
    }
    dst[start..end].copy_from_slice(data);
    data.len() as i32
}

// ── VfsError → return code ────────────────────────────────────────────────────

/// Map a VFS error to the return-code convention used by Yurt host functions.
///
/// -1 = ENOENT, -2 = EACCES/EROFS, -3 = other I/O error.
fn vfs_rc(e: &VfsError) -> i32 {
    match e {
        VfsError::NotFound(_) => -1,
        VfsError::PermissionDenied | VfsError::ReadOnly => -2,
        _ => -3,
    }
}

// ── CPU scheduling helpers ────────────────────────────────────────────────────

/// Convert a POSIX nice value (0–19) to an epoch quantum (epochs between yields).
///
/// nice=0  → 10 epochs (10ms, default)
/// nice=10 → 5 epochs (5ms)
/// nice=19 → 1 epoch  (1ms, lowest priority)
pub fn nice_to_quantum(nice: u8) -> u64 {
    let n = nice.min(19) as u64;
    (10 - n / 2).max(1)
}

// ── Filesystem host imports ───────────────────────────────────────────────────

fn add_fs_imports(linker: &mut Linker<StoreData>) -> anyhow::Result<()> {
    // host_stat(path_ptr, path_len, out_ptr, out_cap) -> i32
    linker.func_wrap(
        "yurt",
        "host_stat",
        |mut c: Caller<'_, StoreData>, path_ptr: u32, path_len: u32, out_ptr: u32, out_cap: u32| -> i32 {
            let path = read_str(&mut c, path_ptr, path_len);
            match c.data().vfs.stat(&path) {
                Ok(s) => {
                    let j = json!({
                        "exists": true,
                        "is_file": s.is_file,
                        "is_dir": s.is_dir,
                        "is_symlink": s.is_symlink,
                        "size": s.size as u64,
                        "mode": s.permissions,
                        "mtime_ms": s.mtime,
                    })
                    .to_string();
                    write_out(&mut c, out_ptr, out_cap, j.as_bytes())
                }
                Err(VfsError::NotFound(_)) => {
                    let j = json!({
                        "exists": false,
                        "is_file": false,
                        "is_dir": false,
                        "is_symlink": false,
                        "size": 0u64,
                        "mode": 0u32,
                        "mtime_ms": 0u64,
                    })
                    .to_string();
                    write_out(&mut c, out_ptr, out_cap, j.as_bytes())
                }
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    // host_read_file(path_ptr, path_len, out_ptr, out_cap) -> i32
    linker.func_wrap(
        "yurt",
        "host_read_file",
        |mut c: Caller<'_, StoreData>, path_ptr: u32, path_len: u32, out_ptr: u32, out_cap: u32| -> i32 {
            let path = read_str(&mut c, path_ptr, path_len);
            match c.data().vfs.read_file(&path) {
                Ok(bytes) => {
                    let bytes = bytes.clone();
                    write_out(&mut c, out_ptr, out_cap, &bytes)
                }
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    // host_write_file(path_ptr, path_len, data_ptr, data_len, mode) -> i32
    // mode: 0 = truncate, 1 = append
    linker.func_wrap(
        "yurt",
        "host_write_file",
        |mut c: Caller<'_, StoreData>,
         path_ptr: u32,
         path_len: u32,
         data_ptr: u32,
         data_len: u32,
         mode: u32|
         -> i32 {
            let path = read_str(&mut c, path_ptr, path_len);
            let data = read_mem(&mut c, data_ptr, data_len);
            match c.data_mut().vfs.write_file(&path, &data, mode != 0) {
                Ok(()) => 0,
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    // host_readdir(path_ptr, path_len, out_ptr, out_cap) -> i32
    linker.func_wrap(
        "yurt",
        "host_readdir",
        |mut c: Caller<'_, StoreData>, path_ptr: u32, path_len: u32, out_ptr: u32, out_cap: u32| -> i32 {
            let path = read_str(&mut c, path_ptr, path_len);
            match c.data().vfs.readdir(&path) {
                Ok(entries) => {
                    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
                    let j = serde_json::to_string(&names).unwrap_or_default();
                    write_out(&mut c, out_ptr, out_cap, j.as_bytes())
                }
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    // host_mkdir(path_ptr, path_len) -> i32
    linker.func_wrap(
        "yurt",
        "host_mkdir",
        |mut c: Caller<'_, StoreData>, path_ptr: u32, path_len: u32| -> i32 {
            let path = read_str(&mut c, path_ptr, path_len);
            match c.data_mut().vfs.mkdirp(&path) {
                Ok(()) => 0,
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    // host_remove(path_ptr, path_len, recursive) -> i32
    linker.func_wrap(
        "yurt",
        "host_remove",
        |mut c: Caller<'_, StoreData>, path_ptr: u32, path_len: u32, recursive: u32| -> i32 {
            let path = read_str(&mut c, path_ptr, path_len);
            let result = if recursive != 0 {
                c.data_mut().vfs.remove_recursive(&path)
            } else {
                // Try unlink first; fall back to rmdir
                let r = c.data_mut().vfs.unlink(&path);
                if r.is_err() {
                    c.data_mut().vfs.rmdir(&path)
                } else {
                    r
                }
            };
            match result {
                Ok(()) => 0,
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    // host_chmod(path_ptr, path_len, mode) -> i32
    linker.func_wrap(
        "yurt",
        "host_chmod",
        |mut c: Caller<'_, StoreData>, path_ptr: u32, path_len: u32, mode: u32| -> i32 {
            let path = read_str(&mut c, path_ptr, path_len);
            match c.data_mut().vfs.chmod(&path, mode) {
                Ok(()) => 0,
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    // host_glob(pattern_ptr, pattern_len, out_ptr, out_cap) -> i32
    linker.func_wrap(
        "yurt",
        "host_glob",
        |mut c: Caller<'_, StoreData>,
         pat_ptr: u32,
         pat_len: u32,
         out_ptr: u32,
         out_cap: u32|
         -> i32 {
            let pattern = read_str(&mut c, pat_ptr, pat_len);
            let paths = c.data().vfs.glob_paths(&pattern);
            let j = serde_json::to_string(&paths).unwrap_or_default();
            write_out(&mut c, out_ptr, out_cap, j.as_bytes())
        },
    )?;

    // host_rename(from_ptr, from_len, to_ptr, to_len) -> i32
    linker.func_wrap(
        "yurt",
        "host_rename",
        |mut c: Caller<'_, StoreData>,
         from_ptr: u32,
         from_len: u32,
         to_ptr: u32,
         to_len: u32|
         -> i32 {
            let from = read_str(&mut c, from_ptr, from_len);
            let to = read_str(&mut c, to_ptr, to_len);
            match c.data_mut().vfs.rename(&from, &to) {
                Ok(()) => 0,
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    // host_symlink(target_ptr, target_len, link_ptr, link_len) -> i32
    linker.func_wrap(
        "yurt",
        "host_symlink",
        |mut c: Caller<'_, StoreData>,
         tgt_ptr: u32,
         tgt_len: u32,
         lnk_ptr: u32,
         lnk_len: u32|
         -> i32 {
            let target = read_str(&mut c, tgt_ptr, tgt_len);
            let link = read_str(&mut c, lnk_ptr, lnk_len);
            match c.data_mut().vfs.symlink(&target, &link) {
                Ok(()) => 0,
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    // host_readlink(path_ptr, path_len, out_ptr, out_cap) -> i32
    linker.func_wrap(
        "yurt",
        "host_readlink",
        |mut c: Caller<'_, StoreData>, path_ptr: u32, path_len: u32, out_ptr: u32, out_cap: u32| -> i32 {
            let path = read_str(&mut c, path_ptr, path_len);
            match c.data().vfs.readlink(&path) {
                Ok(target) => write_out(&mut c, out_ptr, out_cap, target.as_bytes()),
                Err(e) => vfs_rc(&e),
            }
        },
    )?;

    Ok(())
}

// ── I/O (fd) host imports ─────────────────────────────────────────────────────

fn add_io_imports(linker: &mut Linker<StoreData>) -> anyhow::Result<()> {
    // host_pipe(out_ptr, out_cap) -> i32
    // Creates a (read_fd, write_fd) pipe pair; writes JSON {"read_fd":N,"write_fd":M}.
    linker.func_wrap(
        "yurt",
        "host_pipe",
        |mut c: Caller<'_, StoreData>, out_ptr: u32, out_cap: u32| -> i32 {
            let (read_fd, write_fd) = c.data_mut().kernel.pipe();
            let j = json!({"read_fd": read_fd, "write_fd": write_fd}).to_string();
            write_out(&mut c, out_ptr, out_cap, j.as_bytes())
        },
    )?;

    // host_close_fd(fd) -> i32
    linker.func_wrap(
        "yurt",
        "host_close_fd",
        |mut c: Caller<'_, StoreData>, fd: i32| -> i32 {
            c.data_mut().kernel.close_fd(fd);
            0
        },
    )?;

    // host_dup(fd, out_ptr, out_cap) -> i32  — writes JSON {"fd":N}
    linker.func_wrap(
        "yurt",
        "host_dup",
        |mut c: Caller<'_, StoreData>, fd: i32, out_ptr: u32, out_cap: u32| -> i32 {
            match c.data_mut().kernel.dup(fd) {
                Some(new_fd) => {
                    let j = json!({"fd": new_fd}).to_string();
                    write_out(&mut c, out_ptr, out_cap, j.as_bytes())
                }
                None => -1,
            }
        },
    )?;

    // host_dup2(src_fd, dst_fd) -> i32
    linker.func_wrap(
        "yurt",
        "host_dup2",
        |mut c: Caller<'_, StoreData>, src: i32, dst: i32| -> i32 {
            if c.data_mut().kernel.dup2(src, dst) { 0 } else { -1 }
        },
    )?;

    // host_read_fd(fd, out_ptr, out_cap) -> i32  — drains the fd buffer
    linker.func_wrap(
        "yurt",
        "host_read_fd",
        |mut c: Caller<'_, StoreData>, fd: i32, out_ptr: u32, out_cap: u32| -> i32 {
            match c.data().kernel.read_fd(fd) {
                Some(bytes) => write_out(&mut c, out_ptr, out_cap, &bytes),
                None => -1,
            }
        },
    )?;

    // host_write_fd(fd, data_ptr, data_len) -> i32
    linker.func_wrap(
        "yurt",
        "host_write_fd",
        |mut c: Caller<'_, StoreData>, fd: i32, data_ptr: i32, data_len: i32| -> i32 {
            if data_ptr < 0 || data_len < 0 { return -3; }
            let data = read_mem(&mut c, data_ptr as u32, data_len as u32);
            if c.data().kernel.write_fd(fd, &data) { data.len() as i32 } else { -1 }
        },
    )?;

    // host_read_command(out_ptr, out_cap) -> i32
    linker.func_wrap(
        "yurt",
        "host_read_command",
        |mut c: Caller<'_, StoreData>, out_ptr: u32, out_cap: u32| -> i32 {
            let cmd = c.data_mut().pending_command.take();
            match cmd {
                Some(bytes) => write_out(&mut c, out_ptr, out_cap, &bytes),
                None => -1,
            }
        },
    )?;

    // host_write_result(data_ptr, data_len) — void
    linker.func_wrap(
        "yurt",
        "host_write_result",
        |mut c: Caller<'_, StoreData>, data_ptr: u32, data_len: u32| {
            let bytes = read_mem(&mut c, data_ptr, data_len);
            c.data_mut().last_result = bytes;
        },
    )?;

    Ok(())
}

// ── Process host imports ──────────────────────────────────────────────────────

fn add_process_imports(linker: &mut Linker<StoreData>) -> anyhow::Result<()> {
    // host_spawn(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Synchronous spawn (used in test/legacy mode); in production, shell uses host_spawn_async.
    linker.func_wrap(
        "yurt",
        "host_spawn",
        |_: Caller<'_, StoreData>, _: u32, _: u32, _: u32, _: u32| -> i32 { -3 },
    )?;

    // host_spawn_async(req_ptr, req_len) -> i32  — spawn a child, return PID immediately.
    linker.func_wrap(
        "yurt",
        "host_spawn_async",
        |mut c: Caller<'_, StoreData>, req_ptr: u32, req_len: u32| -> i32 {
            let req_str = read_str(&mut c, req_ptr, req_len);
            let req: SpawnRequest = match serde_json::from_str(&req_str) {
                Ok(r) => r,
                Err(_) => return -3,
            };

            let spawn_ctx = match c.data().spawn_ctx.clone() {
                Some(ctx) => ctx,
                None => return -3,
            };

            // Gather stdin: from stdin_data or from a pipe fd.
            let stdin_data: Vec<u8> = if !req.stdin_data.is_empty() {
                req.stdin_data.as_bytes().to_vec()
            } else if req.stdin_fd >= 3 {
                c.data_mut().kernel.read_fd(req.stdin_fd).unwrap_or_default()
            } else {
                Vec::new()
            };

            // Get pipe buffers for stdout/stderr redirection.
            // fd=1/2: forward into parent's own stdout/stderr pipe (inherit).
            // fd>=3: use a kernel pipe fd.
            // anything else: discard.
            let stdout_pipe = match req.stdout_fd {
                1 => Some(c.data().stdout_pipe.as_pipe_buf()),
                fd if fd >= 3 => c.data().kernel.pipe_buf(fd),
                _ => None,
            };
            let stderr_pipe = match req.stderr_fd {
                2 => Some(c.data().stderr_pipe.as_pipe_buf()),
                fd if fd >= 3 => c.data().kernel.pipe_buf(fd),
                _ => None,
            };

            let parent_vfs = c.data().vfs.cow_clone();
            let parent_env = c.data().env.clone();
            let parent_nice = c.data().nice;

            // Spawn background task; get oneshot receiver.
            let (_, rx) =
                spawn::spawn_child(spawn_ctx, parent_vfs, parent_env, stdin_data, stdout_pipe, stderr_pipe, &req, parent_nice);

            // Register the child in the kernel's process table.
            c.data_mut().kernel.add_process(rx)
        },
    )?;

    // host_waitpid(pid, out_ptr, out_cap) -> i32  — async: suspends until child exits.
    linker.func_wrap_async(
        "yurt",
        "host_waitpid",
        |mut caller: Caller<'_, StoreData>, (pid, out_ptr, out_cap): (i32, u32, u32)| {
            Box::new(async move {
                // Take the wait state out before awaiting (borrow-safety).
                let state = caller.data_mut().kernel.take_state(pid);
                let exit_code = match state {
                    Some(ChildState::Running(rx)) => {
                        let code = rx.await.unwrap_or(-1);
                        caller.data_mut().kernel.set_exit_code(pid, code);
                        code
                    }
                    Some(ChildState::Done(code)) => code,
                    None => -1,
                };
                let j = json!({"exit_code": exit_code}).to_string();
                write_out(&mut caller, out_ptr, out_cap, j.as_bytes())
            })
        },
    )?;

    // host_waitpid_nohang(pid) -> i32  — non-blocking: exit code or -1 if still running.
    linker.func_wrap(
        "yurt",
        "host_waitpid_nohang",
        |mut c: Caller<'_, StoreData>, pid: i32| -> i32 {
            c.data_mut().kernel.poll_exit(pid).unwrap_or(-1)
        },
    )?;

    // host_yield() — yield to the async executor (cooperative scheduling).
    linker.func_wrap_async("yurt", "host_yield", |_: Caller<'_, StoreData>, ()| {
        Box::new(async move { tokio::task::yield_now().await })
    })?;

    // host_list_processes(out_ptr, out_cap) -> i32
    linker.func_wrap(
        "yurt",
        "host_list_processes",
        |mut c: Caller<'_, StoreData>, out_ptr: u32, out_cap: u32| -> i32 {
            let list = c.data().kernel.list();
            let j = serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_owned());
            write_out(&mut c, out_ptr, out_cap, j.as_bytes())
        },
    )?;

    // host_register_tool(name_ptr, name_len, path_ptr, path_len) -> i32
    // Registers a host-supplied tool name without adding kernel-only flags to VFS metadata.
    linker.func_wrap(
        "yurt",
        "host_register_tool",
        |mut c: Caller<'_, StoreData>, name_ptr: u32, name_len: u32, path_ptr: u32, path_len: u32| -> i32 {
            let name = read_str(&mut c, name_ptr, name_len);
            let _wasm_path = read_str(&mut c, path_ptr, path_len);
            c.data_mut().registered_tools.insert(name);
            0
        },
    )?;

    Ok(())
}

// ── Network host imports ──────────────────────────────────────────────────────

fn add_network_imports(linker: &mut Linker<StoreData>) -> anyhow::Result<()> {
    // host_network_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32
    linker.func_wrap_async(
        "yurt",
        "host_network_fetch",
        |mut caller: Caller<'_, StoreData>, (req_ptr, req_len, out_ptr, out_cap): (u32, u32, u32, u32)| {
            Box::new(async move {
                let req_str = read_str(&mut caller, req_ptr, req_len);
                let resp = network::fetch(&req_str).await;
                write_out(&mut caller, out_ptr, out_cap, resp.as_bytes())
            })
        },
    )?;

    // Socket stubs (Phase 5+)
    linker.func_wrap(
        "yurt",
        "host_socket_connect",
        |_: Caller<'_, StoreData>, _: u32, _: u32, _: u32, _: u32| -> i32 { -3 },
    )?;
    linker.func_wrap(
        "yurt",
        "host_socket_send",
        |_: Caller<'_, StoreData>, _: u32, _: u32, _: u32, _: u32| -> i32 { -3 },
    )?;
    linker.func_wrap(
        "yurt",
        "host_socket_recv",
        |_: Caller<'_, StoreData>, _: u32, _: u32, _: u32, _: u32| -> i32 { -3 },
    )?;
    linker.func_wrap(
        "yurt",
        "host_socket_close",
        |_: Caller<'_, StoreData>, _: u32, _: u32| -> i32 { 0 },
    )?;

    Ok(())
}

// ── Misc imports ──────────────────────────────────────────────────────────────

fn add_misc_imports(linker: &mut Linker<StoreData>) -> anyhow::Result<()> {
    // host_has_tool(name_ptr, name_len) -> i32  (1=found, 0=not found)
    linker.func_wrap(
        "yurt",
        "host_has_tool",
        |mut c: Caller<'_, StoreData>, name_ptr: u32, name_len: u32| -> i32 {
            let name = read_str(&mut c, name_ptr, name_len);
            if c.data().registered_tools.contains(&name) {
                return 1;
            }
            // Filesystem executables remain discoverable without kernel-only VFS flags.
            let paths = [
                format!("/bin/{name}"),
                format!("/usr/bin/{name}"),
            ];
            for p in &paths {
                if c.data().vfs.stat(p).is_ok() {
                    return 1;
                }
            }
            0
        },
    )?;

    // host_time() -> f64  (seconds since Unix epoch)
    linker.func_wrap("yurt", "host_time", |_: Caller<'_, StoreData>| -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
    })?;

    Ok(())
}
