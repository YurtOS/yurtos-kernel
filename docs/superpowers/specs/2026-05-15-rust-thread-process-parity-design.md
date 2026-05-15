# Rust Thread/Process Parity Design

## Goal

Move pthread thread-group lifecycle authority from the TypeScript kernel and
worker backend into the Rust kernel, while keeping host workers as execution
adapters. This closes the largest remaining gap before the TypeScript kernel can
be retired.

## Scope

In scope:

- Rust-owned process records remain the source of truth for pid, parentage,
  process status, fd table ownership, and thread groups.
- Rust-owned thread records become the source of truth for tid allocation,
  joinability, detach state, exit value, runnable/blocked/exited state, and
  host-worker handle binding.
- `host_thread_spawn`, `host_thread_self`, `host_thread_join`,
  `host_thread_detach`, `host_thread_exit`, and `host_thread_yield` route
  through Rust-owned state.
- Host adapters may create and run Web Workers, Deno Workers, Wasmtime tasks, or
  other execution mechanisms, but they do not own pthread lifecycle semantics.
- Worker host-call proxy plumbing remains an adapter mechanism. It may still use
  postMessage and SharedArrayBuffer internally, but all kernel-facing records
  are fixed binary layouts.
- Mutex and condvar waits may continue to use SAB/Atomics host mechanisms, but
  transitions that affect thread lifecycle must be reflected in Rust records.

Out of scope for this spec:

- `fork` and process memory cloning.
- Full process snapshot restore/migration.
- Replacing Web Workers, Deno Workers, or Wasmtime tasks as execution engines.
- DNS resolution parity.

`fork` should be specified after this work, using the Rust process primitives
that this design keeps authoritative.

## Architecture

The Rust kernel owns the process/thread model. Host adapters perform actions the
sandbox cannot perform itself:

1. Allocate an execution resource for a thread.
2. Start the guest thread entry point in that resource.
3. Block, resume, or tear down that resource when the Rust kernel asks.
4. Report completion or host-side failure back to the Rust kernel.

This mirrors the existing shape for sockets and filesystem access: the kernel
decides what should happen and delegates only the outside-sandbox operation to a
small `kh_*` interface.

## Rust Kernel State

`packages/kernel-wasm/src/kernel.rs` already has `Process.threads`,
`ThreadRecord`, `ThreadState`, `kernel_list_threads`, `kernel_spawn_thread`,
`kernel_detach_thread`, and `kernel_record_thread_exit`. This work promotes
those from host-control helpers to the canonical pthread lifecycle path.

Required state:

- `tid`: kernel-allocated thread id, unique within one process.
- `state`: `Runnable`, `Blocked`, or `Exited`.
- `detached`: whether a join result may be reaped.
- `exit_value`: `None` until exit, then the pthread return value.
- `host_thread_handle`: opaque adapter handle, if the adapter has one.
- `wait_reason`: why the thread is blocked, if blocked.

Required additional behavior:

- Joining a joinable exited thread returns its exit value and reaps the record.
- Joining a running joinable thread blocks the caller until exit.
- Joining the calling thread rejects with the pthread-compatible deadlock error.
- Joining a detached or unknown thread returns the pthread-compatible error.
- Detaching a running thread marks it detached.
- Detaching an exited unjoined thread reaps it.
- Exiting the main thread maps to process exit; exiting a worker thread records
  the thread exit value and wakes joiners.
- Thread self preserves the existing guest ABI: the main thread reports pthread
  id `0`; worker threads report their Rust-allocated tid values (`>= 2`).
  Internally the Rust kernel may keep main as tid `1` for scheduler and
  mutex-owner bookkeeping, but that value is not exposed as main
  `pthread_self()`.
- Tids are never reused during a process lifetime. `next_tid` overflow returns
  `-EAGAIN` from `sys_thread_spawn`; it must not wrap to an earlier tid. Stale
  worker messages are rejected because `(pid, tid, host_thread_handle)` no
  longer matches a live Rust thread record.

## Caller Thread Identity

Thread syscalls need an authenticated caller thread id. `sys_thread_self`,
`sys_thread_exit`, `sys_thread_yield`, and blocking `sys_thread_join` cannot be
implemented from `caller_pid` alone.

The dispatch path must be extended so Rust receives both:

- `caller_pid`: authenticated process id, as today.
- `caller_tid`: authenticated kernel thread id within that process.

The guest must not be allowed to put `caller_tid` in the request body and have
Rust trust it. The value comes from the host adapter context:

- Main-thread calls use the process main thread record (`kernel tid 1`,
  guest-visible pthread id `0`).
- Worker calls use the tid assigned by Rust during `sys_thread_spawn`.
- Worker host-call proxy messages may carry their known worker tid to the
  adapter, but the adapter validates it against the worker handle/session before
  passing it into Rust dispatch.

Implementation can add a `DispatchContext { caller_pid, caller_tid }`, a
`dispatch_with_context(...)` entry point, or an equivalent trampoline-side
context mechanism. The important invariant is that Rust thread lifecycle methods
never infer the calling thread from guest-supplied bytes.

Worker completion uses the same authentication rule. A completion report cannot
be trusted because it contains `(pid, tid)` bytes or message fields. Before the
adapter calls `kernel_record_thread_exit(pid, tid, retval)` or an equivalent
Rust control path, it validates that the reporting worker/session owns the live
`host_thread_handle` currently bound to that `(pid, tid)`. Rust then verifies
the record is still live and that the supplied handle/session matches before
transitioning the thread to `Exited`. Reports for unknown, already reaped, or
mismatched threads return an error and do not mutate state.

## ABI Shape

No JSON is introduced at the guest-to-kernel boundary.

Add `sys_thread_*` methods to `abi/contract/yurt_abi_methods.toml` for the
thread lifecycle surface:

- `sys_thread_spawn`: request `u32 fn_ptr LE + u32 arg LE`; returns tid or
  negated errno.
- `sys_thread_self`: no request; returns the current guest-visible pthread id
  derived from authenticated `caller_tid`.
- `sys_thread_join`: request `u32 tid LE`; response `u32 retval LE`; returns `0`
  on success or negated errno. The return value is not sent through the scalar
  return channel because valid wasm32 pointer-sized thread return values can
  have the high bit set and collide with negated errno.
- `sys_thread_detach`: request `u32 tid LE`; returns `0` or negated errno.
- `sys_thread_exit`: request `i32 retval LE`; does not return to guest on the
  authenticated calling thread. In adapter paths where unwinding is required,
  the adapter may translate the successful syscall into its local unwind
  mechanism.
- `sys_thread_yield`: no request; yields the authenticated calling thread and
  returns `0` or negated errno.

The current host import `host_thread_spawn(fn_ptr, arg)` should become a
compatibility wrapper around `sys_thread_spawn` in the Rust-backed adapters, the
same way `host_socket_set_no_delay` wraps `sys_socket_option`.

`host_thread_join(tid)` remains the guest-facing compatibility import. Its
Rust-backed wrapper calls `sys_thread_join`, reads the `u32 retval` response on
success, and only then casts that value back to `void *` in the libc layer.

## Join Suspend/Resume Protocol

`sys_thread_join` must not spin inside kernel dispatch. When the target thread
is still running:

1. Rust validates the authenticated caller tid and the target tid, rejects
   self-join, and records a `JoinWait { waiter_tid, target_tid }` wait record.
2. Rust marks the caller thread `Blocked` with a join wait reason.
3. Rust returns `-EAGAIN` with a kernel-visible wait record, or an equivalent
   adapter-recognized suspended status, rather than blocking the dispatch call.
4. The adapter parks the caller execution resource using the same suspend
   mechanism used for other host-blocking operations.
5. When worker completion records the target thread exit, Rust stores the
   `u32 retval`, wakes matching join waiters, and marks them runnable.
6. The adapter resumes each woken caller and retries or completes the pending
   join by reading the structured join result.

If the target is already exited when `sys_thread_join` runs, Rust writes the
`u32 retval` response, releases the host handle, reaps the target record, and
returns `0` without parking the caller.

## Kernel-to-Host Interface

Add host imports for unsandboxable thread execution actions to
`abi/contract/kernel_host_abi.toml` and `packages/kernel-wasm/src/kh.rs`.

- `kh_thread_spawn(pid, tid, fn_ptr, arg) -> i32 host_thread_handle | -errno`
  creates the host execution resource and starts or schedules the guest thread.
- `kh_thread_release(host_thread_handle) -> i32` lets the adapter release join
  bookkeeping it owns.
- `kh_thread_cancel(host_thread_handle) -> i32` is used for teardown of detached
  workers or process termination.

The Rust kernel allocates the tid before calling `kh_thread_spawn`. If the host
spawn fails, the kernel removes the pending thread record and returns the host
errno to the guest.

Rust must release adapter bookkeeping before removing any thread record that has
a `host_thread_handle`. That release path is required for:

- successful join reaping;
- detach of an already-exited unjoined thread;
- process teardown of detached or unjoined worker threads.

The ordering is: read the handle from `ThreadRecord`, call
`kh_thread_release(handle)` or `kh_thread_cancel(handle)` as appropriate, then
remove or tombstone the Rust record. The record must not be dropped first,
because that can lose the only handle the adapter needs for cleanup.

The host adapter reports normal completion by calling an authenticated
thread-exit control path. This may wrap the existing
`kernel_record_thread_exit(pid, tid, retval)` export, but the adapter must bind
that call to the worker handle/session that Rust recorded for the thread. A new
control export that accepts `host_thread_handle` explicitly is acceptable if it
makes the authentication invariant simpler to enforce.

## Adapter Responsibilities

TypeScript/Deno worker code remains responsible for:

- Instantiating the same module in a Worker with shared memory.
- Initializing per-thread TLS, stack pointer, and WASI thread pointer.
- Providing worker-local host imports that cannot be directly shared across
  Workers.
- Bridging worker host calls back to the main adapter.
- Reporting worker completion or startup failure back to Rust state.

It must stop being responsible for:

- Allocating guest-visible tids.
- Deciding whether a thread is joinable or detached.
- Owning the final exit value.
- Reaping lifecycle records.

The worker SAB backend can keep its current `SpawnSlot` style temporarily, but
those slots become host-handle bookkeeping only. Rust thread records must be the
authoritative state used by `join`, `detach`, `self`, `exit`, snapshots, and
scheduling.

## Blocking And Synchronization

Mutex and condvar operations are still host-backed because the blocking/wake
mechanism depends on `SharedArrayBuffer` and `Atomics`. For this spec they
remain behind host imports, but they must not create an independent lifecycle
model.

When a thread blocks in a kernel-visible wait, Rust records should transition to
`Blocked` with a `WaitReason`. When a host-only Atomics wait is used and the
kernel cannot observe the wait, the adapter must still keep lifecycle
transitions consistent: detach, exit, and process teardown cannot leave Rust
records stale.

## Testing Strategy

Use TDD for each slice.

Required Rust tests:

- `sys_thread_spawn` allocates tid in Rust state and rolls back on host spawn
  failure.
- `sys_thread_detach` updates Rust state and rejects unknown tid.
- `sys_thread_exit` records exit values and wakes/reaps according to
  joinability.
- `sys_thread_join` returns `0` and writes exit values into the response buffer,
  blocks running threads using a kernel-visible wait record, rejects self-join,
  and rejects detached/unknown tid.
- Snapshot/list-thread encoders reflect lifecycle changes.

Required adapter tests:

- Rust-backed `host_thread_spawn` calls `sys_thread_spawn` and does not allocate
  tid locally.
- Worker completion records exit through Rust state only when the reporting
  worker/session matches the recorded `host_thread_handle`.
- Worker-side nested `host_thread_spawn` routes through the same Rust path.
- `host_thread_self` returns guest-visible `0` on the main thread and
  Rust-allocated tids for worker threads.

Required integration/conformance:

- Existing worker SAB unit tests remain green.
- `pthread-canary` passes for create, join, self, detach, exit, mutex, condvar,
  TLS, and once.
- `libzmq-reactor-spawn_reproducer_test.ts` remains green.
- `cpython3-pyzmq` is re-enabled once the separate ports blocker is fixed.

## Rollout

Implement in small PR commits:

1. Add Rust method ids and dispatch tests for thread lifecycle.
2. Add `kh_thread_spawn` host import and native/test stubs.
3. Route Deno/JS compatibility imports through Rust methods.
4. Convert `WorkerSabThreadsBackend` slots from lifecycle authority to
   host-handle bookkeeping.
5. Wire worker completion into Rust `record_thread_exit`.
6. Expand conformance tests and update the parity matrix.

Do not remove the TypeScript kernel path until the Rust-backed path passes the
thread conformance gates and the remaining non-thread parity gaps are either
done or explicitly accepted.
