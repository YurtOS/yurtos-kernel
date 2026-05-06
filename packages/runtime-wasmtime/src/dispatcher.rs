//! JSON-RPC method dispatcher.
//!
//! Mirrors the TypeScript `dispatcher.ts` interface.  Phase 1 wires `create`
//! to the real SandboxManager; all other methods return a typed "not yet
//! implemented" error so the Python SDK gets a meaningful response.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::rpc::{codes, RequestId, Response};
use crate::sandbox::SandboxManager;
use crate::vfs::VfsError;

/// All methods that will eventually be implemented, listed so the dispatcher
/// returns the right error code (INTERNAL_ERROR vs METHOD_NOT_FOUND).
const KNOWN_METHODS: &[&str] = &[
    "run",
    "files.read",
    "files.write",
    "files.list",
    "files.mkdir",
    "files.rm",
    "files.stat",
    "env.set",
    "env.get",
    "mount",
    "snapshot.create",
    "snapshot.restore",
    "persistence.export",
    "persistence.import",
    "sandbox.fork",
    "sandbox.destroy",
    "sandbox.create",
    "sandbox.list",
    "sandbox.remove",
    "offload",
    "rehydrate",
    "sandbox.suspend",
    "sandbox.resume",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(|e| format!("base64 decode: {e}"))
}

fn b64_encode(b: &[u8]) -> String {
    B64.encode(b)
}

/// Application-level error code (mirrors TypeScript dispatcher's `rpcError(1, ...)`).
/// Used for VFS/filesystem errors.
fn vfs_err(id: Option<RequestId>, e: VfsError) -> Response {
    Response::err(id, 1, e.to_string())
}

fn require_str<'a>(
    id: &Option<RequestId>,
    params: &'a Value,
    key: &str,
) -> Result<&'a str, Response> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| Response::err(id.clone(), codes::INVALID_PARAMS, format!("missing: {key}")))
}

fn sandbox_id(params: &Value) -> Option<&str> {
    params.get("sandboxId").and_then(|v| v.as_str())
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

pub struct Dispatcher {
    initialized: bool,
    pub manager: SandboxManager,
    stdout_tx: mpsc::Sender<String>,
    cb_rx: mpsc::Receiver<String>,
    next_cb_id: u64,
}

impl Dispatcher {
    pub fn new(stdout_tx: mpsc::Sender<String>, cb_rx: mpsc::Receiver<String>) -> Self {
        Self {
            initialized: false,
            manager: SandboxManager::new(),
            stdout_tx,
            cb_rx,
            next_cb_id: 0,
        }
    }

    /// Route an incoming RPC request to the appropriate handler.
    ///
    /// Returns the response to send, plus a bool indicating whether the server
    /// should shut down after sending it (`kill` method).
    pub async fn dispatch(
        &mut self,
        id: Option<RequestId>,
        method: &str,
        params: Value,
    ) -> (Response, bool) {
        let resp = match method {
            "create" => self.handle_create(id, params).await,
            "kill" => return (self.kill(id).await, true),
            _ if !self.initialized => Response::err(
                id,
                codes::INVALID_REQUEST,
                "sandbox not initialized: call 'create' first",
            ),
            _ => self.dispatch_initialized(id, method, params).await,
        };
        (resp, false)
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async fn handle_create(&mut self, id: Option<RequestId>, params: Value) -> Response {
        if self.initialized {
            return Response::err(id, codes::INVALID_REQUEST, "already initialized");
        }

        // Required: shellWasmPath
        let wasm_path = match params.get("shellWasmPath").and_then(|v| v.as_str()) {
            Some(p) => p.to_owned(),
            None => {
                return Response::err(
                    id,
                    codes::INVALID_PARAMS,
                    "missing required param: shellWasmPath",
                );
            }
        };

        // Read WASM bytes from disk.
        let wasm_bytes = match std::fs::read(&wasm_path) {
            Ok(b) => b,
            Err(e) => {
                return Response::err(
                    id,
                    codes::INTERNAL_ERROR,
                    format!("failed to read shellWasmPath '{wasm_path}': {e}"),
                );
            }
        };

        // Optional params.
        let fs_limit_bytes = params
            .get("fsLimitBytes")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64());
        let nice = params
            .get("nice")
            .and_then(|v| v.as_u64())
            .map(|n| n.min(19) as u8)
            .unwrap_or(0);

        // Create the root sandbox.
        if let Err(e) = self
            .manager
            .create(wasm_bytes, fs_limit_bytes, timeout_ms, nice, None)
            .await
        {
            return Response::err(id, codes::INTERNAL_ERROR, format!("create failed: {e}"));
        }

        // Handle mounts: array of { path, files: { rel_path: base64 } }
        if let Some(mounts) = params.get("mounts").and_then(|v| v.as_array()) {
            let sandbox = match self.manager.root.as_mut() {
                Some(s) => s,
                None => {
                    return Response::err(
                        id,
                        codes::INTERNAL_ERROR,
                        "root sandbox missing after create",
                    );
                }
            };
            for mount in mounts {
                let base_path = mount.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                if let Some(files) = mount.get("files").and_then(|v| v.as_object()) {
                    for (rel_path, b64_val) in files {
                        let b64 = match b64_val.as_str() {
                            Some(s) => s,
                            None => continue,
                        };
                        let data = match B64.decode(b64) {
                            Ok(d) => d,
                            Err(e) => {
                                return Response::err(
                                    id,
                                    codes::INVALID_PARAMS,
                                    format!("base64 decode error for '{rel_path}': {e}"),
                                );
                            }
                        };
                        // Build full path: base_path + "/" + rel_path.
                        let full_path = if base_path.ends_with('/') {
                            format!("{base_path}{rel_path}")
                        } else {
                            format!("{base_path}/{rel_path}")
                        };
                        // Ensure parent directory exists.
                        if let Some(parent) = std::path::Path::new(&full_path).parent() {
                            let parent_str = parent.to_string_lossy();
                            if !parent_str.is_empty() && parent_str != "/" {
                                let _ = sandbox.shell.vfs_mut().mkdirp(&parent_str);
                            }
                        }
                        if let Err(e) = sandbox.shell.vfs_mut().write_file(&full_path, &data, false)
                        {
                            return Response::err(
                                id,
                                codes::INTERNAL_ERROR,
                                format!("write_file '{full_path}' failed: {e}"),
                            );
                        }
                    }
                }
            }
        }

        self.initialized = true;
        tracing::info!("sandbox initialized (wasmtime backend)");
        Response::ok(id, json!({ "ok": true }))
    }

    async fn kill(&mut self, id: Option<RequestId>) -> Response {
        tracing::info!("kill received, shutting down");
        Response::ok(id, json!({ "ok": true }))
    }

    // ── Initialized methods ──────────────────────────────────────────────────

    async fn dispatch_initialized(
        &mut self,
        id: Option<RequestId>,
        method: &str,
        params: Value,
    ) -> Response {
        let sid = sandbox_id(&params).map(str::to_owned);
        match method {
            "run" => self.handle_run(id, &params, sid.as_deref()).await,
            "env.set" => self.handle_env_set(id, &params, sid.as_deref()).await,
            "env.get" => self.handle_env_get(id, &params, sid.as_deref()),
            "files.read" => self.handle_files_read(id, &params, sid.as_deref()),
            "files.write" => self.handle_files_write(id, &params, sid.as_deref()),
            "files.list" => self.handle_files_list(id, &params, sid.as_deref()),
            "files.mkdir" => self.handle_files_mkdir(id, &params, sid.as_deref()),
            "files.rm" => self.handle_files_rm(id, &params, sid.as_deref()),
            "files.stat" => self.handle_files_stat(id, &params, sid.as_deref()),
            "snapshot.create" => self.handle_snapshot_create(id, &params, sid.as_deref()),
            "snapshot.restore" => self.handle_snapshot_restore(id, &params, sid.as_deref()),
            "persistence.export" => self.handle_persistence_export(id, &params, sid.as_deref()),
            "persistence.import" => self.handle_persistence_import(id, &params, sid.as_deref()),
            "mount" => self.handle_mount(id, &params, sid.as_deref()),
            "sandbox.fork" => self.handle_sandbox_fork(id, &params, sid.as_deref()).await,
            "sandbox.destroy" => self.handle_sandbox_destroy(id, &params),
            "sandbox.create" => self.handle_sandbox_create(id, &params).await,
            "sandbox.list" => self.handle_sandbox_list(id),
            "sandbox.remove" => self.handle_sandbox_remove(id, &params),
            "sandbox.suspend" => self.handle_sandbox_suspend(id, &params),
            "sandbox.resume" => self.handle_sandbox_resume(id, &params),
            "offload" => self.handle_offload(id, &params, sid.as_deref()).await,
            "rehydrate" => self.handle_rehydrate(id, &params, sid.as_deref()).await,
            // remaining methods still not_implemented (done in later tasks)
            _ if KNOWN_METHODS.contains(&method) => Response::not_implemented(id, method),
            _ => Response::method_not_found(id, method),
        }
    }

    // ── run + env ─────────────────────────────────────────────────────────────

    async fn handle_run(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let cmd = match require_str(&id, params, "command") {
            Ok(c) => c.to_owned(),
            Err(r) => return r,
        };
        let stream = params
            .get("stream")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.run(&cmd).await {
            Ok(result) => {
                if stream {
                    if let Some(ref req_id) = id {
                        let req_id_val = match req_id {
                            RequestId::Num(n) => serde_json::json!(n),
                            RequestId::Str(s) => serde_json::json!(s),
                        };
                        let stdout = result["stdout"].as_str().unwrap_or("").to_string();
                        let stderr = result["stderr"].as_str().unwrap_or("").to_string();
                        if !stdout.is_empty() {
                            let notif = serde_json::to_string(&json!({
                                "jsonrpc": "2.0",
                                "method": "output",
                                "params": {
                                    "request_id": req_id_val,
                                    "stream": "stdout",
                                    "data": stdout,
                                }
                            }))
                            .unwrap_or_default();
                            let _ = self.stdout_tx.send(notif).await;
                        }
                        if !stderr.is_empty() {
                            let notif = serde_json::to_string(&json!({
                                "jsonrpc": "2.0",
                                "method": "output",
                                "params": {
                                    "request_id": req_id_val,
                                    "stream": "stderr",
                                    "data": stderr,
                                }
                            }))
                            .unwrap_or_default();
                            let _ = self.stdout_tx.send(notif).await;
                        }
                        return Response::ok(
                            id,
                            json!({
                                "exitCode": result["exitCode"],
                                "stdout": "",
                                "stderr": "",
                                "executionTimeMs": result["executionTimeMs"],
                            }),
                        );
                    }
                }
                Response::ok(id, result)
            }
            Err(e) => Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
        }
    }

    async fn handle_env_set(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let name = match require_str(&id, &params, "name") {
            Ok(n) => n.to_owned(),
            Err(r) => return r,
        };
        let value = match require_str(&id, &params, "value") {
            Ok(v) => v.to_owned(),
            Err(r) => return r,
        };

        // Validate name: must be a valid shell identifier
        if name.is_empty()
            || !name
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic() || c == '_')
                .unwrap_or(false)
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Response::err(id, codes::INVALID_PARAMS, "invalid env var name");
        }

        // POSIX single-quote escape: replace ' with '\''
        let quoted = format!("'{}'", value.replace('\'', "'\\''"));
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.run(&format!("export {name}={quoted}")).await {
            Ok(_) => Response::ok(id, json!({"ok": true})),
            Err(e) => Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
        }
    }

    fn handle_env_get(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let name = match require_str(&id, params, "name") {
            Ok(n) => n.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        let value = sb.env.get(&name).cloned();
        Response::ok(id, json!({"value": value}))
    }

    // ── File operations ───────────────────────────────────────────────────────

    fn handle_files_read(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs().read_file(&path) {
            Ok(bytes) => Response::ok(id, json!({"data": b64_encode(&bytes)})),
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_write(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let data_b64 = match require_str(&id, params, "data") {
            Ok(d) => d.to_owned(),
            Err(r) => return r,
        };
        let bytes = match b64_decode(&data_b64) {
            Ok(b) => b,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e),
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        // Ensure parent directory exists.
        if let Some(parent) = std::path::Path::new(&path)
            .parent()
            .and_then(|p| p.to_str())
        {
            if !parent.is_empty() && parent != "/" {
                let _ = sb.shell.vfs_mut().mkdirp(parent);
            }
        }
        match sb.shell.vfs_mut().write_file(&path, &bytes, false) {
            Ok(_) => Response::ok(id, json!({"ok": true})),
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_list(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs().readdir(&path) {
            Ok(entries) => {
                let enriched: Vec<_> = entries
                    .iter()
                    .map(|e| {
                        let full = format!("{}/{}", path.trim_end_matches('/'), e.name);
                        let size = sb.shell.vfs().stat(&full).map(|s| s.size).unwrap_or(0);
                        let kind = if e.is_dir { "dir" } else { "file" };
                        json!({"name": e.name, "type": kind, "size": size})
                    })
                    .collect();
                Response::ok(id, json!({"entries": enriched}))
            }
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_mkdir(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs_mut().mkdir(&path) {
            Ok(_) => Response::ok(id, json!({"ok": true})),
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_rm(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        let vfs = sb.shell.vfs_mut();
        // Try stat to decide whether to unlink or remove_recursive.
        let result = match vfs.stat(&path) {
            Ok(st) if st.is_dir => vfs.remove_recursive(&path),
            _ => vfs.unlink(&path),
        };
        match result {
            Ok(_) => Response::ok(id, json!({"ok": true})),
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_stat(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs().stat(&path) {
            Ok(st) => {
                let kind = if st.is_dir { "dir" } else { "file" };
                let name = std::path::Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&path);
                Response::ok(id, json!({"name": name, "type": kind, "size": st.size}))
            }
            Err(e) => vfs_err(id, e),
        }
    }

    // ── Snapshot operations ───────────────────────────────────────────────────

    fn handle_snapshot_create(
        &mut self,
        id: Option<RequestId>,
        _params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        let snap_id = sb.shell.vfs_mut().snapshot();
        Response::ok(id, json!({"id": snap_id}))
    }

    fn handle_snapshot_restore(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let snap_id = match require_str(&id, params, "id") {
            Ok(s) => s.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs_mut().restore(&snap_id) {
            Ok(_) => Response::ok(id, json!({"ok": true})),
            Err(e) => Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    fn handle_persistence_export(
        &mut self,
        id: Option<RequestId>,
        _params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs().export_bytes() {
            Ok(blob) => Response::ok(id, json!({"data": b64_encode(&blob)})),
            Err(e) => Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
        }
    }

    fn handle_persistence_import(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let data_b64 = match require_str(&id, params, "data") {
            Ok(d) => d.to_owned(),
            Err(r) => return r,
        };
        let blob = match b64_decode(&data_b64) {
            Ok(b) => b,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e),
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match crate::vfs::MemVfs::import_bytes(&blob) {
            Ok(new_vfs) => {
                *sb.shell.vfs_mut() = new_vfs;
                Response::ok(id, json!({"ok": true}))
            }
            Err(e) => Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
        }
    }

    // ── Sandbox management ───────────────────────────────────────────────────

    // Always forks the root sandbox. sandboxId is intentionally ignored — forking
    // a named or already-forked sandbox is not supported.
    async fn handle_sandbox_fork(
        &mut self,
        id: Option<RequestId>,
        _params: &Value,
        _sid: Option<&str>,
    ) -> Response {
        if self.manager.forks.len() >= 16 {
            return Response::err(id, codes::INVALID_PARAMS, "max forks reached");
        }
        let forked = {
            let sb = match self.manager.root.as_ref() {
                Some(s) => s,
                None => return Response::err(id, codes::INVALID_PARAMS, "no root sandbox"),
            };
            match sb.fork().await {
                Ok(f) => f,
                Err(e) => return Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
            }
        };
        let fork_id = self.manager.next_fork_id.to_string();
        self.manager.next_fork_id += 1;
        self.manager.forks.insert(fork_id.clone(), forked);
        Response::ok(id, json!({"sandboxId": fork_id}))
    }

    fn handle_sandbox_destroy(&mut self, id: Option<RequestId>, params: &Value) -> Response {
        let sid = match require_str(&id, params, "sandboxId") {
            Ok(s) => s.to_owned(),
            Err(r) => return r,
        };
        if self.manager.forks.remove(&sid).is_none() {
            return Response::err(
                id,
                codes::INVALID_PARAMS,
                format!("unknown sandboxId: {sid}"),
            );
        }
        Response::ok(id, json!({"ok": true}))
    }

    async fn handle_sandbox_create(&mut self, id: Option<RequestId>, params: &Value) -> Response {
        if self.manager.named.len() >= 64 {
            return Response::err(id, codes::INVALID_PARAMS, "max sandboxes reached");
        }
        let (engine, wasm_bytes) = {
            let root = match self.manager.root.as_ref() {
                Some(r) => r,
                None => return Response::err(id, codes::INVALID_PARAMS, "no root sandbox"),
            };
            (root.engine.clone(), root.wasm_bytes.clone())
        };
        let nice = params
            .get("nice")
            .and_then(|v| v.as_u64())
            .map(|n| n.min(19) as u8)
            .unwrap_or(0);
        let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64());
        let vfs = crate::vfs::MemVfs::new(None, None);
        let shell =
            match crate::wasm::ShellInstance::new(&engine, &wasm_bytes, vfs, &[], nice).await {
                Ok(s) => s,
                Err(e) => return Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
            };
        let sb = crate::sandbox::SandboxState {
            engine,
            wasm_bytes,
            shell,
            env: Default::default(),
            nice,
            timeout_ms,
            poisoned: false,
            paused: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            resume_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
        };
        let sid = self.manager.next_named_id.to_string();
        self.manager.next_named_id += 1;
        self.manager.named.insert(sid.clone(), sb);
        Response::ok(id, json!({"sandboxId": sid}))
    }

    fn handle_sandbox_list(&self, id: Option<RequestId>) -> Response {
        let entries: Vec<_> = self
            .manager
            .named
            .keys()
            .map(|sid| json!({"sandboxId": sid}))
            .collect();
        Response::ok(id, json!(entries))
    }

    fn handle_sandbox_remove(&mut self, id: Option<RequestId>, params: &Value) -> Response {
        let sid = match require_str(&id, params, "sandboxId") {
            Ok(s) => s.to_owned(),
            Err(r) => return r,
        };
        if self.manager.named.remove(&sid).is_none() {
            return Response::err(
                id,
                codes::INVALID_PARAMS,
                format!("unknown sandboxId: {sid}"),
            );
        }
        Response::ok(id, json!({"ok": true}))
    }

    fn handle_sandbox_suspend(&mut self, id: Option<RequestId>, params: &Value) -> Response {
        let sid = sandbox_id(params);
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        sb.paused.store(true, std::sync::atomic::Ordering::Release);
        Response::ok(id, json!({ "ok": true }))
    }

    fn handle_sandbox_resume(&mut self, id: Option<RequestId>, params: &Value) -> Response {
        let sid = sandbox_id(params);
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        sb.paused.store(false, std::sync::atomic::Ordering::Release);
        sb.resume_notify.notify_waiters();
        Response::ok(id, json!({ "ok": true }))
    }

    // ── Callback protocol ─────────────────────────────────────────────────────

    /// Send a JSON-RPC callback request to the client (via stdout) and wait for
    /// the response on the cb_rx channel.  The caller (Python SDK) is expected
    /// to handle the request and reply with a matching id.
    async fn send_callback(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let cb_id = format!("cb_{}", self.next_cb_id);
        self.next_cb_id += 1;
        let req = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": cb_id,
            "method": method,
            "params": params,
        }))?;
        // NOTE: stdout_tx must have a large enough buffer (default: 16) to avoid
        // deadlock. The dispatcher is single-threaded — if stdout_tx fills up here,
        // the main loop (which drains it) cannot run because it's waiting for
        // dispatch() to return. The channel buffer must be >= 1 + the maximum
        // number of output lines emitted before the callback response arrives.
        self.stdout_tx.send(req).await?;
        let resp_line = self
            .cb_rx
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("callback channel closed"))?;
        let resp: serde_json::Value = serde_json::from_str(&resp_line)?;
        if let Some(err) = resp.get("error") {
            anyhow::bail!("callback error: {err}");
        }
        Ok(resp["result"].clone())
    }

    // ── Offload / rehydrate ───────────────────────────────────────────────────

    async fn handle_offload(
        &mut self,
        id: Option<RequestId>,
        _params: &Value,
        sid: Option<&str>,
    ) -> Response {
        // Use None to resolve the root sandbox; use the label only for the callback.
        let cb_sandbox_id = sid.unwrap_or("root").to_string();
        // Resolve using the original sid (None → root).
        let resolve_sid = if sid == Some("root") { None } else { sid };
        let blob = {
            let sb = match self.manager.resolve(resolve_sid) {
                Ok(s) => s,
                Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
            };
            match sb.shell.vfs().export_bytes() {
                Ok(b) => b,
                Err(e) => return Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
            }
        };
        if let Err(e) = self
            .send_callback(
                "storage.save",
                json!({
                    "sandbox_id": cb_sandbox_id,
                    "state": b64_encode(&blob),
                }),
            )
            .await
        {
            return Response::err(id, codes::INTERNAL_ERROR, e.to_string());
        }
        Response::ok(id, json!({"ok": true}))
    }

    async fn handle_rehydrate(
        &mut self,
        id: Option<RequestId>,
        _params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let cb_sandbox_id = sid.unwrap_or("root").to_string();
        let result = match self
            .send_callback("storage.load", json!({"sandbox_id": cb_sandbox_id}))
            .await
        {
            Ok(r) => r,
            Err(e) => return Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
        };
        let b64 = match result.as_str() {
            Some(s) => s.to_string(),
            None => {
                return Response::err(
                    id,
                    codes::INTERNAL_ERROR,
                    "expected base64 string from storage.load",
                )
            }
        };
        let blob = match b64_decode(&b64) {
            Ok(b) => b,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e),
        };
        // Resolve using None for root (same as offload).
        let resolve_sid = if sid == Some("root") { None } else { sid };
        let sb = match self.manager.resolve(resolve_sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match crate::vfs::MemVfs::import_bytes(&blob) {
            Ok(new_vfs) => {
                *sb.shell.vfs_mut() = new_vfs;
                Response::ok(id, json!({"ok": true}))
            }
            Err(e) => Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
        }
    }

    // ── Mount ─────────────────────────────────────────────────────────────────

    fn handle_mount(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        // Collect files before taking mutable borrow on manager.
        // A missing `files` key is treated as an empty map (just create the directory).
        let files_vec: Vec<(String, Vec<u8>)> = {
            let files_obj = params.get("files").and_then(|v| v.as_object());
            let mut out = Vec::new();
            if let Some(files_obj) = files_obj {
                for (rel, val) in files_obj {
                    let b64 = match val.as_str() {
                        Some(s) => s,
                        None => continue,
                    };
                    let bytes = match b64_decode(b64) {
                        Ok(b) => b,
                        Err(e) => {
                            return Response::err(
                                id,
                                codes::INVALID_PARAMS,
                                format!("base64 decode error for '{rel}': {e}"),
                            );
                        }
                    };
                    out.push((rel.clone(), bytes));
                }
            }
            out
        };

        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };

        let _ = sb.shell.vfs_mut().mkdirp(&path);
        for (rel, bytes) in &files_vec {
            let full = format!("{}/{}", path.trim_end_matches('/'), rel);
            if let Some(parent) = std::path::Path::new(&full)
                .parent()
                .and_then(|p| p.to_str())
            {
                if !parent.is_empty() && parent != "/" {
                    let _ = sb.shell.vfs_mut().mkdirp(parent);
                }
            }
            if let Err(e) = sb.shell.vfs_mut().write_file(&full, bytes, false) {
                return Response::err(
                    id,
                    codes::INTERNAL_ERROR,
                    format!("write_file '{full}' failed: {e}"),
                );
            }
        }
        Response::ok(id, json!({"ok": true}))
    }
}
