#![allow(dead_code)] // Phase 3: wired to dispatcher in Phase 7
//! Per-sandbox WASM instance: loads a module, wires host imports, drives execution.

use anyhow::{bail, Context};
use std::sync::Arc;
use wasmtime::{Memory, Module, Store, TypedFunc};

use super::spawn::SpawnContext;
use super::{configure_store_preemption, StoreData, WasmEngine};
use crate::vfs::MemVfs;

/// A live WASM instance for one sandbox.
///
/// Each sandbox has one `ShellInstance` which persists across `run_command` calls,
/// preserving the guest's in-module shell state (environment variables, history, etc.).
pub struct ShellInstance {
    store: Store<StoreData>,
    memory: Memory,
    run_command: TypedFunc<(u32, u32, u32, u32), i32>,
    alloc: TypedFunc<u32, u32>,
    dealloc: TypedFunc<(u32, u32), ()>,
}

impl ShellInstance {
    /// Instantiate a WASM module.
    ///
    /// - `wasm_bytes`: raw WASM binary (e.g. `yurt-shell-exec.wasm`).
    /// - `vfs`: the sandbox's virtual filesystem, pre-populated.
    /// - `env`: environment variables passed to the guest via WASI.
    pub async fn new(
        engine: &WasmEngine,
        wasm_bytes: &[u8],
        vfs: MemVfs,
        env: &[(String, String)],
        nice: u8,
    ) -> anyhow::Result<Self> {
        let module =
            Arc::new(Module::new(&engine.engine, wasm_bytes).context("compiling WASM module")?);

        let spawn_ctx = SpawnContext::new(engine, module.clone());
        let data = StoreData::new_with_ctx(vfs, &[], env, Some(spawn_ctx), nice)
            .context("creating store data")?;
        let mut store = Store::new(&engine.engine, data);

        // Yield to the tokio executor every quantum so CPU-bound modules can be preempted.
        configure_store_preemption(&mut store, nice)?;

        let instance = engine
            .linker
            .instantiate_async(&mut store, &module)
            .await
            .context("instantiating WASM module")?;

        // Resolve exported functions and memory.
        let memory = instance
            .get_memory(&mut store, "memory")
            .context("WASM module missing 'memory' export")?;

        let run_command: TypedFunc<(u32, u32, u32, u32), i32> = instance
            .get_typed_func(&mut store, "__run_command")
            .context("WASM module missing '__run_command' export")?;

        let alloc: TypedFunc<u32, u32> = instance
            .get_typed_func(&mut store, "__alloc")
            .context("WASM module missing '__alloc' export")?;

        let dealloc: TypedFunc<(u32, u32), ()> =
            instance
                .get_typed_func(&mut store, "__dealloc")
                .context("WASM module missing '__dealloc' export")?;

        Ok(Self {
            store,
            memory,
            run_command,
            alloc,
            dealloc,
        })
    }

    /// Run a shell command and return the JSON result written by the guest.
    ///
    /// Allocates a guest buffer, calls `__run_command`, and decodes the output.
    /// If the guest signals the buffer is too small, retries with the requested size.
    pub async fn run_command(&mut self, cmd: &str) -> anyhow::Result<serde_json::Value> {
        let cmd_bytes = cmd.as_bytes();

        // Allocate guest memory for the command string.
        let cmd_ptr = self
            .alloc
            .call_async(&mut self.store, cmd_bytes.len() as u32)
            .await
            .context("__alloc for command")?;

        // Write the command into guest memory.
        self.memory
            .write(&mut self.store, cmd_ptr as usize, cmd_bytes)
            .context("writing command to guest memory")?;

        // Allocate the output buffer (start with 64 KB).
        let out_cap: u32 = 64 * 1024;
        let out_ptr = self
            .alloc
            .call_async(&mut self.store, out_cap)
            .await
            .context("__alloc for output buffer")?;

        // Call __run_command.
        let n = self
            .run_command
            .call_async(
                &mut self.store,
                (cmd_ptr, cmd_bytes.len() as u32, out_ptr, out_cap),
            )
            .await
            .context("__run_command")?;

        // Check if the output buffer was too small.
        let (out_ptr, out_cap, n) = if n as usize > out_cap as usize {
            // Free old output buffer.
            self.dealloc
                .call_async(&mut self.store, (out_ptr, out_cap))
                .await
                .context("__dealloc small output buffer")?;

            // Allocate a larger buffer and retry.
            let needed = n as u32;
            let big_ptr = self
                .alloc
                .call_async(&mut self.store, needed)
                .await
                .context("__alloc for large output buffer")?;

            let n2 = self
                .run_command
                .call_async(
                    &mut self.store,
                    (cmd_ptr, cmd_bytes.len() as u32, big_ptr, needed),
                )
                .await
                .context("__run_command (retry)")?;

            if n2 < 0 || n2 as usize > needed as usize {
                bail!("__run_command retry failed: n={n2}");
            }
            (big_ptr, needed, n2)
        } else {
            (out_ptr, out_cap, n)
        };

        // Read the JSON result from guest memory.
        let mut result_bytes = vec![0u8; n as usize];
        self.memory
            .read(&self.store, out_ptr as usize, &mut result_bytes)
            .context("reading result from guest memory")?;

        // Free all guest buffers.
        self.dealloc
            .call_async(&mut self.store, (cmd_ptr, cmd_bytes.len() as u32))
            .await
            .context("__dealloc command")?;
        self.dealloc
            .call_async(&mut self.store, (out_ptr, out_cap))
            .await
            .context("__dealloc output")?;

        serde_json::from_slice(&result_bytes).context("parsing run_command JSON result")
    }

    /// Access the sandbox's VFS (for reading files, checking state, etc.).
    pub fn vfs(&self) -> &MemVfs {
        &self.store.data().vfs
    }

    /// Access the sandbox's VFS mutably (for write_file, mkdir, etc.).
    pub fn vfs_mut(&mut self) -> &mut MemVfs {
        &mut self.store.data_mut().vfs
    }

    /// Take the captured stdout bytes (drains the pipe).
    pub fn take_stdout(&mut self) -> bytes::Bytes {
        self.store.data().stdout_pipe.take()
    }

    /// Take the captured stderr bytes (drains the pipe).
    pub fn take_stderr(&mut self) -> bytes::Bytes {
        self.store.data().stderr_pipe.take()
    }
}
