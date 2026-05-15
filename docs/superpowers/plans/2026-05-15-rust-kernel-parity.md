# Rust Kernel Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach enough Rust `kernel-wasm` + kernel-host-interface parity with
the current TypeScript kernel, including PR43's pthread/libzmq work, that
`packages/kernel/src` can be retired as the authoritative kernel implementation.

**Architecture:** Keep policy and kernel-owned state in `packages/kernel-wasm`,
and keep host authority in kernel-host-interface adapters. The TypeScript kernel
remains the behavioral oracle until each parity gate passes against the Rust
path; migration is complete only when the same ABI, VFS, process, socket,
pthread, Python/Jupyter, browser/Deno, image, and security tests pass without
routing through the old TypeScript kernel.

**Tech Stack:** Rust `wasm32-wasip1`, Wasmtime, `kernel-wasm`,
`runtime-wasmtime`, kernel-host-interface adapters, Deno TypeScript
compatibility tests, yurt ABI/toolchain C shims, pthread Worker/SAB runtime,
cpython/libzmq/ipykernel fixtures.

---

## Current Baseline

This plan is based on `origin/main` at `949926a` plus PR43
(`fix/yurt-net-dispatcher-logging`) as an explicit input dependency.

Rust already has:

- `packages/kernel-wasm/src/dispatch.rs`: method-id syscall dispatch for process
  basics, fd basics, VFS, `/proc`, fetch, IDB, TCP sockets, spawn/wait,
  scheduler records, and control exports.
- `packages/kernel-wasm/src/kernel.rs`: kernel-owned process, fd, pipe, signal,
  scheduler, and thread record state.
- `packages/kernel-wasm/src/vfs.rs`: mount-table VFS with ramfs, `/dev`,
  `/proc`, tar layer, host-fs, yurtfs/overlay-style pieces.
- `packages/kernel-wasm/src/kh.rs`: `kh_*` imports for time, extension invoke,
  real fs, fetch, sockets, IDB, process engine, and resume hooks.
- `packages/runtime-wasmtime/src/kernel_host_interface.rs` and
  `packages/runtime-wasmtime/src/microkernel.rs`: native host adapter/trampoline
  coverage.
- `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`: broad native
  trampoline tests.

TypeScript still has behavior Rust must match before retirement:

- `packages/kernel/src/host-imports/kernel-imports.ts`: full legacy `host_*`
  ABI, AF_UNIX, sendmsg/recvmsg, socketpair, DNS/fetch, dlopen, fd flags, fd
  passing, tty, pthread imports, JSPI/Asyncify hooks.
- `packages/kernel/src/host-imports/worker-bodies.ts` and
  `packages/kernel/src/process/threads/*`: pthread Worker/SAB runtime, mutexes,
  condvars, worker-host dispatcher, worker-side sockets and polling.
- `packages/kernel/src/process/kernel.ts`: init, pid allocation, parent/child
  tracking, exec aliases, process limits, fd tables, locks,
  tty/session/job-control, waiters, credentials, resource limits.
- `packages/kernel/src/vfs/*`: full VFS, overlay, host mounts, tar images,
  permissions, snapshots, persistence, `/proc`, `/dev`, and image tooling.
- `packages/kernel/src/sandbox.ts`, `image-*`, `persistence/*`, `platform/*`,
  `execution/*`: public sandbox API and host integrations.

PR43 adds mandatory parity requirements:

- Per-pthread TLS exports and bootstrap: `__tls_size`, `__tls_base`,
  `__wasm_init_tls`, `__wasi_init_tp`.
- Per-pthread stack allocation and `__stack_pointer` setup.
- Worker-side `host_socket_open`, `host_socket_bind`, `host_socket_listen`,
  `host_socket_is_dgram`, `host_socket_socketpair`, Unix send/recv, `host_poll`,
  `host_thread_spawn`, fd flags, and minimal WASI imports.
- Shared loopback listener/socket registry between main and pthread workers.
- Advisory `setsockopt` no-op compatibility for SO_LINGER, SO_RCVBUF, SO_SNDBUF,
  SO_BROADCAST.
- Per-chunk stdout/stderr streaming and `YURT_NET_DEBUG` diagnostics for main
  and pthread paths.

## Done Means

- `packages/kernel/src/host-imports/kernel-imports.ts` is no longer the
  authoritative implementation of kernel policy.
- Existing user wasm that imports transitional `host_*` symbols works through
  the Rust kernel path.
- Native Wasmtime, Deno, browser/JS, and worker-thread paths share the same
  `kernel.wasm` behavior.
- All required CI jobs are green:
  - `cargo fmt --all -- --check`
  - `cargo clippy --all-targets -- -D warnings`
  - `cargo test --tests`
  - `deno fmt --check`
  - `deno lint`
  - `deno check 'packages/**/*.ts'`
  - `deno test`
  - guest-compat wasm fixture build, ABI, overlay-VFS, adversarial, unit,
    BusyBox/coreutils/jq/curl, cpython/pyzmq, pthread, and jupyter smoke suites

## Work Packages

### Task 1: Land PR43 Before Rust Parity Work

**Files:**

- Merge dependency: PR43 `fix/yurt-net-dispatcher-logging`
- Verify: `abi/src/yurt_socket.c`
- Verify: `abi/toolchain/yurt-toolchain/src/lib.rs`
- Verify: `packages/kernel/src/host-imports/worker-bodies.ts`
- Verify: `packages/kernel/src/process/threads/worker-thread-host.ts`
- Verify: `packages/kernel/src/process/threads/worker-host-proxy.ts`
- Verify: `packages/kernel/src/sandbox.ts`
- Verify: `scripts/diagnostics/run_jupyter_smoke.ts`

- [ ] **Step 1: Merge or rebase PR43 onto the Rust-parity branch**

Run:

```bash
git fetch origin pull/43/head:pr43-yurt-net-dispatcher-logging
git merge --no-ff pr43-yurt-net-dispatcher-logging
```

Expected: merge succeeds or conflicts are only in files listed above.

- [ ] **Step 2: Rebuild threaded cpython after PR43**

Run:

```bash
./scripts/rebuild-threaded-cpython.sh
```

Expected: rebuilt `cpython3.wasm` exports `__tls_size`, `__tls_base`, and
`__wasm_init_tls`.

- [ ] **Step 3: Verify PR43's behavioral floor**

Run:

```bash
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/process/threads/__tests__
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/cpython3-pyzmq_smoke_test.ts
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/jupyter_smoke_test.ts
```

Expected: pthread tests, cpython3-pyzmq smoke, and jupyter smoke pass with
PR43's accepted shapes.

### Task 2: Create a Rust-vs-TS Parity Manifest

**Files:**

- Create: `docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix.md`
- Modify: `packages/runtime-wasmtime/tests/fixture_parity.rs`
- Modify: `packages/kernel/src/host-imports/__tests__/imports-parity_test.ts`

- [ ] **Step 1: Generate the source-of-truth syscall rows**

Run:

```bash
rg "^\[method\.sys_|^\[import\.host_" abi/contract/yurt_abi_methods.toml abi/contract/yurt_abi.toml
```

Expected: every transitional `host_*` import has a stable method id or an
explicit compatibility reason.

- [ ] **Step 2: Document every row**

Create `docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix.md` with
columns:

```markdown
| Area    | Legacy TS symbol                          | Rust method/import                         | Rust owner               | Adapter owner    | Status  | Required tests                                   |
| ------- | ----------------------------------------- | ------------------------------------------ | ------------------------ | ---------------- | ------- | ------------------------------------------------ |
| process | host_getpid                               | METHOD_SYS_GETPID                          | kernel-wasm              | all KH adapters  | done    | kernel_wasm_trampoline, imports-parity           |
| process | host_getppid                              | METHOD_SYS_GETPPID                         | kernel-wasm              | all KH adapters  | done    | kernel_wasm_trampoline, proc tests               |
| pthread | host_thread_spawn                         | host-control thread spawn + worker adapter | kernel-wasm + KH adapter | JS/Deno/Wasmtime | missing | worker-sab, pthread canaries, cpython3-pyzmq     |
| network | host_socket_socketpair                    | METHOD_SYS_SOCKETPAIR                      | kernel-wasm              | all KH adapters  | partial | socket canary, pyzmq, jupyter                    |
| network | host_socket_sendmsg/recvmsg               | METHOD_SYS_SOCKET_SENDMSG/RECVMSG          | kernel-wasm              | all KH adapters  | partial | AF_UNIX fd-passing tests                         |
| vfs     | host_read_file/write_file/open/read/write | METHOD_SYS_OPEN/READ/WRITE/etc             | kernel-wasm              | all KH adapters  | partial | file-conformance, overlay-vfs, busybox/coreutils |
```

Expected: no row has an empty `Status` or `Required tests` cell.

- [ ] **Step 3: Add a CI-friendly parity assertion**

Extend `packages/runtime-wasmtime/tests/fixture_parity.rs` so it reads
`abi/contract/yurt_abi_methods.toml` and asserts that every method categorized
as `sys_*` has one of:

- a dispatch arm in `packages/kernel-wasm/src/dispatch.rs`
- a documented skip row in the parity matrix with
  `Status = intentionally deferred`

Expected: missing Rust dispatch coverage fails in Rust tests before runtime
behavior diverges.

### Task 3: Port PR43 Pthread TLS, Stack, and Worker WASI Bootstrap

**Files:**

- Modify: `abi/toolchain/yurt-toolchain/src/lib.rs`
- Modify: `abi/toolchain/yurt-toolchain/src/main.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Modify: `packages/runtime-wasmtime/src/microkernel.rs`
- Modify: `packages/kernel-wasm/src/kernel.rs`
- Test: `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`
- Test:
  `packages/kernel/src/process/threads/__tests__/worker-thread-host_test.ts`

- [ ] **Step 1: Make optional TLS exports canonical**

Ensure `abi/toolchain/yurt-toolchain/src/lib.rs` has:

```rust
pub const YURT_OPTIONAL_EXPORTS: &[&str] = &["__tls_size", "__tls_base", "__wasm_init_tls"];
```

Ensure `abi/toolchain/yurt-toolchain/src/main.rs` passes each optional export
via `--export-if-defined`.

- [ ] **Step 2: Add adapter-side pthread bootstrap tests**

Add Wasmtime-side tests that instantiate a threaded fixture and assert each
pthread instance:

- allocates unique TLS base
- initializes TLS with `__wasm_init_tls`
- runs `__wasi_init_tp`
- allocates a unique stack region
- writes `__stack_pointer = stack_base + stack_size`

Expected failing symptom before implementation: two worker instances report
identical TLS base or stack pointer.

- [ ] **Step 3: Implement bootstrap in the Rust KH adapter**

In the user-process spawning path, mirror PR43's worker bootstrap:

1. instantiate the module with shared memory
2. read optional `__tls_size`
3. call exported `__alloc(tls_size)`
4. write `__tls_base`
5. call `__wasm_init_tls(tls_base)`
6. allocate `2 * 1024 * 1024` bytes for pthread stack
7. set `__stack_pointer` to stack top
8. call `__wasi_init_tp`

Expected: cpython's `_PyThreadState_Attach: non-NULL old thread state` failure
does not reproduce under Rust.

- [ ] **Step 4: Verify with pthread and cpython canaries**

Run:

```bash
cargo test -p yurt-runtime-wasmtime kernel_wasm_trampoline -- --nocapture
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/cpython3-pyzmq_smoke_test.ts
```

Expected: TLS/stack tests pass and cpython3-pyzmq smoke still passes.

### Task 4: Port Worker-Side Socket, Poll, and Spawn Dispatch

**Files:**

- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `packages/kernel-wasm/src/kernel.rs`
- Modify: `packages/kernel-wasm/src/kh.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Modify: `packages/runtime-wasmtime/src/microkernel.rs`
- Modify: `abi/contract/yurt_abi_methods.toml`
- Test: `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`
- Test: `packages/kernel/src/host-imports/__tests__/worker-bodies_test.ts`

- [ ] **Step 1: Add parity tests for PR43 worker socket operations**

Write tests for:

- worker `socket(AF_INET, SOCK_STREAM)` returns a kernel fd
- worker `bind(127.0.0.1, 0)` records loopback bind metadata
- worker `listen()` registers in the shared loopback listener table
- worker `host_socket_is_dgram(fd)` returns `0` for stream, `1` for datagram,
  `-EBADF` for non-socket
- worker `host_poll` observes socketpair/readiness events without requiring an
  async dispatcher body
- nested worker `host_thread_spawn` returns a real tid

Expected: tests fail until Rust adapter exposes equivalent worker forwarding.

- [ ] **Step 2: Add socket fd entries to kernel-owned fd state**

Extend `packages/kernel-wasm/src/kernel.rs` so `FdEntry` includes socket-backed
records instead of keeping socket handles entirely in host adapter state.
Include:

```rust
Socket {
    handle: i32,
    domain: u32,
    sock_type: u32,
    nonblocking: bool,
    bound_addr: Option<Vec<u8>>,
    local_addr: Option<Vec<u8>>,
    is_dgram: bool,
}
```

Expected: `dup`, `dup2`, `close`, `poll`, and `/proc` can reason over sockets
consistently.

- [ ] **Step 3: Wire worker-compatible socket operations**

Map PR43 worker operations to Rust kernel methods:

- AF_INET stream socket open
- bind/listen/is_dgram
- socketpair
- Unix send/recv
- poll
- fd descriptor flags
- nested thread spawn

Expected: worker-originating socket fds and main-originating socket fds share
the same registry and close semantics.

- [ ] **Step 4: Verify libzmq path**

Run:

```bash
YURT_NET_DEBUG=1 deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/libzmq-reactor-spawn_reproducer_test.ts
```

Expected: original `bridge.requestSync` deadlock shape does not reappear;
failures, if any, are downstream and logged with pthread socket/poll traces.

### Task 5: Complete Network Parity

**Files:**

- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `packages/kernel-wasm/src/kh.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/network.rs`
- Modify: `packages/kernel/src/network/socket-backend.ts` only for parity
  tests/reference, not new authority
- Test: `packages/runtime-wasmtime/tests/network.rs`
- Test: `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`
- Test: `packages/kernel/src/network/__tests__/*`

- [ ] **Step 1: Match TypeScript socket surface**

Port or prove parity for:

- `host_dns_resolve`
- `host_get_local_addr`
- `host_socket_option`
- `host_socket_bind`
- `host_socket_connect`
- `host_socket_listen`
- `host_socket_accept`
- `host_socket_addr`
- `host_socket_send`
- `host_socket_recv`
- `host_socket_sendto`
- `host_socket_recvfrom`
- `host_socket_sendmsg`
- `host_socket_recvmsg`
- `host_socket_socketpair`
- `host_socket_info`
- `host_socket_close`
- AF_UNIX pathname sockets
- AF_UNIX abstract sockets
- fd passing over Unix sockets
- peer credentials
- datagram-vs-stream behavior

- [ ] **Step 2: Preserve advisory socket option compatibility**

Make set-side socket options return success for:

- SO_REUSEADDR
- SO_KEEPALIVE
- SO_LINGER
- SO_RCVBUF
- SO_SNDBUF
- SO_BROADCAST

Expected: get-side unknown options still return `-ENOTSUP`, but set-side
advisory knobs do not kill jupyter/libzmq setup.

- [ ] **Step 3: Verify with network and Python smoke**

Run:

```bash
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/network/__tests__
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/cpython3-pyzmq_smoke_test.ts
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/jupyter_smoke_test.ts
```

Expected: Rust path matches the TS socket behavior needed by pyzmq and jupyter.

### Task 6: Complete Process, Wait, Fork/Exec, and Signal Parity

**Files:**

- Modify: `packages/kernel-wasm/src/kernel.rs`
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Modify: `packages/runtime-wasmtime/src/wasi_shim.rs`
- Reference: `packages/kernel/src/process/kernel.ts`
- Test: `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`
- Test: `packages/kernel/src/__tests__/sandbox-spawn_test.ts`
- Test: `packages/kernel/src/process/__tests__/kernel_test.ts`

- [ ] **Step 1: Port process table semantics**

Rust must match TypeScript semantics for:

- PID 1 init process
- max process limit
- parent/child registration
- orphan reparenting
- zombie state until wait
- `waitpid(WNOHANG)` and specific-pid waits
- `exec` visible-pid aliases
- process command metadata for `/proc`
- kill status encoding

- [ ] **Step 2: Port fd inheritance and fd actions**

Rust must match:

- spawn fd maps
- pass_fds
- close-on-exec descriptor flags
- dup-min behavior
- stdio inheritance
- pipe refcount and EOF/EPIPE semantics
- fd table clone for fork

- [ ] **Step 3: Port signal behavior**

Replace record-only signal stubs with behavior equivalent to the TS kernel:

- `sigaction`
- pending signal queueing
- ignored/default signal handling
- `kill`
- `killpg`
- process exit status on signal

- [ ] **Step 4: Verify process canaries**

Run:

```bash
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/sandbox-spawn_test.ts
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/abi_test.ts --filter "process"
cargo test -p yurt-runtime-wasmtime kernel_wasm_trampoline -- --nocapture
```

Expected: Rust process behavior is indistinguishable from TS for current ABI
canaries.

### Task 7: Complete TTY, Session, and Job-Control Parity

**Files:**

- Modify: `packages/kernel-wasm/src/kernel.rs`
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Reference: `packages/kernel/src/wasi/fd-target.ts`
- Reference: `packages/kernel/src/process/kernel.ts`
- Test: `packages/kernel/src/__tests__/shell-ergonomics_test.ts`
- Test: `packages/kernel/src/process/__tests__/kernel_test.ts`

- [ ] **Step 1: Port controlling TTY state**

Rust must track:

- tty ids
- tty master/slave fd targets
- controlling tty per process
- foreground process group per tty
- master/slave close/HUP behavior

- [ ] **Step 2: Port job-control syscalls**

Rust must match:

- `getpgid`
- `setpgid`
- `getsid`
- `setsid`
- `tcgetpgrp`
- `tcsetpgrp`
- `TIOCSCTTY`
- `isatty`
- `tcgetattr`
- `tcsetattr`
- `winsize`

- [ ] **Step 3: Verify shells and BusyBox**

Run:

```bash
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/shell-ergonomics_test.ts
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/busybox-conformance_integration_test.ts
```

Expected: shell behavior and job-control-adjacent BusyBox cases match TS.

### Task 8: Complete VFS, Image, Overlay, and Persistence Parity

**Files:**

- Modify: `packages/kernel-wasm/src/vfs.rs`
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Reference: `packages/kernel/src/vfs/*`
- Reference: `packages/kernel/src/image-builder.ts`
- Reference: `packages/kernel/src/image-loader.ts`
- Reference: `packages/kernel/src/image-exporter.ts`
- Reference: `packages/kernel/src/persistence/*`
- Test: `packages/kernel/src/vfs/__tests__/*`
- Test: `packages/kernel/src/__tests__/persistence-overlay_test.ts`
- Test: `packages/kernel/src/__tests__/image-*_test.ts`

- [ ] **Step 1: Port metadata and permissions exactly**

Rust VFS must match TS for:

- uid/gid/mode/mtime
- lstat vs stat
- symlink following
- lchown behavior
- chmod/chown permissions
- directory execute/search permission
- umask on create
- root vs non-root behavior

- [ ] **Step 2: Port overlay/image behavior**

Rust VFS must match:

- tar image root provider
- tar install
- overlay upper/lower copy-up
- whiteouts/tombstones if present in TS behavior
- fork/snapshot COW isolation
- image export/import
- host mounts
- `/dev/null`, `/dev/zero`, `/proc/*`

- [ ] **Step 3: Port persistence backends through KH adapter**

Rust path must expose equivalent import/export/offload/rehydrate behavior for:

- memory backend
- fs backend
- IndexedDB/browser backend through KH adapter
- serialized state compatibility or a migration command

- [ ] **Step 4: Verify file and image gates**

Run:

```bash
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/vfs/__tests__
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/file-conformance_integration_test.ts
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/persistence_overlay_test.ts
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/image-loader_test.ts packages/kernel/src/__tests__/image-exporter_test.ts packages/kernel/src/__tests__/image-builder_test.ts
```

Expected: Rust VFS behavior passes the old TS VFS test corpus before TS VFS
authority is removed.

### Task 9: Port Dynamic Linking and Extension Behavior

**Files:**

- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `packages/kernel-wasm/src/kh.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Reference: `packages/kernel/src/process/dynlink.ts`
- Reference: `packages/kernel/src/extension/*`
- Test: `packages/kernel/src/__tests__/abi_test.ts`
- Test: `packages/kernel/src/extension/__tests__/registry_test.ts`

- [ ] **Step 1: Port extension invocation contract**

Rust must preserve:

- opaque request bytes
- host registry dispatch
- `-ENOENT` when no extension is registered
- policy gate before host invocation
- response buffer retry semantics

- [ ] **Step 2: Port dlopen/dlsym/dlclose behavior**

Rust must match:

- canonical path cache
- handle refcounts
- global/local symbol visibility
- missing path errors
- missing symbol errors
- bad format errors
- double-open refcount behavior
- lazy/now equivalence required by current canaries

- [ ] **Step 3: Verify dlopen and extensions**

Run:

```bash
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/extension/__tests__
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/abi_test.ts --filter "dlopen|extension"
```

Expected: current dlopen canary cases pass through Rust.

### Task 10: Port Security, Policy, Limits, and Diagnostics

**Files:**

- Modify: `packages/kernel-wasm/src/kh.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Modify: `packages/runtime-wasmtime/src/microkernel.rs`
- Modify: `packages/runtime-wasmtime/src/dispatcher.rs`
- Reference: `packages/kernel/src/security.ts`
- Reference: `packages/kernel/src/sandbox.ts`
- Test: `packages/kernel/src/__tests__/security_test.ts`
- Test: `packages/kernel/src/__tests__/security-adversarial_test.ts`

- [ ] **Step 1: Port policy gates to every outside-world crossing**

Every `kh_*` path must gate before host authority:

- real fs open/read/write/unlink/mkdir/symlink/rename/stat
- sockets connect/listen/accept/send/recv
- fetch
- IDB/KV
- extension invoke
- process spawn/resume/memory copy
- realtime clock when configured
- log sink when configured

- [ ] **Step 2: Port sandbox limits**

Rust must enforce:

- command byte limit
- stdout/stderr byte limits
- process count limit
- filesystem byte/file limits
- timeout/hard-kill behavior
- cancellation state
- audit events

- [ ] **Step 3: Port PR43 diagnostics**

Rust must expose:

- `YURT_NET_DEBUG=1` equivalent for main and pthread socket paths
- pthread poll request/response logging
- pthread spawn logging
- socket option logging
- per-chunk stdout/stderr streaming before command completion
- diagnostic launcher compatibility for
  `scripts/diagnostics/run_jupyter_smoke.ts`

- [ ] **Step 4: Verify adversarial gates**

Run:

```bash
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/security_test.ts
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/security-adversarial_test.ts
YURT_NET_DEBUG=1 deno run --no-check -A --unstable-sloppy-imports scripts/diagnostics/run_jupyter_smoke.ts
```

Expected: denial tests fail closed and diagnostics expose long-running stalls.

### Task 11: Port Public API and Host Adapters

**Files:**

- Modify: `packages/kernel/src/sandbox.ts`
- Modify: `packages/kernel/src/kernel-api.ts`
- Modify: `packages/kernel/src/platform/*`
- Modify: `packages/kernel/src/execution/*`
- Modify: `packages/runtime-wasmtime/src/dispatcher.rs`
- Add or modify: JS/Deno/browser kernel-host-interface adapter files once their
  final package names are chosen
- Test: `packages/kernel/src/__tests__/sandbox_test.ts`
- Test: `packages/kernel/src/platform/__tests__/*`
- Test: `packages/kernel/src/execution/__tests__/*`

- [ ] **Step 1: Add a Rust-kernel backend behind the existing Sandbox API**

Expose the Rust kernel path without changing callers:

- `Sandbox.create(...)`
- `sandbox.run(...)`
- `sandbox.fork()`
- `sandbox.snapshot/restore`
- `sandbox.offload/rehydrate`
- streaming callbacks
- mount/image/persistence options

Expected: API-level tests can run against both TS and Rust backends using the
same assertions.

- [ ] **Step 2: Port portable JS/browser KH adapter**

Implement a KH adapter that can:

- instantiate `kernel.wasm`
- instantiate user wasm with transitional `host_*` imports
- copy request/response bytes through kernel scratch
- provide JSPI/Asyncify suspension for async `kh_*`
- share memory/SAB for pthreads where supported
- degrade or reject explicitly where browser capabilities do not exist

- [ ] **Step 3: Port Deno-specific KH extensions**

Implement Deno authority for:

- real fs
- raw/loopback sockets where available
- IndexedDB or equivalent persistence
- subprocess/tool integration if still required

- [ ] **Step 4: Verify API parity**

Run:

```bash
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/__tests__/sandbox_test.ts
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/platform/__tests__
deno test --no-check -A --unstable-sloppy-imports packages/kernel/src/execution/__tests__
```

Expected: callers do not need to know whether TS or Rust owns the kernel.

### Task 12: Build the Retirement Gate and Remove TypeScript Authority

**Files:**

- Modify: `.github/workflows/guest-compat.yml`
- Modify: `.github/workflows/deno.yml`
- Modify: `.github/workflows/rust.yml`
- Modify: `deno.json`
- Modify: `Cargo.toml`
- Modify or delete after parity:
  `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify or delete after parity: `packages/kernel/src/process/kernel.ts`
- Modify or delete after parity: `packages/kernel/src/vfs/*` authority paths

- [ ] **Step 1: Add dual-run parity CI**

For every legacy TS conformance test, run:

- old TS backend
- new Rust backend
- compare exit code/stdout/stderr/VFS side effects where deterministic

Expected: CI reports exactly which old behavior is still missing from Rust.

- [ ] **Step 2: Flip the default backend**

Change local and CI default to Rust only after all parity tests pass.

Expected: TS backend is opt-in fallback for one transition PR, not default.

- [ ] **Step 3: Delete or demote TypeScript kernel authority**

Remove or demote TS files after Rust becomes default:

- keep API wrappers only when needed
- remove duplicated policy/state implementations
- remove TS-only socket/process/VFS paths that are no longer used
- keep tests as black-box backend tests

- [ ] **Step 4: Run full gates**

Run:

```bash
pre-commit run --all-files
cargo test --tests
deno test --no-check -A --unstable-sloppy-imports 'packages/**/*_test.ts'
```

Then verify PR CI:

```bash
gh pr checks --watch
```

Expected: required Rust, Deno, and guest-compat jobs are green before claiming
the old kernel is retired.

## Suggested PR Slicing

1. PR43 merge/rebase and fixture rebuild.
2. Parity matrix and CI coverage assertions.
3. Pthread TLS/stack bootstrap in Rust adapters.
4. Worker-side socket/poll/spawn parity.
5. Full socket parity including AF_UNIX, sendmsg/recvmsg, socketpair, fd
   passing.
6. Process/fd/wait/fork/exec/signal parity.
7. TTY/session/job-control parity.
8. VFS/image/overlay/persistence parity.
9. Dynamic linking/extensions parity.
10. Security/diagnostics/limits parity.
11. Public API and JS/Deno/browser KH adapters.
12. Dual-run CI, default flip, TypeScript authority removal.

## Verification Checklist

- [ ] PR43 behavior is present in the branch or merged into base.
- [ ] `cargo test -p yurt-runtime-wasmtime` passes.
- [ ] `cargo build --target wasm32-wasip1 -p yurt-kernel-wasm` passes.
- [ ] `deno fmt --check` and `deno lint` pass.
- [ ] `deno check 'packages/**/*.ts'` passes.
- [ ] `deno test` fast tier passes.
- [ ] `guest-compat.yml` passes against the Rust backend.
- [ ] `cpython3-pyzmq` passes against the Rust backend.
- [ ] `jupyter_smoke_test.ts` passes against the Rust backend with PR43's
      accepted shapes or a stricter successor shape.
- [ ] `scripts/diagnostics/run_jupyter_smoke.ts` produces useful Rust-backend
      diagnostics with `YURT_NET_DEBUG=1`.
- [ ] No new JSON is introduced at the guest/kernel boundary.
- [ ] All outside-world `kh_*` crossings are policy-gated.
