# YurtOS Architecture & Ecosystem Overview

> **Audience:** an engineer or AI agent starting fresh on YurtOS. This is the
> single orientation doc — what the system is, how the repos fit together, what
> is implemented, and what is in flight.
>
> **Snapshot freshness:** last reviewed **2026-05-18** against `main`
> (`origin/main` at the time). Sections marked _(snapshot)_ cite PR/issue
> numbers that go stale fast — the **living** sources of truth are the tracking
> issues **#52** (parity), **#71** (holistic review), **#172** (TS retirement)
> and the design specs under `docs/superpowers/specs/`. Procedure for working in
> this repo is **not** here — see [`AGENTS.md`](../AGENTS.md) (canonical).

---

## 1. What YurtOS is

YurtOS is a **sandbox runtime that runs WASM guest programs against a Yurt-owned
process, filesystem, and syscall surface** — an OS-like userland (processes,
fds, signals, sockets, a VFS, an image format) implemented entirely in software
so the same programs run identically on native hosts, in Deno, and in the
browser.

The defining architectural move
(`docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`): **the kernel
itself is compiled to `wasm32-wasip1`** (`kernel.wasm`). It runs in its own
sandbox the same way user processes do. A thin per-platform **kernel-host (KH)
interface** owns only the wasm engine and the outside world (real fs, network,
clock, scheduling). One Rust kernel source serves every host.

- **Kernel.wasm owns _policy_:** VFS layout, process tree, fd table, signal
  routing, security checks, image semantics, network policy.
- **The KH interface owns _mechanism_:** instantiate wasm, copy bytes between
  linear memories, perform real I/O, suspend/resume on JS hosts, preempt on
  native.

The KH interface is a **pluggable backend**: any wasm runtime that can host the
`kh_*` imports and call `kernel_dispatch` is a supported backend.

**Languages & pins:** a Rust workspace (root `Cargo.toml`, toolchain **1.95.0**)
plus TypeScript on **Deno 2.x** (`deno.json`, sources under `packages/`). WASM
crates target `wasm32-wasip1` and are intentionally excluded from
`default-members` so a plain `cargo build` does not link them natively.

> **Current operational reality (snapshot):** on `main`, `deno.json` still maps
> `@yurt/kernel → packages/kernel/src` and the README states the **TypeScript
> kernel is the main developer entry point today**. The Rust `kernel.wasm` is
> the real implementation and the destination; the TS kernel is being retired
> (§7). Both implement the same `yurt_abi.toml` surface during the transition.

---

## 2. The kernel / host split

```
┌──────────────────────────────────────────────────────────────┐
│ Kernel-Host (KH) Interface / adapter  (per-platform)         │
│  - native Wasmtime   packages/runtime-wasmtime               │
│  - any JS engine     packages/kernel-host-interface-js        │
│       (Deno, browsers, Node, Bun share this)                 │
│  - Deno-only adds    packages/kernel-host-interface-deno      │
│       (real fs / sockets / subprocess on top of -js)         │
│  - bare CLI          wasmtime run kernel.wasm                │
└──────┬───────────────────────────────────────┬───────────────┘
       │ user→kernel trampoline                 │ kernel→host (kh_*)
       ▼                                        ▼
 ┌──────────────────┐                  ┌────────────────────────┐
 │ User process     │                  │ Kernel WASM            │
 │ imports host_*   │                  │ packages/kernel-wasm   │
 │ (yurt_abi.toml)  │                  │ wasm32-wasip1          │
 └──────────────────┘                  └────────────────────────┘
```

> Naming note: the 2026-05-09 design doc's diagram labels the native adapter
> `packages/kernel-host-interface-wasmtime`; the **actual crate is
> `packages/runtime-wasmtime`**. The design doc explicitly calls existing
> package names "historical; architecturally they are KH adapters."

### Three ABI surfaces (no JSON at the guest↔kernel boundary)

| Surface                   | Contract                            | Shape                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **User → Kernel**         | `abi/contract/yurt_abi.toml`        | Legacy `host_*` imports (transitional; eventual `sys_*`). KH copies the request out of process memory, calls `kernel_dispatch(method_id, in_ptr, in_len, out_ptr, out_cap)`, copies the response back. `method_id` is a stable `u32` pinned in `abi/contract/yurt_abi_methods.toml`. |
| **Kernel → Host**         | `abi/contract/kernel_host_abi.toml` | ~20 `kh_*` imports (time/entropy, real fs, sockets/fetch, wasm-engine ops, idb KV, diagnostics, `kh_yield`).                                                                                                                                                                         |
| **Host → Kernel control** | exports on `kernel.wasm`            | `kernel_spawn_process`, `kernel_record_exit`, `kernel_drain_spawn`, `kernel_kill`, `kernel_wait`, `kernel_list_processes`, `kernel_snapshot`, thread-control exports. Binary records only.                                                                                           |

Calling convention everywhere: scalar `>= 0` success / `< 0` negated POSIX
errno; variable results into caller-provided fixed-layout out buffers (WASI
preview1 style). JSON is allowed only for host-level JSON-RPC / manifests /
application payloads, never for kernel-owned wire formats. See
[`AGENTS.md`](../AGENTS.md) "No JSON at the guest↔kernel boundary".

### Suspension & concurrency

`kernel.wasm` is **single-threaded** for kernel execution; the KH interface
serializes `kernel_dispatch` under a per-instance lock. User processes may be
truly multi-threaded — the kernel owns the thread-group model even when the host
uses Workers/SAB or native threads.

Suspension reuses the `AsyncBridge` in `packages/kernel/src/async-bridge.ts`
with three modes:

- **native Wasmtime:** Tokio-driven async stores + `epoch_interruption`;
  `kh_yield` is a real `tokio::task::yield_now`. No JS bridge.
- **JSPI** (Deno 1.40+/Chrome 137+): `kh_*` async imports wrapped as
  `WebAssembly.Suspending`; `kernel_dispatch` wrapped via
  `WebAssembly.promising`.
- **asyncify** (Safari/Bun fallback): `wasm-opt --asyncify` `-asyncify` binary;
  also the mechanism for `setjmp`/`longjmp`.
- **threads** (future): wasi-threads + SAB + `Atomics.wait`.

Two JS-host absolutes: cooperative multitasking makes **every** `sys_*` call a
suspension point; `setjmp`/`longjmp` always requires asyncify. Native Wasmtime
avoids both via epoch interruption.

---

## 3. Workspace & crate map

Rust workspace = 54 members; only **6** native crates are `default-members`
(everything WASM-only is excluded so `cargo build` doesn't link wasm targets).

### Rust crates

| Crate                                                                          | default-member | Purpose                                                                                                                          |
| ------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel-wasm`                                                         | no             | **The kernel.** Compiles to `wasm32-wasip1`. Dispatch, VFS, process/thread/socket/signal state.                                  |
| `packages/runtime-wasmtime`                                                    | no             | **Native Wasmtime KH host.** Instantiates `kernel.wasm`, implements `kh_*`, JSON-RPC dispatch over stdio, spawns user processes. |
| `packages/kernel-host-interface-core`                                          | no             | Engine-agnostic Rust trait scaffolding (`WasmEngine` etc.) so host code isn't bound to one runtime.                              |
| `packages/kernel-host-interface-wasmedge`, `-wasmer`                           | no             | Future engine adapters (placeholders, not wired).                                                                                |
| `abi/rust/yurt-abi-sys`                                                        | **yes**        | Low-level FFI to the native ABI.                                                                                                 |
| `abi/rust/yurt-abi`                                                            | **yes**        | Safe Rust wrapper over `yurt-abi-sys`.                                                                                           |
| `abi/rust/yurt-wasi-shims`                                                     | **yes**        | WASI shims for libc compat.                                                                                                      |
| `abi/toolchain/yurt-toolchain`                                                 | **yes**        | C-compiler drop-in (`yurt-cc`/`yurt-ar`/`cargo-yurt` …).                                                                         |
| `abi/toolchain/yurt-wasi-postlink`                                             | no             | Post-link wasm transform tool.                                                                                                   |
| `test-fixtures/yurt-process`                                                   | **yes**        | Native test process fixture.                                                                                                     |
| `test-fixtures/wasm/*`, `test-fixtures/shell*`, `test-fixtures/zstd-sys-smoke` | no             | WASM guest fixtures.                                                                                                             |
| `abi/conformance/rust/*-canary` (~30)                                          | no             | POSIX conformance canaries (wasm32-wasip1) exercised by the parity gate.                                                         |

`packages/kernel-wasm/src/`: `lib.rs` (entry/scratch/IO validation), `kernel.rs`
(process/thread/fd/socket/VFS state), `dispatch/` (`mod.rs` router +
`fs.rs`/`process.rs`/`socket.rs`/`thread.rs`/`tests.rs`), `vfs.rs`, `kh.rs`
(`kh_*` imports), `abi.rs`, `path.rs`, `state.rs`.

`packages/runtime-wasmtime/src/`: `kernel_host_interface.rs`, `dispatcher.rs`,
`engine.rs`, `sandbox.rs`, `wasi_shim.rs`, `rpc.rs`, `main.rs`, `vfs/`, `wasm/`.

### TypeScript / Deno packages (not in the Cargo workspace)

| Package                               | Purpose                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel`                     | The **old TS kernel** (~60k LOC: `host-imports/`, `process/`, `vfs/`, `wasi/`, `network/`, `persistence/`, `extension/`, `boot/`, `execution/`, `sandbox.ts`, `async-bridge.ts`, image tooling, parity harness). Current operational default; slated for deletion (§7). |
| `packages/kernel-host-interface-js`   | Portable KH adapter for any JS engine (no engine-specific APIs). Already drives the real `kernel.wasm` with zero `@yurt/kernel` imports.                                                                                                                                |
| `packages/kernel-host-interface-deno` | Deno-only extensions (real fs/sockets/subprocess) on top of `-js`.                                                                                                                                                                                                      |
| `packages/cli`                        | Interactive sandbox shell + image runner/builder (`packages/cli/src/cli.ts`).                                                                                                                                                                                           |

---

## 4. Subsystem implementation status

Status as understood on `main` (snapshot). "Stub/degraded" = present but
intentionally simplified; "planned" = not yet implemented.

| Subsystem                                                                                                                                         | Status                                             | Key location                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VFS** — mount table, ramfs, overlay (COW), tar.zst image layers, procfs, devfs, hostfs; per-component symlink resolution; inode-anchored dirfds | Implemented                                        | `packages/kernel-wasm/src/vfs.rs`                                                                                                                                                                                                                 |
| **Process/thread mgr** — spawn (pending-spawn queue), fork-state tracking, creds, cwd inode-anchoring, `waitid`, thread group/cancel              | Implemented                                        | `kernel.rs`, `dispatch/process.rs`                                                                                                                                                                                                                |
| **Signals** — 1..=64 incl. RT (SIGRTMAX), `sigaction`/`sigpending`/`sigqueue`/`sigwaitinfo`, per-thread + process masks                           | Implemented; delivery pre-queue partially degraded | `dispatch/process.rs`                                                                                                                                                                                                                             |
| **Sockets** — AF_INET + AF_UNIX (IPv4), options, listen/accept (async backends), `sendmsg`/`recvmsg` SCM_RIGHTS, MSG_PEEK, MSG_CTRUNC, socketpair | Implemented                                        | `dispatch/socket.rs`                                                                                                                                                                                                                              |
| **Syscall dispatch** — fs/process/socket/thread/IPC/persistence/extension/fetch families                                                          | Implemented (broad coverage)                       | `dispatch/mod.rs` + submodules                                                                                                                                                                                                                    |
| **Persistence (idb KV)** — `kh_idb_*` get/put/delete/list; native durable-KV + browser IndexedDB                                                  | Implemented (B4a)                                  | `dispatch` + `kh.rs`                                                                                                                                                                                                                              |
| **Image build/load/export** — Yurtfile, tar.zst, overlay base/upper                                                                               | Implemented                                        | `packages/kernel/src/image-*.ts`                                                                                                                                                                                                                  |
| **Async bridge** — threads-mode is the production path; JSPI & asyncify wiring                                                                    | Partial (JSPI/asyncify TODO)                       | `packages/kernel/src/async-bridge.ts`                                                                                                                                                                                                             |
| **Planned / not yet**                                                                                                                             | —                                                  | AF_INET6 in scope (DNS resolve **descoped**), `select`/`pselect`/`ppoll`, `epoll`/`eventfd`/`timerfd`/`signalfd`, file-backed `mmap` (descope-or-emulate decision pending, #93), real `fork()` (#168), broader `ioctl`, signal pre-queue delivery |

---

## 5. Syscall parity & gates

Goal (tracking **#52**, living spec
`docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md`):
maximal Linux-userland parity (~80–120 syscalls). A row is _done_ only when Rust
owns the state, all KH adapters are wired, fixtures pass, the differ shows
**zero** TS-vs-Rust divergence, **and** the Open POSIX Test Suite area is PASS
(or a justified tracked `UNSUPPORTED`).

**The parity gate:** `packages/kernel/src/__tests__/parity-differ_test.ts` runs
every conformance canary case through both kernels (`YURT_KERNEL=ts|wasm`) and
fails on any observable divergence not allowlisted in
`abi/conformance/parity-baseline.toml`. The baseline can only **shrink** (fixing
a row deletes its entry). One sanctioned exception class: an intentional
POSIX-faithful divergence that retires with the TS kernel. The gate is blocking
only when `YURT_ENABLE_WASM_KERNEL_CI` is set; canary specs are
`abi/conformance/*.spec.toml`.

**Slices — approach C (thin gate first)** _(snapshot)_:

| Slice  | Scope                                                                  | State                              |
| ------ | ---------------------------------------------------------------------- | ---------------------------------- |
| B0     | thin parity gate (`YURT_KERNEL` differ + baseline)                     | merged (#53)                       |
| B1     | process model (SIGCHLD/`waitid`/siginfo/pgrp/`pthread_cancel`/RT-sigs) | merged (#54)                       |
| B2     | FD/VFS (`pread`/`pwrite`/`openat`/`dup3`/`ioctl`/`fcntl`)              | merged (#55)                       |
| B2.8   | `fcntl(F_GETFL)` access-mode                                           | merged (#62)                       |
| B2.9   | `openat`/`fchdir` inode-anchoring                                      | merged (#63)                       |
| B3     | sockets/network (`shutdown`/`SO_PEERCRED`/AF_INET6; DNS descoped)      | merged (#58)                       |
| B4a    | persistence durable-KV + `sys_idb_*`                                   | merged (#61)                       |
| #85    | `*at` family follow-up (S0 #190 / S1 #194 / S2 #195)                   | merged (S2 = `main` HEAD)          |
| **B5** | harden gate — full Open POSIX Test Suite green, CI-locked              | **not yet opened** (next big gate) |
| **B6** | TS retirement (default `YURT_KERNEL=wasm`, delete TS state)            | last; overlaps #172 (§7)           |

**#57** is the umbrella PR — an _intentionally never-merged_ coordination
tracker (draft), by design per #52. Do not expect it to merge.

**Holistic review (#71**, `2026-05-17`, deep multi-agent crate audit): the
critical/security ship-blockers **#65** (32-bit `usize` length-guard wrap),
**#66** (kill/sigqueue authorizing on guest pid), **#67** (`stat` vs `lstat`),
**#68** (`O_EXCL`/`EEXIST`), **#69** (`ELOOP`) are **closed/fixed**; **#70**
(wait-status not Linux-encoded) remains **open**. Remaining M/Low/architecture
checklist items route into the parity slices, not loosely.

---

## 6. Testing & CI

Three blocking workflows ([`AGENTS.md`](../AGENTS.md),
`docs/contributing/gates.md`):

- **`rust.yml`** — `cargo fmt --all -- --check`,
  `cargo clippy --all-targets -- -D warnings`, `cargo test --tests`.
- **`deno.yml`** — `deno fmt --check`, `deno lint`,
  `deno check 'packages/**/*.ts'`, fast `deno test`.
- **`guest-compat.yml`** (slow tier) — wasm fixture/canary builds, BusyBox,
  kernel smoke / ABI conformance / overlay-VFS / adversarial suites.

Local gates via `pre-commit` (`scripts/install-hooks.sh`): pre-commit =
fmt/clippy-on-changed/lint/hygiene; pre-push = `cargo test --tests` + the
`packages/**/*_test.ts` Deno glob. Never `--no-verify`.

**Three known coverage gaps to keep in mind:**

1. **`usize` width.** `kernel-wasm` ships 32-bit `usize` (wasm32) but
   `cargo test` runs 64-bit native — length-guard overflow bugs can pass CI
   invisibly (this exact class was holistic-review ship-blocker **#65**, now
   fixed; the structural gap remains).
2. **`kernel-wasm` not clippy-gated.** It is excluded from `default-members`, so
   CI clippy skips it unless `YURT_ENABLE_WASM_KERNEL_CI` is set. Gate locally:
   `cargo clippy -p yurt-kernel-wasm --target wasm32-wasip1`.
3. **Deno scope.** Pre-existing repo-wide Deno fmt/lint debt means `deno.yml`
   enforces only a curated path list, **not** the full `packages/**/*_test.ts`
   glob — most kernel TS tests are pre-push-only. See
   `docs/contributing/gates.md`.

---

## 7. TypeScript-kernel retirement (umbrella #172) _(snapshot)_

The repo shipped **two** kernels. The Rust `kernel.wasm` is the real one; the
old TS kernel (`packages/kernel/`) is being deleted and replaced by a Deno-side
**Runner** that drives `kernel.wasm` through the surviving KH interface
(`kernel-host-interface-js`/`-deno`/`-core`, `runtime-wasmtime`), reusing
non-kernel code via `git mv`.

| Phase  | Work                                                                                                             | State                           |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1      | extract 21 reusable modules → `packages/runner/` (shims keep callers green)                                      | PR #129                         |
| 2      | Runner + multi-process spawn/wait driver (cross-host parity oracle)                                              | PR #129                         |
| fork() | real return-twice continuation (`2026-05-16-rust-fork-parity-design.md`)                                         | #168 (draft) — unblocks Phase 3 |
| 3      | rewire CLI/scripts/CI off `@yurt/kernel`; rebuild `image-builder.run()`; port ~13 conformance suites onto Runner | #169 (open, blocked)            |
| 4      | `git rm -r packages/kernel/`; drop `@yurt/kernel` alias; delete parity-matrix doc                                | #170 (open, blocked)            |
| 5      | docs (README/AGENTS.md/CLAUDE.md)                                                                                | #171 (open, blocked)            |

> **Important reconciliation:** GitHub reports PR **#129 merged to `main`**, but
> on the `main` snapshot used here `packages/runner/` is **absent**, no
> `@yurt/runner` references exist, and `deno.json` still routes
> `@yurt/kernel → packages/kernel/src`. The runner extraction commits
> (`1816a16b`, `d36219e0`, `930a872a`, `90bfcc6e`) currently live on branch
> `claude/remove-typescript-kernel-CUcuf` (PR #129's head). Treat the TS kernel
> as the **operational default on `main`** and **#172 + the live tree** as
> source of truth — do not assume the Runner is the entry point yet.

---

## 8. Worker / dispatcher async stabilization (this branch's lineage)

Background pthreads (e.g. libzmq's ZMQ Heartbeat in ipykernel) proxy host
imports back to the main thread via SAB. A synchronous dispatcher could not
`await`, so a worker calling `listen()` froze the main event loop ("Task 10",
PR74 follow-up).

- **PR #119** (merged) — async + serialized worker-host dispatcher:
  `WorkerHostSerializer` (per-process Promise-chain mutex) + async
  `WorkerHostDispatcherBodies`, so worker syscalls can suspend without losing
  per-process FIFO ordering of kernel-state mutations.
- Supporting merged work: #162 (worker async socket listen), #185
  (`WorkerHostSerializer` watchdog timeout), #183 (serialize `NetworkBridge`
  fetchSync/requestSync SAB access).
- Open audit: **#125 / PR #186** — whether cross-process kernel-state mutations
  across `await` need a tier above per-process serialization.
- **Current branch `codex/fix-worker-async-listen`** builds directly on #119:
  await worker socket-listen backends, guard stale-fd reuse after async
  suspension, and handle async listen failures cleanly.

---

## 9. Sibling-repo ecosystem (full depth)

All under `git@github.com:YurtOS/…`. Sibling checkouts live at
`/Users/sunny/work/yurtos/`. The pipeline is **compile → package → publish →
install → run**.

```
yurt-clang ──compiler──┐
                       ▼
yurt-ports (recipes) ──uses──> yurt-pkg (yurt-pack) ──produces──> *.yurtpkg.tar.zst
                                                                       │ publish
                                                                       ▼
                                                            yurt-packages (signed repo)
                                                                       │ pkg update/install
                                                                       ▼
                                              yurtos-kernel (Sandbox / Runner over kernel.wasm)
                                                                       │ runs
                                                                       ▼
                                              yurt-greet (smoke) · yurt-agent (LLM harness)
```

### yurtos-kernel — the canonical kernel

This repo. TS kernel (operational default today) + Rust `kernel.wasm`
(destination) + KH interface + ABI/toolchain + conformance canaries. Build/test:
`cargo build` / `cargo test --tests`; `deno run … packages/cli/src/cli.ts`;
`make -C abi all copy-fixtures`.

### yurt-clang — compiler tooling & SDK

Owns the clang-facing toolchain product: host tools `yurt-cc`, `yurt-ar`,
`yurt-ranlib`, `cargo-yurt`; native Yurt clang SDK bootstrap; LLVM/clang driver
patches. **Consumes** ABI/runtime artifacts from `yurtos-kernel` (does not own
the ABI shims — `libyurt_abi.a`/`libyurt_continuation.a` stay in the kernel
repo) via `YURT_KERNEL_ROOT` / installed SDK, never path-guessing. Build:
`cargo build --release -p yurt-toolchain` / `-p yurt-wasi-postlink`.

### yurt-ports — build recipes

Source-to-package recipes; does **not** publish repo metadata. Layout per port:
`port.toml`, `yurt-pack.toml`, `src/`, `files/`, `scripts/{build,package}.sh`.
Compiler wrappers come from the sibling kernel repo; packaging from `yurt-pkg`.
(Active branch at snapshot: `busybox-init-login-getty`.)

### yurt-pkg — package format & tools

**Outside the kernel boundary** (the kernel only applies a prevalidated tar
payload). Defines `<name>-<version>-<build>.yurtpkg` (zstd tar with
`info/index.json`, `info/files.json`, optional `info/yurt.json`). Crates:
`yurt-pkg-format` (library), `yurt-pack` (host build CLI), `pkg` (in-sandbox
client, partly deferred), `yurt-pkg-repo`/`yurt-pkg-trust`/`yurt-repo-ci`
(repo/signing/CI). Docs: `docs/package-format.md`, `docs/pkg.md`,
`docs/building-packages.md`.

### yurt-packages — signed package repository

The repo consumed by `pkg update`: `index.json`(+`.bundle`),
`packages/<name>.json`, `artifacts/<name>/<version>/…`. A manual
`Publish Package` GitHub Actions workflow checks out a port from `yurt-ports`,
builds it, runs `yurt-repo-ci publish-local --reject-existing`, commits
metadata, and pushes. Ships e.g. busybox, clang, libcxx, ncurses, openssl, pkg,
zlib, zsh, yurt-greet.

### yurt-agent — LLM agent harness

A conversation harness packaged for the sandbox. Owns the loop; parses
Anthropic-Messages content blocks (text + `tool_use`), routes tool calls through
a local registry, feeds `tool_result` back until a no-tool turn or
`--max-turns`. **Yurt is the agent; the LLM is pluggable.** Backends: `stub`
(scripted trace, used by tests) and `ollama` (local Ollama). Sibling of
`yurt-greet`/`yurt-python`.

### yurt-greet — end-to-end smoke test

Tiny Rust WASI binary packaged as `.yurtpkg.tar.zst`, run in the kernel sandbox,
exercising the highest-breakage-risk surface: argv (incl. `argv[0]` symlink
dispatch), stdin, env, VFS read + readdir, stdout, exit codes,
`exportState`/`importState`, full package round-trip (build→write→read→extract,
symlinks/hardlinks), and **two entry paths from one package** (a wasm32-wasip1
binary _and_ a Python sibling with identical behavior).

> The `yurtos-kernel-af-unix`, `-ci-fix`, `-fork`, `-pr129` directories under
> `/Users/sunny/work/yurtos/` are **transient feature worktrees of this repo**,
> not separate projects.

---

## 10. Where to look next

- **Procedure & standards (canonical):** [`AGENTS.md`](../AGENTS.md)
- **Why kernel-as-wasm:**
  `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`
- **Parity matrix (living source of truth):**
  `docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md` +
  tracking issue **#52**
- **Holistic review:** issue **#71** (the `docs/superpowers/reviews/` doc is not
  committed to `main`)
- **TS retirement:** issue **#172**; **fork()** spec
  `docs/superpowers/specs/2026-05-16-rust-fork-parity-design.md` (#168)
- **Slice designs:** `docs/superpowers/specs/2026-05-16-*-completion-design.md`,
  `2026-05-16-thin-parity-gate-design.md`,
  `2026-05-1{6,7}-b2.{8,9}-*-design.md`, `2026-05-11-af-unix-design.md`
- **ABI:** `abi/contract/{yurt_abi,yurt_abi_methods,kernel_host_abi}.toml`,
  `docs/abi/native-syscall-abi.md`
- **Gates/images:** `docs/contributing/gates.md`, `docs/images.md`
