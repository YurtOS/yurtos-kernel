# Real `fork()` continuation — design (supersedes 2026-05-16-rust-fork-parity-design.md)

**Date:** 2026-05-18
**PR:** #224 (`claude/fork-impl`). **Umbrella:** #172. **Blocks:** Phase 4 / `git rm packages/kernel/` (#170).
**Supersedes:** `docs/superpowers/specs/2026-05-16-rust-fork-parity-design.md` — its kernel `prepare_fork`/`commit_fork`/`rollback_fork` contract and *host-owns-continuation, kernel-owns-identity* architecture remain valid and are carried forward verbatim; this doc replaces its host-implementation framing with the Task-0 spike reality and the verified two-libc / 99-1 model.

## Goal

A guest `fork()` returns **twice** — child gets `0`, parent gets the child pid — with the **child resuming at the `fork()` call site holding the parent's exact linear memory and execution state at that point** (true POSIX fork, not a fresh image). **Non-negotiable:** the TypeScript kernel being deleted (#170) supports `fork()`; deleting it without real `fork()` on the Rust/WASM side is a functional regression. Real `fork()` therefore **blocks Phase 4**.

## The two-libc / opt-in-asyncify model (codebase-verified)

`fork()` (and `setjmp`/`longjmp`) require capturing and resuming wasm execution state. The only mechanism available on the user-process path is **Binaryen asyncify** (the user-process wasmtime engine has no `async_support`/JSPI/stack-switching — Task-0 spike). Asyncify is a **whole-module control-flow rewrite that taints the module's execution strategy**:

> `abi/toolchain/yurt-toolchain/src/wasm_opt.rs:21-27` — *"Continuations are an explicit opt-in because they taint the process execution strategy: those modules run under the Asyncify adapter while normal modules remain free to use JSPI or another backend."*

So a module is **either** asyncify-instrumented (runs under the Asyncify adapter; `fork`/`setjmp`/`longjmp` work) **or** lean (free for JSPI/native; `fork()` → link error by design). It cannot be both — verified, per-module, chosen at build time. Hence **two libcs**:

- **continuation libc** — asyncify-tainted; provides `fork`/`setjmp`/`longjmp`.
- **lean libc** — no asyncify; preserves the JSPI/native fast route; `fork()` is a weak/`-ENOSYS` stub (link error by design).

**Cost of asyncify (verified, why this is opt-in not universal):**
- Code size **≈ +40%** (`docs/superpowers/plans/2026-05-17-fork-capture-notes.md:150`).
- A fixed **64 KiB** static unwind side-stack per continuation guest (`abi/src/yurt_setjmp.c:45` `YURT_ASYNCIFY_BUF_SIZE 65536`, exported `yurt_asyncify_buf_size`).
- Runtime: per-instrumented-function unwind/rewind state-machine prologue/epilogue + local spill, even when never suspending.

Universal asyncify would impose this on **every** guest while 99% never `fork()` — and would forfeit JSPI/native everywhere. Opt-in two-libc is therefore correct, not stylistic.

**Open cost lever (recorded, not a blocker):** `continuation_args()` (`wasm_opt.rs:15-18`) applies **blanket `--asyncify`** — no `--pass-arg=asyncify-imports@…` allowlist. Scoping asyncify to only the `fork`/`setjmp` suspend-import call paths would materially cut the +40%/runtime cost. Tracked as a future optimization sub-task; this design does not depend on it.

## The 99% / 1% split (sys_spawn is required, NOT obsoleted)

- **99% — `system()` / `popen()` / `posix_spawn()`**: "run a child program", not "duplicate my address space." Routed through a POSIX extension over **`sys_spawn`** (fork+exec fused, **no continuation, lean libc**). This is the common path; **`sys_spawn` and its contract-completeness (#169) are required and explicitly NOT obsoleted by real `fork()`** — they serve the lean-libc majority. (Corrects an earlier #169 reframing comment that wrongly routed `posix_spawn` through userland fork+exec; a correction is posted to #169.)
- **1% — real `fork()`** (job-control shells, fork-then-work-in-child without exec): continuation libc only. **This spec is the 1% path.**

They are complementary tracks, never to be re-conflated: lean-libc programs get spawn (#169); continuation-libc programs get real fork (this).

## Host architecture

**Current state (Task-0 spike, verified):** the Rust host `host_fork` is a broken **memory-only rebuild** — `snapshot_user_memory` (`kernel_host_interface.rs:209`) copies linear-memory bytes only (no stack/locals/return-address); `instantiate_fork_child` builds a fresh instance driven via `child.call_run()`→`"run"` (`:3134`,`:3606`), but WASI binaries export `_start`, so the child runs **zero instructions**. The JS host `host_fork` is an `-ENOSYS` stub. Both must be **built, not wired**.

**Rust host** (`packages/runtime-wasmtime`): replace the rebuild with real asyncify unwind/rewind:
1. guest (continuation libc) calls `yurt.host_fork`; the asyncify-instrumented guest is mid-unwind, its call stack spilled into `yurt_asyncify_buf` (64 KiB), linear memory is the parent's exact state at the `fork()` site.
2. host calls kernel `prepare_fork(parent_pid)` → `child_pid` (kernel allocates pid, clones fd-table/cwd/creds, marks `ForkPreparing`).
3. host creates the child instance from the **parent's memory + asyncify buffer snapshot** (NOT a fresh `_start`), starts the child in asyncify **rewind** so it returns from `host_fork` with `0`.
4. parent is rewound returning `child_pid`.
5. host calls `commit_fork(parent_pid, child_pid)` (child becomes waitpid/signal/schedule-visible); any host-step failure → `rollback_fork`.
- A **lean-libc** guest (no asyncify) reaching `host_fork` → return spec-mandated **`-ENOSYS`** (fix the current bug where it returns a bogus child pid). Belt-and-braces; the primary gate is the link error.

**JS host** (`kernel-host-interface-js`): **port-and-adapt** the proven `AsyncifyAsyncBridge` fork logic — `hostFork` / `snapshotForkContinuation` / `restoreForkSnapshot` / `startForkRewind` / `AsyncifyForkController` — out of `packages/kernel/src/async-bridge.ts`. Remove `host_fork` from `USER_YURT_STUB_IMPORTS`. Mirror the Rust per-child semantics (cross-host parity discipline, as the spawn/wait slice did).

**Kernel** (`packages/kernel-wasm`): `prepare_fork`/`commit_fork`/`rollback_fork`/`ProcessForkState::ForkPreparing` are **landed and valid — unchanged**. Kernel owns process identity/fd-table-clone/wait-visibility/rollback; host owns continuation capture/restore.

## Critical sequencing / interlock

The proven JS continuation reference (`AsyncifyAsyncBridge`) lives in **`packages/kernel/src/async-bridge.ts` — the TS kernel that Phase 4 (#170) deletes.** It MUST be ported out (JS-host Task) **before** #170 removes it. **#224 (this) blocks #170**; #170 must not delete `packages/kernel/src/async-bridge.ts` until the JS port lands. This ordering is a hard constraint on the umbrella #172.

## Error handling / edges

- lean-libc `fork()` → link error (primary, by design); `host_fork` reached by a lean guest → `-ENOSYS`.
- `fork()` from a process with imported shared memory, or a non-main pthread → **`-EAGAIN`** (first pass; existing non-goal carried from the 2026-05-16 spec).
- Any host capture/instantiate/commit failure → `rollback_fork`, no partial child visible to `waitpid`.
- `vfork()` = `fork()` alias (existing non-goal: no suspended-parent shared-address-space semantics).
- `WIFSIGNALED`/full signal wait-status is **#99**, out of scope.

## Testing / cross-host parity

- The Task-0 `fork-twice` characterizing test (`fixture_parity.rs`) is the **tripwire**: today it asserts the rebuild signature (parent-only line, child never runs). On completion it must flip to the true-snapshot signature — **two** lines, the child observing the parent's *pre-fork* sentinel (proving shared memory state at the fork point) and `rc=0`, parent `rc=child_pid`.
- Cross-host **parity oracle**: same `fork-twice` (+ a `fork-exec` fixture) byte-identical stdout + exit through the Rust `kernel_host_interface` host AND the JS `Runner`, same discipline as the merged spawn/wait slice (#129).
- Fork fixtures must be built through the **continuation/asyncify toolchain mode** (`wasm_opt.rs` `use_continuation=true`); `ensure_fixture_built`'s plain `cargo build` does not run `wasm-opt --asyncify` — the fixture harness needs an asyncify build path. (New sub-task surfaced by the spike.)

## Decomposition (for the implementation plan)

1. **T1** — `fork-twice` (exists) + `fork-exec` fixtures; asyncify fixture-build harness (`ensure_fixture_built` continuation mode).
2. **T2** — Rust host: replace the rebuild with real asyncify snapshot/rewind; lean-guest `host_fork` → `-ENOSYS`.
3. **T3** — JS host: port-and-adapt `AsyncifyAsyncBridge` from `packages/kernel/src/async-bridge.ts`; un-stub `host_fork`.
4. **T4** — cross-host parity (`fixture_parity.rs` + JS `Runner` E2E) + edges (`vfork`, `-EAGAIN` shared-mem/threaded, `-ENOSYS` lean).
5. **T5** — verify + the #170 port-before-delete coordination (block/annotate #170 so `async-bridge.ts` survives until T3 lands).

## Out of scope (cross-referenced)

- The 99% `system`/`popen`/`posix_spawn` → `sys_spawn` POSIX-extension + `sys_spawn` contract-completeness — **#169** (required, separate track, not obsoleted).
- Full `WIFSIGNALED` wait-status — **#99**.
- Scoped-asyncify cost optimization (`asyncify-imports` allowlist) — recorded future lever, not depended on.
- Concurrent fork with live pipes/pthreads beyond first-pass `-EAGAIN`.
