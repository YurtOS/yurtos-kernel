#![allow(dead_code)] // Phase 4: used by mod.rs; reserved APIs for Phase 5+
//! Child-process spawning logic.
//!
//! `host_spawn_async` creates a new WASM instance that runs the requested
//! program as a shell command via `__run_command` in a background tokio task.
//! The child's stdout/stderr are captured and fed back into the parent's pipe fds.

use std::sync::Arc;

use anyhow::Context;
use serde::Deserialize;
use tokio::sync::oneshot;
use wasmtime::{Module, Store, TypedFunc};

use super::kernel::PipeBuf;
use super::{StoreData, WasmEngine};
use crate::vfs::MemVfs;

// ── SpawnContext ──────────────────────────────────────────────────────────────

/// Immutable context shared by a sandbox and all its children.
///
/// Holds everything needed to create a new `Store<StoreData>` and
/// instantiate the shell WASM module without owning a linker reference
/// that would create a cycle.
pub struct SpawnContext {
    pub engine: Arc<wasmtime::Engine>,
    pub linker: Arc<wasmtime::Linker<StoreData>>,
    pub module: Arc<Module>,
}

impl SpawnContext {
    pub fn new(engine_ref: &WasmEngine, module: Arc<Module>) -> Arc<Self> {
        Arc::new(Self {
            engine: engine_ref.engine.clone(),
            linker: engine_ref.linker.clone(),
            module,
        })
    }
}

// ── SpawnRequest ──────────────────────────────────────────────────────────────

/// JSON spawn request from the guest (`host_spawn_async`).
#[derive(Deserialize, Debug)]
pub struct SpawnRequest {
    pub prog: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Env pairs as `[[key, value], ...]`.
    #[serde(default)]
    pub env: Vec<[String; 2]>,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default = "neg_one")]
    pub stdin_fd: i32,
    #[serde(default = "neg_one")]
    pub stdout_fd: i32,
    #[serde(default = "neg_one")]
    pub stderr_fd: i32,
    #[serde(default)]
    pub stdin_data: String,
    /// Scheduling priority for this child process. 0–19; inherits from parent if absent.
    #[serde(default)]
    pub nice: u8,
}

fn default_cwd() -> String {
    "/home/user".to_owned()
}
fn neg_one() -> i32 {
    -1
}

impl SpawnRequest {
    /// Build a shell command string suitable for `__run_command`.
    /// Each argument is single-quote-escaped.
    pub fn to_shell_cmd(&self) -> String {
        let mut cmd = shell_quote(&self.prog);
        for arg in &self.args {
            cmd.push(' ');
            cmd.push_str(&shell_quote(arg));
        }
        cmd
    }
}

/// POSIX single-quote escaping: `'` → `'\''`.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

// ── Child runner ──────────────────────────────────────────────────────────────

/// Spawn a child WASM instance in a background task.
///
/// Returns the PID assigned to this child.
pub fn spawn_child(
    spawn_ctx: Arc<SpawnContext>,
    parent_vfs: MemVfs,
    parent_env: Vec<(String, String)>,
    stdin_data: Vec<u8>,
    stdout_pipe: Option<PipeBuf>,
    stderr_pipe: Option<PipeBuf>,
    req: &SpawnRequest,
    parent_nice: u8,
) -> (i32, oneshot::Receiver<i32>) {
    let (tx, rx) = oneshot::channel::<i32>();

    // Build the child's environment: parent env overridden by spawn request env.
    let mut child_env = parent_env;
    for [k, v] in &req.env {
        if let Some(existing) = child_env.iter_mut().find(|(ek, _)| ek == k) {
            existing.1 = v.clone();
        } else {
            child_env.push((k.clone(), v.clone()));
        }
    }
    // Override CWD via PWD env var.
    if let Some(pwd) = child_env.iter_mut().find(|(k, _)| k == "PWD") {
        pwd.1 = req.cwd.clone();
    } else {
        child_env.push(("PWD".to_owned(), req.cwd.clone()));
    }

    // Child inherits parent nice unless the spawn request overrides it.
    let child_nice = if req.nice > 0 { req.nice } else { parent_nice };

    let cmd_str = req.to_shell_cmd();

    tokio::spawn(async move {
        let exit_code =
            run_child(spawn_ctx, parent_vfs, stdin_data, child_env, cmd_str, stdout_pipe, stderr_pipe, child_nice)
                .await
                .unwrap_or(1);
        let _ = tx.send(exit_code);
    });

    // The PID assignment happens in the kernel (caller's responsibility).
    // We return rx so the caller can register it.
    (0 /* placeholder, caller uses real pid */, rx)
}

/// Create and run a child WASM instance to completion.
///
/// Returns the exit code.
async fn run_child(
    ctx: Arc<SpawnContext>,
    vfs: MemVfs,
    stdin: Vec<u8>,
    env: Vec<(String, String)>,
    cmd: String,
    stdout_pipe: Option<PipeBuf>,
    stderr_pipe: Option<PipeBuf>,
    nice: u8,
) -> anyhow::Result<i32> {
    let data = StoreData::new_with_ctx(vfs, &stdin, &env, Some(ctx.clone()), nice)
        .context("creating child store data")?;

    // Remember the output pipes before creating the store (we'll use them after).
    let child_stdout_pipe = data.stdout_pipe.clone();
    let child_stderr_pipe = data.stderr_pipe.clone();

    let mut store = Store::new(&ctx.engine, data);
    store.set_fuel(u64::MAX / 2)?;
    let quantum = crate::wasm::nice_to_quantum(nice);
    store.epoch_deadline_async_yield_and_update(quantum);

    let instance = ctx
        .linker
        .instantiate_async(&mut store, &ctx.module)
        .await
        .context("instantiating child WASM")?;

    // Resolve exports.
    let alloc: TypedFunc<u32, u32> = instance.get_typed_func(&mut store, "__alloc")?;
    let dealloc: TypedFunc<(u32, u32), ()> = instance.get_typed_func(&mut store, "__dealloc")?;
    let run_cmd: TypedFunc<(u32, u32, u32, u32), i32> =
        instance.get_typed_func(&mut store, "__run_command")?;
    let memory = instance.get_memory(&mut store, "memory").context("missing memory")?;

    // Allocate and write command string.
    let cmd_bytes = cmd.as_bytes();
    let cmd_ptr = alloc.call_async(&mut store, cmd_bytes.len() as u32).await?;
    memory.write(&mut store, cmd_ptr as usize, cmd_bytes)?;

    // Run with an initial 64 KB output buffer.
    let out_cap: u32 = 64 * 1024;
    let out_ptr = alloc.call_async(&mut store, out_cap).await?;
    let n = run_cmd.call_async(&mut store, (cmd_ptr, cmd_bytes.len() as u32, out_ptr, out_cap)).await?;

    // Handle "need bigger buffer" signal.
    let exit_code = if n > 0 && n as usize > out_cap as usize {
        // Retry with larger buffer.
        dealloc.call_async(&mut store, (out_ptr, out_cap)).await?;
        let needed = n as u32;
        let big_ptr = alloc.call_async(&mut store, needed).await?;
        let n2 = run_cmd
            .call_async(&mut store, (cmd_ptr, cmd_bytes.len() as u32, big_ptr, needed))
            .await?;
        let mut result_buf = vec![0u8; n2.max(0) as usize];
        memory.read(&store, big_ptr as usize, &mut result_buf)?;
        dealloc.call_async(&mut store, (big_ptr, needed)).await?;
        parse_exit_code(&result_buf)
    } else if n >= 0 {
        let mut result_buf = vec![0u8; n as usize];
        memory.read(&store, out_ptr as usize, &mut result_buf)?;
        dealloc.call_async(&mut store, (out_ptr, out_cap)).await?;
        parse_exit_code(&result_buf)
    } else {
        1 // error
    };

    dealloc.call_async(&mut store, (cmd_ptr, cmd_bytes.len() as u32)).await?;

    // Flush captured stdio into the parent's pipe buffers.
    let stdout_bytes = child_stdout_pipe.take();
    if let Some(pipe) = stdout_pipe {
        if !stdout_bytes.is_empty() {
            pipe.lock().unwrap().extend_from_slice(&stdout_bytes);
        }
    }
    let stderr_bytes = child_stderr_pipe.take();
    if let Some(pipe) = stderr_pipe {
        if !stderr_bytes.is_empty() {
            pipe.lock().unwrap().extend_from_slice(&stderr_bytes);
        }
    }

    Ok(exit_code)
}

/// Extract `exit_code` from the JSON result written by `__run_command`.
fn parse_exit_code(json: &[u8]) -> i32 {
    #[derive(Deserialize)]
    struct R {
        #[serde(default)]
        exit_code: i32,
    }
    serde_json::from_slice::<R>(json).map(|r| r.exit_code).unwrap_or(0)
}
