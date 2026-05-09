# Plan: Sandboxed Kernel (rosy-stream)

## Context

Today's yurtos-kernel is two-tier: ~16k LOC of TypeScript (Deno) implements the
"kernel" (VFS overlay, image loader, process manager, pipes, fd table, security
policy, network gateway, persistence), and a ~5k LOC Rust crate
(`packages/runtime-wasmtime`) hosts wasmtime and bridges native syscalls
back to the TS kernel via JSON-RPC over stdio. User processes call native
`host_*` imports defined by `abi/contract/yurt_abi.toml`.

The user wants to:

1. **Eliminate two parallel implementations.** Currently moving the kernel to
   Rust would mean either rewriting *everything* or maintaining TS + Rust
   forever. We need one source of truth.
2. **Make the kernel runnable inside a sandbox itself.** The kernel becomes a
   Rust crate compiled to `wasm32-wasip1` (a "kernel.wasm"). The host shrinks
   to a small "microkernel" that owns the wasm engine plus the outside world
   (real fetch, real disk, real clock, scheduling/preemption).
3. **Support multiple hosts uniformly.** Native wasmtime, browser (JSPI;
   asyncify fallback), Deno (browser-like, useful for CLI debug), and a bare
   `wasmtime run yurt-kernel.wasm` mode without any orchestrator.

The user's framing: every syscall already forces a yield on JS-hosted engines
(no preemptive multitasking), so syscall == suspend. User-wasm and kernel-wasm
do not share memory or talk directly — the host trampoline copies bytes
between them. On native wasmtime there's no need to suspend; the trampoline
can just move pointers around (epoch interruption already provides
preemption).

## Architectural Overview

```
┌──────────────────────────────────────────────────────────────┐
│ Host Microkernel (per-platform; small)                       │
│  - wasmtime native:  packages/microkernel-wasmtime           │
│  - browser/JSPI:     packages/microkernel-js            │
│  - deno (debug):     packages/microkernel-deno               │
│  - bare CLI:         `wasmtime run yurt-kernel.wasm`         │
│                                                              │
│  Owns: Engine/Store, real fs/net/clock, spawn-wasm,          │
│        memory copies between instances, scheduling, JSPI/asyncify
└────────┬─────────────────────────────────────┬───────────────┘
         │                                     │
         │ user→kernel trampoline              │ kernel→host calls
         │ (copies bytes between memories)     │ (kh_fetch, kh_now,
         │                                     │  kh_real_fs_*, etc.)
         ▼                                     ▼
┌────────────────────────┐         ┌──────────────────────────┐
│ User process        │         │ Kernel WASM              │
│ (existing model)       │         │ packages/kernel-wasm     │
│  imports: host_*       │         │ (Rust, wasm32-wasip1)    │
│   (yurt_abi.toml)      │         │  exports: kernel_dispatch│
│                        │         │  imports: kh_* (host ABI)│
└────────────────────────┘         └──────────────────────────┘
```

Two distinct ABI surfaces:

- **User→Kernel ABI** = the existing `abi/contract/yurt_abi.toml`. Unchanged
  for user processes. The microkernel forwards each `host_*` call into
  `kernel_dispatch(method_id, in_ptr, in_len, out_ptr, out_cap)` exported by
  kernel.wasm, after copying request bytes from user memory into kernel
  memory.
- **Kernel→Host ABI** = NEW. A small surface for things only the host can do:
  `kh_now`, `kh_random`, `kh_real_fs_open/read/write/close`,
  `kh_fetch_send/poll`, `kh_spawn_process`, `kh_destroy_instance`,
  `kh_process_mem_read/write`, `kh_yield`, `kh_log`. ~20 functions max.

This is a true microkernel split: kernel.wasm owns *policy* (VFS layout,
process tree, fd table, signal routing, security checks, image semantics).
The host owns *mechanism* (run wasm, do I/O, copy bytes, suspend/resume).

## Migration Strategy: Keep TS in Parallel, Then Delete

Per the user's choice, we keep the TS kernel running and build the Rust
kernel-wasm alongside it. Both implement the same `yurt_abi.toml` surface.
A runtime flag (`YURT_KERNEL=ts|wasm`) selects which one services syscalls.
Tests run against both until parity is reached, then TS is deleted.

This is reversible at every step and lets us migrate one syscall family at a
time *within* the Rust kernel build-out (pipes → fd table → process manager
→ VFS → network → image loader → security → persistence).

## Phased Plan

### Phase 0 — Spec & ABI design (docs only)
- Write design doc `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`
  capturing: the two ABI surfaces, the kernel→host ABI in TOML form
  (mirroring `yurt_abi.toml`), the trampoline protocol, error/errno mapping,
  memory-copy semantics, JSPI/asyncify suspend points, parity matrix vs the
  TS kernel.
- Define `abi/contract/kernel_host_abi.toml` and code-generate C header /
  Rust constants the same way `yurt_abi.toml` already does.

### Phase 1 — Skeleton kernel-wasm crate + microkernel split
- Create `packages/kernel-wasm/` (Rust, `wasm32-wasip1`, excluded from
  default-members like other wasm crates).
- Export a stub `kernel_dispatch` that returns `-ENOSYS` for everything.
- Refactor `packages/runtime-wasmtime` into:
  - `packages/microkernel-wasmtime` — the host: engine, stores, kernel.wasm
    loader, trampoline, kh_* implementations, JSON-RPC stdio shell preserved
    for the TS kernel during transition.
  - `packages/kernel-wasm` — the kernel wasm module (currently a stub).
- The microkernel can route to *either* the embedded kernel.wasm or the TS
  kernel (via existing JSON-RPC callbacks) per `YURT_KERNEL` env.
- Rust test: load kernel.wasm, call `kernel_dispatch`, get `-ENOSYS`. Confirms
  the trampoline plumbing works end-to-end.

### Phase 2 — Port leaf syscall families (no dependencies on VFS)
Order chosen by dependency and existing Rust footprint (much is already in
`packages/runtime-wasmtime/src/wasm/kernel.rs`):

1. Pipes + fd table + dup/dup2/close (already partially Rust; relocate into
   `kernel-wasm`, keep host-side `kh_yield` for blocking reads).
2. Process kernel: spawn/wait/exit. Uses `kh_spawn_process` to ask the
   microkernel to instantiate a process. Process tree lives in kernel.wasm.
3. Signals + process groups + tty.
4. Clock/random/uid/gid/priority/sched (mostly pure logic, trivial).

After each family: parity test runs the same fixture (`test-fixtures/wasm/*`)
against both `YURT_KERNEL=ts` and `YURT_KERNEL=wasm`, asserts identical
exit/stdout/stderr.

### Phase 3 — Port VFS
- Largest single port: `vfs.ts`, `overlay-vfs.ts`, `tar-image-root-provider.ts`,
  `proc-provider.ts`, `dev-provider.ts`, `host-fs-provider.ts`,
  `host-mount.ts`, `pipe.ts` → Rust modules in kernel-wasm.
- The host-fs-provider becomes the only piece that calls out: kernel.wasm
  asks the microkernel via `kh_real_fs_*` to read backing files. All overlay
  / cow / inode logic stays inside the sandbox.
- Image loader (`image-loader.ts`, `image-builder.ts`) ports next; tar parsing
  is pure Rust (`tar` crate).

### Phase 4 — Port network bridge & gateway
- `network/bridge.ts`, `gateway.ts`, `socket-backend.ts` → Rust.
- Host exposes `kh_fetch_*` and `kh_socket_*` for actual I/O.
- Network policy enforcement happens inside kernel.wasm.

### Phase 5 — Port security, persistence, execution
- `security.ts`, `persistence/`, `execution/worker-executor.ts`.
- The worker-executor pattern (running multiple processes) becomes the
  microkernel's job, orchestrated by kernel.wasm via `kh_spawn_process`
  and `kh_destroy_instance`.

### Phase 6 — Browser / Deno / bare-CLI microkernels
- `packages/microkernel-js` — small TS+wasm using JSPI to suspend
  process at the trampoline; asyncify fallback for engines without JSPI.
  Replaces `packages/kernel/src/browser-adapter.ts`.
- `packages/microkernel-deno` — Deno-based microkernel (debug-friendly,
  shape close to browser). Replaces the orchestrator side of the current TS
  kernel for CLI use.
- Bare CLI: ship `yurt-kernel.wasm` plus a tiny `wasmtime run` recipe; the
  microkernel for this mode is just the wasmtime CLI's WASI plus a minimal
  set of preopens/env conventions for kh_*.

### Phase 7 — Delete TypeScript kernel
- Once parity tests are green for all syscall families across all
  microkernel hosts, remove `packages/kernel/src/`, `packages/cli/src/`
  (replaced by Rust CLI calling microkernel-wasmtime), TS-only packages
  from `deno.json`, and the `YURT_KERNEL=ts` branch.
- Keep `deno test` only for any remaining TS test fixtures; otherwise drop
  the `deno.yml` CI gate.

## Critical Files

**To create:**
- `packages/kernel-wasm/Cargo.toml`, `src/lib.rs`, per-subsystem modules
- `packages/microkernel-wasmtime/` (rename from `packages/runtime-wasmtime`)
- `packages/microkernel-js/`
- `packages/microkernel-deno/`
- `abi/contract/kernel_host_abi.toml`
- `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`
- `docs/superpowers/plans/2026-05-09-sandboxed-kernel.md` (this plan,
  copied into the repo when we commit Phase 0)

**To migrate (TS → Rust kernel-wasm):**
- `packages/kernel/src/host-imports/kernel-imports.ts` — syscall dispatch logic
- `packages/kernel/src/process/kernel.ts` (1618 LOC) — process manager
- `packages/kernel/src/vfs/{vfs.ts, overlay-vfs.ts, *-provider.ts, pipe.ts}` (~3500 LOC)
- `packages/kernel/src/network/{bridge.ts, gateway.ts, socket-backend.ts}` (~1300 LOC)
- `packages/kernel/src/security.ts`, `persistence/`, `execution/`

**To reuse (already Rust, relocates into kernel-wasm):**
- `packages/runtime-wasmtime/src/wasm/kernel.rs` (fd table, pipes, process kernel)
- `packages/runtime-wasmtime/src/wasm/native_abi.rs` (syscall decoders)
- `packages/runtime-wasmtime/src/vfs/` (skeleton VFS already in Rust)

## Verification

Per-phase parity gate: every existing wasm fixture under
`test-fixtures/wasm/` and conformance crate under `abi/conformance/rust/`
must produce identical exit code + stdout + stderr under both
`YURT_KERNEL=ts` and `YURT_KERNEL=wasm`. Add a CI matrix dimension that
runs `guest-compat.yml` twice with each kernel selection.

End-to-end smoke per microkernel host:
- `cargo test -p microkernel-wasmtime` — native path
- `deno test packages/microkernel-deno/**/*_test.ts` — Deno path
- A Playwright run of microkernel-js loading `kernel.wasm` and
  executing the BusyBox shell fixture in JSPI mode and again in asyncify
  mode.
- `wasmtime run target/wasm32-wasip1/release/yurt-kernel.wasm -- <args>`
  for the bare-CLI mode.

Final acceptance: TS kernel deletion lands without regressing
`guest-compat.yml`.

## Open Questions (resolve in Phase 0 spec)

1. **Memory-copy cost on JS hosts.** Every syscall does two copies (user→kernel
   and kernel→user). On the native path we can shortcut by giving kernel.wasm
   direct access to user memory via a host-mediated borrow primitive. Spec
   needs to define `kh_process_mem_read/write` and whether the native path
   exposes a zero-copy variant.
2. **JSPI availability matrix.** JSPI is shipping in V8 (Chrome 123+) and
   Firefox 134+. Safari status is uncertain. Asyncify fallback adds ~30%
   code-size and per-call overhead — confirm we're OK with that floor for
   Safari users, or scope Safari out.
3. **Kernel-internal preemption.** On native, epoch interruption preempts
   process. Should the kernel.wasm itself also be preemptible, or does it
   run to completion per syscall? Recommend run-to-completion (kernel is
   trusted code) but document.
4. **Persistence format.** `packages/kernel/src/persistence/` snapshots TS
   data structures today. The Rust port needs a stable on-disk format spec
   so existing snapshots either migrate or the format version bumps.
5. **Image loader build dependency.** Some image-loader code reads from
   the host filesystem during boot. Decide whether kernel.wasm reads images
   purely via `kh_real_fs_*`, or whether the microkernel pre-mounts the
   image into kernel.wasm's address space at startup.
