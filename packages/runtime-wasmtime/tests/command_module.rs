use yurt_runtime_wasmtime::vfs::MemVfs;
use yurt_runtime_wasmtime::wasm::command::{run_command_module, CommandRunConfig};
use yurt_runtime_wasmtime::wasm::WasmEngine;

#[tokio::test]
async fn command_timeout_preempts_tight_loop() {
    let wasm = wat::parse_str(
        r#"
        (module
          (func (export "_start")
            (loop
              br 0)))
        "#,
    )
    .unwrap();
    let engine = WasmEngine::new().unwrap();

    let result = run_command_module(
        &engine,
        &wasm,
        CommandRunConfig {
            argv: vec!["loop".to_owned()],
            env: vec![],
            stdin: vec![],
            vfs: MemVfs::new(None, None),
            nice: 0,
            timeout_ms: Some(50),
        },
    )
    .await
    .unwrap();

    assert_eq!(result.exit_code, 124);
    assert_eq!(result.stderr, "timeout\n");
}
