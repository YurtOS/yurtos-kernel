# JS-host multi-process driver (spawn / wait) — design

**Date:** 2026-05-17
**Branch:** `claude/remove-typescript-kernel-CUcuf` (advances draft PR #129)
**Slice of:** PR #129 "Remove the old TypeScript kernel; build a thin WASM-kernel runner" — completes Phase 2's spawn/wait driver.
**Revision:** 2 (post-review — scope, framing, stdio, and test-wiring corrected).

## Problem

`packages/kernel-host-interface-js` (the JS/Deno host that the new `Runner`
drives) stubs `host_spawn` / `host_wait` / `host_fork` to `-ENOSYS`
(`mod.ts:518` `USER_YURT_STUB_IMPORTS`, applied in `buildUserYurtImports` at
`mod.ts:1620`). A guest that spawns and waits for a child therefore cannot run
through the Runner. The kernel side already supports it
(`packages/kernel-wasm/src/dispatch/process.rs`: `sys_spawn` enqueues a
`PendingSpawn`, `drain_spawn` pops it, `record_exit` reaps, `wait_response`
returns `-EAGAIN` until a child is reaped), and the **Rust host already drives
spawn/wait end-to-end** (`packages/runtime-wasmtime/src/kernel_host_interface.rs:3095`
`run_pending_spawns`). Only the JS host is behind for spawn/wait.

## Scope

**In scope (this slice):**

- `host_spawn` and `host_wait` wired in the JS host.
- `CachedProcessEngine.runPendingSpawns(kernel)` (the JS pump).
- `buildUserYurtImports` gains a `drainPendingProcess?` callback; `host_spawn`
  and `host_wait` removed from `USER_YURT_STUB_IMPORTS`.
- New `test-fixtures/wasm/spawn-wait/` Rust fixture.
- Cross-host parity verification (Rust `fixture_parity.rs` + JS `Runner` E2E).
- Wire `packages/runner/src/__tests__/` into CI and adopt the existing
  cargo-auto-build convention so fixture-dependent tests actually run and the
  pre-push fast glob is not broken.

**Out of scope (tracked follow-ups, not this slice):**

- **`fork()` entirely.** `host_fork` stays an `-ENOSYS` stub in the JS host
  here. Real return-twice `fork()` (memory/stack continuation snapshot,
  cross-host) is its own PR, built on the existing
  `docs/superpowers/specs/2026-05-16-rust-fork-parity-design.md`. The kernel
  already owns fork identity/state (`kernel.rs:715/754/773`,
  `ProcessForkState::ForkPreparing`); the Rust host has a partial `host_fork`
  path (`kernel_host_interface.rs:3466`, `forced_fork_return`) whose
  snapshot-vs-rebuild correctness must be settled in that dedicated PR. None of
  it is touched here. **Decision: spawn/wait lands first this session; the fork
  PR is the immediate next initiative.**
- Per-pid **child stdout/stderr** draining in the JS Runner (see Verification).
- Concurrent fork / pipes / pthreads via JSPI / AsyncBridge.
- Phase 3 (CLI/scripts/workflow rewire), Phase 4 (`git rm packages/kernel/`).

## Framing: parity at the per-child-semantics level

The spawn/wait pump is an **ABI-contract behavior of `kernel.wasm`**, not a JS
implementation detail. "Host" = whoever implements the `kh_*` side of
`abi/contract/kernel_host_abi.toml` — JS/Deno *or* a Rust runtime
(`runtime-wasmtime`, eventually WasmEdge/wasmer behind the planned `WasmEngine`
trait). Both hosts load the **same** `kernel.wasm`.

The Rust host is the **reference for per-child semantics**, and this slice makes
the JS host reproduce those semantics exactly. **Parity is scoped to per-child
behavior, not the drive-loop control structure** — the two hosts legitimately
differ there (analyzed below). This is a deliberate narrowing of the earlier
"exact mirror" claim, which was an overstatement.

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

Per-child semantics the JS port must reproduce exactly:

1. The child is instantiated with the **kernel-allocated `child_pid`**, not a
   fresh host pid, so the parent's `sys_wait` reaps the right pid
   (`fn instantiate_with_pid` at `kernel_host_interface.rs:3020`).
2. A clean return with no WASI exit reports **0** (`last_exit().unwrap_or(0)`).
3. The drain is a **flat iterative** `while let Some(...)` loop — a child that
   itself calls `sys_spawn` enqueues into the same kernel queue and is picked up
   by the next iteration. **Correction to PR #129 prose**, which said "recurse
   via the child's own `drainPendingProcess`": the reference is iterative, not
   recursive. The JS port mirrors the iterative drain.

### Drive-loop divergence (analysis, not parity)

The Rust reference is driven by an **external cadence** — its own doc comment
(`kernel_host_interface.rs:3091-3094`): *"Embedders typically call this in a
loop after each parent syscall (or in a fixed-cadence drain)."*

The JS host **cannot** do that: synchronous JS can't run an external loop while
a parent's `_start` is blocked on the call stack. So the JS host drives the
pump **re-entrantly from inside `host_wait`** (`-EAGAIN` →
`drainPendingProcess()` → retry), which is the *exact shape of the existing JS
thread pump* (`host_thread_join` at `mod.ts:1693`; `runPendingThread` at
`mod.ts:2071`). This is a different control structure from the Rust reference,
deliberately, and it is consistent with how JS already drives threads.

Re-entrancy correctness analysis:

- The kernel spawn queue is a **single global FIFO**. A re-entrant
  `runPendingSpawns` invoked from one parent's blocked `host_wait` drains and
  runs **every** queued child to completion on the inner stack, including
  children another parent is waiting on. Reaping is **by pid**
  (`record_exit(child_pid, …)` + `sys_wait(want_pid)`), so correctness of *who
  reaps what* is preserved. What diverges from the reference is **scheduling
  order** (inner-stack run-to-completion) and **stack depth** under deep
  spawn→wait nesting. Both are acceptable for the single-process-tree Runner use
  case; neither breaks the per-child contract. This is recorded as a known,
  intentional divergence, not a bug.

## Architecture & components

All JS changes in `packages/kernel-host-interface-js/mod.ts`.

### `CachedProcessEngine.runPendingSpawns(kernel)` (new)

Flat iterative drain mirroring the Rust reference. Per child:

1. `kernel.drainPendingSpawn()` → `PendingSpawn | null`; loop until `null`
   (kernel returns `-ENOENT`/None when the queue is empty).
2. `cacheModule(spawn.wasm)`, then instantiate **bound to the kernel-allocated
   `spawn.childPid`** and `spawn.argv`. **Hard requirement:** use the engine's
   internal instantiate-by-pid path (the `spawn()`/`spawnThread` machinery with
   an explicit pid, mirroring Rust `instantiate_with_pid`). It must **not** call
   the public `spawnCachedProcess`, which allocates a *fresh* pid — that would
   make `sys_wait` reap the wrong pid (see per-child semantic #1).
3. `_start()` in try/catch; parse exit from the `proc_exit(n)` trap using the
   existing parser in `packages/runner/src/process-pump.ts`; a clean return with
   no WASI exit → `0` (per-child semantic #2).
4. `kernel.recordExit(spawn.childPid, exit)`.

Structure = parallel sibling of `spawnThread`/`runPendingThread`; no refactor of
the working thread path.

### Imports in `buildUserYurtImports`

- `host_spawn`: build the `SYS_SPAWN` request
  (`u32 path_len + path + (u32 len + arg)*`), `kernel.syscall(SYS_SPAWN, …)`,
  return `child_pid` in the C-ABI out shape.
- `host_wait`: `kernel.syscall(SYS_WAIT, u32 want_pid + u32 flags, …)`; then
  `while rc === -EAGAIN && !(flags & WNOHANG) && drainPendingProcess:
  drainPendingProcess(); retry;` — verbatim shape of `host_thread_join`'s
  `-EAGAIN`→drain→retry. Map the kernel `{pid,status}` result to the
  `yurt_wait_result_v1` out shape.
- `buildUserYurtImports` signature gains `drainPendingProcess?: () => void`
  (sibling of `drainPendingThread`), passed by `spawn()`/`spawnThread` as
  `() => this.runPendingSpawns(kernel)`. Remove `host_spawn`/`host_wait` from
  `USER_YURT_STUB_IMPORTS` (leave `host_fork` stubbed — out of scope).

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
- Drain loop terminates on `-ENOENT` / `null`.
- `-EAGAIN` with no `drainPendingProcess` callback, or with `WNOHANG`,
  propagates unchanged → **no behavior change to the single-process path** that
  Phase 2 already verified.
- **`recordExit` failure:** the JS `recordExit` wrapper (`mod.ts:3522`) throws
  when the kernel returns `rc !== 0` (e.g. `-ESRCH` for a pid the kernel no
  longer tracks). An unguarded throw inside the drain loop would abort the whole
  pump and surface as a parent `host_wait` failure. The pump must treat a
  `recordExit` `-ESRCH` as "child already reaped/gone" — log and continue the
  drain — rather than letting it propagate. Other non-zero `recordExit` codes
  propagate as genuine errors.
- Child instantiation/trap failures surface through the existing `process-pump`
  error path; the parent's `sys_wait` still observes a recorded exit rather than
  hanging.

## Verification — definition of done

Done = the slice is CI-green and parity-verified, per AGENTS.md "CI green = done".

1. **New fixture:** `test-fixtures/wasm/spawn-wait/` — a Rust crate (no `wabt`
   available; must be a Rust fixture, not WAT). The parent spawns a child,
   `wait`s for it, and **the parent prints a deterministic line encoding the
   child's reaped exit code**, then exits. The observable contract is therefore
   **the parent's stdout + the parent's exit code** — both already drainable via
   the root `UserProcess.capturedStdout()` path the Runner uses
   (`runner.ts:79`). The fixture deliberately does **not** rely on the child's
   own stdout, because the JS Runner only drains the root pid's per-pid buffer;
   per-pid child-stdout draining is a separate follow-up. This still fully
   exercises spawn + wait + cross-process exit-code reaping (the actual landing
   rule).
2. **JS path:** new E2E test runs the fixture through `Runner.runArgv`,
   asserting parent stdout + exit code.
3. **Cross-host parity:** the same fixture added to
   `runtime-wasmtime/tests/fixture_parity.rs`; both hosts must produce
   byte-identical parent stdout and the same exit code. This is the empirical
   check that the contract — not just one host — is complete.
4. **No regression:** the existing 8 `test-fixtures/wasm` guests stay green;
   thread path unchanged.
5. **Test wiring + fast-tier hygiene** (replaces the earlier skip plan, which
   verification showed was wrong — `packages/runner/__tests__` is in no CI job,
   so a skip-on-missing test would run nowhere):
   - Adopt the **existing codebase convention**: the runner E2E test
     auto-builds the required wasm fixtures via `cargo` on missing artifact,
     exactly as `packages/kernel-host-interface-js/__tests__/kernel-host-interface_test.ts:52-64`
     already does (that sibling suite is itself in the pre-push glob and
     cargo-auto-builds). This keeps the pre-push fast glob
     (`packages/**/*_test.ts`, `.pre-commit-config.yaml`) working — no throw on
     a clean checkout — and matches precedent instead of inventing a skip.
   - **Wire `packages/runner/src/__tests__/` into CI**: add it to the
     `deno.yml` test invocation (alongside the existing kernel-host-interface
     suites) so it runs in CI rather than nowhere. This also closes the
     pre-existing gap that Phases 1–2 left.
   - This resolves the validated review finding under AGENTS.md:97 *"Don't add
     slow tests to the fast glob"* by following the established
     auto-build-and-CI-wired pattern rather than diverging from it. The same
     auto-build treatment is applied to the existing
     `packages/runner/src/__tests__/runner_test.ts`.
6. **CI:** `cargo build --release --target wasm32-wasip1` fixtures →
   `deno fmt --check`/`lint`/`check 'packages/**/*.ts'` →
   `deno test` runner + host-interface suites → `cargo test --tests` →
   all PR #129 checks green.

## Risks

- **Semantic drift from the Rust reference.** Mitigation: cross-host
  byte-parity test (verification step 3) is the oracle; drift fails CI.
- **Wrong pid binding.** If the JS child is instantiated with a host-fresh pid
  (e.g. via `spawnCachedProcess`) instead of the kernel-allocated `childPid`,
  `sys_wait` reaps the wrong pid. Mitigation: hard requirement in
  Architecture; verification steps 1–3.
- **Re-entrant drive loop** (analyzed above): scheduling-order/stack-depth
  divergence from the reference under deep nesting. Accepted, documented;
  per-child contract preserved.
- **`recordExit -ESRCH` aborting the pump.** Mitigation: explicit
  continue-on-`-ESRCH` rule in Error handling.

## Decisions (locked with the user)

1. Spawn-pump structure = **parallel** sibling of the thread pump (no
   threads+processes unification).
2. Test hygiene = **adopt the existing cargo-auto-build convention + wire
   `packages/runner/__tests__` into CI** (supersedes the initial
   skip-on-missing-artifact idea, which verification disproved).
3. Branch = **advance PR #129's branch** `claude/remove-typescript-kernel-CUcuf`.
4. `fork()` = **entirely out of this slice**; its own dedicated PR on
   `2026-05-16-rust-fork-parity-design.md`, the immediate next initiative after
   spawn/wait lands.
