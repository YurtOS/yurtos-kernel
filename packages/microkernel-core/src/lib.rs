//! Engine-agnostic scaffolding for the native microkernel.
//!
//! The kernel-host code (process spawning, syscall trampoline, WASI
//! shim) shouldn't care which WASM engine is hosting `kernel.wasm` and
//! the user processes. This crate defines the [`WasmEngine`] trait and
//! companion types that engine-specific microkernel crates implement
//! (today: `microkernel-wasmtime`; future: `microkernel-wasmedge`,
//! `microkernel-wasmer`).
//!
//! The split mirrors the JS side: `microkernel-js` is the portable
//! kernel-host code, with Deno/browser specifics (real sockets, OPFS)
//! living in extension crates. On native we want the same
//! engine-agnostic shape: drop in a different `WasmEngine` impl to run
//! with a different runtime.
//!
//! ## Why three engines
//!
//! - **wasmtime** — current native impl, single-threaded host
//! - **WasmEdge** — adds threads support; relevant when kernel.wasm
//!   wants real concurrency (right now it's deliberately
//!   single-threaded behind a Mutex)
//! - **wasmer** — third runtime worth supporting; standalone CLI,
//!   different optimizer trade-offs
//!
//! Anything else is out of scope.
//!
//! ## Phase status
//!
//! Phase 5 (this crate's first appearance): trait skeleton + error
//! type. The wasmtime microkernel doesn't yet route through the
//! trait — that's a follow-up refactor where `microkernel.rs` stops
//! talking to `wasmtime::*` directly and instead takes a
//! `&dyn WasmEngine`. Once that lands the second engine can be
//! added without touching kernel-host code.

use thiserror::Error;

/// Anything the engine can fail at gets mapped to one of these
/// variants on the way out. Engine-specific error types stay inside
/// their crate; we don't expose `wasmtime::Error` /
/// `wasmedge::WasmEdgeError` etc. to kernel-host code.
#[derive(Debug, Error)]
pub enum EngineError {
    #[error("wasm module failed to compile: {0}")]
    Compile(String),
    #[error("wasm module failed to instantiate: {0}")]
    Instantiate(String),
    #[error("import {namespace}::{name} not found or wrong signature")]
    MissingImport { namespace: String, name: String },
    #[error("export {0} not found")]
    MissingExport(String),
    #[error("memory read out of bounds: addr={addr:#x}, len={len}")]
    MemoryRead { addr: u32, len: u32 },
    #[error("memory write out of bounds: addr={addr:#x}, len={len}")]
    MemoryWrite { addr: u32, len: u32 },
    #[error("trap: {0}")]
    Trap(String),
    #[error("engine error: {0}")]
    Other(String),
}

/// Outcome of a [`HostCallCtx::dispatch_kernel`] call. `rc` is the
/// syscall scalar (negative POSIX errno on error, otherwise the
/// engine-neutral semantic value); `response` carries up to
/// `response_cap` bytes from kernel scratch when `rc > 0`.
#[derive(Debug)]
pub struct KernelDispatchOutcome {
    pub rc: i64,
    pub response: Vec<u8>,
}

/// What every host-side import callback gets, regardless of engine.
/// The kernel-host code (sys_* trampoline, WASI shim) reads/writes
/// user-process memory, reaches the per-process state, and invokes
/// `kernel_dispatch` through this trait — never through
/// `wasmtime::Caller` directly. That's the surface a different engine
/// (WasmEdge, wasmer) plugs into.
///
/// User-state type `S` is supplied by kernel-host code (today
/// [`UserState`] in microkernel-wasmtime: `pid`, `argv`, the kernel
/// handle).
pub trait HostCallCtx<S> {
    /// Read `buf.len()` bytes from the user process's linear memory
    /// starting at `addr`. Returns [`EngineError::MemoryRead`] on OOB.
    fn read_user_memory(&mut self, addr: u32, buf: &mut [u8]) -> Result<(), EngineError>;

    /// Write `bytes` into the user process's linear memory at `addr`.
    /// Returns [`EngineError::MemoryWrite`] on OOB.
    fn write_user_memory(&mut self, addr: u32, bytes: &[u8]) -> Result<(), EngineError>;

    /// Borrow the embedder's per-process state (pid, argv, kernel
    /// handle).
    fn user_state(&self) -> &S;

    /// Mutably borrow the embedder's per-process state.
    fn user_state_mut(&mut self) -> &mut S;

    /// Stage `req_bytes` in kernel scratch and invoke
    /// `kernel_dispatch(method_id, caller_pid, in_ptr, in_len,
    /// out_ptr, out_cap)`. Returns the syscall scalar and (when
    /// positive) up to `response_cap` bytes from kernel scratch.
    /// The trait impl owns all the wasm-engine-specific glue —
    /// callers see only bytes in / bytes out.
    fn dispatch_kernel(
        &mut self,
        method_id: u32,
        caller_pid: u32,
        req_bytes: &[u8],
        response_cap: u32,
    ) -> KernelDispatchOutcome;
}

/// Top-level engine handle. Compiles modules; the rest of the
/// lifecycle (instantiate, register imports, call exports) lives on
/// associated types so each engine can keep its own concrete
/// `Module` / `Store` / `Instance` representation.
///
/// The minimal surface: kernel-host code only needs to compile bytes
/// to a module today; instantiation + import registration + memory
/// access cross the trait via [`HostCallCtx`] when the bigger
/// refactor lands. This trait will grow associated types
/// (`type Module`, `type Instance`, `type Linker`) at that point —
/// keeping it minimal here lets early adopters experiment without
/// committing to the full surface.
pub trait WasmEngine {
    /// Compile a wasm module from raw bytes. Returns an opaque,
    /// engine-specific compiled artifact. Errors with
    /// [`EngineError::Compile`].
    fn compile(&self, bytes: &[u8]) -> Result<CompiledModule, EngineError>;
}

/// Opaque compiled module. Engine-specific bytes live behind it; only
/// the engine that produced it knows how to instantiate it. The
/// microkernel passes these around without inspecting them.
///
/// Phase 5 representation is a `Box<dyn Any + Send + Sync>` so engine
/// implementations can stash whatever they need (e.g. wasmtime stores
/// a `wasmtime::Module`). Future versions may add typed accessors.
pub struct CompiledModule(pub Box<dyn std::any::Any + Send + Sync>);

impl CompiledModule {
    pub fn new<T: std::any::Any + Send + Sync>(inner: T) -> Self {
        Self(Box::new(inner))
    }

    pub fn downcast_ref<T: std::any::Any>(&self) -> Option<&T> {
        self.0.downcast_ref::<T>()
    }
}
