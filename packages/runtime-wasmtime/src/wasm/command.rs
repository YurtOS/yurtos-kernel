//! One-shot WASI command execution for normal `_start` modules.

use anyhow::Context;
use wasmtime::{Module, Store, TypedFunc};
use wasmtime_wasi::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::I32Exit;

use super::{configure_store_preemption, StoreData, WasmEngine};
use crate::vfs::MemVfs;

pub struct CommandRunConfig {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub stdin: Vec<u8>,
    pub vfs: MemVfs,
    pub nice: u8,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run_command_module(
    engine: &WasmEngine,
    wasm_bytes: &[u8],
    config: CommandRunConfig,
) -> anyhow::Result<CommandRunResult> {
    let module =
        Module::new(&engine.engine, wasm_bytes).context("compiling WASI command module")?;
    let stdout = MemoryOutputPipe::new(1024 * 1024);
    let stderr = MemoryOutputPipe::new(1024 * 1024);
    let mut data = StoreData::new_with_ctx(config.vfs, &[], &config.env, None, config.nice)
        .context("creating command store data")?;

    data.p1_ctx = {
        let mut builder = wasmtime_wasi::WasiCtxBuilder::new();
        builder.stdin(MemoryInputPipe::new(config.stdin));
        builder.stdout(stdout.clone());
        builder.stderr(stderr.clone());
        let argv: Vec<&str> = config.argv.iter().map(String::as_str).collect();
        builder.args(&argv);
        for (key, value) in &config.env {
            builder.env(key, value);
        }
        builder.build_p1()
    };

    let mut store = Store::new(&engine.engine, data);
    configure_store_preemption(&mut store, config.nice)?;

    let instance = engine
        .linker
        .instantiate_async(&mut store, &module)
        .await
        .context("instantiating WASI command module")?;
    let start: TypedFunc<(), ()> = instance
        .get_typed_func(&mut store, "_start")
        .context("WASI command module missing _start export")?;

    let call = start.call_async(&mut store, ());
    let exit_code = match config.timeout_ms {
        Some(ms) => match tokio::time::timeout(std::time::Duration::from_millis(ms), call).await {
            Ok(result) => command_exit_code(result)?,
            Err(_) => {
                return Ok(CommandRunResult {
                    exit_code: 124,
                    stdout: String::from_utf8_lossy(&stdout.contents()).into_owned(),
                    stderr: "timeout\n".to_owned(),
                });
            }
        },
        None => command_exit_code(call.await)?,
    };

    Ok(CommandRunResult {
        exit_code,
        stdout: String::from_utf8_lossy(&stdout.contents()).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.contents()).into_owned(),
    })
}

fn command_exit_code(result: Result<(), wasmtime::Error>) -> anyhow::Result<i32> {
    match result {
        Ok(()) => Ok(0),
        Err(err) => {
            if let Some(exit) = err.downcast_ref::<I32Exit>() {
                Ok(exit.0)
            } else {
                Err(err).context("running WASI command _start")
            }
        }
    }
}
