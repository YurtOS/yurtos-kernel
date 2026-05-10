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

/// Per-process state types implement this so the trampoline helpers
/// (which live below) can read the caller's pid without knowing the
/// concrete user-state shape — pid is the one field every embedder
/// needs to expose. Engine-specific UserState types impl this in one
/// line.
pub trait HasCallerPid {
    fn caller_pid(&self) -> u32;
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

// ── Engine-agnostic trampoline helpers ─────────────────────────────
//
// Used by every engine's user-process import closures. Bodies stay
// in core because they're thin shims over [`HostCallCtx`] — no
// engine types appear. Engine-specific code is reduced to:
//   - the `linker.func_wrap(name, |caller, args| ...)` registration
//     (typed wasm signatures are inherently engine-specific)
//   - a `Ctx` adapter that wraps the engine's caller and impls
//     [`HostCallCtx<S>`]
// Both per-engine pieces are tiny; everything below is shared.

/// POSIX EFAULT — kernel and helper return on host-side memory or
/// engine-call failure. Same value as `abi/contract/yurt_abi.toml`.
const EFAULT: i64 = 14;

/// Forward a scalar-only syscall (no request bytes, no response
/// capacity). Returns the i32 cast of the kernel's i64 result.
pub fn forward_scalar<S: HasCallerPid, C: HostCallCtx<S>>(
    ctx: &mut C,
    method_id: u32,
) -> i32 {
    let pid = ctx.user_state().caller_pid();
    ctx.dispatch_kernel(method_id, pid, &[], 0).rc as i32
}

/// Forward a syscall whose only argument is a single u32 (e.g.
/// fd numbers). Argument is staged as 4 little-endian bytes.
pub fn forward_u32_arg<S: HasCallerPid, C: HostCallCtx<S>>(
    ctx: &mut C,
    method_id: u32,
    arg: u32,
) -> i32 {
    forward_request_bytes(ctx, method_id, &arg.to_le_bytes()) as i32
}

/// Forward a syscall whose request is `request_bytes`; no response
/// buffer. Returns the syscall scalar (i64 to preserve sign /
/// negative-errno semantics; i32-callers cast).
pub fn forward_request_bytes<S: HasCallerPid, C: HostCallCtx<S>>(
    ctx: &mut C,
    method_id: u32,
    request_bytes: &[u8],
) -> i64 {
    let pid = ctx.user_state().caller_pid();
    ctx.dispatch_kernel(method_id, pid, request_bytes, 0).rc
}

/// Forward a syscall that reads bytes from user memory at
/// `(user_ptr, user_len)`, copies them into kernel scratch, and
/// invokes `kernel_dispatch`. Used by syscalls like `sys_chdir`.
pub fn forward_user_ptr_len<S: HasCallerPid, C: HostCallCtx<S>>(
    ctx: &mut C,
    method_id: u32,
    user_ptr: u32,
    user_len: u32,
) -> i32 {
    let mut buf = vec![0u8; user_len as usize];
    if user_len > 0 && ctx.read_user_memory(user_ptr, &mut buf).is_err() {
        return -(EFAULT as i32);
    }
    forward_request_bytes(ctx, method_id, &buf) as i32
}

/// Forward a syscall whose request is `req_bytes` (already encoded
/// by the caller) and whose response goes into a user-memory buffer
/// `(user_out_ptr, user_out_cap)`. Returns the syscall scalar
/// verbatim — collapse positive `rc` to 0 in the caller if the user
/// API expects POSIX semantics.
pub fn forward_request_with_user_response<S: HasCallerPid, C: HostCallCtx<S>>(
    ctx: &mut C,
    method_id: u32,
    req_bytes: &[u8],
    user_out_ptr: u32,
    user_out_cap: u32,
) -> i64 {
    let pid = ctx.user_state().caller_pid();
    let outcome = ctx.dispatch_kernel(method_id, pid, req_bytes, user_out_cap);
    if outcome.rc <= 0 {
        return outcome.rc;
    }
    if !outcome.response.is_empty()
        && ctx
            .write_user_memory(user_out_ptr, &outcome.response)
            .is_err()
    {
        return -EFAULT;
    }
    outcome.rc
}

/// Forward a syscall that fills a response buffer in user memory at
/// `(user_out_ptr, user_out_cap)`. No request bytes.
pub fn forward_response_to_user<S: HasCallerPid, C: HostCallCtx<S>>(
    ctx: &mut C,
    method_id: u32,
    user_out_ptr: u32,
    user_out_cap: u32,
) -> i32 {
    let pid = ctx.user_state().caller_pid();
    let outcome = ctx.dispatch_kernel(method_id, pid, &[], user_out_cap);
    if outcome.rc <= 0 {
        return outcome.rc as i32;
    }
    if !outcome.response.is_empty()
        && ctx
            .write_user_memory(user_out_ptr, &outcome.response)
            .is_err()
    {
        return -(EFAULT as i32);
    }
    outcome.rc as i32
}

/// Forward an arbitrary syscall (request bytes in, response bytes
/// into the caller-provided slice). Returns the syscall scalar.
/// Used by the WASI shim where the response goes back into a host-
/// stack buffer rather than directly into user memory.
pub fn trampoline_request<S: HasCallerPid, C: HostCallCtx<S>>(
    ctx: &mut C,
    method_id: u32,
    req_bytes: &[u8],
) -> i64 {
    let pid = ctx.user_state().caller_pid();
    ctx.dispatch_kernel(method_id, pid, req_bytes, 0).rc
}

/// Like [`trampoline_request`] but copies the kernel's response into
/// `response`. Returns the kernel's scalar (e.g. bytes written).
pub fn trampoline_request_with_response<S: HasCallerPid, C: HostCallCtx<S>>(
    ctx: &mut C,
    method_id: u32,
    req_bytes: &[u8],
    response: &mut [u8],
) -> i64 {
    let pid = ctx.user_state().caller_pid();
    let outcome = ctx.dispatch_kernel(method_id, pid, req_bytes, response.len() as u32);
    if outcome.rc <= 0 {
        return outcome.rc;
    }
    let to_copy = outcome.response.len().min(response.len());
    response[..to_copy].copy_from_slice(&outcome.response[..to_copy]);
    outcome.rc
}
