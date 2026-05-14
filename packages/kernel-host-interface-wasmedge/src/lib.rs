//! WasmEdge-backed kernel-host interface — **stub impl**.
//!
//! Validates the [`yurt_kernel_host_interface_core::WasmEngine`] +
//! [`yurt_kernel_host_interface_core::HostCallCtx`] trait surface against a
//! second engine without yet pulling the `wasmedge-sdk` dependency.
//! Every method bodies-out to `todo!()` with a comment naming the
//! corresponding wasmedge-sdk API. The crate compiling cleanly is
//! the architectural proof — it means no engine-specific knowledge
//! has leaked into the trait surface.
//!
//! ## Why WasmEdge specifically
//!
//! 1. **wasi-threads.** WasmEdge ships native support; wasmtime does
//!    not. The kernel.wasm port needs to be reentrant when threads
//!    land — see project memory `project_kernel_reentrance`.
//! 2. **JIT + AOT.** WasmEdge's AOT compiler is genuinely fast;
//!    distinct workloads benefit from picking it.
//! 3. **C/C++ bindings.** Embedders that aren't Rust prefer
//!    WasmEdge's C SDK shape.
//!
//! ## What's missing for a real impl
//!
//! - Pull `wasmedge-sdk` as a non-stub dependency.
//! - Compile via `wasmedge_sdk::Module::from_bytes(&vm, bytes)` or
//!   the equivalent in the active SDK version.
//! - Per-process Stores: WasmEdge's `Vm` plays the role of
//!   wasmtime's `Store`; one per user process.
//! - Imports via `ImportObjectBuilder::with_func` instead of
//!   `Linker::func_wrap`.
//! - User-memory access: `vm.named_module(name)?.memory("memory")?`,
//!   then `mem.read()` / `mem.write()`.
//! - Caller-side state: WasmEdge passes `&CallingFrame` to import
//!   functions; that's the analog of `wasmtime::Caller`. Wrap it in
//!   `WasmEdgeCtx<'_>` so the shared trampoline helpers in
//!   `yurt_kernel_host_interface_core` work unchanged.
//! - Wire `kh_thread_spawn` (new) to wasi-threads' thread-spawn
//!   callback so user processes can spawn POSIX-shaped threads.
//!   This is the slice that needs `Tid`/`Thread` plumbing in
//!   kernel.wasm.

use yurt_kernel_host_interface_core::{
    CompiledModule, EngineError, HasCallerPid, HostCallCtx, KernelDispatchOutcome, WasmEngine,
};

/// WasmEdge-backed [`WasmEngine`] impl. Stub — calls `todo!()`
/// pending the real wasmedge-sdk wiring.
pub struct WasmEdgeEngine {
    // Real impl: `vm: wasmedge_sdk::Vm` (or equivalent for the
    // chosen SDK version).
    _placeholder: (),
}

impl WasmEdgeEngine {
    pub fn new() -> Self {
        Self { _placeholder: () }
    }
}

impl Default for WasmEdgeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmEngine for WasmEdgeEngine {
    fn compile(&self, _bytes: &[u8]) -> Result<CompiledModule, EngineError> {
        // Real impl: wasmedge_sdk::Module::from_bytes(&self.vm, bytes)
        // → wrap in CompiledModule::new(module).
        todo!("WasmEdgeEngine::compile — wire wasmedge-sdk Module::from_bytes")
    }
}

/// Per-process state threaded through every wasmedge import callback.
/// Mirrors [`crate::kernel_host_interface::UserState`] in kernel-host-interface-wasmtime
/// shape — distinct concrete type because the kernel handle (the
/// reference to the wasmedge `Vm` hosting kernel.wasm) is engine-
/// specific.
pub struct WasmEdgeUserState {
    pub pid: u32,
    pub argv: Vec<Vec<u8>>,
    // Real impl: `pub kernel: Arc<Mutex<WasmEdgeKernelInstance>>`
    // where WasmEdgeKernelInstance bundles the kernel.wasm Vm,
    // memory handle, and dispatch executor.
}

impl HasCallerPid for WasmEdgeUserState {
    fn caller_pid(&self) -> u32 {
        self.pid
    }
}

/// Adapter that wraps WasmEdge's `&CallingFrame` (or the SDK
/// equivalent) and impls [`HostCallCtx<WasmEdgeUserState>`]. The
/// shared trampoline helpers in `yurt_kernel_host_interface_core` use this —
/// no changes to those when we wire the real impl.
pub struct WasmEdgeCtx<'a> {
    // Real impl: `frame: &'a wasmedge_sdk::CallingFrame`
    // + a reference to the user-state slot.
    _placeholder: std::marker::PhantomData<&'a ()>,
}

impl<'a> WasmEdgeCtx<'a> {
    pub fn new() -> Self {
        Self {
            _placeholder: std::marker::PhantomData,
        }
    }
}

impl<'a> Default for WasmEdgeCtx<'a> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> HostCallCtx<WasmEdgeUserState> for WasmEdgeCtx<'a> {
    fn read_user_memory(&mut self, _addr: u32, _buf: &mut [u8]) -> Result<(), EngineError> {
        // Real impl: frame.memory_ref(0)?.read(addr, buf)
        todo!("WasmEdgeCtx::read_user_memory — wire CallingFrame::memory_ref")
    }

    fn write_user_memory(&mut self, _addr: u32, _bytes: &[u8]) -> Result<(), EngineError> {
        todo!("WasmEdgeCtx::write_user_memory — wire CallingFrame::memory_mut")
    }

    fn user_state(&self) -> &WasmEdgeUserState {
        todo!("WasmEdgeCtx::user_state — wasmedge passes per-instance data via Vm or CallingFrame depending on SDK")
    }

    fn user_state_mut(&mut self) -> &mut WasmEdgeUserState {
        todo!("WasmEdgeCtx::user_state_mut")
    }

    fn dispatch_kernel(
        &mut self,
        _method_id: u32,
        _caller_pid: u32,
        _req_bytes: &[u8],
        _response_cap: u32,
    ) -> KernelDispatchOutcome {
        // Real impl mirrors WasmtimeCtx::dispatch_kernel:
        //   1. Lock the kernel-side Vm
        //   2. Write req_bytes to kernel scratch via vm.memory_mut()
        //   3. Call the dispatch export with (method, pid, in_ptr,
        //      in_len, out_ptr, out_cap)
        //   4. Read the response back from kernel scratch
        todo!("WasmEdgeCtx::dispatch_kernel — encapsulates the full kernel-side hop")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Architectural test: the stub crate compiles and the trait
    /// types match. If this crate ever fails to typecheck, a recent
    /// change to `kernel-host-interface-core` leaked engine-specific
    /// assumptions into the trait — fix the trait, not the engine.
    #[test]
    fn stub_satisfies_trait_shape() {
        fn assert_engine<E: WasmEngine>() {}
        fn assert_ctx<C: HostCallCtx<WasmEdgeUserState>>() {}
        assert_engine::<WasmEdgeEngine>();
        assert_ctx::<WasmEdgeCtx<'static>>();
    }
}
