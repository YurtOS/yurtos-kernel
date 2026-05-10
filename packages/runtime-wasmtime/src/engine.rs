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

use yurt_microkernel_core::{
    CompiledModule, EngineError, HostCallCtx, KernelDispatchOutcome, WasmEngine,
};

use crate::microkernel::UserState;
use wasmtime::Caller;

/// Wraps a `wasmtime::Caller` plus its inferred user-process memory
/// so the trampoline helpers can talk to it through the engine-
/// agnostic [`HostCallCtx`] trait. Lives one stack frame deep inside
/// every `linker.func_wrap` closure; the closure mints one and hands
/// it to whichever helper does the actual work.
pub struct WasmtimeCtx<'a, 'b> {
    caller: &'a mut Caller<'b, UserState>,
}

impl<'a, 'b> WasmtimeCtx<'a, 'b> {
    pub fn new(caller: &'a mut Caller<'b, UserState>) -> Self {
        Self { caller }
    }
}

impl<'a, 'b> HostCallCtx<UserState> for WasmtimeCtx<'a, 'b> {
    fn read_user_memory(&mut self, addr: u32, buf: &mut [u8]) -> Result<(), EngineError> {
        let mem = self
            .caller
            .get_export("memory")
            .and_then(|e| e.into_memory())
            .ok_or(EngineError::MemoryRead {
                addr,
                len: buf.len() as u32,
            })?;
        mem.read(&self.caller, addr as usize, buf)
            .map_err(|_| EngineError::MemoryRead {
                addr,
                len: buf.len() as u32,
            })
    }

    fn write_user_memory(&mut self, addr: u32, bytes: &[u8]) -> Result<(), EngineError> {
        let mem = self
            .caller
            .get_export("memory")
            .and_then(|e| e.into_memory())
            .ok_or(EngineError::MemoryWrite {
                addr,
                len: bytes.len() as u32,
            })?;
        mem.write(&mut self.caller, addr as usize, bytes)
            .map_err(|_| EngineError::MemoryWrite {
                addr,
                len: bytes.len() as u32,
            })
    }

    fn user_state(&self) -> &UserState {
        self.caller.data()
    }

    fn user_state_mut(&mut self) -> &mut UserState {
        self.caller.data_mut()
    }

    /// Stage `req_bytes` into kernel.wasm's scratch buffer, invoke
    /// `kernel_dispatch(method_id, caller_pid, in_ptr, in_len,
    /// out_ptr, out_cap)`, and read back up to `response_cap` bytes
    /// of kernel scratch when the return is positive. Mirrors the
    /// previous inline `trampoline_request*` helpers exactly — the
    /// only change is callers no longer see scratch pointers.
    fn dispatch_kernel(
        &mut self,
        method_id: u32,
        caller_pid: u32,
        req_bytes: &[u8],
        response_cap: u32,
    ) -> KernelDispatchOutcome {
        let kernel = self.caller.data().kernel.clone();
        let mut k = kernel.lock().unwrap();
        let scratch_ptr = k.scratch_ptr;
        let scratch_len = k.scratch_len;
        let memory = k.memory;
        let dispatch = k.dispatch.clone();
        let in_ptr = scratch_ptr;
        let in_len = req_bytes.len() as u32;
        let out_ptr = scratch_ptr + in_len;
        let out_cap = response_cap.min(scratch_len.saturating_sub(in_len));

        if !req_bytes.is_empty()
            && memory
                .write(&mut k.store, in_ptr as usize, req_bytes)
                .is_err()
        {
            return KernelDispatchOutcome {
                rc: -(crate::microkernel::EFAULT_PUB),
                response: Vec::new(),
            };
        }
        let rc = match dispatch.call(
            &mut k.store,
            (method_id, caller_pid, in_ptr, in_len, out_ptr, out_cap),
        ) {
            Ok(rc) => rc,
            Err(_) => {
                return KernelDispatchOutcome {
                    rc: -(crate::microkernel::EFAULT_PUB),
                    response: Vec::new(),
                };
            }
        };
        if rc <= 0 || response_cap == 0 {
            return KernelDispatchOutcome {
                rc,
                response: Vec::new(),
            };
        }
        let to_copy = (rc as u32).min(out_cap) as usize;
        let mut response = vec![0u8; to_copy];
        if to_copy > 0
            && memory
                .read(&k.store, out_ptr as usize, &mut response)
                .is_err()
        {
            return KernelDispatchOutcome {
                rc: -(crate::microkernel::EFAULT_PUB),
                response: Vec::new(),
            };
        }
        KernelDispatchOutcome { rc, response }
    }
}

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
