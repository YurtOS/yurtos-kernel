//! Wasmer-backed microkernel — **stub impl**.
//!
//! Validates the [`yurt_microkernel_core::WasmEngine`] +
//! [`yurt_microkernel_core::HostCallCtx`] trait surface against a
//! third engine without yet pulling the `wasmer` dependency. Same
//! "compile cleanly == architecture is right" proof as the wasmedge
//! stub.
//!
//! ## Why Wasmer specifically
//!
//! 1. **Standalone CLI.** wasmer-cli ships precompiled binaries
//!    suitable for distribution-as-tooling (vs wasmtime's library-
//!    first model). Embedders that want a CLI shipping path pick it.
//! 2. **Different optimizer trade-offs.** Wasmer's Cranelift /
//!    Singlepass / LLVM compiler choices differ from wasmtime's;
//!    workloads with specific perf profiles benefit.
//! 3. **JSPI / asyncify.** Wasmer exposes both today, ahead of
//!    wasmtime — relevant when the AsyncBridge integration lands.
//!
//! ## What's missing for a real impl
//!
//! - Pull `wasmer` as a non-stub dependency.
//! - Compile via `wasmer::Module::new(&store, bytes)`.
//! - Per-process Stores: `wasmer::Store` plays the same role as
//!   wasmtime's; one per user process.
//! - Imports via `imports! { "env" => { "sys_…" => Function::new_…
//!   } }` macro expansion.
//! - User-memory access: `instance.exports.get_memory("memory")?`,
//!   then `view.read(addr, buf)` / `view.write(addr, bytes)`.
//! - Caller-side state: wasmer passes `&FunctionEnvMut<'_, S>` to
//!   import functions; that's the analog of `wasmtime::Caller`.
//!   Wrap it in `WasmerCtx<'_>` so the shared trampoline helpers
//!   in `yurt_microkernel_core` work unchanged.
//! - Optional: enable wasmer's JSPI feature when the AsyncBridge
//!   integration lands.

use yurt_microkernel_core::{
    CompiledModule, EngineError, HasCallerPid, HostCallCtx, KernelDispatchOutcome, WasmEngine,
};

/// Wasmer-backed [`WasmEngine`] impl. Stub — calls `todo!()`
/// pending the real wasmer wiring.
pub struct WasmerEngine {
    // Real impl: `engine: wasmer::Engine` + a `wasmer::Store`
    // factory closure (Stores are per-process in wasmer).
    _placeholder: (),
}

impl WasmerEngine {
    pub fn new() -> Self {
        Self { _placeholder: () }
    }
}

impl Default for WasmerEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmEngine for WasmerEngine {
    fn compile(&self, _bytes: &[u8]) -> Result<CompiledModule, EngineError> {
        // Real impl: wasmer::Module::new(&store, bytes)
        // → wrap in CompiledModule::new(module).
        todo!("WasmerEngine::compile — wire wasmer::Module::new")
    }
}

/// Per-process state threaded through every wasmer import callback.
/// Same shape as the wasmedge / wasmtime equivalents — distinct
/// concrete type because the kernel handle (reference to the wasmer
/// Store hosting kernel.wasm) is engine-specific.
pub struct WasmerUserState {
    pub pid: u32,
    pub argv: Vec<Vec<u8>>,
    // Real impl: `pub kernel: Arc<Mutex<WasmerKernelInstance>>`.
}

impl HasCallerPid for WasmerUserState {
    fn caller_pid(&self) -> u32 {
        self.pid
    }
}

/// Adapter that wraps wasmer's `&FunctionEnvMut<'_, S>` (or the SDK
/// equivalent) and impls [`HostCallCtx<WasmerUserState>`].
pub struct WasmerCtx<'a> {
    // Real impl: `env: &'a mut wasmer::FunctionEnvMut<'a, WasmerUserState>`
    _placeholder: std::marker::PhantomData<&'a ()>,
}

impl<'a> WasmerCtx<'a> {
    pub fn new() -> Self {
        Self {
            _placeholder: std::marker::PhantomData,
        }
    }
}

impl<'a> Default for WasmerCtx<'a> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> HostCallCtx<WasmerUserState> for WasmerCtx<'a> {
    fn read_user_memory(&mut self, _addr: u32, _buf: &mut [u8]) -> Result<(), EngineError> {
        // Real impl: env.data().memory.view(&store).read(addr, buf)
        todo!("WasmerCtx::read_user_memory — wire MemoryView::read")
    }

    fn write_user_memory(&mut self, _addr: u32, _bytes: &[u8]) -> Result<(), EngineError> {
        todo!("WasmerCtx::write_user_memory — wire MemoryView::write")
    }

    fn user_state(&self) -> &WasmerUserState {
        todo!("WasmerCtx::user_state — env.data()")
    }

    fn user_state_mut(&mut self) -> &mut WasmerUserState {
        todo!("WasmerCtx::user_state_mut — env.data_mut()")
    }

    fn dispatch_kernel(
        &mut self,
        _method_id: u32,
        _caller_pid: u32,
        _req_bytes: &[u8],
        _response_cap: u32,
    ) -> KernelDispatchOutcome {
        // Real impl mirrors WasmtimeCtx::dispatch_kernel:
        //   1. Lock the kernel-side Store
        //   2. Write req_bytes to kernel scratch
        //   3. Call kernel_dispatch.call(…)
        //   4. Read the response back from kernel scratch
        todo!("WasmerCtx::dispatch_kernel — encapsulates the full kernel-side hop")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_satisfies_trait_shape() {
        fn assert_engine<E: WasmEngine>() {}
        fn assert_ctx<C: HostCallCtx<WasmerUserState>>() {}
        assert_engine::<WasmerEngine>();
        assert_ctx::<WasmerCtx<'static>>();
    }
}
