# JS-host multi-process driver (spawn / wait / sequential fork) — design

**Date:** 2026-05-17
**Branch:** `claude/remove-typescript-kernel-CUcuf` (advances draft PR #129)
**Slice of:** PR #129 "Remove the old TypeScript kernel; build a thin WASM-kernel runner" — completes Phase 2 (the multi-process driver).

## Problem

`packages/kernel-host-interface-js` (the JS/Deno host that the new `Runner` drives)
stubs `host_spawn` / `host_wait` / `host_fork` to `-ENOSYS`
(`mod.ts:518` `USER_YURT_STUB_IMPORTS`, applied in `buildUserYurtImports` at
`mod.ts:1620`). A guest that spawns and waits for a child therefore cannot run
through the Runner. The kernel side already supports it
(`packages/kernel-wasm/src/dispatch/process.rs`: `sys_spawn` enqueues a
`PendingSpawn`, `drain_spawn` pops it, `record_exit` reaps, `wait_response`
returns `-EAGAIN` until a child is reaped), and the **Rust host already drives
it end-to-end** (`packages/runtime-wasmtime/src/kernel_host_interface.rs:3095`
`run_pending_spawns`). Only the JS host is behind.

## Framing: this is a parity port, not a new design

The spawn/wait/fork pump is an **ABI-contract behavior of `kernel.wasm`**, not a
JS implementation detail. "Host" = whoever implements the `kh_*` side of
`abi/contract/kernel_host_abi.toml` — JS/Deno *or* a Rust runtime
(`runtime-wasmtime`, and eventually WasmEdge/wasmer behind the planned
`WasmEngine` trait). Both hosts load the **same** `kernel.wasm` and call the
same exports.

The Rust host is the **normative reference**. This slice makes the JS host
*conform* to the semantics `runtime-wasmtime` already defines — the same
discipline used for the PR15/17 reconciliation: mirror the existing reference,
do not invent semantics. The JS *thread* pump
(`host_thread_join` EAGAIN→drain→retry at `mod.ts:1693`; `runPendingThread` at
`mod.ts:2071`) supplies only the JS-side import-wiring mechanic.

### Normative reference (cite, do not paraphrase)

`packages/runtime-wasmtime/src/kernel_host_interface.rs`:

```rust
pub fn run_pending_spawns(&self) -> Result<usize> {
    while let Some(spawn) = self.drain_pending_spawn()? {
        let mut child = self.instantiate_with_pid(spawn.child_pid, &spawn.wasm, spawn.argv)?;
        let _ = child.run_start();                  // traps on proc_exit; shim stashes code first
        let exit = child.last_exit().unwrap_or(0);  // clean (non-WASI) return => 0
        self.record_exit(spawn.child_pid, exit)?;
    }
}
```

Two semantics the JS port must reproduce exactly:

1. The child is instantiated with the **kernel-allocated `child_pid`**, not a
   fresh host pid, so the parent's `sys_wait` reaps the right pid
   (`instantiate_with_pid`, `kernel_host_interface.rs:3017`).
2. A clean return with no WASI exit reports **0** (`last_exit().unwrap_or(0)`).

**Correction to PR #129 prose:** the PR body said `runPendingSpawns` should
"recurse via the child's own `drainPendingProcess`." The reference is a **flat
iterative** `while let Some(...)` drain — a child that itself calls `sys_spawn`
enqueues into the same kernel queue and is picked up by the next loop
iteration. The JS port mirrors the **iterative** drain, not recursion.

## Scope

**In scope (this slice):**

- `host_spawn`, `host_wait`, sequential `host_fork` wired in the JS host.
- `CachedProcessEngine.runPendingSpawns(kernel)` (the JS pump).
- `buildUserYurtImports` gains a `drainPendingProcess?` callback; the three
  names removed from `USER_YURT_STUB_IMPORTS`.
- New `test-fixtures/wasm/spawn-wait/` Rust fixture.
- Cross-host parity verification (Rust `fixture_parity.rs` + JS `Runner` E2E).
- Fix the validated review finding: fixture-dependent Deno tests must not break
  the pre-push fast-tier glob.

**Out of scope (tracked follow-up, not this session):**

- Concurrent fork (pipes / pthreads) via JSPI / the AsyncBridge async-suspension
  rewrite. The PR author de-scoped this; project memory records it as its own
  multi-slice initiative. Sequential fork only here.
- Phase 3 (CLI/scripts/workflow rewire), Phase 4 (`git rm packages/kernel/`).

## Architecture & components

All JS changes in `packages/kernel-host-interface-js/mod.ts`.

### `CachedProcessEngine.runPendingSpawns(kernel)` (new)

Flat iterative drain mirroring the Rust reference. Per child:

1. `kernel.drainPendingSpawn()` → `PendingSpawn | null`; loop until `null`
   (kernel returns `-ENOENT`/None when the queue is empty).
2. `cacheModule(spawn.wasm)` then instantiate **bound to `spawn.childPid`** and
   `spawn.argv`, using the same instantiation path as `spawn()` (`mod.ts:1857`)
   modulo the pid source — i.e. a sibling of `spawnThread`/`runPendingThread`,
   parallel structure, no refactor of the working thread path.
3. `_start()` in try/catch; parse exit code from the `proc_exit(n)` trap using
   the existing parser in `packages/runner/src/process-pump.ts`; a clean return
   with no WASI exit → `0`.
4. `kernel.recordExit(spawn.childPid, exit)`.

### Imports in `buildUserYurtImports`

- `host_spawn`: build the `SYS_SPAWN` request
  (`u32 path_len + path + (u32 len + arg)*`), `kernel.syscall(SYS_SPAWN, …)`,
  return `child_pid` in the C-ABI out shape.
- `host_wait`: `kernel.syscall(SYS_WAIT, u32 want_pid + u32 flags, …)`; then
  `while rc === -EAGAIN && !(flags & WNOHANG) && drainPendingProcess:
  drainPendingProcess(); retry;` — the verbatim shape of `host_thread_join`'s
  EAGAIN→drain→retry loop. Map the kernel `{pid,status}` result to the
  `yurt_wait_result_v1` out shape.
- `host_fork` (sequential): `prepareFork` → run continuation →
  `commitFork` / `rollbackFork` (engine methods at `mod.ts:1594/1601/1608`).
- `buildUserYurtImports` signature gains `drainPendingProcess?: () => void`
  (sibling of `drainPendingThread`), passed by `spawn()` / `spawnThread` as
  `() => this.runPendingSpawns(kernel)`. Remove `host_spawn` / `host_wait` /
  `host_fork` from `USER_YURT_STUB_IMPORTS`.

### Data flow (guest-initiated, kernel-queued, host-executed)

```
guest host_spawn  → kernel sys_spawn (enqueue PendingSpawn, return child_pid)
guest host_wait   → kernel sys_wait  → -EAGAIN (no child reaped yet)
                  → host drainPendingProcess() = runPendingSpawns(kernel)
                      → drain → instantiate(childPid) → _start() → record_exit
                  → retry sys_wait → reaps child {pid,status}
```

## Error handling

- Exit-code extraction reuses the existing `proc_exit(n)` trap parser in
  `packages/runner/src/process-pump.ts` — no new parsing logic.
- Drain loop terminates on `-ENOENT` / `null` (no more pending children).
- `-EAGAIN` with no `drainPendingProcess` callback, or with `WNOHANG` set,
  propagates unchanged → **no behavior change to the single-process path** that
  Phase 2 already verified.
- Child instantiation/trap failures surface through the existing
  `process-pump` error path; the parent's `sys_wait` still observes a recorded
  exit (non-zero) rather than hanging.

## Verification — definition of done

Done = the slice is CI-green and parity-verified, per AGENTS.md "CI green = done".

1. **New fixture:** `test-fixtures/wasm/spawn-wait/` — a Rust crate (no `wabt`
   available; must be a Rust fixture, not WAT). Parent spawns a child, waits,
   asserts the child's exit code, prints deterministic stdout.
2. **JS path:** new E2E test runs the fixture through `Runner.runArgv`,
   asserting stdout + exit-code parity vs. the `kernel-host-interface` reference.
3. **Cross-host parity:** the same fixture added to the Rust
   `runtime-wasmtime/tests/fixture_parity.rs` set; both hosts must produce
   byte-identical stdout and the same exit code. This is the empirical check
   that the contract — not just one host — is complete.
4. **No regression:** the existing 8 `test-fixtures/wasm` guests stay green;
   thread path unchanged.
5. **Fast-tier hygiene (validated review finding):** a shared helper makes a
   fixture-dependent Deno test *skip* (Deno `ignore`) when its wasm artifact is
   absent, instead of throwing. Keeps `*_test.ts` naming (still runs in
   `guest-compat.yml` slow tier where artifacts exist) but the pre-push fast
   glob `packages/**/*_test.ts` (`.pre-commit-config.yaml`) no longer fails for
   devs without wasm builds. Applied uniformly to the existing
   `packages/runner/src/__tests__/runner_test.ts` and the new spawn-wait test.
   Quoted rule (AGENTS.md:97): *"Don't add slow tests to the fast glob."*
6. **CI:** `cargo build --release --target wasm32-wasip1` fixtures →
   `deno fmt --check` / `lint` / `check 'packages/**/*.ts'` /
   `deno test` runner + host-interface suites → `cargo test --tests` →
   all PR #129 checks green.

## Risks

- **Hidden semantic drift from the Rust reference.** Mitigation: cross-host
  byte-parity test (verification step 3) is the oracle; any drift fails CI.
- **Pid binding.** If the JS child is instantiated with a host-fresh pid
  instead of the kernel-allocated `childPid`, `sys_wait` reaps the wrong pid.
  Mitigation: explicit verification step 1/3; mirrors `instantiate_with_pid`.
- **Fast-glob fix masking real failures.** A skip-on-missing-artifact helper
  could hide a genuinely broken test. Mitigation: the slow tier
  (`guest-compat.yml`) always has artifacts, so the test still runs there with
  no skip; skip only applies when artifacts are legitimately absent (local
  pre-push without a wasm build).

## Decisions (locked with the user)

1. Spawn-pump code structure = **parallel** sibling of the thread pump, not a
   threads+processes unification.
2. Fast-glob fix = **artifact-guard skip helper** (not rename-out-of-glob).
3. Branch = **advance PR #129's branch** `claude/remove-typescript-kernel-CUcuf`.
4. fork = **sequential only**; concurrent fork is a tracked follow-up.
