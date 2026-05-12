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

- Define the host-control exports in `packages/kernel-wasm` before changing TS
  compatibility shims. `kernel_list_processes`, `kernel_kill`, and `kernel_wait`
  now exist. The kernel-driven cached-module spawn path now exists as
  `kernel_spawn_process`: it allocates the pid before calling
  `kh_spawn_process`, passes that pid in a binary `spawn_context_v1` record,
  records the returned opaque instance handle in the kernel-owned process
  record, and stores argv. Rust `kh` wrappers and portable JS KH-adapter
  bindings now exist for the wasm-engine import family (`kh_spawn_process`,
  `kh_destroy_instance`, `kh_process_mem_read`, `kh_process_mem_write`,
  `kh_process_resume`). The portable JS KH adapter now has a host module cache
  and opaque instance-handle table for cached modules, including process memory
  read/write and destroy. Kernel `kill` now destroys an attached KH instance
  handle and clears it only after the KH adapter reports success.
  `kh_process_resume` still returns `-ENOSYS` until the scheduler/resume loop
  lands. The remaining reserved export is `kernel_snapshot`.
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
- Add a shared binary process-list record in Rust first. The first version
  should encode count-prefixed process entries with `pid`, `ppid`, `pgid`,
  `sid`, state, exit status, command bytes, and visible fd numbers. Keep the
  decoder test close to the Rust kernel test so record drift fails locally.
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
- Only after the Rust export and adapter path are covered, update the temporary
  TS-kernel path to mirror the same binary record where existing userland still
  needs compatibility. Do not introduce new TS-owned process APIs.
- Remove remaining JSON process-control paths incrementally:
  `host_list_processes`, shell-fixture `ps` parsing, run-result transport, and
  spawn compatibility fallbacks. Each removal gets a focused test proving the
  binary record shape.

### Phase C — Parity Harness

- Add a focused parity runner that executes the same deterministic fixture
  through TS kernel mode and wasm kernel mode and compares exit code, stdout,
  stderr, cwd/filesystem side effects, and relevant process status.
- Start with smoke commands that exercise already-ported syscall families:
  `true`, `false`, `echo`, `cat`, `wc`, simple pipes, cwd/stat/read/write,
  procfs reads, and basic fetch/socket tests where host support exists.
- Promote `Sandbox.create({ kernelImpl: "wasm" })` tests from a probe-only
  integration check to fixture parity. Existing TS-kernel tests remain the
  source of truth until wasm mode matches them.

### Phase D — Standard Image and BusyBox

- Build `standard.yurtimg` and run representative BusyBox commands through wasm
  kernel mode: shell startup, `printf | wc -l`, file writes, directory
  traversal, procfs, and short-lived child wait/reap behavior.
- Keep the `printf 'line1\nline2\n' | wc -l` regression in the parity suite, but
  do not let TS-kernel waitpid debugging block wasm-kernel parity work unless
  the same failure reproduces under `kernelImpl: "wasm"`.

### Phase E — CI Rollout and TS Deletion

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
