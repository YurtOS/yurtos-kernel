# Fork Capture Spike — Task 0 Findings

> Gating discovery spike for the real-`fork()` initiative
> (`docs/superpowers/plans/2026-05-17-fork-continuation.md`,
> governed by `docs/superpowers/specs/2026-05-16-rust-fork-parity-design.md`).
> **No host code was changed.** This document is the deliverable; it
> revises Tasks 1–4 of the plan.
>
> Worktree `yurtos-kernel-forkimpl`, branch `claude/fork-impl`, off
> `main @ 396c7c50`. Line numbers below were re-pinned during this
> spike (the plan's v2 note anticipated this drift).

---

## (a) Snapshot-vs-rebuild verdict: **REBUILD** (and the rebuilt child does not even run for standard WASI binaries)

The Rust host `runtime-wasmtime` `host_fork` is **NOT a continuation
snapshot**. It is a **linear-memory-copy REBUILD**, and for a standard
`wasm32-wasip1` binary the rebuilt child **never executes at all**.

### Code-evidence chain

`packages/runtime-wasmtime/src/kernel_host_interface.rs`:

| Step | file:line | What it does |
| --- | --- | --- |
| `host_fork` linker fn | `:3548-3616` (`"host_fork"` at `:3550`) | The whole fork path. |
| forced-return short-circuit | `:3552-3554` | `if let Some(value) = caller.data_mut().forced_fork_return.take() { return value; }` — consumed by the child the **first time the child itself calls `host_fork`**, not at instantiation. |
| `prepare_fork` | `:3557-3566` | Kernel allocates `child_pid`. |
| `snapshot_user_memory` | `:3567` → def `:209-223` | Copies **linear-memory bytes only** (`memory.read(&*caller, 0, &mut snapshot)`). Returns `-EAGAIN` if memory is shared. **No execution stack, no locals, no call frames, no instruction pointer captured.** |
| `instantiate_fork_child` | `:3583` → def `:813-870` | `Module::new` (`:821`, fresh compile) + `linker.instantiate` (`:846-848`, **brand-new instance**); writes the parent's memory bytes into the child's linear memory (`:860-864`); sets `forced_fork_return: Some(0)` (`:838`). |
| `commit_fork` | `:3597-3605` | Makes child waitable. |
| **child drive** | `:3606` | `child.call_run()` → `call_export_i32("run")` (`:3134-3135`, `:3139-3146`) — invokes an exported function literally named **`run`**. |
| child exit recording | `:3610-3613` | `record_exit(child_pid, child_exit)`. |
| parent return | `:3614` | `child_pid as i32`. |

Two independent proofs this is a rebuild, not a continuation:

1. **Only linear memory is captured.** `snapshot_user_memory`
   (`:209-223`) reads `memory` bytes. The wasm **execution stack**
   (operand stack, locals, the `fork()` call frame / return address)
   is never touched. A continuation requires that stack; a rebuild
   does not. There is no asyncify unwind/rewind, no JSPI
   `Suspending`, no stack-switching anywhere on this path.

2. **The child is entered from a fresh top-level export, not the
   `fork()` site.** `call_run()` looks for an export named `run`.
   A standard Rust `wasm32-wasip1` binary exports `_start`, **not
   `run`** — so for every real fixture the child instance's `run`
   lookup fails (`get_typed_func` errors), `call_run()` returns
   `Err`, and the child is recorded as exit 127 **without running a
   single guest instruction**. Even if the child *did* export `run`,
   it would re-enter from the top with `forced_fork_return: Some(0)`
   armed for its *own* future `host_fork` call — i.e. re-run the
   whole program, not resume after the parent's `fork()`. Either way
   it is categorically not "child resumes at the `fork()` call site".

### Fixture + characterizing test

- Fixture: `test-fixtures/wasm/fork-twice/{Cargo.toml,src/main.rs}`,
  registered in workspace `Cargo.toml` members. Raw
  `#[link(wasm_import_module = "yurt")] extern "C" { fn host_fork() -> i32; }`
  (exactly the `abi/src/yurt_runtime.h:137` / `abi/src/yurt_fork.c`
  ABI: module `yurt`, name `host_fork`, `() -> i32`). Mirrors
  `abi/conformance/c/fork-canary.c`'s `expect_continuation_split`
  reduced to its load-bearing observable: set
  `static mut FORK_SENTINEL = 42` **before** `fork()`, then print one
  deterministic host-invariant line
  `fork-twice <branch> rc=<rc> sentinel=<n>`.
- Test:
  `packages/runtime-wasmtime/tests/fixture_parity.rs::fork_twice_characterizes_current_host_fork`
  — explicitly labelled **CHARACTERIZING** (pins *current* behavior;
  it is **not** the eventual oracle). It asserts the rebuild
  behavior so a future Task 2 real-snapshot trips it loudly.

### Observed output (captured this spike, via the public
`KernelHostInterface` API, kernel.wasm built from this worktree)

```
stdout:    "fork-twice parent rc=2 sentinel=42\n"   (exactly ONE line)
last_exit: Some(0)
run_start: Err("user process called proc_exit(0)")  (normal: WASI shim
           traps proc_exit after stashing the code)
```

Interpretation: `host_fork()` returned `2` (the `prepare_fork`-allocated
child pid); the **parent** kept its own `sentinel=42` and exited 0.
**There is no `rc=0` child line at all** — the rebuilt child instance
was driven via the absent `run` export and executed zero instructions.
This empirically confirms REBUILD, and specifically the
"child-never-runs" sub-case for standard WASI binaries.

`cargo test -p yurt-runtime-wasmtime --test fixture_parity` → **13
passed, 0 failed** (12 pre-existing untouched + this 1 new
characterizing test).

---

## (b) Capture-mechanism recommendation

### What this repo can actually do today (evidence)

| Capability | In-repo evidence | Status for the `host_fork` path |
| --- | --- | --- |
| Binaryen `--asyncify` build | `abi/toolchain/yurt-toolchain/src/wasm_opt.rs:15-19` (`continuation_args()` adds `--asyncify`), `:27-53` (`maybe_run`), gated by `use_continuation`; `abi/toolchain/yurt-toolchain/src/features.rs:9` marks `{"async":"asyncify","features":["continuations"]}`; `abi/src/yurt_fork.c` is the continuation-archive strong `fork()` shim that calls `yurt_host_fork`. | **Toolchain exists and works** — a continuation-tagged guest is asyncify-instrumented (exports `asyncify_{start,stop}_{unwind,rewind}`). This is the universal mechanism. Requires `wasm-opt` on PATH at build. |
| Asyncify host driver (JS) | `packages/kernel/src/async-bridge.ts` ships a **complete** `AsyncifyAsyncBridge` (`:130+`) with `hostFork` (`:284`), `snapshotForkContinuation` (`:363`), `restoreForkSnapshot` (`:304`), `startForkRewind` (`:321`), and the `AsyncifyForkController` / `AsyncifyForkSnapshot` types (`:73-86`). | **Reference implementation exists** — but in the **old TS kernel that PR #129 deletes**. It is the proven design to port, not reuse as-is. |
| JSPI | `kernel-host-interface-core/src/lib.rs:96-102` + `kernel-host-interface-js/mod.ts:836-839` both document JSPI present on V8/SpiderMonkey, **absent on Safari/JavaScriptCore**. Matches project memory `project_async_bridge` (JSPI not universal). | Faster where present; **cannot be the only path** (Safari). |
| wasmtime async / stack-switching | `runtime-wasmtime` `call_async` usages are all on the **kernel.wasm sandbox driver** (`wasm/instance.rs`, `wasm/spawn.rs`, `wasm/command.rs`), a *different* engine. The **user-process engine** (`kernel_host_interface.rs:2542-2545`) is built with **only** `epoch_interruption(true)` + `wasm_threads(true)` — **no `async_support`, no stack-switching**. The Rust `AsyncBridge` trait (`kernel-host-interface-core/src/lib.rs:136-156`) is `suspend_until`-only (no fork/continuation method) and wasmtime defaults to `NoopAsyncBridge` → `NotSuspendable` (`:158-175`). | wasmtime has **no continuation capability on the user-process path today**. wasmtime stack-switching is not enabled/used anywhere. |

### Recommendation

**Both hosts: asyncify is the only viable universal mechanism — adopt
it as the primary path for `host_fork`. JSPI is a per-host
*optimization* layered on top later, never the sole path.**

- **Rust host (`runtime-wasmtime`):** Implement continuation capture
  via the **Binaryen asyncify** instrumentation the in-repo toolchain
  already produces (`wasm_opt.rs` continuation mode). The host drives
  `asyncify_start_unwind` at the `host_fork` import to unwind the
  parent's stack into the asyncify data buffer, snapshots **memory +
  the asyncify data buffer + stack pointer** (not memory alone, which
  is the current bug), instantiates the child from that full
  snapshot, rewinds the child (`asyncify_start_rewind`) so it resumes
  *at the `fork()` call site* returning `0`, and rewinds the parent
  returning the child pid. wasmtime cannot do JSPI or stack-switching
  on the user-process engine today, and adding `async_support` to that
  engine does **not** give continuation snapshot/restore (JSPI-style
  suspension ≠ fork's clone-and-resume-twice) — so asyncify is not
  just the universal choice, it is the *only* one available to the
  Rust host without a wasmtime upgrade + new engine config. Rationale
  matches the spec ("a host that cannot snapshot returns `-ENOSYS`")
  and project memory `setjmp_longjmp = libc + asyncify`,
  `project_async_bridge` (asyncify universal), `project_async_bridge_integration`.

- **JS host (`kernel-host-interface-js`):** Implement the **asyncify**
  path, porting the proven `AsyncifyAsyncBridge` continuation logic
  (`hostFork` / `snapshotForkContinuation` / `restoreForkSnapshot` /
  `startForkRewind` / `AsyncifyForkController`) from the
  to-be-deleted `packages/kernel/src/async-bridge.ts` into the new
  host's bridge. The new host's `AsyncBridge` interface
  (`mod.ts:871-879`) is currently a `suspendUntil`-only shape with
  **no fork method**, defaults to `noopAsyncBridge`, and `host_fork`
  is hardwired `-ENOSYS` (in `USER_YURT_STUB_IMPORTS`, `mod.ts:547`,
  → `() => -ENOSYS` at `:1697-1698`). JSPI (`JspiAsyncBridge`) is a
  later optimization for V8/SpiderMonkey hosts; it must never be the
  only path because Safari/JavaScriptCore lacks it (per the matrix and
  project memory). Asyncify is engine-agnostic and is the universal
  fallback the spec's non-goals assume.

- **Tradeoffs (grounded):** asyncify ≈ +40% binary size and a
  measurable per-instrumented-call overhead (documented in
  `async-bridge.ts:13-16`), but is the **only** mechanism that works
  on every engine in the matrix and the **only** one wasmtime can do
  on the user-process path today. JSPI: no size cost, faster, but
  V8/SpiderMonkey-only — strictly a layered optimization. Native
  wasmtime stack-switching: would be ideal but is **not enabled,
  configured, or used** anywhere in this repo's user-process path —
  out of scope for this initiative.

### Why fork differs from the just-merged spawn/wait pump

The spawn/wait re-entrant pump (`drain_and_run_pending_spawns`,
`kernel_host_interface.rs:3432-3450`) instantiates each pending child
from `spawn.wasm` and runs it via **`run_start()` (`_start` from the
top)**. That is *correct for spawn* because a spawned child **is** a
fresh program image that *should* begin at `main`. It uses **no
continuation capture** — it never needs the parent's stack, only a new
process from an image. `fork()` is the opposite: the child must resume
**mid-execution at the `fork()` call site** with the parent's exact
stack and post-fork memory image. `instantiate_with_pid_raw` +
`run_start` (fresh `_start`) structurally cannot express that. This is
precisely why the spawn/wait spec deliberately deferred fork to this
continuation-snapshot initiative, and why reusing the spawn pump
verbatim for fork is impossible — only its `(engine, kernel)`
free-fn / re-entrant-drive *plumbing pattern* is reusable, not its
"start child at `_start`" semantics.

---

## How this revises Tasks 1–4 of the plan

The plan's Task 0 explicitly anticipated this ("is the child a true
snapshot or a weaker rebuild? … the weaker model is semantically
wrong"). The spike resolves it to **REBUILD**, with the additional
finding that the rebuilt child **never executes** for standard WASI
binaries (no `run` export). This sharpens later tasks:

- **Task 1 (`fork-twice` / `fork-exec` fixtures):** Partially done.
  `fork-twice` exists and builds (`fork-twice-wasm`,
  `wasm32-wasip1`). It currently encodes the **rebuild
  characterization**, not the parent-observes-child-via-`waitpid`
  contract. Task 1's remaining work: keep `fork-twice` but layer the
  `prepare/commit` + `waitpid` observation discipline (like the
  spawn-wait fixture) once the child can actually run; add the
  separate `fork-exec` fixture. The characterizing test must be
  **replaced** (not extended) by the Task 4 oracle when Task 2 lands —
  it is wired to fail the moment a real `rc=0` child line appears, by
  design.

- **Task 2 (Rust host real continuation): scope is "REPLACE the
  rebuild with a real asyncify snapshot/restore", NOT "wire existing
  scaffolding".** The existing `forced_fork_return` /
  `instantiate_fork_child` / memory-only `snapshot_user_memory` path
  is **fundamentally the wrong shape** and must be **removed**, not
  extended:
  - `snapshot_user_memory` must additionally capture the asyncify
    data buffer + stack pointer (memory-only is the core bug).
  - `instantiate_fork_child` must **not** drive the child via
    `call_run()` (absent `run` export — currently dead). It must
    instantiate the child and **rewind** it (`asyncify_start_rewind`)
    so it resumes at the `fork()` site returning `0`; the parent must
    likewise rewind returning the child pid. `forced_fork_return`
    becomes obsolete (replaced by asyncify's natural import-return
    value on rewind).
  - The user-process engine config (`kernel_host_interface.rs:2542`)
    stays as-is (asyncify is wasm-level; no `async_support` needed)
    — but the guest fixtures for fork tests must be built through the
    **continuation/asyncify** toolchain mode
    (`wasm_opt.rs::continuation_args`), which the current
    `ensure_fixture_built` (plain `cargo build`, no `wasm-opt
    --asyncify`) does **not** do. Task 2 must add an asyncify build
    step for fork fixtures (new sub-task; not in the original plan).

- **Task 3 (JS host `host_fork`): scope is "port the proven
  `AsyncifyAsyncBridge` fork logic from the deleted TS kernel into
  the new host", NOT "implement from scratch".** Remove `host_fork`
  from `USER_YURT_STUB_IMPORTS` (`mod.ts:547`); extend the new host's
  `AsyncBridge` interface with the fork-controller surface
  (`forkFromContinuation` / snapshot shape from `async-bridge.ts:73-86`);
  port `hostFork`/`snapshotForkContinuation`/`restoreForkSnapshot`/
  `startForkRewind`. This is a *port-and-adapt*, materially
  de-risked vs. the plan's implied greenfield.

- **Task 4 (cross-host parity oracle):** Unchanged in intent, but its
  prerequisite is now explicit: it can only exist once **both** hosts
  do real asyncify continuation **and** the fork fixtures are built
  asyncify-instrumented. The `fork_twice_characterizes_current_host_fork`
  test is the tripwire that forces this swap.

### Does this change whether the spec's approach is still valid?

**The spec's approach remains valid and is reaffirmed.** The
`prepare_fork`/`commit_fork`/`rollback_fork` kernel contract is
sound, landed, and unit-tested; the spike confirms the host adapter
(not the kernel) owns continuation capture exactly as the spec's
Architecture section states. The only spec-relevant clarification:
the spec's "the host adapter owns the continuation operation:
capture the guest stack/memory state" is currently **unimplemented on
both hosts** — Rust does a memory-only rebuild, JS returns `-ENOSYS`.
The spec's non-goal "no `fork()` without continuation snapshot
support; non-continuation guests keep `-ENOSYS`" is the correct
fallback and must be wired (Rust currently returns a bogus child pid
for non-asyncify guests instead of `-ENOSYS` — a Task 2/5 correctness
item this spike surfaces).
