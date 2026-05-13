# Plan: Sandboxed Kernel Migration

## Current Status

The migration is no longer in the skeleton phase. `packages/kernel-wasm`
contains an active Rust `kernel.wasm` implementation with syscall dispatch,
process primitives, fd/pipe handling, VFS layers, proc/dev/hostfs/yurtfs
mounting, fetch/socket forwarding, durable KV hooks, and host extension
forwarding. `packages/microkernel-js` and `packages/microkernel-deno` exist, and
the native host path still lives in `packages/runtime-wasmtime`.

The TypeScript kernel remains the default and must continue running in parallel
until the wasm kernel passes the same behavioral gates. The current rollout
surface is `Sandbox.create({ kernelImpl: "wasm" })` plus `wasmHostImports` /
`wasmOverrideNames`, with the older `YURT_KERNEL=ts|wasm` environment switch
still the intended CLI/CI spelling.

Recent parity work filled the Deno wasm-kernel wrapper table for durable KV /
IndexedDB-shaped `host_idb_*` imports. The socket wrappers now follow the direct
`yurt_abi.toml` socket signatures (`fd`, pointer/length, flags) for the Rust
`SYS_SOCKET_*` rows; older TS-kernel-only helper imports such as
`host_socket_open`, `host_socket_bind`, and `host_socket_option` remain outside
the wasm-kernel table until userland stops depending on them or Rust grows
matching kernel-owned fd/socket option semantics.

The next milestone is parity, not feature count. The Rust kernel already has
many syscall families; the work now is to make those routes selectable from the
existing sandbox, run the same fixtures through TS and wasm kernels, and close
the adapter gaps that parity exposes.

Current Phase C status:
`packages/kernel/src/__tests__/sandbox-wasm-kernel_test.ts` now runs
deterministic fixtures through both `Sandbox.create()`'s TS-kernel default and
`kernelImpl: "wasm"` mode, comparing exit code, stdout, and stderr for
argv/stdout, zero exit, nonzero exit, std env/process, and std paths canary
coverage. The portable JS WASI shim now keeps guest fd numbers distinct from
kernel fd numbers, reserves WASI preopen fd 3, and forwards `fd_tell`,
`path_create_directory`, `path_filestat_get`, `path_readlink`,
`path_remove_directory`, `path_symlink`, and `path_unlink_file` to Rust-kernel
syscalls. The Rust kernel now owns `SYS_REALPATH`, and both the Deno
host-wrapper table and portable JS user-process `yurt.host_realpath` import
route postlinked Rust `std::fs::canonicalize` through that syscall. Direct JS
microkernel coverage now runs the checked-in `std-fs-canary.wasm`, and
sandbox-level parity coverage now runs the same std-fs canary through both the
TS kernel and wasm kernel from a writable cwd. The Sandbox wasm-kernel adapter
now mirrors each TS loader pid and cwd into the Rust kernel before Rust-owned
`host_realpath` runs.

## Architecture To Preserve

Two ABI surfaces stay separate:

- **User process to kernel:** transitional userland still imports current
  `host_*` symbols from `yurt_abi.toml`. In wasm-kernel mode the KH adapter
  implements those imports by copying request bytes into `kernel.wasm` and
  calling `kernel_dispatch(method_id, in_ptr, in_len, out_ptr, out_cap)`. New or
  rebuilt userland may move to `sys_*` names later, but that rename is not part
  of the parity gate.
- **Kernel to host interface:** `kernel.wasm` imports `kh_*` functions for real
  host authority: clock, entropy, real filesystem, network sockets/fetch,
  process instantiation/memory copies, extension invocation, logging, and
  cooperative yield.

Kernel.wasm owns policy and virtual state: process tree, fd table, VFS, signals,
security checks, image semantics, and network policy. The KH adapter owns
mechanism: wasm engine/store management, host I/O, byte copies between
instances, scheduling, JSPI/asyncify suspension, and native epoch preemption.

Process control and sandbox observability are kernel APIs, not KH-adapter data
structures. Host-facing operations such as spawn, kill, wait/reap, and
list-processes must enter `kernel.wasm` through explicit control/query exports.
The KH adapter may expose those operations to the embedding host, but it must
not keep a parallel process table or synthesize process state. For the
transition, TS-kernel compatibility can mirror the ABI shape only where required
by existing tests; new process ownership work starts in the Rust kernel.

Control/query wire formats must be binary records. JSON remains acceptable for
host JSON-RPC, manifests, persistence blobs until the Rust schema lands, and
application payloads. It is not acceptable for kernel-owned process control,
wait status, fd metadata, VFS metadata, sockets, fetch, or other syscall/control
records.

## Implementation Plan

### Phase A — Branch Hygiene and Docs

- Keep the sandboxed-kernel work in the `worktree-kernel-as-wasm-guest`
  worktree. Do not mix unrelated TS kernel pipeline/debug changes into this
  slice.
- Update this plan and the companion design spec whenever implementation status
  changes; stale phase lists are now a migration risk.
- Keep `packages/runtime-wasmtime` named as-is for now. Any rename to
  `packages/microkernel-wasmtime` should be a dedicated mechanical PR after
  parity is healthier.

### Phase B — Adapter Coverage

- Audit `packages/kernel/src/host-imports/kernel-imports.ts` and
  `packages/kernel/src/process/loader.ts` against
  `packages/microkernel-deno/wasm-kernel-imports.ts`.
- Add thin wrapper rows only for Rust syscalls that already exist in `METHOD`
  and `packages/kernel-wasm/src/dispatch.rs`; leave unsupported calls absent so
  link/test failures expose real gaps.
- Cover every wrapper-table addition with a Deno test. At minimum, keep the
  table covering identity, cwd, fd/pipe, wait, VFS path ops, fetch, extension
  invoke, and the socket connect/listen/accept/addr/send/recv/close surface.
  Durable KV (`host_idb_get`, `host_idb_put`, `host_idb_delete`,
  `host_idb_list`) is now covered by `wasm-kernel-imports_test.ts`.
- Treat socket parity as a separate runtime task, not just a table-presence
  task. The Deno wrapper table now emits the direct transitional ABI shape for
  connect/listen/accept/addr/send/recv/close; remaining work is end-to-end
  userland coverage and deciding whether `host_socket_open` / `host_socket_bind`
  / `host_socket_option` are deleted from the C shim path or reintroduced as
  real Rust-kernel fd/socket-option operations.

### Phase B2 — Kernel-Owned Process Control

Status: substantially implemented for process/thread ownership and first
binary snapshot surface. Remaining B2 work is integration of real pthread
backends and removal of old TS-owned compatibility surfaces where they still
exist outside wasm-kernel mode.

- The host-control exports in `packages/kernel-wasm` are defined before TS
  compatibility shims. `kernel_list_processes`, `kernel_kill`, and `kernel_wait`
  exist. The kernel-driven cached-module spawn path exists as
  `kernel_spawn_process`: it allocates the pid before calling
  `kh_spawn_process`, passes that pid in a binary `spawn_context_v1` record,
  records the returned opaque instance handle in the kernel-owned process
  record, and stores argv. Rust `kh` wrappers and portable JS KH-adapter
  bindings now exist for the wasm-engine import family (`kh_spawn_process`,
  `kh_destroy_instance`, `kh_process_mem_read`, `kh_process_mem_write`,
  `kh_process_resume`). `kh_process_resume` now accepts a kernel-authored
  abstract `budget_ns`, so wasmtime can translate the scheduler decision into
  fuel/epoch configuration without exposing those internals through the kernel
  ABI. The portable JS KH adapter now has a host module cache and opaque
  instance-handle table for cached modules, including process memory read/write
  and destroy. Kernel `kill` now destroys an attached KH instance handle and
  clears it only after the KH adapter reports success. `kh_process_resume`
  still returns `-ENOSYS` until the scheduler/resume loop lands.
- The portable JS KH adapter can now instantiate cached user modules with
  pid-bound syscall imports through `spawnCachedUserProcess`, and the public
  `spawnUserProcessWithArgs` helper now caches anonymous modules and uses that
  path by default. The old JS host-instantiated `kernel_spawn` wrapper has been
  removed.
- The native wasmtime KH adapter mirrors that cached-spawn path:
  `kh_spawn_process` validates `spawn_context_v1`, returns an opaque handle, and
  `spawn_user_process_with_args` now reaches user instantiation through
  `kernel_spawn_process` with an anonymous cached module id.
- `sys_spawn` now stores the decoded argv in the kernel-owned child process
  record before staging the pending spawn, so the wasmtime host no longer calls
  a post-spawn argv patch after draining a child. The old generic
  `kernel_set_argv` method id has been removed from the kernel ABI contract.
- Native wasmtime `spawn_child` now passes the intended parent pid into
  `kernel_spawn_process`; it no longer spawns with parent 0 and patches
  parentage afterward. The old generic `kernel_register_child` method id has
  been removed from the kernel ABI contract.
- `kernel_record_exit` and `kernel_drain_spawn` now exist as typed host-control
  exports. The JS adapter and native wasmtime adapter use them instead of
  generic dispatch method ids for process lifecycle notification and
  pending-spawn draining, and the old generic dispatch method ids have been
  removed from the kernel ABI contract.
- The shared binary process-list record exists in Rust. It encodes
  count-prefixed process entries with `pid`, `ppid`, `pgid`, `sid`, state, exit
  status, command bytes, and visible fd numbers. Rust, JS, and native wasmtime
  tests cover the record shape.
- Route microkernel process observability through the Rust export. In JS/Deno
  and wasmtime adapters, the host may render the returned snapshot, but it does
  not create the process list. The JS adapter and native wasmtime adapter now
  expose decoded views backed by `kernel_list_processes`; remaining work is to
  delete old host-authored list surfaces that belong to the pre-sandboxed
  runtime path.
- Expose host-control `kill` and `wait` through dedicated kernel exports in each
  adapter. JS and native wasmtime now call `kernel_kill` / `kernel_wait`
  directly; the KH adapter decodes return records but does not own process
  state.
- Start the kernel-owned thread model before wiring PR37's Worker/SAB backend
  into wasm-kernel mode. The Rust kernel now records per-process thread groups
  with main-thread initialization, spawned thread records, runnable/blocked/
  exited state, detached status, exit values, and opaque host-thread handles.
  `kernel_list_threads` serializes those records as a binary host-control
  snapshot, and the JS/native microkernels decode it for embedder
  observability.
- Expose typed host-control thread lifecycle hooks before binding PR37's
  Worker/SAB backend: `kernel_spawn_thread`, `kernel_block_thread`,
  `kernel_unblock_thread`, `kernel_detach_thread`, and
  `kernel_record_thread_exit` now mutate the Rust kernel's thread table, and
  the JS/native microkernel wrappers keep the host out of thread-state
  ownership.
- Move nice/priority policy into kernel.wasm. `sys_getpriority`,
  `sys_setpriority`, `sys_sched_getscheduler`, `sys_sched_getparam`,
  `sys_sched_setscheduler`, and `sys_sched_setparam` now mutate or read
  kernel-owned process scheduling state. The kernel enforces the root-only
  priority raise rule, accepts the current SCHED_OTHER/priority-0 contract, and
  rejects unsupported realtime policy without delegating policy ownership to
  the host. Child process creation inherits the parent nice/scheduler values.
  `kernel_schedule_next` returns a binary schedule decision with `pid/tid`, an
  opaque host handle, flags, and `budget_ns`; JS and native wasmtime adapters
  decode that record but do not author scheduler policy.
- Add the first concrete `kernel_snapshot` export. V1 returns a versioned
  `YURTSNP\0` binary envelope with process-list, thread-group, wait-record, and
  runnable-thread sections. Blocked threads now carry a kernel-owned wait
  reason, and the snapshot serializes that as count-prefixed
  `pid/tid/reason/detail` records. Runnable threads serialize as
  count-prefixed `pid/tid` records. This is not full suspend/resume yet; it is
  the stable kernel-authored container that future richer scheduler queues,
  fd/VFS/pipe state, module identities, and memory sections will extend.
- Treat PR37's Worker/SAB pthread backend as host-interface machinery, not final
  ownership. Its module detection, shared-memory setup, Worker creation, and
  async import wrapping are reusable; thread slots, mutex/condvar queues,
  pthread join state, and poll/select waiters move into kernel.wasm. PR37 has
  landed on `main`; this branch now carries its relevant loader/profile/backend
  tests so future Rust-kernel threading work preserves the same guest-facing
  behavior while moving ownership out of TypeScript.
- Temporary TS-kernel compatibility should only mirror binary records where
  existing userland still needs compatibility. Do not introduce new TS-owned
  process APIs.
- The old TS host import `host_list_processes` has been removed, and the
  shell-exec fixture no longer parses a JSON process list for `ps`. Remaining
  cleanup is to remove old process/run transport compatibility and spawn
  compatibility fallbacks incrementally. Each removal gets a focused test
  proving the binary record shape or absence of the legacy import.

### Phase C — Parity Harness

Status: partial. The first sandbox-level TS-vs-wasm fixture parity tests exist
for exit code/stdout/stderr and selected std canaries. Filesystem side effects,
process-status comparison, socket/fetch parity, and shell/BusyBox parity remain
open.

- Add a focused parity runner that executes the same deterministic fixture
  through TS kernel mode and wasm kernel mode and compares exit code, stdout,
  stderr, cwd/filesystem side effects, and relevant process status. The first
  Sandbox-level runner exists for exit/stdout/stderr comparisons; filesystem
  side-effect and process-status comparisons are still pending.
- Start with smoke commands that exercise already-ported syscall families:
  `true`, `false`, `echo`, `cat`, `wc`, simple pipes, cwd/stat/read/write,
  procfs reads, and basic fetch/socket tests where host support exists.
- Promote `Sandbox.create({ kernelImpl: "wasm" })` tests from a probe-only
  integration check to fixture parity. Existing TS-kernel tests remain the
  source of truth until wasm mode matches them. The probe test remains, but the
  file now also covers real fixture execution through both kernels.
- Add Rust-kernel realpath/canonicalize support and route transitional
  `host_realpath` through it. Direct JS microkernel and Deno wrapper coverage
  now exercise this path. Sandbox wasm-kernel coverage mirrors per-process cwd
  into `kernel.wasm`, and the parity runner now compares `std-fs-canary.wasm`
  against the TS kernel from a writable cwd.

### Phase D — Standard Image and BusyBox

Status: not complete. A local standard image artifact may exist in this
worktree, but it is not part of the committed kernel-as-wasm slice yet.

- Build `standard.yurtimg` and run representative BusyBox commands through wasm
  kernel mode: shell startup, `printf | wc -l`, file writes, directory
  traversal, procfs, and short-lived child wait/reap behavior.
- Keep the `printf 'line1\nline2\n' | wc -l` regression in the parity suite, but
  do not let TS-kernel waitpid debugging block wasm-kernel parity work unless
  the same failure reproduces under `kernelImpl: "wasm"`.

### Phase E — CI Rollout and TS Deletion

Status: not started. TS remains the default until the wasm kernel passes the
full parity and guest-compat matrix.

- Add non-default CI coverage for wasm-kernel parity after the focused local
  suite is reliable.
- Flip the default only after Rust tests, Deno tests, guest-compat, and the
  parity runner are green with `kernelImpl: "wasm"`.
- Delete the TypeScript kernel only after the wasm kernel passes the same
  syscall families across native wasmtime, Deno, browser/JSPI, and asyncify
  fallback where supported.

## Verification

Local gates for this worktree:

- `cargo fmt --all -- --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test --tests`
- `deno fmt --check`
- `deno lint`
- `deno check 'packages/**/*.ts'`
- `deno test`

Focused gates while iterating:

- `cargo test -p yurt-kernel-wasm`
- `cargo test -p yurt-runtime-wasmtime`
- `deno test --allow-read --allow-write --allow-run --allow-env --allow-net --no-check packages/microkernel-js/__tests__ packages/microkernel-deno/__tests__`
- wasm-kernel parity runner once Phase C lands.

Final acceptance is unchanged: the TS kernel can be removed only when the wasm
kernel passes the full guest-compat matrix without behavioral regressions.

## Assumptions

- Keep TS kernel as the default during migration.
- Keep `packages/runtime-wasmtime` name until a dedicated rename.
- Keep extensions hosted by the microkernel; `kernel.wasm` forwards bytes.
- Use a format bump for Rust persistence unless compatibility is explicitly
  required.
- Keep asyncify as the fallback for engines without JSPI.
