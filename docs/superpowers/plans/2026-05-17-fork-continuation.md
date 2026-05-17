# Real `fork()` (return-twice continuation) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Spec:** `docs/superpowers/specs/2026-05-16-rust-fork-parity-design.md` (the governing design — read it first; this plan does not restate it).

**Goal:** A guest `fork()` returns **twice** — child gets `0`, parent gets the child pid — with the child running from the parent's exact memory/stack at the `fork()` call site, across both hosts (JS/Deno and Rust/wasmtime). Carved out of PR #129's multi-process driver (spawn/wait shipped at `3f5be0b` on `claude/remove-typescript-kernel-CUcuf`); this is its sibling initiative.

**Status: DRAFT scaffold.** This is the continuation-snapshot initiative the spawn/wait spec deliberately deferred. It is genuinely multi-slice (it is the asyncify/JSPI execution-state-capture work, ref the project's AsyncBridge notes). Not a one-session task.

## Codebase reality (verified 2026-05-17)

| Layer | State |
|---|---|
| Kernel identity/state | **Done & unit-tested on `main`**: `kernel.rs` `prepare_fork:715`, `commit_fork:754`, `rollback_fork:773`, `ProcessForkState::ForkPreparing:114`; exercised by `dispatch/tests.rs:8501-8502`. Kernel owns child pid alloc, parent linkage, fd-table clone, wait visibility, rollback. |
| Rust host (`runtime-wasmtime`) | **Partial**: `kernel_host_interface.rs:3472` registers a real `host_fork` linker fn with child-side `forced_fork_return: Some(0)` scaffolding + `prepare_fork` call. **Open question to settle first:** is the child a *true* linear-memory/stack snapshot of the parent at the `fork()` site, or a weaker "rebuild child from wasm/argv + force fork()→0"? The `forced_fork_return` on a freshly-built child instance suggests the weaker model, which is **semantically wrong** for real `fork()`. |
| JS host (`kernel-host-interface-js`) | **Stub**: `host_fork` is in `USER_YURT_STUB_IMPORTS` → `-ENOSYS`. |
| Reusable scaffolding (from the spawn/wait slice) | The `(engine, kernel)` free-fn extraction pattern, `register_yurt_process_imports`, `fixture_parity.rs` cross-host harness, and the `yurt-process`/abi spawn fixtures are all reusable here. `prepareFork`/`commitFork`/`rollbackFork` host wrappers already exist (`mod.ts:1594/1601/1608`, `kernel_host_interface.rs:3397/3405/3410`). |

## The hard core: continuation capture

`fork()` returning twice requires capturing the calling guest's execution state (stack + linear memory) at the `host_fork` call and resuming it twice. Per the spec's non-goals, a host that cannot snapshot returns `-ENOSYS`; shared-memory/threaded fork returns `-EAGAIN` first pass; `vfork` aliases `fork`.

Two capture mechanisms (project AsyncBridge constraint: **JSPI is not universal — Safari excluded; asyncify is the universal fallback**):
- **Asyncify** (Binaryen transform) — universal; the kernel/guest toolchain already contemplates it (ref setjmp/longjmp = libc + asyncify note). Likely the primary path.
- **JSPI** — where available; faster, no size cost; not universal.

This plan's **Task 0 is a spike** to settle the Rust-host snapshot-vs-rebuild question and pick the capture mechanism before any host code — its outcome may revise later tasks.

## Phased tasks (TDD; each its own commit; reviewed per subagent-driven-development)

- [ ] **Task 0 — Capture spike (gates everything).** Determine empirically: (a) does `runtime-wasmtime` `host_fork` (`kernel_host_interface.rs:3472`) do a true memory/stack snapshot or a rebuild? Write a Rust fixture `fork-twice` whose parent sets a memory value, `fork()`s, and child+parent print divergent values proving (or disproving) shared-snapshot semantics; run through the Rust host. (b) Pick capture mechanism (asyncify vs JSPI) per the AsyncBridge matrix. Deliverable: `docs/superpowers/plans/2026-05-17-fork-capture-notes.md` + a passing/xfail `fork-twice` Rust fixture demonstrating current behavior. No host changes. **Escalate with findings before Task 1.**
- [ ] **Task 1 — `fork-twice` + `fork-exec` Rust fixtures** under `test-fixtures/wasm/` (parent observes child via `prepare/commit` + `waitpid`; deterministic host-invariant stdout, same discipline as the spawn-wait fixture).
- [ ] **Task 2 — Rust host real continuation.** Implement true snapshot/restore in `runtime-wasmtime` `host_fork` per Task 0's chosen mechanism: `prepare_fork` → capture parent continuation+memory → instantiate child from the snapshot (NOT a fresh `_start`) resuming at the `fork()` site returning `0`; parent resumes returning child pid → `commit_fork` / `rollback_fork` on failure. Reuse the spawn/wait `(engine,kernel)` extraction pattern for any re-entrant drive.
- [ ] **Task 3 — JS host `host_fork`.** Remove from `USER_YURT_STUB_IMPORTS`; implement the asyncify (universal) path: capture/restore via the AsyncBridge; `prepareFork`→snapshot→child→`commitFork`/`rollbackFork`. Mirror the Rust per-child semantics (parity discipline, as the spawn/wait slice did).
- [ ] **Task 4 — Cross-host parity** in `fixture_parity.rs` + a JS `Runner` E2E: `fork-twice` byte-identical stdout + exit on both hosts (the oracle).
- [ ] **Task 5 — Edge semantics per spec:** `vfork`=`fork` alias; shared-memory/threaded-process fork → `-EAGAIN`; non-continuation guest → `-ENOSYS`; `fork`+`exec` fast path delegating to the existing `sys_spawn`.
- [ ] **Task 6 — Verify:** port the TS `fork-canary` continuation cases onto the Rust-backed kernel (spec Test Strategy); CI green; no regression to spawn/wait.

## Out of scope
`pthread_atfork`, kernel DNS, concurrent-fork-with-live-pipes/pthreads beyond first-pass `-EAGAIN` (spec non-goals). The spawn/wait slice (already shipped) is not re-touched.

## Definition of done
`fork-twice` passes byte-identically through the JS Runner and the Rust `fixture_parity` host; `vfork`/`-EAGAIN`/`-ENOSYS` edge cases per spec; the TS `fork-canary` cases pass on the Rust kernel; CI green. This removes the last reason the TS kernel owns process duplication — a prerequisite for PR #129 Phase 4 (`git rm -r packages/kernel/`).
