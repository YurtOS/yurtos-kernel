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
- Joining a detached or unknown thread returns the pthread-compatible error.
- Detaching a running thread marks it detached.
- Detaching an exited unjoined thread reaps it.
- Exiting the main thread maps to process exit; exiting a worker thread records
  the thread exit value and wakes joiners.
- Thread self returns the Rust-owned tid mapping expected by the guest ABI.

## ABI Shape

No JSON is introduced at the guest-to-kernel boundary.

Add `sys_thread_*` methods to `abi/contract/yurt_abi_methods.toml` for the
thread lifecycle surface:

- `sys_thread_spawn`: request `u32 fn_ptr LE + u32 arg LE`; returns tid or
  negated errno.
- `sys_thread_self`: no request; returns current tid.
- `sys_thread_join`: request `u32 tid LE`; returns joined thread exit value or
  negated errno.
- `sys_thread_detach`: request `u32 tid LE`; returns `0` or negated errno.
- `sys_thread_exit`: request `i32 retval LE`; does not return to guest on the
  calling thread. In adapter paths where unwinding is required, the adapter may
  translate the successful syscall into its local unwind mechanism.
- `sys_thread_yield`: no request; returns `0` or negated errno.

The current host import `host_thread_spawn(fn_ptr, arg)` should become a
compatibility wrapper around `sys_thread_spawn` in the Rust-backed adapters, the
same way `host_socket_set_no_delay` wraps `sys_socket_option`.

## Kernel-to-Host Interface

Add host imports for unsandboxable thread execution actions to
`abi/contract/kernel_host_abi.toml` and `packages/kernel-wasm/src/kh.rs`.

- `kh_thread_spawn(pid, tid, fn_ptr, arg) -> i32 host_thread_handle | -errno`
  creates the host execution resource and starts or schedules the guest thread.
- `kh_thread_detach(host_thread_handle) -> i32` lets the adapter release join
  bookkeeping it owns.
- `kh_thread_cancel(host_thread_handle) -> i32` is used for teardown of detached
  workers or process termination.

The Rust kernel allocates the tid before calling `kh_thread_spawn`. If the host
spawn fails, the kernel removes the pending thread record and returns the host
errno to the guest.

The host adapter reports normal completion by calling the existing
`kernel_record_thread_exit(pid, tid, retval)` control export, or by a new
syscall path if the implementation consolidates control exports behind dispatch.

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
- `sys_thread_join` returns exit values, blocks running threads using a
  kernel-visible wait record, and rejects detached/unknown tid.
- Snapshot/list-thread encoders reflect lifecycle changes.

Required adapter tests:

- Rust-backed `host_thread_spawn` calls `sys_thread_spawn` and does not allocate
  tid locally.
- Worker completion records exit through Rust state.
- Worker-side nested `host_thread_spawn` routes through the same Rust path.
- `host_thread_self` returns the Rust-owned tid for main and workers.

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
