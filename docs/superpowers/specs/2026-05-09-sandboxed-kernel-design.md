# Sandboxed Kernel Design

**Date:** 2026-05-09 **Status:** Draft

## Summary

Move the Yurt kernel out of host TypeScript and into a Rust crate compiled to
`wasm32-wasip1`. Shrink the host side to a kernel-host interface that owns only
the wasm engine and the outside world (real filesystem, network, clock,
scheduling). Run the kernel in its own sandbox the same way user processes
already run, so the kernel and user processes share an isolation model and the
same Rust source serves every host (native wasmtime, browser via JSPI/asyncify,
Deno, bare `wasmtime run`).

This is a kernel/host-interface split. Kernel.wasm owns _policy_: VFS layout,
process tree, fd table, signal routing, security checks, image semantics,
network policy. The host interface owns _mechanism_: instantiate wasm modules,
copy bytes between linear memories, perform real I/O, suspend/resume on JS hosts
via JSPI or asyncify, preempt via wasmtime epochs.

The kernel-host interface is therefore a **pluggable backend**: a runtime is
defined entirely by its implementation of the kernel→host ABI plus a small
instantiation/dispatch contract. Any wasm runtime that can host the same `kh_*`
imports and call `kernel_dispatch` is a supported backend — wasmtime, Wasmer,
the browser engine via JSPI/asyncify, Wasmi for embedded, and future runtimes
drop in without touching kernel.wasm or process. Existing package names such as
`packages/kernel-host-interface-js` are historical; architecturally they are KH adapters,
not independent kernels.

## Why

1. **One implementation.** Today the kernel is ~16k LOC TypeScript plus a ~5k
   LOC Rust runtime. Adding a Rust kernel without removing TypeScript would mean
   two implementations to maintain. We need exactly one.
2. **Host-portable.** Browser, native, and CLI hosts each need a kernel today;
   only TypeScript covers them all. Compiling the kernel to wasm inverts this:
   every host instantiates the same `kernel.wasm`.
3. **Smaller TCB.** The host interface becomes small enough to audit thoroughly.
   Kernel logic that doesn't need ambient host authority (most of it) runs
   sandboxed alongside user code.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Kernel-Host Interface / KH Adapter (per-platform)            │
│  - wasmtime native     packages/kernel-host-interface-wasmtime         │
│  - any JS engine       packages/kernel-host-interface-js               │
│       (Deno, browsers, Node, Bun all share this)             │
│  - Deno-only adds      packages/kernel-host-interface-deno             │
│       (real fs / sockets / subprocess on top of -js)         │
│  - bare CLI            wasmtime run kernel.wasm              │
└────────┬──────────────────────────────────┬──────────────────┘
         │ user→kernel trampoline           │ kernel→host (kh_*)
         ▼                                  ▼
   ┌─────────────────┐             ┌──────────────────────┐
   │ User process    │             │ Kernel WASM          │
   │ (Yurt process,  │             │ packages/kernel-wasm │
   │  imports host_*)│             │ wasm32-wasip1        │
   └─────────────────┘             └──────────────────────┘
```

(Throughout this document, "process" means a Yurt user process — a wasm module
instantiated by the KH adapter that imports `host_*` from `yurt_abi.toml`. The
repo is mid-rename from the older "guest" terminology.)

### Naming note: transitional `host_*`, eventual `sys_*`

Architecturally, the user-facing operations are syscalls because they land
inside kernel.wasm. New kernel dispatch constants and shim code use `sys_*`
names for that reason.

The migration does **not** rename every existing user process import as part of
the parity gate. Transitional userland still imports legacy `host_*` symbols
from `yurt_abi.toml`, and the kernel-host interface implements those names by forwarding
into `kernel_dispatch`. Once parity is reached, new or rebuilt userland can move
to `sys_*` imports as a dedicated ABI cleanup. Until then, `host_*` is a
compatibility spelling, not an architectural boundary.

Two ABI surfaces:

- **User→Kernel** — `abi/contract/yurt_abi.toml`. Unchanged for the transition.
  The kernel-host interface re-exports each `host_*` import to the calling process; the
  implementation copies the request out of process memory, calls
  `kernel_dispatch(method_id, in_ptr, in_len, out_ptr, out_cap)` exported by
  kernel.wasm, then copies the response back into process memory.
- **Kernel→Host** — `abi/contract/kernel_host_abi.toml`. New, small (~20
  functions). The kernel imports `kh_*` for things only the host can do.

There is also a host-control surface in the opposite direction:

- **Host→Kernel control/query** — exports on `kernel.wasm` used by the
  kernel-host interface and embedding host to operate the sandbox itself: create a
  process, send a signal or kill request, wait/reap, list process state, query
  fd/proc metadata, snapshot state, and eventually set resource limits. These
  calls are not `kh_*` imports because the kernel-host interface is not implementing the
  behavior. They enter kernel.wasm, where the process table, credentials, signal
  policy, fd table, and VFS state live. The kernel-host interface only copies
  request/response bytes and drives wasm instances.

## Trampoline Protocol

A user syscall executes in five steps:

1. User wasm calls a `host_*` import. On JS hosts this is a JSPI suspend point;
   on native wasmtime it is a normal host call.
2. KernelHostInterface reads the request bytes from user linear memory using
   pointer/length args defined by `yurt_abi.toml`.
3. KernelHostInterface writes those bytes into kernel.wasm linear memory at a
   pre-arranged scratch region (or via `kh_user_mem_*`-style copy primitive —
   TBD: see Open Question 1) and calls
   `kernel_dispatch(method_id, in_ptr, in_len, out_ptr, out_cap)`. `method_id`
   is a stable u32 encoded from the import name in `yurt_abi.toml` (assigned in
   declaration order; pinned in `abi/contract/yurt_abi_methods.toml` once we
   generate it).
4. Kernel.wasm executes the syscall. If it needs the outside world it calls a
   `kh_*` import; on JS hosts those are JSPI suspend points too. Return value
   follows the existing native-syscall convention: `>= 0` success, `< 0` negated
   POSIX errno. Variable-size results land in the caller-provided out buffer
   using the same fixed-record layouts the native ABI already defines
   (`yurt_*_result_v1` structs).
5. KernelHostInterface copies the response from kernel memory back into user memory and
   returns the scalar result to the process.

On native wasmtime steps 2 and 5 can collapse to direct slice borrows between
stores once we add a host-mediated borrow primitive; the spec permits that as an
optimization but does not require it.

## Method ID Assignment

`method_id` is a `u32` derived from each `[import.<name>]` entry in
`yurt_abi.toml`. Generate `abi/contract/yurt_abi_methods.toml` with one
`method.<name> = <id>` per import, IDs starting at 1, never reused, never
renumbered. `method_id == 0` is reserved for negotiation/health.

This is the only new piece of the wire format; everything else (structures,
errno, alignment) reuses the existing native-syscall ABI.

## Kernel→Host ABI (kh_*)

See `abi/contract/kernel_host_abi.toml` (to land in this slice). Initial
surface, grouped:

- **Time & entropy:** `kh_now_realtime`, `kh_now_monotonic`, `kh_random`.
- **Real filesystem:** `kh_real_open`, `kh_real_read`, `kh_real_write`,
  `kh_real_close`, `kh_real_stat`, `kh_real_readdir`. Used only by the
  host-fs-provider inside kernel.wasm; everything else goes through the kernel's
  own VFS.
- **Network:** `kh_fetch_send`, `kh_fetch_poll`, and the full socket surface —
  `kh_socket_open`, `kh_socket_bind`, `kh_socket_connect`, `kh_socket_listen`,
  `kh_socket_accept`, `kh_socket_addr`, `kh_socket_option`, `kh_socket_send`,
  `kh_socket_recv`, `kh_socket_close`. Tracks the existing `host_network_fetch`
  and `host_socket_*` surface in `yurt_abi.toml`. Blocking semantics (`recv`,
  `accept`, `connect`) follow the **event-driven model established by PR15**
  (`feat: kernel primitives for in-browser sandbox-listening servers`): the host
  suspends the kernel call until the operation can make progress (Tokio await on
  native; JSPI/asyncify on the browser/Deno). A `KH_SOCK_NONBLOCK` flag returns
  `-EAGAIN` when the operation would block. There is no polling loop on any
  path. PR15 also adds a host-page `sandbox.net` facade and a `ListenerRegistry`
  for routing in-tab fetch/WS into the sandbox; those live above the kernel↔host
  ABI and are the kernel-host-interface-js adapter's concern, not kernel.wasm's.
- **Wasm engine ops:** `kh_spawn_process` (creates a new process instance from a
  module already loaded into the host's module cache, returns an instance
  handle), `kh_destroy_instance`,
  `kh_process_mem_read(handle, addr, dst_ptr, len)`,
  `kh_process_mem_write(handle, addr, src_ptr, len)`,
  `kh_process_resume(handle, result, budget_ns)`. This import family is now represented in
  `packages/kernel-wasm/src/kh.rs`, `packages/kernel-host-interface-js/mod.ts`, and the
  native wasmtime KH adapter. The portable JS backend has a host module cache
  and opaque instance-handle table for cached wasm modules, including instance
  destroy and kernel↔process memory copies. The native wasmtime backend now
  validates kernel-provided spawn contexts and instantiates cached modules with
  the kernel-allocated pid. POSIX priority and scheduler syscalls are
  kernel-authored state: `getpriority`/`setpriority` and the `sched_*`
  policy/param calls read and update kernel process records, while the host
  only applies the resulting execution decision. `budget_ns` is an abstract
  kernel scheduler budget: native wasmtime maps it to fuel/epoch deadlines, JS
  backends map it to safepoint cadence/AsyncBridge policy, and kernel.wasm
  never exposes engine-specific scheduling internals. `kh_process_resume` intentionally
  returns `-ENOSYS` until the scheduler/resume loop is wired; the ABI bindings
  themselves are no longer spec-only.
- **Diagnostics:** `kh_log` (severity, ptr, len), `kh_panic` (ptr, len —
  kernel-host interface must terminate the kernel instance and surface the message).
- **Cooperative yield:** `kh_yield` — blocks the calling kernel computation
  until the host signals progress (used for blocking pipe reads, wait for child
  exit, etc.). On JS hosts this is JSPI; on native it is a Tokio await.

All `kh_*` calls follow the same calling convention as the native ABI: scalars
`>= 0` for success / `< 0` errno; structured returns into caller-provided
fixed-size out buffers.

## Host→Kernel Control API

The process-control and observability API is owned by kernel.wasm. The
kernel-host interface exposes these operations to the embedding host, but it must not keep
an independent process table or synthesize process state. The source of truth is
inside kernel.wasm.

Initial exports:

- `kernel_spawn_process(parent_pid, module_id_ptr, module_id_len, argv_ptr,
  argv_len) -> i64`
  — kernel-driven cached-module spawn. The module id names a wasm module already
  cached in the KH adapter. Kernel.wasm allocates/reserves the pid first, builds
  `spawn_context_v1`, calls `kh_spawn_process`, records the returned opaque
  instance handle in its process table, stores parentage and argv, and returns
  the pid. `spawn_context_v1` is binary: `u16 version`, `u16
  flags`,
  `u32 pid`, `u32 argv_len`, then the same `(u32 arg_len + arg_bytes)*` argv
  record used by the host-control spawn request. If the KH adapter cannot
  instantiate the module, the pid has not been published in the process table.
  This is the forward path for moving process instantiation behind kernel
  policy.
- User-facing `sys_spawn` likewise decodes argv into the child process record at
  pid allocation time before returning a pending spawn to the KH adapter. The
  host receives argv for WASI instantiation, but it does not author `/proc`
  command metadata afterward.
- `kernel_record_exit(pid, status) -> i64` — KH adapter notification that a
  process instance has exited. It records the exit status in kernel-owned state
  for later `kernel_wait` / user `sys_wait` reaping. JS and native wasmtime
  adapters call this typed export directly rather than routing lifecycle
  notification through generic dispatch method ids.
- `kernel_drain_spawn(out_ptr, out_cap) -> i64` — typed host-control export for
  draining kernel-staged user `sys_spawn` work. The response remains the binary
  pending-spawn record: `u32 child_pid`, `u32 wasm_len`, wasm bytes, `u32 argc`,
  then `(u32 arg_len + arg_bytes)*`. JS and native wasmtime adapters decode this
  binary record without owning or synthesizing process state.
- `kernel_kill(pid, signal) -> i64` — apply signal/permission policy and route
  termination to the process instance through the host mechanism when needed. If
  the process record has an attached KH instance handle, kernel.wasm calls
  `kh_destroy_instance` and clears the handle only after the KH adapter reports
  success. The JS and native wasmtime adapters expose this as a host-control
  wrapper; the kernel still owns signal validation and process state mutation.
- `kernel_wait(caller_pid, child_pid, flags, out_ptr, out_cap) -> i64` —
  wait/reap according to kernel process ownership rules. This is the
  host-control equivalent of the user-facing wait syscall, not a KH adapter
  process-table operation. JS and native wasmtime wrappers decode only the
  returned `(pid, status)` record.
- `kernel_list_processes(out_ptr, out_cap) -> i64` — return a packed binary
  process snapshot from the kernel-owned table. At minimum each entry carries
  `pid`, `ppid`, `pgid`, `sid`, state, exit status, command bytes, and visible
  fd numbers. The host may render this for users, but it does not author it. The
  JS and native wasmtime KH adapters decode this binary snapshot for their
  embedder APIs; the authoritative table remains inside kernel.wasm.
- `kernel_snapshot(out_ptr, out_cap) -> i64` — return a versioned binary
  `.yurtsnap` envelope authored by kernel.wasm. V1 starts with
  `YURTSNP\0`, `u16 version = 1`, `u16 section_count`, `u32 flags`, followed by
  section records (`u32 section_type`, `u32 section_len`, bytes). V1 contains
  the existing process-list record (`section_type = 1`), per-process
  thread-group records (`section_type = 2`), and kernel-owned wait records
  (`section_type = 3`), and runnable-thread records (`section_type = 4`). Wait
  records are count-prefixed entries of `u32 pid`, `u32 tid`, `u32 reason`,
  `u32 detail`; reason `1` means a host-interface block point. Runnable-thread
  records are count-prefixed `u32 pid`, `u32 tid` pairs. Later versions add
  richer scheduler queues, fd/VFS/pipe state, module identities, and memory
  sections without moving ownership back into the host.

Control/query responses use explicit binary records with little-endian scalar
fields and length-prefixed byte strings. JSON is allowed for host-level
JSON-RPC, manifests, and application payloads, but not for kernel-owned
process-control wire formats.

## Suspension Model

The sandboxed-kernel reuses the existing `AsyncBridge` infrastructure in
`packages/kernel/src/async-bridge.ts` rather than reinventing it. That module
already implements all three modes the migration needs — `jspi`, `asyncify`
(with snapshot/fork), and `threads` — and is currently driving the TS kernel's
user-process loaders, setjmp/longjmp, and process manager. The Rust
kernel.wasm + kernel-host interface split slots into the same bridge:

- **Native wasmtime:** Both the process and the kernel wasm run in Tokio-driven
  async stores with `epoch_interruption` enabled. Syscalls from process execute
  inline; the kernel's `kh_yield` is a real `tokio::task::yield_now`. No JS-side
  bridge required.
- **Browser / Deno, JSPI:** the host-interface-side `kh_*` host functions that
  perform async work are wrapped with `bridge.wrapImport(asyncFn)`, which
  returns a `WebAssembly.Suspending`. The `kernel_dispatch` export is wrapped
  with `bridge.wrapExport(...)`, which returns `WebAssembly.promising(...)` so
  callers `await` the result. JSPI is unflagged in Deno 1.40+ and Chrome 137+.
- **Browser, asyncify fallback:** the kernel.wasm artifact is built with
  `wasm-opt --asyncify --pass-arg=asyncify-imports@<list>` emitting a
  `-asyncify` suffixed binary. The bridge's `AsyncifyAsyncBridge` drives the
  unwind/rewind loop on the JS side, including the snapshot/fork support already
  used for setjmp/longjmp. Safari and Bun ride this fallback.
- **Threads (future):** wasi-threads + `SharedArrayBuffer` + `Atomics.wait`.
  True parallelism with no JSPI/asyncify needed; the bridge already has the
  protocol stubbed.

When the first blocking `kh_*` call lands (likely `kh_yield` for pipe/wait), the
kernel-host-interface-deno integrates `AsyncBridge`. The existing implementation stays —
the migration's job is to consume it, not replace it.

### Two architectural absolutes for JS-hosted backends

Both of these are **non-negotiable** on browser / Deno; native wasmtime is
unaffected because epoch interruption + Tokio cover them.

1. **Cooperative multitasking requires JSPI or asyncify, and the suspension
   point is _every_ `sys_*` call — not just the ones that route async work to
   the host.** WebAssembly on JS engines has no preemption: a process that
   doesn't make a host call cannot be interrupted. The only points in a
   process's execution where the scheduler can possibly intervene are the
   syscall boundaries. So every `sys_*` import on JS hosts goes through
   `bridge.wrapImport(asyncFn)` — even trivial scalar syscalls like `sys_getuid`
   that have nothing async to do. The scheduler decides _at each syscall_
   whether to resume the caller immediately (no contention) or yield to another
   runnable process; the engine makes that choice possible by suspending the
   user-process wasm stack at the import boundary. Without that wrapping, a
   tight loop between two `sys_getuid` calls in one process would starve every
   other process indefinitely.

   The only primitives JS provides for the suspension are
   `WebAssembly.Suspending` / `promising` (JSPI) and Binaryen's asyncify
   unwind/rewind. There is no third option. Engines that lack JSPI (Safari, Bun)
   must run asyncify-built artifacts.

   On the native wasmtime backend the equivalent is wasmtime's epoch
   interruption — every N quanta of guest execution, any process can be
   preempted regardless of whether it called a syscall. The Rust kernel-host interface
   does _not_ need to wrap every `sys_*` for scheduling; epochs handle it. This
   is the one architectural difference between the JS-hosted and native
   backends.

2. **setjmp/longjmp requires asyncify.** Even on engines with JSPI, POSIX
   `setjmp`/`longjmp` semantics on wasm are implemented via the asyncify pass —
   the unwind/rewind machinery _is_ the long-jump. JSPI doesn't replace this.
   The TS kernel today gates a setjmp bridge per-module via
   `needsSetjmpBridge(module)` in `process/manager.ts`; the sandboxed-kernel
   inherits the same discipline. Modules that need setjmp/longjmp are built with
   asyncify regardless of which suspension mode is otherwise active.

Consequence for the build pipeline: kernel.wasm and any user-process binary that
uses setjmp/longjmp must have an `-asyncify` variant available. The kernel-host interface
selects the right artifact at instantiation time (matches the existing
`binarySuffix` logic on `AsyncBridge`).

## Memory & Concurrency

Kernel.wasm is single-threaded for kernel execution: the kernel-host interface serializes
syscall dispatch by holding a per-kernel-instance lock around `kernel_dispatch`.
User processes, however, may be truly multi-threaded. The kernel owns the thread
group model even when the host interface uses Worker/SAB or native host threads
to execute those user threads.

Each process has a kernel-authored thread group. Tid 1 is the main thread.
Thread records carry `tid`, runnable/blocked/exited state, detached/joinable
state, exit value, and an opaque host-thread/instance handle when the KH adapter
has one. Scheduler queues, pthread join state, mutex ownership, condvar wait
queues, and poll/select waiters live in kernel.wasm. The KH adapter may create
workers, shared memories, wasmtime tasks, and wake/suspend host execution, but
it does not author thread lifecycle or synchronization state.

PR37's Worker/SAB pthread backend is the host-interface prototype for JS/Deno:
module feature detection, shared-memory validation, worker creation, and async
import wrapping are reusable. Its TS-owned thread slots, mutex maps, and condvar
queues are transitional; wasm-kernel mode moves those records into the Rust
kernel and exposes host-rendered views through binary kernel snapshots.

Kernel state lives in kernel.wasm's linear memory. The kernel-host interface treats kernel
state as opaque except via `kernel_dispatch` and a small host-control export set
(`kernel_spawn_process`, `kernel_kill`, `kernel_wait`, `kernel_list_processes`,
`kernel_list_threads`, `kernel_schedule_next`, `kernel_spawn_thread`,
`kernel_detach_thread`, `kernel_record_thread_exit`, `kernel_block_thread`,
`kernel_unblock_thread`, `kernel_record_exit`, `kernel_drain_spawn`,
`kernel_snapshot`). `kernel_schedule_next` returns a binary decision record
(`pid`, `tid`, opaque host-thread/instance handle, flags, and `budget_ns`) so the
host can resume the selected execution unit without owning scheduler policy.

### Suspend, Resume, and Teleport

Live-state images are a separate binary artifact, `.yurtsnap`, not a `.yurtimg`
extension. A snapshot is authored by kernel.wasm after a stop-the-world barrier:
new process/thread creation is paused, runnable threads must reach a
syscall/import safepoint, and blocked threads must be represented as
kernel-owned wait records. V1 returns busy rather than serializing opaque JSPI
continuations, Promises, Worker objects, wasmtime Stores, or native file/socket
handles.

The `.yurtsnap` format is sectioned and versioned. It contains kernel process
and thread records, scheduler queues, wait reasons, fd/VFS/pipe state, module
identities, linear memory bytes, shared-memory bytes, and portable resource
descriptors. Cross-host resume is required only when the target host supports
the snapshot's feature set and can recreate instances from the recorded module
identities and memory sections.

## Migration Strategy

Build Rust kernel-wasm next to the TypeScript kernel. Both implement the same
`yurt_abi.toml` surface. A runtime flag selects the active kernel:

```
YURT_KERNEL=ts    (default during transition)
YURT_KERNEL=wasm  (parity testing and incremental rollout)
```

Routing happens inside the kernel-host interface: when `YURT_KERNEL=ts`, host_* calls
forward to the existing TS kernel via the current JSON-RPC callback path. When
`YURT_KERNEL=wasm`, they forward into kernel.wasm. Per-syscall routing is
allowed (`YURT_KERNEL_OVERRIDE=pipes:wasm,vfs:ts`) so we can land the Rust port
one syscall family at a time and run the parity matrix continuously.

The TypeScript kernel is deleted only after all syscall families pass parity on
every supported host.

## Open Questions

1. **Memory copy cost on JS hosts.** Do we standardize on host-mediated copy
   through scratch regions, or expose a JSPI-friendly borrow primitive that lets
   kernel.wasm read user memory directly via `kh_process_mem_read`? Decision
   deferred until we benchmark with the pipes port.
2. **JSPI Safari coverage.** JSPI is shipping in Chromium and Firefox; Safari
   status is unsettled. Confirm whether asyncify fallback is the long-term
   Safari plan or whether we de-scope Safari for now.
3. **Kernel preemption.** Should kernel.wasm itself be preemptible via epoch
   interruption (defends against a buggy kernel hot loop), or trusted to run to
   completion per syscall? Recommendation: trusted-but-bounded — wasmtime stays
   armed but with a generous deadline; document the bound.
4. **Persistence format.** The TS persistence layer snapshots TS data
   structures. The Rust port needs a stable on-disk schema; either bump format
   version or write a one-shot migrator. Locked to "bump version, no migration"
   pending stakeholder review.
5. **Image loader bootstrapping.** Does the kernel read images via `kh_real_*`
   from inside the sandbox, or does the kernel-host interface pre-mount images into
   kernel.wasm memory at boot? Default: through `kh_real_*`; revisit if startup
   cost is unacceptable.

## Extensions Live in the KernelHostInterface, Not the Kernel

The TS kernel exposes `host_extension_invoke` as the user-facing escape hatch
for "syscalls implemented via a plugin" — database access, custom host
callbacks, Python-backed handlers, etc. Extensions are _the_ mechanism for
adding new syscall-shaped functionality without changing the ABI.

In the sandboxed-kernel split this means: **kernel.wasm does not host
extensions.** It forwards `host_extension_invoke` straight through to the
kernel-host interface via a `kh_extension_invoke` import (TBD; will be added to
`kernel_host_abi.toml` when we port the syscall). Each kernel-host interface embedder owns
its own extension registry — wasmtime hosts register native Rust handlers, the
browser kernel-host interface registers JS/TS handlers via JSPI, and so on. The kernel
only carries bytes between the calling process and the host-side handler.

Consequence: adding a new domain capability ("access a database", "call a custom
RPC", "invoke a TS callback") is an extension registration on the kernel-host interface
side, never a kernel.wasm change. New user-facing syscalls inside
`yurt_abi.toml` remain rare — they're reserved for genuinely kernel-resident
concerns (process tree, fd table, signals, VFS).

## Non-Goals

- Replacing user processes' ABI surface. They keep importing `host_*`.
- Multi-tenant kernel sharing. One kernel.wasm per logical sandbox.
- Removing TypeScript before parity. The flag-gated coexistence is the whole
  point of the migration plan.
