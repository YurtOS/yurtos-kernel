# Rust Fork Parity Design

## Goal

Support guest `fork()` through the Rust kernel so the TypeScript kernel can stop
owning process duplication semantics. The host may still perform continuation
snapshot and child instance creation, but the Rust kernel owns process identity,
parent/child relationships, fd table cloning, wait visibility, and rollback.

## Non-Goals

- No kernel DNS resolver work in this slice.
- No `pthread_atfork` callback implementation in this slice.
- No `fork()` support for shared-memory threaded processes in the first pass;
  return `-EAGAIN` as the TypeScript path does.
- No attempt to implement `fork()` without continuation snapshot support.
  Non-continuation guests keep the weak `fork()`/`vfork()` `-ENOSYS` behavior.

## Architecture

Guest continuation builds import `yurt.host_fork() -> i32`. That import is not a
normal Rust syscall because it must return twice: child receives `0`, parent
receives the child pid. The host adapter owns the continuation operation:
capture the guest stack/memory state, create a child wasm instance from that
snapshot, and resume parent and child with different return values.

The host adapter must not allocate process identity or clone kernel-owned state
directly. Instead it calls Rust kernel control exports:

1. `kernel_prepare_fork(parent_pid) -> child_pid_or_neg_errno`
2. host captures the parent continuation and memory snapshot
3. host creates child execution state and starts the child continuation
4. host calls `kernel_commit_fork(parent_pid, child_pid)`
5. if any host step fails, host calls `kernel_rollback_fork(parent_pid, child_pid)`

The Rust kernel's prepare step allocates the child pid, records the parent, marks
the child as `ForkPreparing`, clones kernel-owned process metadata, and clones
the fd table with shared open-file descriptions where POSIX requires shared file
offsets and flags. The commit step makes the child visible to `waitpid`, process
listing, signals, and scheduling. Rollback removes the prepared child and
releases any kernel-owned handles that were cloned during prepare.

## State Rules

- A prepared child is not waitable until `kernel_commit_fork`.
- `waitpid(child)` before commit returns as if the child is not yet exited; it
  must not observe a partial process.
- If the child wasm instance exits before commit, the adapter must commit then
  record exit, or rollback if the continuation was never started.
- Fork from a non-main pthread returns `-EAGAIN` in the first pass.
- Fork from a process with imported shared memory returns `-EAGAIN` in the first
  pass.
- `vfork()` remains an alias to `fork()` for now; it does not share address space
  with suspended-parent semantics.

## ABI Surface

Guest import:

```text
yurt.host_fork() -> i32
```

Rust kernel host-control exports:

```text
kernel_prepare_fork(parent_pid: u32) -> i64
kernel_commit_fork(parent_pid: u32, child_pid: u32) -> i64
kernel_rollback_fork(parent_pid: u32, child_pid: u32) -> i64
```

Return values are `0` or a positive child pid on success, and negated errno on
failure. Child pids are limited to `1..=i32::MAX` because the guest scalar fork
return channel collides with negated errno above that range.

## Host Responsibilities

- Deno/Worker/SAB and Wasmtime adapters may use different continuation
  mechanisms, but both must call the same Rust kernel prepare/commit/rollback
  exports.
- A host must return `-ENOSYS` from `host_fork` if it cannot capture and restore
  continuation snapshots.
- A host must return `-EAGAIN` for shared-memory or multithreaded fork in the
  first pass.
- A host must not directly mutate Rust kernel process tables.

## Test Strategy

- Unit-test Rust kernel prepare/commit/rollback state transitions.
- Add Wasmtime trampoline coverage that `yurt.host_fork` is linkable and returns
  `-ENOSYS` until Wasmtime continuation support is implemented.
- Port the existing TypeScript `fork-canary` continuation cases to Rust-backed
  kernel execution once prepare/commit/rollback is in place.
- Keep the default non-continuation `fork()` canary expecting `-ENOSYS`.
