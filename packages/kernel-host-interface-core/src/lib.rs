//! Engine-agnostic scaffolding for the native kernel-host interface.
//!
//! The kernel-host code (process spawning, syscall trampoline, WASI
//! shim) shouldn't care which WASM engine is hosting `kernel.wasm` and
//! the user processes. This crate defines the [`WasmEngine`] trait and
//! companion types that engine-specific kernel-host-interface crates implement
//! (today: `kernel-host-interface-wasmtime`; future: `kernel-host-interface-wasmedge`,
//! `kernel-host-interface-wasmer`).
//!
//! The split mirrors the JS side: `kernel-host-interface-js` is the portable
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
//! type. The wasmtime kernel-host interface doesn't yet route through the
//! trait — that's a follow-up refactor where `kernel_host_interface.rs` stops
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
    #[error("engine cannot suspend: no JSPI and no asyncify available")]
    NotSuspendable,
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
    /// The full requested scratch window (up to `response_cap`), **not**
    /// truncated to `rc`: out-params (recvfrom source address, recvmsg
    /// SCM_RIGHTS fds) live at fixed offsets past `rc`. Callers that
    /// follow the "rc == bytes written" convention must clamp their
    /// user-visible copy to `rc` themselves (the trampoline helpers do).
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

/// Capabilities a [`AsyncBridge`] impl exposes. **Two of these are
/// "per-host" (JSPI, native async) and one is "per-loaded-wasm"
/// (asyncify)** — see project memory `project_async_bridge` for the
/// matrix. Always check capabilities before calling
/// [`AsyncBridge::suspend_until`]; bridges with no suspension
/// mechanism return [`EngineError::NotSuspendable`].
#[derive(Clone, Copy, Debug, Default)]
pub struct AsyncCapabilities {
    /// **JS hosts only.** Host supports `WebAssembly.Suspending` /
    /// `WebAssembly.promising` so wasm imports can return Promises
    /// that suspend the calling wasm. V8 / SpiderMonkey: yes;
    /// JavaScriptCore (Safari): not yet. Native engines (wasmtime,
    /// wasmedge, wasmer) use their own async mechanisms instead;
    /// JSPI is `false` for them by definition.
    pub jspi: bool,
    /// kernel.wasm + user wasm were built with the binaryen
    /// `--asyncify` pass — the wasm exports
    /// `asyncify_{start,stop}_{unwind,rewind}` and the host drives
    /// suspension by calling them across import-call boundaries.
    /// **Engine-agnostic**: works on wasmtime, wasmedge, wasmer,
    /// every JS engine. Universal fallback when JSPI / stack
    /// switching / native async aren't available.
    pub asyncify: bool,
    /// Engine supports the WebAssembly Stack Switching proposal
    /// (`cont.new`, `suspend`, `resume`). First-class wasm
    /// suspend/resume primitives — supersedes asyncify and JSPI.
    /// Wasmer ships it today; Chrome has experimental support; the
    /// rest of the matrix lags. When universal, AsyncBridge impls
    /// prefer this over asyncify.
    pub stack_switching: bool,
    /// Host supports wasi-threads / wasm-threads. Widely supported
    /// across modern engines (wasmtime, wasmedge, wasmer, V8,
    /// SpiderMonkey, JavaScriptCore ≥ 14.1). Orthogonal to
    /// suspension; relevant for kernel reentrance.
    pub threads: bool,
}

/// Engine-supplied bridge to the host's async machinery. Lets
/// blocking syscalls (`sys_nanosleep`, `sys_read` on a drained pipe,
/// `sys_wait` once spawn lands, signal-aware syscalls in general)
/// suspend the calling wasm until the host completes the work.
///
/// **Capability-dependent.** Some engines have neither JSPI nor
/// asyncify (wasmtime today); their bridges return
/// [`EngineError::NotSuspendable`]. Calling code is expected to
/// check [`AsyncBridge::capabilities`] first and fall back to
/// non-blocking semantics (EAGAIN / immediate-return) when
/// suspension is unavailable.
pub trait AsyncBridge: Send + Sync {
    fn capabilities(&self) -> AsyncCapabilities;

    /// Suspend the calling wasm until `task` resolves, then return
    /// its bytes payload. Engines that can't suspend return
    /// [`EngineError::NotSuspendable`] without invoking `task`.
    ///
    /// Phase 5 surface uses opaque byte payloads so the trait stays
    /// dyn-compatible; engines impl the actual JSPI / asyncify dance
    /// behind the scenes. When typed payloads are needed (return a
    /// typed timer-elapsed result), helpers above wrap (de)serialize
    /// — no need for generics here.
    ///
    /// `task` is invoked synchronously by the engine impl; impls
    /// that need async dispatch (Tokio, the JS event loop) wrap the
    /// closure into their runtime.
    fn suspend_until(
        &self,
        task: Box<dyn FnOnce() -> Result<Vec<u8>, EngineError> + Send>,
    ) -> Result<Vec<u8>, EngineError>;
}

/// Default no-suspension bridge. Wasmtime uses this today (no JSPI,
/// no asyncify). Blocking syscalls that route through it must fall
/// back to non-blocking semantics — sys_nanosleep returns 0
/// immediately, sys_read returns EAGAIN.
pub struct NoopAsyncBridge;

impl AsyncBridge for NoopAsyncBridge {
    fn capabilities(&self) -> AsyncCapabilities {
        AsyncCapabilities::default()
    }

    fn suspend_until(
        &self,
        _task: Box<dyn FnOnce() -> Result<Vec<u8>, EngineError> + Send>,
    ) -> Result<Vec<u8>, EngineError> {
        Err(EngineError::NotSuspendable)
    }
}

/// What every host-side import callback gets, regardless of engine.
/// The kernel-host code (sys_* trampoline, WASI shim) reads/writes
/// user-process memory, reaches the per-process state, and invokes
/// `kernel_dispatch` through this trait — never through
/// `wasmtime::Caller` directly. That's the surface a different engine
/// (WasmEdge, wasmer) plugs into.
///
/// User-state type `S` is supplied by kernel-host code (today
/// [`UserState`] in kernel-host-interface-wasmtime: `pid`, `argv`, the kernel
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
/// kernel_host_interface passes these around without inspecting them.
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
const E2BIG: i64 = 7;
pub const MAX_GUEST_BUFFER_LEN: u32 = 1024 * 1024;

pub fn checked_guest_buffer_len(len: u32) -> Result<usize, i64> {
    if len > MAX_GUEST_BUFFER_LEN {
        Err(-E2BIG)
    } else {
        Ok(len as usize)
    }
}

pub fn checked_guest_buffer_sum(parts: &[u32]) -> Result<usize, i64> {
    let mut total = 0u32;
    for part in parts {
        total = total.checked_add(*part).ok_or(-E2BIG)?;
        if total > MAX_GUEST_BUFFER_LEN {
            return Err(-E2BIG);
        }
    }
    Ok(total as usize)
}

/// Forward a scalar-only syscall (no request bytes, no response
/// capacity). Returns the i32 cast of the kernel's i64 result.
pub fn forward_scalar<S: HasCallerPid, C: HostCallCtx<S>>(ctx: &mut C, method_id: u32) -> i32 {
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
    let len = match checked_guest_buffer_len(user_len) {
        Ok(n) => n,
        Err(rc) => return rc as i32,
    };
    let mut buf = vec![0u8; len];
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
    // The kernel scratch window may carry stale bytes past the `rc`
    // meaningful prefix. Syscalls routed through this helper follow the
    // "rc == bytes written" convention, so only the first `rc` bytes are
    // valid; clamp the user-visible copy so widening the scratch read in
    // `dispatch_kernel` cannot surface stale scratch to the guest.
    let n = (outcome.rc as usize).min(outcome.response.len());
    if n > 0
        && ctx
            .write_user_memory(user_out_ptr, &outcome.response[..n])
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
    // See `forward_request_with_user_response`: clamp to the `rc`
    // meaningful prefix so the widened scratch read cannot leak stale
    // scratch bytes to the guest.
    let n = (outcome.rc as usize).min(outcome.response.len());
    if n > 0
        && ctx
            .write_user_memory(user_out_ptr, &outcome.response[..n])
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
    let response_cap = match u32::try_from(response.len()) {
        Ok(n) => n,
        Err(_) => return -E2BIG,
    };
    let outcome = ctx.dispatch_kernel(method_id, pid, req_bytes, response_cap);
    if outcome.rc <= 0 {
        return outcome.rc;
    }
    let to_copy = outcome.response.len().min(response.len());
    response[..to_copy].copy_from_slice(&outcome.response[..to_copy]);
    outcome.rc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_guest_buffer_lengths_are_capped_before_allocation() {
        assert_eq!(checked_guest_buffer_len(0), Ok(0));
        assert_eq!(
            checked_guest_buffer_len(MAX_GUEST_BUFFER_LEN),
            Ok(MAX_GUEST_BUFFER_LEN as usize)
        );
        assert_eq!(
            checked_guest_buffer_len(MAX_GUEST_BUFFER_LEN + 1),
            Err(-E2BIG)
        );
    }

    #[test]
    fn core_guest_buffer_sum_checks_overflow_and_cap() {
        assert_eq!(checked_guest_buffer_sum(&[4, 8, 16]), Ok(28));
        assert_eq!(
            checked_guest_buffer_sum(&[MAX_GUEST_BUFFER_LEN - 4, 4]),
            Ok(MAX_GUEST_BUFFER_LEN as usize)
        );
        assert_eq!(
            checked_guest_buffer_sum(&[MAX_GUEST_BUFFER_LEN, 1]),
            Err(-E2BIG)
        );
        assert_eq!(checked_guest_buffer_sum(&[u32::MAX, 1]), Err(-E2BIG));
    }

    struct MockState {
        pid: u32,
    }
    impl HasCallerPid for MockState {
        fn caller_pid(&self) -> u32 {
            self.pid
        }
    }

    /// Mocks the *fixed* engine `dispatch_kernel`: when `rc > 0` it
    /// returns the full `response_cap` scratch window (out-params can sit
    /// past `rc`), padded/truncated to exactly `response_cap` bytes.
    struct MockCtx {
        state: MockState,
        rc: i64,
        scratch: Vec<u8>,
        writes: Vec<(u32, Vec<u8>)>,
    }
    impl HostCallCtx<MockState> for MockCtx {
        fn read_user_memory(&mut self, _addr: u32, _buf: &mut [u8]) -> Result<(), EngineError> {
            Ok(())
        }
        fn write_user_memory(&mut self, addr: u32, bytes: &[u8]) -> Result<(), EngineError> {
            self.writes.push((addr, bytes.to_vec()));
            Ok(())
        }
        fn user_state(&self) -> &MockState {
            &self.state
        }
        fn user_state_mut(&mut self) -> &mut MockState {
            &mut self.state
        }
        fn dispatch_kernel(
            &mut self,
            _method_id: u32,
            _caller_pid: u32,
            _req: &[u8],
            response_cap: u32,
        ) -> KernelDispatchOutcome {
            if self.rc <= 0 || response_cap == 0 {
                return KernelDispatchOutcome {
                    rc: self.rc,
                    response: Vec::new(),
                };
            }
            let mut response = self.scratch.clone();
            response.resize(response_cap as usize, 0);
            KernelDispatchOutcome {
                rc: self.rc,
                response,
            }
        }
    }

    // recvfrom/recvmsg shape: rc = data-byte count, but out-params
    // (source address / SCM_RIGHTS) live at offsets >= rc. The full
    // scratch window must reach the caller's response buffer so the
    // linker func can parse them.
    #[test]
    fn trampoline_with_response_surfaces_out_params_past_rc() {
        let mut scratch = vec![0u8; 64];
        scratch[..4].copy_from_slice(b"ping"); // data, rc = 4
        scratch[16..20].copy_from_slice(&12u32.to_le_bytes()); // path_len at offset 16
        scratch[24..36].copy_from_slice(b"/tmp/tx.sock"); // path bytes
        let mut ctx = MockCtx {
            state: MockState { pid: 1 },
            rc: 4,
            scratch,
            writes: Vec::new(),
        };
        let mut response = vec![0u8; 64];
        let rc = trampoline_request_with_response(&mut ctx, 0xABCD, &[], &mut response);
        assert_eq!(rc, 4);
        assert_eq!(&response[..4], b"ping");
        assert_eq!(u32::from_le_bytes(response[16..20].try_into().unwrap()), 12);
        assert_eq!(&response[24..36], b"/tmp/tx.sock");
    }

    // The wholesale-copy helpers must NOT leak the stale scratch tail
    // past `rc` now that dispatch_kernel returns the full window.
    #[test]
    fn forward_with_user_response_clamps_to_rc_and_does_not_leak() {
        let mut scratch = vec![0xAAu8; 64];
        scratch[..4].copy_from_slice(b"DATA");
        let mut ctx = MockCtx {
            state: MockState { pid: 1 },
            rc: 4,
            scratch,
            writes: Vec::new(),
        };
        let rc = forward_request_with_user_response(&mut ctx, 0xABCD, &[], 100, 64);
        assert_eq!(rc, 4);
        assert_eq!(ctx.writes.len(), 1);
        assert_eq!(ctx.writes[0].0, 100);
        assert_eq!(ctx.writes[0].1, b"DATA"); // exactly rc bytes, no 0xAA leak
    }

    #[test]
    fn forward_response_to_user_clamps_to_rc_and_does_not_leak() {
        let mut scratch = vec![0xAAu8; 64];
        scratch[..3].copy_from_slice(b"abc");
        let mut ctx = MockCtx {
            state: MockState { pid: 1 },
            rc: 3,
            scratch,
            writes: Vec::new(),
        };
        let rc = forward_response_to_user(&mut ctx, 0xABCD, 200, 64);
        assert_eq!(rc, 3);
        assert_eq!(ctx.writes.len(), 1);
        assert_eq!(ctx.writes[0], (200, b"abc".to_vec())); // no stale tail
    }
}
