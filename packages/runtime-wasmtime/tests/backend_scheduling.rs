use yurt_runtime_wasmtime::wasm::{nice_to_quantum, WasmEngine};

#[test]
fn nice_to_quantum_matches_yurt_policy() {
    assert_eq!(nice_to_quantum(0), 10);
    assert_eq!(nice_to_quantum(10), 5);
    assert_eq!(nice_to_quantum(19), 1);
    assert_eq!(nice_to_quantum(255), 1);
}

#[tokio::test]
async fn wasm_engine_constructs_with_epoch_support() {
    let engine = WasmEngine::new().expect("WasmEngine::new() should enable backend features");
    assert_eq!(nice_to_quantum(19), 1);
    drop(engine);
}
