//! [`yurt_microkernel_core::WasmEngine`] impl backed by `wasmtime`.
//!
//! Phase 5 surface is intentionally narrow — just `compile`. The
//! existing `microkernel.rs` still talks to `wasmtime::*` types
//! directly; the next refactor slice will route those calls through
//! the trait so a second engine (WasmEdge or wasmer) can be dropped
//! in by adding a sibling impl.
//!
//! Cross-references:
//!   - `packages/microkernel-core/src/lib.rs` — the trait definition
//!   - project memory `project_pluggable_wasm_runtime.md` — design
//!     direction the user flagged on 2026-05-10

use yurt_microkernel_core::{CompiledModule, EngineError, WasmEngine};

/// Wasmtime-backed [`WasmEngine`]. Owns a single
/// `wasmtime::Engine`; modules compiled through it carry that engine
/// internally and can be instantiated against any `Store` derived
/// from the same engine.
pub struct WasmtimeEngine {
    engine: wasmtime::Engine,
}

impl WasmtimeEngine {
    pub fn new() -> Self {
        Self {
            engine: wasmtime::Engine::default(),
        }
    }

    /// Construct from an existing `wasmtime::Engine`. Lets callers
    /// share an engine with code outside the trait while still
    /// surfacing the trait surface.
    pub fn from_engine(engine: wasmtime::Engine) -> Self {
        Self { engine }
    }

    /// Borrow the underlying engine. Useful while the wider refactor
    /// is in flight and call sites still want raw wasmtime access.
    pub fn raw(&self) -> &wasmtime::Engine {
        &self.engine
    }
}

impl Default for WasmtimeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmEngine for WasmtimeEngine {
    fn compile(&self, bytes: &[u8]) -> Result<CompiledModule, EngineError> {
        let module = wasmtime::Module::new(&self.engine, bytes)
            .map_err(|e| EngineError::Compile(e.to_string()))?;
        Ok(CompiledModule::new(module))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wasmtime_engine_compiles_minimal_module() {
        // Smallest valid wasm: the empty module header.
        let wat = r#"(module)"#;
        let bytes = wat::parse_str(wat).unwrap();
        let engine = WasmtimeEngine::new();
        let compiled = engine.compile(&bytes).expect("compile empty module");
        assert!(
            compiled.downcast_ref::<wasmtime::Module>().is_some(),
            "CompiledModule should carry a wasmtime::Module"
        );
    }

    #[test]
    fn invalid_bytes_yield_compile_error() {
        let engine = WasmtimeEngine::new();
        let err = match engine.compile(b"not wasm at all") {
            Ok(_) => panic!("expected compile error"),
            Err(e) => e,
        };
        assert!(matches!(err, EngineError::Compile(_)), "got: {err}");
    }
}
