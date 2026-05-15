# Rust Thread/Process Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move pthread lifecycle authority from the TypeScript/Deno worker
backend into the Rust kernel while preserving the existing guest-visible pthread
behavior needed for TS-kernel parity.

**Architecture:** Rust owns thread ids, join/detach/exit state, caller identity
validation, and scheduler-visible blocked/runnable transitions. Host adapters
only execute Web Workers / Worker Threads / Wasmtime host tasks and report
authenticated completion events back to Rust through a narrow kernel-host
interface. Fork and process memory cloning stay out of this slice; the design
keeps the process/thread model compatible with adding fork after thread
lifecycle semantics are kernel-owned.

**Tech Stack:** Rust workspace crates (`packages/kernel-wasm`,
`packages/runtime-wasmtime`, `abi/rust/yurt-libc`), Deno TypeScript host
adapters (`packages/kernel-host-interface-*`,
`packages/kernel/src/process/threads`), TOML ABI manifests
(`abi/contract/*.toml`), wasm32-wasip1 guest fixtures, `cargo test`,
`deno test`, and guest-compat smoke tests.

---

## Current Baseline

The design spec is
`docs/superpowers/specs/2026-05-15-rust-thread-process-parity-design.md`.

Existing Rust kernel pieces:

- `packages/kernel-wasm/src/kernel.rs` has `ThreadRecord`, `ThreadState`,
  `spawn_thread`, `detach_thread`, `exit_thread`, `block_thread`, and
  `unblock_thread`, but not pthread join semantics.
- `packages/kernel-wasm/src/lib.rs` exports host-control functions including
  `kernel_spawn_thread`, `kernel_detach_thread`, and
  `kernel_record_thread_exit`.
- `packages/kernel-wasm/src/dispatch/mod.rs` dispatches with only `caller_pid`;
  thread syscalls need an authenticated `caller_tid`.
- `packages/runtime-wasmtime/src/kernel_host_interface.rs` calls
  `kernel_dispatch(method_id, caller_pid, ...)` and typed control exports.
- `abi/rust/yurt-libc/src/pthread.rs` currently imports
  `host_thread_join(tid) -> c_int`, which loses high-bit pthread return values.
- `packages/kernel/src/process/threads/worker-sab.ts` currently owns thread id
  allocation and pthread lifecycle for the TS kernel path.

## Target File Responsibilities

- `abi/contract/yurt_abi_methods.toml`: assign stable `sys_thread_*` method ids
  and document binary request/response layouts.
- `abi/contract/kernel_host_abi.toml`: define Rust-kernel-to-host thread
  execution calls: spawn, release, cancel.
- `abi/contract/yurt_abi.toml`: change the guest pthread compatibility import
  for join to structured status plus retval-out.
- `packages/kernel-wasm/src/dispatch/mod.rs`: introduce authenticated dispatch
  context while preserving the existing exported `kernel_dispatch` compatibility
  wrapper.
- `packages/kernel-wasm/src/dispatch/thread.rs`: implement syscall parsing and
  response encoding for `sys_thread_spawn`, `sys_thread_self`,
  `sys_thread_join`, `sys_thread_detach`, `sys_thread_exit`, and
  `sys_thread_yield`.
- `packages/kernel-wasm/src/kernel.rs`: own thread ids, lifecycle states, join
  wait records, detach/reap ordering, and host handle release requirements.
- `packages/kernel-wasm/src/kh.rs`: expose `kh_thread_spawn`,
  `kh_thread_release`, and `kh_thread_cancel` wrappers with native test stubs.
- `packages/kernel-wasm/src/lib.rs`: add authenticated caller-tid dispatch
  export and authenticated thread completion export; keep old exports as
  compatibility wrappers where safe.
- `packages/runtime-wasmtime/src/kernel_host_interface.rs`: pass caller tid
  through dispatch, serve thread host calls, and drive join suspend/resume
  without spinning in `kernel_dispatch`.
- `packages/kernel-host-interface-js/mod.ts`: expose new Rust-kernel thread
  control helpers and completion validation to Deno/JS adapters.
- `packages/kernel-host-interface-deno/wasm-kernel-imports.ts`: route guest
  pthread imports to Rust-backed `sys_thread_*` methods.
- `packages/kernel/src/process/threads/worker-sab.ts`: keep worker execution
  mechanics, but remove lifecycle authority for Rust-backed adapters.
- `packages/kernel/src/process/threads/worker-host-proxy.ts`: pass authenticated
  worker session/tid completion events instead of locally deciding pthread
  lifecycle.
- `packages/kernel/src/host-imports/kernel-imports.ts`: keep old TS-kernel
  imports intact; select Rust-backed imports when the runtime is using
  kernel.wasm.
- `abi/rust/yurt-libc/src/pthread.rs`: use structured join status plus `u32`
  retval bits.
- `abi/src/yurt_runtime.h`: update C import declarations to match the structured
  join import.

## Task 1: Add Authenticated Dispatch Context and Thread Method Ids

**Files:**

- Modify: `abi/contract/yurt_abi_methods.toml`
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Modify: `packages/kernel-wasm/src/lib.rs`
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`
- Test: `packages/runtime-wasmtime/tests/fixture_parity.rs`

- [ ] **Step 1: Write failing method-manifest tests**

Add assertions in `packages/runtime-wasmtime/tests/fixture_parity.rs` that the
manifest contains these exact ids:

```rust
assert_method(&methods, "sys_thread_spawn", 0x1_004D);
assert_method(&methods, "sys_thread_self", 0x1_004E);
assert_method(&methods, "sys_thread_join", 0x1_004F);
assert_method(&methods, "sys_thread_detach", 0x1_0050);
assert_method(&methods, "sys_thread_exit", 0x1_0051);
assert_method(&methods, "sys_thread_yield", 0x1_0052);
```

Run: `cargo test -p runtime-wasmtime --test fixture_parity thread`

Expected: fail because the manifest does not yet define those methods.

- [ ] **Step 2: Add method ids**

Append these sections after `method.sys_socket_option` in
`abi/contract/yurt_abi_methods.toml`:

```toml
[method.sys_thread_spawn]
id = 0x1_004D
kind = "syscall"
doc = "Spawn a Rust-kernel-owned pthread. Request bytes: u32 fn_ptr LE + u32 arg LE. Returns tid in 1..=i32::MAX or negated errno."

[method.sys_thread_self]
id = 0x1_004E
kind = "syscall"
doc = "Return the authenticated caller's guest-visible pthread id. Main thread returns 0; workers return Rust-allocated tids >= 2."

[method.sys_thread_join]
id = 0x1_004F
kind = "syscall"
doc = "Join a Rust-kernel-owned pthread. Request bytes: u32 tid LE. Response bytes: u32 retval LE. Returns 0, -EAGAIN when the adapter must park the caller, or negated errno."

[method.sys_thread_detach]
id = 0x1_0050
kind = "syscall"
doc = "Detach a Rust-kernel-owned pthread. Request bytes: u32 tid LE. Returns 0 or negated errno."

[method.sys_thread_exit]
id = 0x1_0051
kind = "syscall"
doc = "Record exit for the authenticated caller thread. Request bytes: u32 retval LE. Does not return to the guest on the successful adapter path."

[method.sys_thread_yield]
id = 0x1_0052
kind = "syscall"
doc = "Yield the authenticated caller thread. No request bytes. Returns 0 or negated errno."
```

- [ ] **Step 3: Introduce dispatch context**

In `packages/kernel-wasm/src/dispatch/mod.rs`, add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DispatchContext {
    pub caller_pid: u32,
    pub caller_tid: u32,
}

impl DispatchContext {
    pub const fn main_thread(caller_pid: u32) -> Self {
        Self {
            caller_pid,
            caller_tid: crate::kernel::MAIN_THREAD_TID,
        }
    }
}
```

Rename the current dispatch body to:

```rust
pub fn dispatch_with_context(
    method_id: u32,
    ctx: DispatchContext,
    request: &[u8],
    response: &mut [u8],
) -> i64 {
    let caller_pid = ctx.caller_pid;
    // existing match body, replacing the old function body
}
```

Keep the compatibility wrapper:

```rust
pub fn dispatch(method_id: u32, caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    dispatch_with_context(
        method_id,
        DispatchContext::main_thread(caller_pid),
        request,
        response,
    )
}
```

- [ ] **Step 4: Add authenticated export**

In `packages/kernel-wasm/src/lib.rs`, keep `kernel_dispatch` unchanged and add:

```rust
#[no_mangle]
pub unsafe extern "C" fn kernel_dispatch_thread(
    method_id: u32,
    caller_pid: u32,
    caller_tid: u32,
    in_ptr: *const u8,
    in_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    if let Err(rc) = validate_scratch_range(in_ptr as usize, in_len) {
        return rc;
    }
    if let Err(rc) = validate_scratch_range(out_ptr as usize, out_cap) {
        return rc;
    }
    match ranges_overlap(in_ptr as usize, in_len, out_ptr as usize, out_cap) {
        Ok(false) => {}
        Ok(true) => return -(abi::EINVAL as i64),
        Err(rc) => return rc,
    }
    let request = match raw_input(in_ptr, in_len) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    let response = match raw_output(out_ptr, out_cap) {
        Ok(slice) => slice,
        Err(rc) => return rc,
    };
    dispatch::dispatch_with_context(
        method_id,
        dispatch::DispatchContext {
            caller_pid,
            caller_tid,
        },
        request,
        response,
    )
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
cargo test -p kernel-wasm dispatch::tests::unknown_method_returns_enosys
cargo test -p runtime-wasmtime --test fixture_parity thread
```

Expected: both pass.

Commit:

```bash
git add abi/contract/yurt_abi_methods.toml packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/lib.rs packages/runtime-wasmtime/tests/fixture_parity.rs
git commit -m "feat: add thread syscall dispatch context"
```

## Task 2: Build Rust Kernel Thread State Machine

**Files:**

- Modify: `packages/kernel-wasm/src/kernel.rs`
- Test: `packages/kernel-wasm/src/kernel.rs`

- [ ] **Step 1: Write failing unit tests for lifecycle rules**

Add tests under the existing `#[cfg(test)] mod tests` in
`packages/kernel-wasm/src/kernel.rs`:

```rust
#[test]
fn thread_ids_stop_at_i32_max() {
    let mut kernel = Kernel::new();
    kernel.create_process_for_test(7);
    kernel.set_next_thread_id_for_test(7, i32::MAX as u32);

    let tid = kernel.reserve_thread_id(7).expect("i32::MAX tid");
    assert_eq!(tid, i32::MAX as u32);
    assert_eq!(kernel.reserve_thread_id(7), Err(abi::EAGAIN));
}

#[test]
fn join_running_thread_blocks_one_waiter() {
    let mut kernel = Kernel::new();
    kernel.create_process_for_test(7);
    let target = kernel.insert_thread_for_test(7, 2, 44);

    assert_eq!(kernel.begin_thread_join(7, 1, target, &mut [0; 4]), Err(abi::EAGAIN));
    assert_eq!(kernel.begin_thread_join(7, 3, target, &mut [0; 4]), Err(abi::EBUSY));

    let waiter = kernel.thread_record(7, 1).expect("waiter");
    assert_eq!(waiter.state, ThreadState::Blocked);
    assert_eq!(waiter.wait_reason, Some(WaitReason::ThreadJoin { target_tid: target }));
}

#[test]
fn exited_join_writes_u32_retval_and_releases_handle() {
    let mut kernel = Kernel::new();
    kernel.create_process_for_test(7);
    let target = kernel.insert_thread_for_test(7, 2, 44);
    kernel.exit_thread_authenticated(7, target, 0x8000_0001).unwrap();

    let mut out = [0; 4];
    assert_eq!(kernel.begin_thread_join(7, 1, target, &mut out), Ok(JoinResult::Completed));
    assert_eq!(u32::from_le_bytes(out), 0x8000_0001);
    assert_eq!(kernel.thread_record(7, target), None);
    assert_eq!(kernel.take_release_events_for_test(), vec![44]);
}

#[test]
fn detach_rejects_target_with_pending_join() {
    let mut kernel = Kernel::new();
    kernel.create_process_for_test(7);
    let target = kernel.insert_thread_for_test(7, 2, 44);

    assert_eq!(kernel.begin_thread_join(7, 1, target, &mut [0; 4]), Err(abi::EAGAIN));
    assert_eq!(kernel.detach_thread(7, target), Err(abi::EINVAL));
}
```

These tests rely on helper methods added in this task. Keep helpers under
`#[cfg(test)]`.

- [ ] **Step 2: Add thread constants and state types**

In `packages/kernel-wasm/src/kernel.rs`, add:

```rust
pub const MAIN_THREAD_TID: u32 = 1;
pub const GUEST_MAIN_PTHREAD_ID: u32 = 0;
pub const FIRST_WORKER_TID: u32 = 2;
pub const MAX_GUEST_THREAD_ID: u32 = i32::MAX as u32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JoinResult {
    Completed,
    Suspended,
}
```

Extend `WaitReason` with:

```rust
ThreadJoin { target_tid: u32 },
```

Extend `ThreadRecord` with:

```rust
pub waiter_tid: Option<u32>,
pub exit_value: Option<u32>,
```

Store host cleanup events in kernel state as an internal queue:

```rust
pending_thread_releases: Vec<i32>,
```

- [ ] **Step 3: Implement id reservation and binding**

Add methods:

```rust
pub fn reserve_thread_id(&mut self, pid: u32) -> Result<u32, i32> {
    let process = self.process_mut(pid).ok_or(abi::ESRCH)?;
    let tid = process.next_tid;
    if tid > MAX_GUEST_THREAD_ID {
        return Err(abi::EAGAIN);
    }
    process.next_tid = tid.checked_add(1).unwrap_or(MAX_GUEST_THREAD_ID + 1);
    Ok(tid)
}

pub fn bind_thread_handle(&mut self, pid: u32, tid: u32, host_thread_handle: i32) -> Result<(), i32> {
    let process = self.process_mut(pid).ok_or(abi::ESRCH)?;
    if process.threads.contains_key(&tid) {
        return Err(abi::EEXIST);
    }
    process.threads.insert(tid, ThreadRecord::running(tid, host_thread_handle));
    Ok(())
}

pub fn rollback_reserved_thread(&mut self, pid: u32, tid: u32) -> Result<(), i32> {
    let process = self.process_mut(pid).ok_or(abi::ESRCH)?;
    if process.next_tid == tid.saturating_add(1) {
        process.next_tid = tid;
    }
    Ok(())
}
```

Use the existing `Process` thread map and `next_tid` field names when adding
these methods; this branch already stores process thread records in the
kernel-owned process table.

- [ ] **Step 4: Implement join/detach/exit rules**

Add methods with these signatures:

```rust
pub fn begin_thread_join(
    &mut self,
    pid: u32,
    waiter_tid: u32,
    target_tid: u32,
    retval_out: &mut [u8],
) -> Result<JoinResult, i32>;

pub fn exit_thread_authenticated(
    &mut self,
    pid: u32,
    tid: u32,
    retval: u32,
) -> Result<Option<u32>, i32>;
```

Required behavior:

- self-join returns `Err(abi::EDEADLK)`.
- unknown target returns `Err(abi::ESRCH)`.
- detached target returns `Err(abi::EINVAL)`.
- target with an existing `waiter_tid` returns `Err(abi::EBUSY)`.
- running target records one waiter, marks waiter `Blocked`, sets
  `WaitReason::ThreadJoin { target_tid }`, and returns `Err(abi::EAGAIN)`.
- exited target writes `retval.to_le_bytes()` to `retval_out`, queues host
  handle release before removing the target, and returns
  `Ok(JoinResult::Completed)`.
- detach of running target marks detached.
- detach of exited target queues host handle release before removing the target.
- detach while `waiter_tid.is_some()` returns `Err(abi::EINVAL)`.
- authenticated exit records `u32` bits exactly, wakes the waiter if present,
  and leaves reaping to the resumed joiner.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cargo test -p kernel-wasm thread_ids_stop_at_i32_max
cargo test -p kernel-wasm join_running_thread_blocks_one_waiter
cargo test -p kernel-wasm exited_join_writes_u32_retval_and_releases_handle
cargo test -p kernel-wasm detach_rejects_target_with_pending_join
```

Expected: all pass.

Commit:

```bash
git add packages/kernel-wasm/src/kernel.rs
git commit -m "feat: add Rust pthread lifecycle state"
```

## Task 3: Add Kernel-Host Thread Execution ABI

**Files:**

- Modify: `abi/contract/kernel_host_abi.toml`
- Modify: `packages/kernel-wasm/src/kh.rs`
- Test: `packages/kernel-wasm/src/kh.rs`

- [ ] **Step 1: Write failing kh tests**

Add native test stubs in `packages/kernel-wasm/src/kh.rs` tests:

```rust
#[test]
fn kh_thread_spawn_returns_host_handle() {
    test_support::set_next_thread_spawn_result(77);
    assert_eq!(kh_thread_spawn(9, 2, 0x1234, 0x5678), 77);
}

#[test]
fn kh_thread_release_records_handle_before_reap() {
    assert_eq!(kh_thread_release(77), 0);
    assert_eq!(test_support::take_thread_release_calls(), vec![77]);
}
```

Run: `cargo test -p kernel-wasm kh_thread`

Expected: fail because wrappers do not exist.

- [ ] **Step 2: Define ABI imports**

Append to `abi/contract/kernel_host_abi.toml`:

```toml
# ── Thread execution ─────────────────────────────────────────────────────────

[import.kh_thread_spawn]
doc = "Start executing a Rust-kernel-owned pthread. Returns a positive opaque host_thread_handle or negated errno. The Rust kernel already reserved tid and owns lifecycle state."
return = "scalar"
args = [
  { name = "pid", type = "u32" },
  { name = "tid", type = "u32" },
  { name = "fn_ptr", type = "u32" },
  { name = "arg", type = "u32" },
]

[import.kh_thread_release]
doc = "Release host adapter bookkeeping for an exited or detached pthread handle. Rust calls this before removing the final ThreadRecord."
return = "scalar"
args = [
  { name = "host_thread_handle", type = "i32" },
]

[import.kh_thread_cancel]
doc = "Cancel a host pthread execution handle when Rust must roll back a started worker. Returns 0 or negated errno."
return = "scalar"
args = [
  { name = "host_thread_handle", type = "i32" },
]
```

- [ ] **Step 3: Add Rust wrappers**

In `packages/kernel-wasm/src/kh.rs`, add wasm imports under the wasm target and
test stubs under non-wasm:

```rust
#[cfg(target_arch = "wasm32")]
extern "C" {
    #[link_name = "kh_thread_spawn"]
    fn kh_thread_spawn_import(pid: u32, tid: u32, fn_ptr: u32, arg: u32) -> i32;
    #[link_name = "kh_thread_release"]
    fn kh_thread_release_import(host_thread_handle: i32) -> i32;
    #[link_name = "kh_thread_cancel"]
    fn kh_thread_cancel_import(host_thread_handle: i32) -> i32;
}

pub fn kh_thread_spawn(pid: u32, tid: u32, fn_ptr: u32, arg: u32) -> i32 {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        kh_thread_spawn_import(pid, tid, fn_ptr, arg)
    }
    #[cfg(not(target_arch = "wasm32"))]
    test_support::take_next_thread_spawn_result(pid, tid, fn_ptr, arg)
}

pub fn kh_thread_release(host_thread_handle: i32) -> i32 {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        kh_thread_release_import(host_thread_handle)
    }
    #[cfg(not(target_arch = "wasm32"))]
    test_support::record_thread_release(host_thread_handle)
}

pub fn kh_thread_cancel(host_thread_handle: i32) -> i32 {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        kh_thread_cancel_import(host_thread_handle)
    }
    #[cfg(not(target_arch = "wasm32"))]
    test_support::record_thread_cancel(host_thread_handle)
}
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
cargo test -p kernel-wasm kh_thread
cargo test -p runtime-wasmtime --test fixture_parity kernel_host_abi
```

Expected: all pass.

Commit:

```bash
git add abi/contract/kernel_host_abi.toml packages/kernel-wasm/src/kh.rs
git commit -m "feat: add thread execution host ABI"
```

## Task 4: Implement Rust Thread Syscalls

**Files:**

- Create: `packages/kernel-wasm/src/dispatch/thread.rs`
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Modify: `packages/kernel-wasm/src/dispatch/tests.rs`
- Modify: `packages/kernel-wasm/src/lib.rs`

- [ ] **Step 1: Write failing dispatch tests**

Add tests to `packages/kernel-wasm/src/dispatch/tests.rs`:

```rust
#[test]
fn sys_thread_self_maps_main_to_zero_and_worker_to_tid() {
    assert_eq!(dispatch(METHOD_SYS_THREAD_SELF, 9, &[], &mut []), 0);
    let ctx = DispatchContext { caller_pid: 9, caller_tid: 2 };
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_SELF, ctx, &[], &mut []),
        2
    );
}

#[test]
fn sys_thread_join_preserves_high_bit_retval() {
    let ctx = DispatchContext { caller_pid: 9, caller_tid: 1 };
    let tid = seed_exited_thread_for_test(9, 2, 77, 0x8000_0001);
    let mut out = [0; 4];
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_JOIN, ctx, &tid.to_le_bytes(), &mut out),
        0
    );
    assert_eq!(u32::from_le_bytes(out), 0x8000_0001);
}

#[test]
fn sys_thread_join_running_thread_suspends_without_spinning() {
    let ctx = DispatchContext { caller_pid: 9, caller_tid: 1 };
    let tid = seed_running_thread_for_test(9, 2, 77);
    let mut out = [0; 4];
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_JOIN, ctx, &tid.to_le_bytes(), &mut out),
        -(abi::EAGAIN as i64)
    );
}
```

Run: `cargo test -p kernel-wasm sys_thread`

Expected: fail because constants and syscall module do not exist.

- [ ] **Step 2: Add syscall constants and module wiring**

In `packages/kernel-wasm/src/dispatch/mod.rs`, expose:

```rust
pub const METHOD_SYS_THREAD_SPAWN: u32 = 0x1_004D;
pub const METHOD_SYS_THREAD_SELF: u32 = 0x1_004E;
pub const METHOD_SYS_THREAD_JOIN: u32 = 0x1_004F;
pub const METHOD_SYS_THREAD_DETACH: u32 = 0x1_0050;
pub const METHOD_SYS_THREAD_EXIT: u32 = 0x1_0051;
pub const METHOD_SYS_THREAD_YIELD: u32 = 0x1_0052;

mod thread;
```

Add match arms in `dispatch_with_context`:

```rust
METHOD_SYS_THREAD_SPAWN => thread::sys_thread_spawn(ctx, request),
METHOD_SYS_THREAD_SELF => thread::sys_thread_self(ctx, request),
METHOD_SYS_THREAD_JOIN => thread::sys_thread_join(ctx, request, response),
METHOD_SYS_THREAD_DETACH => thread::sys_thread_detach(ctx, request),
METHOD_SYS_THREAD_EXIT => thread::sys_thread_exit(ctx, request),
METHOD_SYS_THREAD_YIELD => thread::sys_thread_yield(ctx, request),
```

- [ ] **Step 3: Create `dispatch/thread.rs`**

Implement these functions:

```rust
use super::DispatchContext;
use crate::{abi, kernel, kh};

pub fn sys_thread_self(ctx: DispatchContext, request: &[u8]) -> i64 {
    if !request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if ctx.caller_tid == kernel::MAIN_THREAD_TID {
        kernel::GUEST_MAIN_PTHREAD_ID as i64
    } else {
        ctx.caller_tid as i64
    }
}

pub fn sys_thread_spawn(ctx: DispatchContext, request: &[u8]) -> i64 {
    if request.len() != 8 {
        return -(abi::EINVAL as i64);
    }
    let fn_ptr = u32::from_le_bytes(request[0..4].try_into().unwrap());
    let arg = u32::from_le_bytes(request[4..8].try_into().unwrap());
    let mut guard = kernel::state();
    let tid = match guard.reserve_thread_id(ctx.caller_pid) {
        Ok(tid) => tid,
        Err(errno) => return -(errno as i64),
    };
    drop(guard);

    let host_handle = kh::kh_thread_spawn(ctx.caller_pid, tid, fn_ptr, arg);
    if host_handle < 0 {
        let mut guard = kernel::state();
        let _ = guard.rollback_reserved_thread(ctx.caller_pid, tid);
        return host_handle as i64;
    }

    let mut guard = kernel::state();
    match guard.bind_thread_handle(ctx.caller_pid, tid, host_handle) {
        Ok(()) => tid as i64,
        Err(errno) => {
            drop(guard);
            let _ = kh::kh_thread_cancel(host_handle);
            -(errno as i64)
        }
    }
}

pub fn sys_thread_join(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() != 4 || response.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let target_tid = u32::from_le_bytes(request.try_into().unwrap());
    let mut guard = kernel::state();
    match guard.begin_thread_join(ctx.caller_pid, ctx.caller_tid, target_tid, response) {
        Ok(kernel::JoinResult::Completed) => 0,
        Ok(kernel::JoinResult::Suspended) => -(abi::EAGAIN as i64),
        Err(errno) => -(errno as i64),
    }
}

pub fn sys_thread_detach(ctx: DispatchContext, request: &[u8]) -> i64 {
    if request.len() != 4 {
        return -(abi::EINVAL as i64);
    }
    let target_tid = u32::from_le_bytes(request.try_into().unwrap());
    let mut guard = kernel::state();
    guard.detach_thread(ctx.caller_pid, target_tid).map_or_else(|errno| -(errno as i64), |_| 0)
}

pub fn sys_thread_exit(ctx: DispatchContext, request: &[u8]) -> i64 {
    if request.len() != 4 {
        return -(abi::EINVAL as i64);
    }
    let retval = u32::from_le_bytes(request.try_into().unwrap());
    let mut guard = kernel::state();
    guard
        .exit_thread_authenticated(ctx.caller_pid, ctx.caller_tid, retval)
        .map_or_else(|errno| -(errno as i64), |_| 0)
}

pub fn sys_thread_yield(_ctx: DispatchContext, request: &[u8]) -> i64 {
    if request.is_empty() {
        0
    } else {
        -(abi::EINVAL as i64)
    }
}
```

If the implementation uses the existing `with_kernel(|k| ...)` accessor instead
of a guard-returning `kernel::state()`, keep the same lock discipline and move
host calls outside the closure so `kh_thread_spawn`, `kh_thread_cancel`, and
`kh_thread_release` never run while the kernel mutex is held.

- [ ] **Step 4: Release host handles after state transitions**

Where `kernel.rs` queues release/cancel events, call
`kh::kh_thread_release(handle)` after dropping the kernel state lock. Do this
from the dispatch functions after `begin_thread_join` and `detach_thread` return
a list of handles to release, using:

```rust
for handle in handles_to_release {
    let _ = kh::kh_thread_release(handle);
}
```

The release call must happen before the final record is considered gone to the
adapter. If the current state API cannot return release handles without holding
the lock, change it to return `ThreadMutation { status, release_handles }`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cargo test -p kernel-wasm sys_thread
cargo test -p kernel-wasm dispatch::tests::lifecycle_host_control_is_not_available_through_generic_dispatch
```

Expected: all pass; host-control legacy method ids still return `-ENOSYS`
through generic dispatch.

Commit:

```bash
git add packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/thread.rs packages/kernel-wasm/src/dispatch/tests.rs packages/kernel-wasm/src/lib.rs packages/kernel-wasm/src/kernel.rs
git commit -m "feat: implement Rust thread syscalls"
```

## Task 5: Authenticate Worker Completion Exports

**Files:**

- Modify: `packages/kernel-wasm/src/lib.rs`
- Modify: `packages/kernel-wasm/src/kernel.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Test: `packages/kernel-wasm/src/lib.rs`
- Test: `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`

- [ ] **Step 1: Write failing authentication tests**

Add tests proving a completion event must match the live
`(pid, tid, host_thread_handle)`:

```rust
#[test]
fn record_thread_exit_rejects_wrong_host_handle() {
    kernel_spawn_thread_for_test(9, 2, 44);
    let rc = kernel_record_thread_exit_authenticated(9, 2, 45, 0x1234);
    assert_eq!(rc, -(abi::EPERM as i64));
}

#[test]
fn record_thread_exit_accepts_matching_host_handle() {
    kernel_spawn_thread_for_test(9, 2, 44);
    let rc = kernel_record_thread_exit_authenticated(9, 2, 44, 0x8000_0001);
    assert_eq!(rc, 0);
}
```

Run: `cargo test -p kernel-wasm record_thread_exit_auth`

Expected: fail because the authenticated export does not exist.

- [ ] **Step 2: Add authenticated export**

In `packages/kernel-wasm/src/lib.rs`, add:

```rust
#[no_mangle]
pub extern "C" fn kernel_record_thread_exit_authenticated(
    pid: u32,
    tid: u32,
    host_thread_handle: i32,
    exit_value: u32,
) -> i64 {
    let mut guard = kernel::state();
    match guard.record_thread_exit_authenticated(pid, tid, host_thread_handle, exit_value) {
        Ok(()) => 0,
        Err(errno) => -(errno as i64),
    }
}
```

Keep the old `kernel_record_thread_exit(pid, tid, exit_value: i32)` only as a
compatibility path for existing tests and TS-kernel scaffolding; have it
reinterpret `exit_value as u32`.

- [ ] **Step 3: Add kernel validation**

In `packages/kernel-wasm/src/kernel.rs`, implement:

```rust
pub fn record_thread_exit_authenticated(
    &mut self,
    pid: u32,
    tid: u32,
    host_thread_handle: i32,
    exit_value: u32,
) -> Result<(), i32> {
    let thread = self.thread_record_mut(pid, tid).ok_or(abi::ESRCH)?;
    if thread.host_thread_handle != host_thread_handle {
        return Err(abi::EPERM);
    }
    self.exit_thread_authenticated(pid, tid, exit_value)?;
    Ok(())
}
```

- [ ] **Step 4: Update Wasmtime typed export**

In `packages/runtime-wasmtime/src/kernel_host_interface.rs`, add a typed func
lookup:

```rust
let record_thread_exit_authenticated = instance
    .get_typed_func::<(u32, u32, i32, u32), i64>(
        &mut store,
        "kernel_record_thread_exit_authenticated",
    )?;
```

Update worker completion paths to call the authenticated export with the host
handle that was returned by `kh_thread_spawn`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cargo test -p kernel-wasm record_thread_exit
cargo test -p runtime-wasmtime --test kernel_wasm_trampoline record_thread_exit
```

Expected: all pass.

Commit:

```bash
git add packages/kernel-wasm/src/lib.rs packages/kernel-wasm/src/kernel.rs packages/runtime-wasmtime/src/kernel_host_interface.rs packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs
git commit -m "feat: authenticate Rust thread completion"
```

## Task 6: Convert yurt-libc pthread Join to Structured Retval

**Files:**

- Modify: `abi/contract/yurt_abi.toml`
- Modify: `abi/src/yurt_runtime.h`
- Modify: `abi/rust/yurt-libc/src/pthread.rs`
- Test: `abi/rust/yurt-libc/src/pthread.rs`

- [ ] **Step 1: Write failing high-bit join test**

Add a Rust unit test in `abi/rust/yurt-libc/src/pthread.rs` using a small
wrapper function that converts structured join output into `pthread_join`
behavior:

```rust
#[test]
fn pthread_join_preserves_high_bit_return_value() {
    let mut out: *mut c_void = core::ptr::null_mut();
    let raw = join_status_to_pthread_result(0, 0x8000_0001, &mut out);
    assert_eq!(raw, 0);
    assert_eq!(out as usize as u32, 0x8000_0001);
}
```

Run: `cargo test -p yurt-libc pthread_join_preserves_high_bit_return_value`

Expected: fail because the helper and structured path do not exist.

- [ ] **Step 2: Update ABI declaration**

In `abi/contract/yurt_abi.toml`, change `host_thread_join` to accept an output
pointer:

```toml
[import.host_thread_join]
doc = "Join a pthread. Returns 0 or negated errno; writes raw u32 pthread retval bits to out_retval_ptr on success."
return = "scalar"
args = [
  { name = "tid", type = "i32" },
  { name = "out_retval_ptr", type = "ptr" },
]
```

In `abi/src/yurt_runtime.h`, change:

```c
__attribute__((import_module("yurt"), import_name("host_thread_join")))
int yurt_host_thread_join(int tid, uint32_t *out_retval);
```

- [ ] **Step 3: Update yurt-libc import and conversion**

In `abi/rust/yurt-libc/src/pthread.rs`, change the extern:

```rust
#[link_name = "host_thread_join"]
fn yurt_host_thread_join(tid: c_int, out_retval: *mut u32) -> c_int;
```

Add:

```rust
fn join_status_to_pthread_result(status: c_int, raw_retval: u32, retval: *mut *mut c_void) -> c_int {
    if status < 0 {
        set_errno(-status);
        return status;
    }
    if !retval.is_null() {
        unsafe {
            *retval = raw_retval as usize as *mut c_void;
        }
    }
    0
}
```

Update `pthread_join`:

```rust
let mut raw_retval = 0_u32;
let status = unsafe { yurt_host_thread_join(pthread_to_thread_id(thread), &mut raw_retval) };
join_status_to_pthread_result(status, raw_retval, retval)
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
cargo test -p yurt-libc pthread_join_preserves_high_bit_return_value
make -C abi
```

Expected: tests pass and generated ABI shims compile.

Commit:

```bash
git add abi/contract/yurt_abi.toml abi/src/yurt_runtime.h abi/rust/yurt-libc/src/pthread.rs
git commit -m "fix: preserve pthread join return bits"
```

## Task 7: Wire Rust-Backed Guest Thread Imports in Deno/JS

**Files:**

- Modify: `packages/kernel-host-interface-js/mod.ts`
- Modify: `packages/kernel-host-interface-deno/wasm-kernel-imports.ts`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Test: `packages/kernel-host-interface-deno/wasm-kernel-imports_test.ts`
- Test: `packages/kernel-host-interface-js/mod_test.ts`

- [ ] **Step 1: Write failing adapter tests**

Add Deno tests that install a fake Rust kernel dispatcher and call the guest
imports:

```ts
Deno.test("rust-backed host_thread_self maps main to guest zero", () => {
  const calls: Array<{ method: number; pid: number; tid: number }> = [];
  const imports = createWasmKernelImports({
    pid: 9,
    currentTid: () => 1,
    dispatchThread(method, pid, tid, request, response) {
      calls.push({ method, pid, tid });
      return 0;
    },
  });

  assertEquals(imports.yurt.host_thread_self(), 0);
  assertEquals(calls[0], { method: 0x1_004E, pid: 9, tid: 1 });
});

Deno.test("rust-backed host_thread_join writes retval through pointer", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports = createWasmKernelImports({
    pid: 9,
    currentTid: () => 1,
    memory,
    dispatchThread(_method, _pid, _tid, _request, response) {
      new DataView(response.buffer, response.byteOffset, response.byteLength)
        .setUint32(0, 0x8000_0001, true);
      return 0;
    },
  });

  const rc = imports.yurt.host_thread_join(2, 64);
  assertEquals(rc, 0);
  assertEquals(new DataView(memory.buffer).getUint32(64, true), 0x8000_0001);
});
```

Run:
`/Users/sunny/.deno/bin/deno test --no-check packages/kernel-host-interface-deno/wasm-kernel-imports_test.ts`

Expected: fail because the imports do not route to `sys_thread_*`.

- [ ] **Step 2: Add method constants and request encoders**

In `packages/kernel-host-interface-js/mod.ts`, add:

```ts
export const METHOD_SYS_THREAD_SPAWN = 0x1_004D;
export const METHOD_SYS_THREAD_SELF = 0x1_004E;
export const METHOD_SYS_THREAD_JOIN = 0x1_004F;
export const METHOD_SYS_THREAD_DETACH = 0x1_0050;
export const METHOD_SYS_THREAD_EXIT = 0x1_0051;
export const METHOD_SYS_THREAD_YIELD = 0x1_0052;
```

Add helpers:

```ts
function u32Request(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) =>
    view.setUint32(index * 4, value >>> 0, true)
  );
  return bytes;
}
```

- [ ] **Step 3: Route Deno guest imports**

In `packages/kernel-host-interface-deno/wasm-kernel-imports.ts`, implement:

```ts
host_thread_spawn: (fnPtr: number, arg: number): number => {
  return dispatchThread(
    METHOD_SYS_THREAD_SPAWN,
    pid,
    currentTid(),
    u32Request(fnPtr, arg),
    new Uint8Array(),
  );
},
host_thread_self: (): number => {
  return dispatchThread(
    METHOD_SYS_THREAD_SELF,
    pid,
    currentTid(),
    new Uint8Array(),
    new Uint8Array(),
  );
},
host_thread_join: (tid: number, outRetvalPtr: number): number => {
  const response = new Uint8Array(4);
  const rc = dispatchThread(
    METHOD_SYS_THREAD_JOIN,
    pid,
    currentTid(),
    u32Request(tid),
    response,
  );
  if (rc === 0) {
    new Uint8Array(memory.buffer, outRetvalPtr, 4).set(response);
  }
  return rc;
},
host_thread_detach: (tid: number): number => {
  return dispatchThread(
    METHOD_SYS_THREAD_DETACH,
    pid,
    currentTid(),
    u32Request(tid),
    new Uint8Array(),
  );
},
host_thread_exit: (retval: number): number => {
  return dispatchThread(
    METHOD_SYS_THREAD_EXIT,
    pid,
    currentTid(),
    u32Request(retval),
    new Uint8Array(),
  );
},
host_thread_yield: (): number => {
  return dispatchThread(
    METHOD_SYS_THREAD_YIELD,
    pid,
    currentTid(),
    new Uint8Array(),
    new Uint8Array(),
  );
},
```

- [ ] **Step 4: Preserve TS-kernel import behavior**

In `packages/kernel/src/host-imports/kernel-imports.ts`, keep the existing
`ThreadsBackend` path for the TypeScript kernel. Only use the Rust-backed import
route when the caller provides `dispatchThread`. This preserves old TS kernel
tests while the Rust path takes over for kernel.wasm.

- [ ] **Step 5: Verify and commit**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check packages/kernel-host-interface-deno/wasm-kernel-imports_test.ts
/Users/sunny/.deno/bin/deno test --no-check packages/kernel-host-interface-js/mod_test.ts
/Users/sunny/.deno/bin/deno check 'packages/**/*.ts'
```

Expected: all pass.

Commit:

```bash
git add packages/kernel-host-interface-js/mod.ts packages/kernel-host-interface-deno/wasm-kernel-imports.ts packages/kernel/src/host-imports/kernel-imports.ts packages/kernel-host-interface-deno/wasm-kernel-imports_test.ts packages/kernel-host-interface-js/mod_test.ts
git commit -m "feat: route pthread imports through Rust kernel"
```

## Task 8: Convert Worker Backend to Execution Adapter for Rust Kernel

**Files:**

- Modify: `packages/kernel/src/process/threads/worker-sab.ts`
- Modify: `packages/kernel/src/process/threads/worker-host-proxy.ts`
- Modify: `packages/kernel-host-interface-js/mod.ts`
- Test: `packages/kernel/src/process/threads/worker-sab_test.ts`

- [ ] **Step 1: Write failing adapter ownership tests**

Add tests:

```ts
Deno.test("Rust worker adapter does not allocate tid locally", async () => {
  const spawned: Array<
    { pid: number; tid: number; fnPtr: number; arg: number }
  > = [];
  const adapter = new RustKernelWorkerThreadAdapter({
    spawnWorker(pid, tid, fnPtr, arg) {
      spawned.push({ pid, tid, fnPtr, arg });
      return 55;
    },
    recordExit() {
      throw new Error("not called during spawn");
    },
  });

  const handle = await adapter.khThreadSpawn(9, 2, 0x1234, 0x5678);
  assertEquals(handle, 55);
  assertEquals(spawned, [{ pid: 9, tid: 2, fnPtr: 0x1234, arg: 0x5678 }]);
});

Deno.test("Rust worker adapter reports completion with session handle", async () => {
  const completions: Array<
    { pid: number; tid: number; handle: number; retval: number }
  > = [];
  const adapter = new RustKernelWorkerThreadAdapter({
    spawnWorker: () => 55,
    recordExit(pid, tid, handle, retval) {
      completions.push({ pid, tid, handle, retval });
      return 0;
    },
  });

  await adapter.khThreadSpawn(9, 2, 0x1234, 0x5678);
  await adapter.recordWorkerExitForTest(55, 0x8000_0001);
  assertEquals(completions, [{
    pid: 9,
    tid: 2,
    handle: 55,
    retval: 0x8000_0001,
  }]);
});
```

Run:
`/Users/sunny/.deno/bin/deno test --no-check packages/kernel/src/process/threads/worker-sab_test.ts`

Expected: fail because the Rust execution adapter does not exist.

- [ ] **Step 2: Add Rust execution adapter**

In `packages/kernel/src/process/threads/worker-sab.ts`, add a Rust-specific
adapter class that keeps worker handles and sessions but does not allocate
pthread ids:

```ts
export class RustKernelWorkerThreadAdapter {
  #nextHostHandle = 1;
  #sessions = new Map<number, { pid: number; tid: number; worker: Worker }>();

  constructor(
    private readonly hooks: {
      spawnWorker(pid: number, tid: number, fnPtr: number, arg: number): Worker;
      recordExit(
        pid: number,
        tid: number,
        hostHandle: number,
        retval: number,
      ): number;
      releaseWorker?(worker: Worker): void;
      cancelWorker?(worker: Worker): void;
    },
  ) {}

  khThreadSpawn(pid: number, tid: number, fnPtr: number, arg: number): number {
    const worker = this.hooks.spawnWorker(pid, tid, fnPtr, arg);
    const hostHandle = this.#nextHostHandle++;
    this.#sessions.set(hostHandle, { pid, tid, worker });
    return hostHandle;
  }

  khThreadRelease(hostHandle: number): number {
    const session = this.#sessions.get(hostHandle);
    if (!session) return -3; // ESRCH
    this.hooks.releaseWorker?.(session.worker);
    this.#sessions.delete(hostHandle);
    return 0;
  }

  khThreadCancel(hostHandle: number): number {
    const session = this.#sessions.get(hostHandle);
    if (!session) return -3; // ESRCH
    this.hooks.cancelWorker?.(session.worker);
    this.#sessions.delete(hostHandle);
    return 0;
  }

  recordWorkerExit(hostHandle: number, retval: number): number {
    const session = this.#sessions.get(hostHandle);
    if (!session) return -3; // ESRCH
    return this.hooks.recordExit(
      session.pid,
      session.tid,
      hostHandle,
      retval >>> 0,
    );
  }
}
```

Use existing errno constants if present in the file instead of raw `-3`.

- [ ] **Step 3: Update worker proxy completion**

In `packages/kernel/src/process/threads/worker-host-proxy.ts`, ensure worker
exit messages carry the opaque host handle/session assigned by the adapter. The
parent side must call `recordWorkerExit(hostHandle, retval)` and never call
`kernel_record_thread_exit(pid, tid, retval)` without the handle.

- [ ] **Step 4: Verify and commit**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check packages/kernel/src/process/threads/worker-sab_test.ts
/Users/sunny/.deno/bin/deno lint packages/kernel/src/process/threads/worker-sab.ts packages/kernel/src/process/threads/worker-host-proxy.ts
```

Expected: all pass.

Commit:

```bash
git add packages/kernel/src/process/threads/worker-sab.ts packages/kernel/src/process/threads/worker-host-proxy.ts packages/kernel/src/process/threads/worker-sab_test.ts packages/kernel-host-interface-js/mod.ts
git commit -m "feat: make workers Rust thread execution adapters"
```

## Task 9: Wire Wasmtime Thread Host Interface and Suspend/Resume

**Files:**

- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Modify: `packages/runtime-wasmtime/src/engine.rs`
- Test: `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`
- Test: `packages/runtime-wasmtime/tests/integration.rs`

- [ ] **Step 1: Write failing trampoline tests**

Add tests:

```rust
#[test]
fn dispatch_thread_passes_authenticated_tid() {
    let mut fixture = KernelHostFixture::new();
    let rc = fixture.dispatch_thread(0x1_004E, 9, 2, &[], &mut []);
    assert_eq!(rc, 2);
    assert_eq!(fixture.last_dispatch_context(), Some((9, 2)));
}

#[test]
fn host_thread_join_suspends_and_resumes_after_exit() {
    let mut fixture = KernelHostFixture::new();
    let join = fixture.call_host_thread_join(2);
    assert_eq!(join.status(), JoinCallStatus::Suspended);

    fixture.record_thread_exit_authenticated(9, 2, join.host_handle(), 0x8000_0001);

    let resumed = fixture.resume_join(join);
    assert_eq!(resumed.status(), 0);
    assert_eq!(resumed.retval(), 0x8000_0001);
}
```

Run: `cargo test -p runtime-wasmtime --test kernel_wasm_trampoline thread`

Expected: fail because caller tid and join suspension are not wired.

- [ ] **Step 2: Lookup authenticated dispatch export**

In `packages/runtime-wasmtime/src/kernel_host_interface.rs`, add typed lookup:

```rust
let kernel_dispatch_thread = instance.get_typed_func::<(u32, u32, u32, u32, u32, u32, u32), i64>(
    &mut store,
    "kernel_dispatch_thread",
)?;
```

Keep old `kernel_dispatch` for main-thread-only and non-thread-aware calls. Add
a helper:

```rust
fn dispatch_kernel_thread(
    &mut self,
    method_id: u32,
    caller_pid: u32,
    caller_tid: u32,
    request: &[u8],
    response: &mut [u8],
) -> Result<i64> {
    // allocate request/response buffers in kernel.wasm memory, call kernel_dispatch_thread,
    // copy response back exactly like the existing dispatch helper does
}
```

- [ ] **Step 3: Track current thread identity**

Add a current-thread context to the Wasmtime user process state:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CallerThreadContext {
    pid: u32,
    tid: u32,
}
```

Main user entry uses `{ pid, tid: MAIN_THREAD_TID }`. Worker calls use the
Rust-allocated tid associated with the host handle.

- [ ] **Step 4: Implement join park/resume**

When `sys_thread_join` returns `-EAGAIN`, the host import must not spin. It
must:

1. Store a wait record with caller `(pid, tid)`, target tid, and the guest
   output pointer.
2. Park the guest execution using the existing trap/suspend mechanism used for
   other async host interactions.
3. On authenticated thread exit, ask the kernel scheduler for the resumed
   waiter.
4. Reissue `sys_thread_join` for the resumed caller; the second call writes the
   `u32 retval` response.
5. Write the response to the guest output pointer and return `0` to
   `pthread_join`.

Use an explicit enum:

```rust
enum ThreadJoinHostState {
    Running,
    Suspended {
        caller: CallerThreadContext,
        target_tid: u32,
        out_retval_ptr: u32,
    },
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
cargo test -p runtime-wasmtime --test kernel_wasm_trampoline thread
cargo test -p runtime-wasmtime --test integration thread
```

Expected: all pass.

Commit:

```bash
git add packages/runtime-wasmtime/src/kernel_host_interface.rs packages/runtime-wasmtime/src/engine.rs packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs packages/runtime-wasmtime/tests/integration.rs
git commit -m "feat: wire Wasmtime Rust thread runtime"
```

## Task 10: Add Guest Pthread Conformance Coverage

**Files:**

- Modify: `test-fixtures/abi-conformance/src/main.rs`
- Modify: `test-fixtures/abi-conformance/Cargo.toml`
- Modify: `packages/runtime-wasmtime/tests/integration.rs`
- Test: guest-compat command set

- [ ] **Step 1: Add conformance cases**

Add guest tests that exercise:

```rust
fn pthread_self_main_is_zero();
fn pthread_spawn_join_returns_pointer_bits();
fn pthread_join_rejects_second_joiner();
fn pthread_detach_rejects_pending_join();
fn pthread_join_high_bit_retval_preserved();
fn pthread_spawn_tid_exhaustion_returns_eagain();
```

Use `pthread_create`, `pthread_self`, `pthread_join`, `pthread_detach`, and a
thread function that returns `0x8000_0001usize as *mut c_void`.

- [ ] **Step 2: Add runtime integration assertion**

In `packages/runtime-wasmtime/tests/integration.rs`, run the ABI conformance
fixture under the Rust kernel path and assert the output contains:

```text
pthread_self_main_is_zero: ok
pthread_join_high_bit_retval_preserved: ok
```

- [ ] **Step 3: Verify and commit**

Run:

```bash
cargo build --target wasm32-wasip1 -p abi-conformance
cargo test -p runtime-wasmtime --test integration pthread
```

Expected: all pass.

Commit:

```bash
git add test-fixtures/abi-conformance/src/main.rs test-fixtures/abi-conformance/Cargo.toml packages/runtime-wasmtime/tests/integration.rs
git commit -m "test: cover Rust pthread conformance"
```

## Task 11: Keep DNS Resolve as a Separate Parity Slice

**Files:**

- Modify: `docs/superpowers/plans/2026-05-15-rust-kernel-parity-pr43.md`
- Create: `docs/superpowers/specs/2026-05-15-rust-dns-resolve-parity-design.md`

- [ ] **Step 1: Document the decision**

Add a short DNS section to the existing parity plan:

```markdown
### DNS Resolve

Rust thread lifecycle is the current parity blocker. DNS resolve remains a small
follow-up slice because it is not a clean POSIX syscall and needs an explicit
guest API decision: either `getaddrinfo`-shaped libc behavior, a yurt-specific
resolver syscall, or both. Do not block thread/process parity implementation on
DNS.
```

- [ ] **Step 2: Create DNS spec**

Create `docs/superpowers/specs/2026-05-15-rust-dns-resolve-parity-design.md`:

```markdown
# Rust DNS Resolve Parity Design

## Goal

Port DNS resolution from the TypeScript kernel path to Rust without pretending
it is a POSIX kernel syscall.

## Decision

Expose a Rust-kernel syscall for resolver requests and keep libc `getaddrinfo`
as a compatibility adapter. The kernel owns policy, caching, and request
validation. Host adapters perform actual network resolution through a
`kh_dns_resolve` call because DNS cannot be performed inside the sandbox.

## Out of Scope

Thread lifecycle, fork, and process memory cloning are handled by the
thread/process parity plan.
```

- [ ] **Step 3: Verify and commit**

Run:

```bash
/Users/sunny/.deno/bin/deno fmt --check docs/superpowers/plans/2026-05-15-rust-kernel-parity-pr43.md docs/superpowers/specs/2026-05-15-rust-dns-resolve-parity-design.md
```

Expected: pass.

Commit:

```bash
git add docs/superpowers/plans/2026-05-15-rust-kernel-parity-pr43.md docs/superpowers/specs/2026-05-15-rust-dns-resolve-parity-design.md
git commit -m "docs: split DNS resolve parity follow-up"
```

## Task 12: Full Local and PR Verification

**Files:**

- No source edits unless verification finds a real failure.

- [ ] **Step 1: Run Rust gates**

Run:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --tests
```

Expected: all pass.

- [ ] **Step 2: Run Deno gates**

Run:

```bash
/Users/sunny/.deno/bin/deno fmt --check
/Users/sunny/.deno/bin/deno lint
/Users/sunny/.deno/bin/deno check 'packages/**/*.ts'
/Users/sunny/.deno/bin/deno test --no-check packages/**/*_test.ts
```

Expected: all pass.

- [ ] **Step 3: Run guest compatibility gates**

Run the same commands as `.github/workflows/guest-compat.yml` for ABI
conformance and Rust-kernel smoke tests. The current temporary port-related red
is acceptable only if it is unrelated to the thread changes and is already
tracked on the PR.

- [ ] **Step 4: Push and verify PR checks**

Run:

```bash
git push origin codex/rust-kernel-parity-pr43
gh pr checks 47 --watch
```

Expected:

- Rust workflow green.
- Deno workflow green.
- Guest Compat either green or red only on the previously accepted port blocker,
  with logs linked in the PR comment.

- [ ] **Step 5: Update PR comment**

Post a PR comment:

```markdown
Thread/process parity implementation status:

- Rust owns pthread ids and lifecycle state.
- Guest pthread join preserves raw `u32` return bits.
- Worker/Wasmtime adapters execute threads but no longer own lifecycle
  semantics.
- Caller tid and worker completion reports are authenticated.
- Fork remains explicitly out of scope for the next parity slice.
- DNS resolve is split into its own design because it is not a strict POSIX
  kernel syscall.

Verification:

- `cargo fmt --all -- --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test --tests`
- `deno fmt --check`
- `deno lint`
- `deno check 'packages/**/*.ts'`
- `deno test --no-check packages/**/*_test.ts`
- Guest Compat: <result and link>
```

Run:

```bash
gh pr comment 47 --body-file /tmp/rust-thread-parity-pr-comment.md
```

Expected: comment appears on PR #47.

## Self-Review

- Spec coverage: caller tid authentication is covered by Tasks 1, 5, and 9;
  structured join return is covered by Tasks 4, 6, and 7; detach/reap and
  multiple joiner rules are covered by Tasks 2 and 4; host release ordering is
  covered by Tasks 2, 3, and 4; worker completion authentication is covered by
  Tasks 5 and 8; tid exhaustion is covered by Tasks 2 and 10.
- Fork/process cloning: intentionally not implemented in this plan. The
  Rust-owned process/thread model is prepared for fork by requiring explicit
  caller tid and scheduler-visible blocked state.
- DNS resolve: intentionally split into Task 11 documentation/spec work so
  thread lifecycle remains the current implementation focus.
- No JSON is introduced at the guest/kernel boundary; thread request and
  response layouts are fixed little-endian bytes.
