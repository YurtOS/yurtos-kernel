//! SandboxState and SandboxManager — high-level sandbox abstractions over
//! WasmEngine + ShellInstance.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Notify;

use anyhow::{bail, Result};
use serde_json::Value;

use crate::vfs::MemVfs;
use crate::wasm::{ShellInstance, WasmEngine};

// ── SandboxState ─────────────────────────────────────────────────────────────

/// One live sandbox: a WASM shell instance plus its environment state.
pub struct SandboxState {
    pub engine: Arc<WasmEngine>,
    pub wasm_bytes: Arc<Vec<u8>>,
    pub shell: ShellInstance,
    /// Env table — synced from `__run_command` output after each call.
    pub env: HashMap<String, String>,
    /// Scheduling priority 0–19. 0 = default (10ms quantum), 19 = lowest (1ms).
    pub nice: u8,
    /// Per-command wall-clock kill timeout in ms. None = no limit.
    pub timeout_ms: Option<u64>,
    /// Set to true after a command times out. Subsequent run() calls error immediately.
    pub poisoned: bool,
    /// When true, run() waits before executing the next command.
    pub paused: Arc<AtomicBool>,
    pub resume_notify: Arc<Notify>,
}

impl SandboxState {
    pub async fn new(
        engine: Arc<WasmEngine>,
        wasm_bytes: Arc<Vec<u8>>,
        fs_limit_bytes: Option<usize>,
        initial_env: Vec<(String, String)>,
        nice: u8,
        timeout_ms: Option<u64>,
    ) -> Result<Self> {
        let vfs = MemVfs::new(fs_limit_bytes, None);
        let shell = ShellInstance::new(&engine, &wasm_bytes, vfs, &initial_env, nice).await?;
        let env: HashMap<_, _> = initial_env.into_iter().collect();
        Ok(Self {
            engine,
            wasm_bytes,
            shell,
            env,
            nice,
            timeout_ms,
            poisoned: false,
            paused: Arc::new(AtomicBool::new(false)),
            resume_notify: Arc::new(Notify::new()),
        })
    }

    /// Run a shell command; sync env from the WASM output.
    pub async fn run(&mut self, cmd: &str) -> Result<Value> {
        if self.poisoned {
            anyhow::bail!("sandbox poisoned: previous command timed out");
        }
        // Pre-command pause: if the sandbox was suspended externally, wait here
        // before starting the next command. Mid-command suspension (pausing an
        // already-running command) is not implemented — it would require the
        // dispatcher to handle concurrent RPCs.
        while self.paused.load(Ordering::Acquire) {
            self.resume_notify.notified().await;
        }

        let run_fut = self.shell.run_command(cmd);
        let raw = match self.timeout_ms {
            Some(ms) => {
                match tokio::time::timeout(std::time::Duration::from_millis(ms), run_fut).await {
                    Ok(Ok(v)) => v,
                    Ok(Err(e)) => return Err(e),
                    Err(_elapsed) => {
                        self.poisoned = true;
                        return Ok(serde_json::json!({
                            "exitCode": 124,
                            "stdout": "",
                            "stderr": "timeout\n",
                            "executionTimeMs": ms,
                        }));
                    }
                }
            }
            None => run_fut.await?,
        };

        if let Some(env_map) = raw.get("env").and_then(|v| v.as_object()) {
            self.env.clear();
            for (k, v) in env_map {
                if let Some(s) = v.as_str() {
                    self.env.insert(k.clone(), s.to_owned());
                }
            }
        }
        let stdout = String::from_utf8_lossy(&self.shell.take_stdout()).into_owned();
        let stderr = String::from_utf8_lossy(&self.shell.take_stderr()).into_owned();
        Ok(serde_json::json!({
            "exitCode": raw["exit_code"].as_i64().unwrap_or(1),
            "stdout": stdout,
            "stderr": stderr,
            "executionTimeMs": raw["execution_time_ms"].as_u64().unwrap_or(0),
        }))
    }

    /// Fork this sandbox: CoW VFS clone + fresh shell instance with same env.
    pub async fn fork(&self) -> Result<Self> {
        let forked_vfs = self.shell.vfs().cow_clone();
        let env_vec: Vec<_> = self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let shell =
            ShellInstance::new(&self.engine, &self.wasm_bytes, forked_vfs, &env_vec, self.nice)
                .await?;
        Ok(Self {
            engine: self.engine.clone(),
            wasm_bytes: self.wasm_bytes.clone(),
            shell,
            env: self.env.clone(),
            nice: self.nice,
            timeout_ms: self.timeout_ms,
            poisoned: false,
            paused: Arc::new(AtomicBool::new(false)),
            resume_notify: Arc::new(Notify::new()),
        })
    }
}

// ── SandboxManager ───────────────────────────────────────────────────────────

/// Manages the root sandbox plus any named or numbered fork sandboxes.
pub struct SandboxManager {
    pub root: Option<SandboxState>,
    pub forks: HashMap<String, SandboxState>,
    pub next_fork_id: u32,
    pub named: HashMap<String, SandboxState>,
    pub next_named_id: u32,
}

#[allow(clippy::new_without_default)]
impl SandboxManager {
    pub fn new() -> Self {
        Self {
            root: None,
            forks: HashMap::new(),
            next_fork_id: 1,
            named: HashMap::new(),
            next_named_id: 1,
        }
    }

    /// Initialize the root sandbox from raw WASM bytes.
    pub async fn create(
        &mut self,
        wasm_bytes: Vec<u8>,
        fs_limit_bytes: Option<usize>,
        timeout_ms: Option<u64>,
        nice: u8,
        initial_env: Option<Vec<(String, String)>>,
    ) -> Result<()> {
        let engine = Arc::new(WasmEngine::new()?);
        let wasm = Arc::new(wasm_bytes);
        let env = initial_env.unwrap_or_default();
        self.root =
            Some(SandboxState::new(engine, wasm, fs_limit_bytes, env, nice, timeout_ms).await?);
        Ok(())
    }

    /// Resolve a sandbox by id (None / "" → root).
    pub fn resolve(&mut self, sandbox_id: Option<&str>) -> Result<&mut SandboxState> {
        match sandbox_id {
            None | Some("") => {
                self.root.as_mut().ok_or_else(|| anyhow::anyhow!("no root sandbox"))
            }
            Some(id) => {
                if let Some(sb) = self.named.get_mut(id) {
                    return Ok(sb);
                }
                if let Some(sb) = self.forks.get_mut(id) {
                    return Ok(sb);
                }
                bail!("unknown sandboxId: {id}")
            }
        }
    }

    /// Run a command on the root sandbox.
    pub async fn root_run(&mut self, cmd: &str) -> Result<Value> {
        self.root
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("no root sandbox"))?
            .run(cmd)
            .await
    }
}
