# Shared Libraries — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [2026-05-09 Shared Libraries Design](../specs/2026-05-09-shared-libraries-design.md)

**Goal:** Land the guest-visible shared-library contract and a correct
(unoptimized) base implementation that works identically on Wasmtime,
Deno/Node, and browsers. Performance optimizations are out of scope and
covered by a follow-up spec.

**Non-goals for Phase 1:**

- Module deduplication, AOT cache, pooling allocator, CoW initial
  memory, sandbox snapshots — Wasmtime-only optimizations, follow-up
  spec.
- Component Model dynamic composition.
- TLS in side modules.

---

## Slice ordering

Each slice ships independently and gates the next. Sub-slices may
parallelize where their **Depends on** column allows.

| # | Slice | Output | Depends on |
|---|---|---|---|
| 1A | Spec + plan + failing canary skeleton | This doc; the design spec; canary `.c` and `.spec.toml` committed; Deno tests `it.skip` with TODO; Rust test `#[ignore]` | — |
| 1B | Toolchain | `yurt-cc -fPIC`, `yurt-cc -shared`; `yurt-wasi-postlink` `dylink.0` validator + `yurtmeta.json` emitter | 1A |
| 1C | Headers + guest stubs | `abi/include/dlfcn.h`; `abi/src/dlfcn.c` calling `yurt_dl*` host imports; main module exports `__alloc`/`__dealloc` available to loader | 1A |
| 1D | Wasmtime loader | `packages/runtime-wasmtime/src/wasm/dynlink.rs`; host imports in `mod.rs:977`; canaries pass on Wasmtime | 1B + 1C |
| 1E | Deno/Node + browser loader | TS loader under `packages/kernel/src/process/`; host imports in the kernel import-builder; canaries pass on Deno/Node and browsers | 1B + 1C |
| 1F | Dogfood | `libyurt_sched.wasm` side module; affinity-canary rebuilt against the dynamic version; passes existing `sched_*` specs on all backends | 1D + 1E |

The contract is observably frozen at the end of 1A. Slices 1B–1F
implement the contract; if any of them surfaces a contract problem we
land an amendment to the spec before the slice ships.

---

## Slice 1A — Spec + plan + failing canary skeleton (this commit)

**Files in this slice:**

- Create: `docs/superpowers/specs/2026-05-09-shared-libraries-design.md`
- Create: `docs/superpowers/plans/2026-05-09-shared-libraries-phase1.md`
  (this document)
- Create: `abi/conformance/c/dlopen-canary.c`
- Modify: `packages/kernel/src/__tests__/abi_test.ts`
  - Add a `describe.skip('dlopen-canary', ...)` block that documents
    the cases the canary should cover, with a `TODO: requires
    yurt-cc -shared (1B) + Wasmtime/Deno loaders (1D, 1E)` comment.

**Tasks:**

- [ ] **Step 1: Land the spec doc.** Already produced; review against
  the user feedback: "stabilize the ABI; make sure the contract is
  right and the base implementation works; optimize later, with
  Wasmtime in mind." Confirm the spec separates contract (Phase 1)
  from optimization (deferred).

- [ ] **Step 2: Land this plan doc.** Confirms slice ordering and
  pins the dependency graph.

- [ ] **Step 3: Add `abi/conformance/c/dlopen-canary.c`** following
  the existing canary template
  (`abi/conformance/c/dup2-canary.c`). The C source documents the
  six cases (`happy_path`, `lazy_now_equiv`, `double_open_refcount`,
  `missing_path`, `missing_symbol`, `bad_format`) and references
  `<dlfcn.h>` (which itself lands in 1C). The canary is not added to
  `CANARY_NAMES` in `abi/Makefile` until 1B.

- [ ] **Step 4: Defer `abi/conformance/dlopen.spec.toml` to slice 1B.**
  `yurt-conf` (the local opt-in conformance runner) hard-fails when a
  `.spec.toml` exists without a corresponding built canary wasm. The
  spec doc and the C source already document the cases; the TOML
  ships in 1B alongside the build wiring.

- [ ] **Step 5: Add a skipped Deno test** under
  `packages/kernel/src/__tests__/abi_test.ts` that documents the
  expected end state. Use `describe.ignore` with a comment pointing
  at this plan and the spec.

- [ ] **Step 6: pre-commit + pre-push.** No code is built in 1A so
  the gates are paperwork-only: `deno fmt --check`, `deno lint`,
  `cargo fmt --all -- --check`, hygiene hooks. `cargo test --tests`
  and the deno test glob must remain green. New canary `.c` is
  not yet built, so it does not affect `make -C abi all` or
  `yurt-conf` (no spec.toml → no failure path triggered).

**Definition of done for 1A:** This commit lands on
`claude/add-shared-libraries-zzuRn`. CI is green. Reviewer can answer
"is the contract right?" purely from the spec doc + canary cases.

---

## Slice 1B — Toolchain (next commit)

**Files in this slice:**

- Modify: `abi/toolchain/yurt-toolchain/src/main.rs` — add
  `-fPIC` and `-shared` modes; route `-shared` invocations through
  `wasm-ld --shared --experimental-pic` plus the new postlink pass.
- Modify: `abi/toolchain/yurt-wasi-postlink/` — add the `dylink.0`
  validator pass and `yurtmeta.json` sidecar emitter.
- Modify: `abi/Makefile` — new rule for side-module canaries; add
  `dlopen-canary` to `CANARY_NAMES` once the side module
  `libyurt_dlcanary.wasm` builds; add `libyurt_dlcanary.wasm` recipe.
- Add: `abi/conformance/c/libyurt_dlcanary.c` (companion side module
  for `dlopen-canary`; exports `yurt_dlcanary_double`).
- Add: `abi/conformance/dlopen.spec.toml` — case definitions for the
  conformance runner. Lands here (not in 1A) so that `yurt-conf` does
  not hard-fail before the canary wasm is built.

**Definition of done:** `make -C abi canaries` produces
`build/libyurt_dlcanary.wasm` with a valid `dylink.0` section and a
sidecar manifest. `yurt-wasi-postlink` rejects malformed `dylink.0`
sections in unit tests.

---

## Slice 1C — Headers + guest stubs

**Files:**

- Add: `abi/include/dlfcn.h` (per spec § dlfcn API Surface).
- Add: `abi/src/yurt_dlfcn.c` — guest-side stubs that call
  `yurt_dlopen`/`yurt_dlsym`/`yurt_dlclose`/`yurt_dlerror`.
- Modify: `abi/Makefile` — add `yurt_dlfcn.o` to `LIB_OBJS`; the
  static archive grows by ~1 KB. Existing static-link path
  unaffected.

**Definition of done:** `make -C abi lib` produces a `libyurt_abi.a`
that contains `dlopen`/`dlsym`/`dlclose`/`dlerror`. The stubs return
`NULL`/`-1` at run time when the host has no loader (1D/1E land
that). `dup2-canary` and friends rebuild without regression.

---

## Slice 1D — Wasmtime loader

**Files:**

- Add: `packages/runtime-wasmtime/src/wasm/dynlink.rs` — handle
  table, instantiation algorithm (per spec § Loader Algorithm).
- Modify: `packages/runtime-wasmtime/src/wasm/mod.rs` — register
  `yurt_dlopen`/`yurt_dlsym`/`yurt_dlclose`/`yurt_dlerror` host
  imports (alongside existing `add_misc_imports` at line 977).
- Modify: `packages/runtime-wasmtime/src/wasm/mod.rs` `StoreData` —
  add the per-sandbox handle table.
- Add: `packages/runtime-wasmtime/tests/dlopen.rs` — Rust-side
  integration test driving the canary against the Wasmtime backend.
- Modify: `packages/kernel/src/__tests__/abi_test.ts` — flip the
  Wasmtime-backed `dlopen-canary` describe from `skip` to active.

**Definition of done:** `dlopen-canary` (all cases) passes on
Wasmtime. Existing canaries still pass. `cargo clippy --all-targets
-- -D warnings` clean.

---

## Slice 1E — Deno/Node + browser loader

**Files:**

- Add: `packages/kernel/src/process/dynlink.ts` — TS loader
  mirroring 1D's algorithm via `WebAssembly.{Module,Instance}` and
  `WebAssembly.Table.prototype.grow`.
- Modify: `packages/kernel/src/process/loader.ts` (or wherever the
  kernel registers `yurt`-namespace imports) — add the four
  `yurt_dl*` imports.
- Add: `packages/kernel/src/__tests__/dlopen_test.ts` — Deno-side
  integration test driving the canary.
- Confirm browser smoke via the existing browser-platform-adapter
  pattern.

**Definition of done:** `dlopen-canary` passes on Deno/Node. Browser
smoke passes (subject to existing browser test setup). The skipped
Deno test from 1A is now active and passing.

---

## Slice 1F — Dogfood

**Files:**

- Add: `abi/src/yurt_sched_pic.c` — same content as the relevant
  parts of `abi/src/yurt_sched.c` but compiled with `-fPIC` and
  linked with `-shared`.
- Modify: `abi/Makefile` — new recipe building
  `build/libyurt_sched.wasm`. Static `libyurt_abi.a` keeps a strong
  reference to the same symbols.
- Add: `abi/conformance/c/affinity-canary-dyn.c` — a variant of
  `affinity-canary.c` that loads `libyurt_sched.wasm` via `dlopen`
  and calls into it.
- Spec: existing `abi/conformance/sched_*.spec.toml` files cover the
  expected behavior; the dynamic canary asserts the same outputs.

**Definition of done:** `affinity-canary-dyn` passes on all three
backends with identical observable output to `affinity-canary`. The
contract is proven end-to-end on a real ABI piece.

---

## Cross-cutting verification

After each slice the following gates must be green:

- `cargo fmt --all -- --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test --tests`
- `deno fmt --check`
- `deno lint`
- `deno check 'packages/**/*.ts'`
- `deno test` (fast tier)
- `make -C abi all` and `copy-fixtures` from 1B onward
- `guest-compat.yml` (the slow tier) from 1D onward, locally if
  available, otherwise on PR

"CI green = done" per [`AGENTS.md:11`](../../../AGENTS.md). The bar
is unchanged.
