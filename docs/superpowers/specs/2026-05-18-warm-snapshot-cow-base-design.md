# Warm-Snapshot CoW Base ("Python loads once")

**Date:** 2026-05-18 **Status:** Draft

## Summary

Make the post-init heap of a warmed interpreter a **shared read-only base
layer** that every new sandbox starts from copy-on-write: snapshot e.g. CPython
_once_ after interpreter/import init, then spawn each new identical sandbox by
`mmap(MAP_PRIVATE)`-ing that warm image. Sandbox N+1 costs only its dirty pages
and skips interpreter init entirely (millisecond cold-starts). This is
sub-project **E3** of the sandbox-orchestration platform — the memory-density
lever that makes "thousands of sandboxes, never recycled" economically real, and
the concrete meaning of "Python loads once, not once per machine."

This is the same copy-on-write model YurtOS **already ships at the filesystem
layer** (overlay VFS: shared read-only base image + per-sandbox writable upper,
copy-up on write), applied **one layer down at the wasm linear memory**. The
warm memory image rides the existing image-artifact/loader machinery; the only
genuinely new code is an `mmap`-backed `wasmtime::LinearMemory` plus a capture
step.

Scope of _this_ spec: **native/Wasmtime, single host, one warm base per image,
B-independent.** Convergence with sub-project B's `.yurtsnap` S5 is a design
constraint (the warm-image bytes are byte-identical to S5) but not a runtime
dependency.

## Why

The target clients are LLM-driven agents that spin up many sandboxes and must
not have them recycled. Today each sandbox is a fresh `WebAssembly.Instance`
with its own OS-allocated linear memory (~1 MB floor + interpreter heap), and
the compiled module is only shared within a process tree — so a Python sandbox
re-runs interpreter init and re-pays its multi-MB heap every time. The
architectural enabler (and why this is tractable here vs Docker/Firecracker):
there is no per-sandbox guest kernel, the compiled module is content-addressed,
and the overlay CoW pattern is already proven in the filesystem layer.

## Decisions (locked in brainstorming)

- **Host target:** native / Wasmtime, macOS (darwin) is the real first target —
  no `memfd`; CoW substrate is `mmap(MAP_PRIVATE)` of a warm-image file.
- **v1 mechanism:** warm a **template** instance, capture its linear memory to a
  content-addressed artifact, CoW-spawn new sandboxes from it. B-independent.
- **Convergence with B:** the warm-image artifact is laid out **byte-identical
  to B's `.yurtsnap` S5** section, so once B lands, E3 becomes the digest-keyed
  shared CoW base behind B's restore (`base_image_digest`) with no format
  change.
- **Warm point:** declarative — the Yurtfile/image recipe specifies a warm
  command + an explicit "snapshot-ready" marker; reproducible,
  content-addressed.
- **CoW substrate:** Approach 1 — host-managed `mmap(MAP_PRIVATE)` of the
  warm-image file, supplied to Wasmtime via the embedder `MemoryCreator` /
  `LinearMemory` trait, slot-pooled by us. Approach 2 (Wasmtime native
  `memory_init_cow` + synthesized module) is the documented fallback if the
  embedder-`unsafe` surface proves too sharp; it shares less across host
  processes on darwin. Approach 3 (in-process fork of a live template) is
  rejected as primary — it buys cold-start latency, not memory density — but its
  parentage bookkeeping is reused.
- **Reseed barrier:** reuse B's `SIGCONT` + epoch resume contract; kernel
  enforces fresh identity/entropy/clocks; in-heap userland entropy correctness
  needs a guest-side warm-fork shim (shipped for Python in v1).

## Architecture

**Same CoW model, one layer down.** Overlay VFS already gives: shared read-only
base image + per-sandbox writable upper, copy-up on write. E3 is that exact
model at the wasm linear memory: a shared read-only **warm memory image**
(base) + per-sandbox dirty pages (the "upper"), realized by
`mmap(warm_image, MAP_PRIVATE)`. "Python loads once" = the interpreter's
post-init heap _is_ the read-only base layer; spawning sandbox N+1 costs only
its divergent pages — like a container sharing a base image's pages, but at
RAM-page granularity with no per-sandbox kernel.

**Reuse vs build:**

- _Reuse:_ the image-artifact + loader/overlay machinery — the warm memory image
  is another content-addressed layer that rides existing image loading and the
  Yurtfile/image-builder pipeline that produces it; and the overlay CoW
  _pattern_ itself (proven, shipping).
- _Reuse:_ B's `.yurtsnap` **S5 byte layout** for the warm-image file → E3's
  base file _is_ B's S5 payload; later convergence = "S5 restore points at this
  shared file."
- _Build (the only new code):_ an `mmap(MAP_PRIVATE)` CoW-backed
  `wasmtime::LinearMemory` injected at the `runtime-wasmtime` instance-creation
  seam + a host-owned slot pool; and the warm-capture step.

**Ownership is unchanged from B:** the kernel quiesces the template and records
"this sandbox derives from base image D"; the host owns the mmap/slot mechanics.
Same kernel-policy / host-mechanism split — no new ownership concept.

## Warm-capture pipeline

1. The Yurtfile/image recipe declares: base rootfs + a **warm command** (e.g.
   `python -S -c 'import <preload set>'`) + a **readiness marker** (the warm
   command invokes an explicit "snapshot-ready" syscall, or exits with a
   sentinel — recipe-driven, reproducible).
2. The builder boots **one** template, runs the warm command to the marker, then
   **quiesces at that marker** (a syscall safepoint — reuses B's quiesce
   protocol) and serializes linear memory + exported globals (`__stack_pointer`,
   …) into the warm-image artifact in **S5 layout**, recording `module_digest`
   and the rootfs/overlay base it was warmed against.
3. The artifact is content-addressed → `base_image_digest`; stored/loaded
   through the existing image machinery. Identical recipe ⇒ identical digest ⇒
   shareable across the whole host (page cache) and across hosts (ship the
   artifact, exactly like B/D).

**Capture-time invariant:** a warm template **must hold no external handles**
(it is quiesced at the pre-network marker). The builder rejects a template that
opened host/external fds. Internal fds the warm command legitimately opened
(e.g. a preloaded data file) are part of the image and valid.

## CoW-spawn + slot pool

Spawn a sandbox from warm base image `D`:

1. Acquire a free **slot** from a host slot pool — pre-reserved address-space
   regions, wasm32-sized + guard page (amortizes mmap/teardown, bounds memory).
2. `mmap(warm_image, MAP_PRIVATE, cur_pages·64KiB)` into the slot → reads share
   the file's page cache; writes fault private copies. Restore exported globals
   from the artifact.
3. Hand it to Wasmtime via the custom `LinearMemory`, enforcing wasm semantics:
   size = `cur_pages`; `memory.grow` maps fresh anonymous zero pages _beyond_
   the image; `max` + guard page honored; never expose image bytes past
   `cur_pages`.
4. Kernel records the sandbox as deriving from `base_image_digest=D` (so a later
   B checkpoint emits S5 as "base D + dirty pages" — the reserved S5 field goes
   non-zero; convergence).
5. Run the **reseed barrier** (below) _before_ the guest executes.

**Reclamation** on exit/offload: drop private dirty pages
(`madvise(MADV_DONTNEED)` / remap clean), return the slot to the pool; the
shared base stays page-cached for the next spawn (that is the "loaded once"
persistence). Pool capacity = `max_resident_sandboxes` → back-pressure
(EAGAIN/wait), never OOM. wasm32 slots reserve 4 GiB _virtual_ (not resident)
address space — fine on 64-bit hosts; document the virtual-AS budget.

**Plan spike (darwin):** validate `MAP_PRIVATE` file CoW + `madvise`
(`MADV_DONTNEED`/`MADV_FREE`) slot-reset semantics on macOS vs Linux, and the
exact Wasmtime `MemoryCreator`/`LinearMemory` surface for the pinned Wasmtime
version, before committing the slot-reuse strategy (remap vs madvise).

## Reseed / re-identity barrier (core correctness & security risk)

A CoW-spawned sandbox is semantically "restored from a shared warm heap," so it
**reuses B's resume contract** (bump the yurt epoch counter, set per-process
flags, deliver `SIGCONT`), plus a typed barrier the kernel runs **before the
guest's first instruction**:

- **Kernel-enforced (not trusting the guest):** fresh pid/tid, argv/env/cwd,
  credentials; an **independent entropy source per sandbox** — the next
  `getrandom`/`/dev/urandom` returns fresh bytes, never the template's (the
  security-critical guarantee); `CLOCK_MONOTONIC` rebased (B's S7/S9 machinery);
  realtime = host now.
- **Guest-cooperative (userland half):** runtimes that cache entropy/identity
  _in their own heap_ (which is inside the CoW image) must reseed themselves —
  CPython hash seed, `random`, OpenSSL/`ssl` PRNG, pid caches,
  `register_at_fork`-style hooks. The platform supplies the `SIGCONT` + epoch
  signal and a documented fork-safety contract; a small **yurt warm-fork shim**
  (loaded by the recipe's warm command) installs the handlers so stock Python is
  correct out of the box. This is the well-understood PRNG-reseed-after-fork
  class of fix.

**Invariant (the honest boundary, same shape as B's drop-and-observe):** the
platform guarantees fresh kernel-level identity/entropy/clocks at the barrier;
in-heap userland entropy correctness requires the shim or guest cooperation; a
warm template with live external handles is rejected at capture.

## Failure modes & limits

- **Digest/arch skew:** spawn refuses if `base_image_digest` is not
  resident/loadable (same manifest-gate discipline as B restore). A warm image
  is bound to its `module_digest` + host arch + Wasmtime codegen; cross-arch
  reuse is out of scope (a warm image is host-specific, like any snapshot) and
  ties to E1 compiled-code dedup.
- **Grow-past-image / bounds:** the custom `LinearMemory` enforces zero-fill
  beyond `cur_pages` and `max`; mapping-length math must not wrap (the 32-bit
  `usize` length-guard discipline — kernel-wasm is wasm32 while `cargo test` is
  64-bit, so overflow can pass CI invisibly).
- **Untrusted artifact:** validate header/section bounds and page counts vs file
  length _before_ mapping, with the rigor the kernel applies to guest syscall
  buffers.
- **Slot exhaustion:** bounded pool → back-pressure surfaced to the orchestrator
  (future A/F control plane), never OOM.
- **Reseed gap is a security bug, not a perf nit:** v1 ships the warm-fork shim
  for Python and documents the contract; non-cooperative guests get kernel-level
  guarantees only — explicitly called out, not silently degraded.
- **v1 limits / out of scope:** single host; native/Wasmtime; one warm base per
  image. Out: page-diff-vs-base delta encoding in B's S5; JS/Deno path
  (engine-limited CoW); cross-arch; multiple warm bases per image.

## Test matrix

Native/Wasmtime; darwin + linux (the spike validates darwin CoW reset). Tests
must exercise the real wasm path, not native-only logic.

1. **Density:** spawn N=100 sandboxes from one warm CPython base → process RSS ≈
   N × dirty-pages, not N × full-heap (measure RSS + dirty-page count).
2. **Cold-start:** CoW-spawn time-to-first-guest-instruction ≪ a cold `python`
   boot (skips interpreter init) — assert order-of-magnitude.
3. **CoW isolation:** sandbox A writes a page; sandbox B (same base) still sees
   the original bytes (private-copy semantics).
4. **Entropy/identity independence (security)** — probes the two halves of the
   reseed barrier with the right primitive for each (they have opposite expected
   outcomes without the shim):
   - **4a, kernel-enforced (shim-independent):** `os.urandom` / a raw
     `getrandom` differ across two sandboxes from the same base **even without
     the warm-fork shim**. `os.urandom` is a direct kernel CSPRNG consumer, not
     an in-heap PRNG (which is exactly why `os.register_at_fork` never reseeds
     it), so this proves the kernel-enforced entropy guarantee and must hold
     independently of the shim.
   - **4b, shim-dependent (in-heap):** the in-heap PRNG/identity state —
     `random.random()` sequence, `hash(str)` under `PYTHONHASHSEED`, and the
     OpenSSL/`ssl` PRNG — is **identical** across two siblings **without** the
     shim and **differs with** it. This is the assertion that proves the
     warm-fork shim is load-bearing.
5. **Clock rebase:** a fresh sandbox sees `monotonic()` ≈ 0, not the template's
   warm age.
6. **Slot reuse:** spawn → exit → spawn reuses a slot; the freed sandbox's dirty
   pages do not leak into the next (assert clean image bytes).
7. **B-convergence smoke:** the warm-image artifact parses as a valid
   `.yurtsnap` S5 section (proves the format-convergence claim without requiring
   full B).

## Relationship to the platform

This is sub-project **E3** (see
`docs/superpowers/specs/2026-05-18-running-sandbox-checkpoint-restore-design.md`,
Decomposition). Siblings: **E1** compiled-code dedup (`Arc<Module>` across
sandboxes + AOT cache — a natural prerequisite/parallel win), **E2** pooling
allocator + CoW memory-init from module data segments, **E4** side-module dedup.
E3 is the dramatic "loads once" lever and is independent of B at runtime; **B**
(`.yurtsnap`) is the convergence target — once B lands, the warm image _is_ B's
S5 `base_image_digest` and E3 becomes B-restore with a shared CoW base.

## Existing code this builds on / touches

- Reuse: the image-loader / overlay-VFS / Yurtfile / image-builder pipeline to
  produce, store, and load the warm-image artifact (content-addressed layer).
- Reuse: B's quiesce protocol to stop the template at the snapshot marker, and
  B's `SIGCONT`+epoch resume contract as the reseed trigger.
- Build: an `mmap(MAP_PRIVATE)` CoW-backed `wasmtime::LinearMemory` + host slot
  pool at the `packages/runtime-wasmtime` instance/Store/Memory creation seam
  (no pooling allocator / `memory_creator` is wired today).
- Build: the warm-fork reseed shim for the Python runtime fixture.
- Format: warm-image artifact == B's `.yurtsnap` S5 section layout.

## Open questions (resolve in the plan, not blocking the design)

1. Slot-reset strategy on darwin: `madvise(MADV_DONTNEED)` vs remap vs
   `MADV_FREE` — decided by the spike.
2. Whether the warm-fork shim is a libc-level constructor, a Python
   `sitecustomize`, or a yurt runtime preload — pick the one stock Python honors
   without app changes.
3. Exact "snapshot-ready" marker surface (dedicated syscall vs sentinel exit
   code vs a Yurtfile directive) — align with the image-builder's existing
   command model.
4. Slot-pool sizing/eviction policy and its interface to the future A/F control
   plane (back-pressure vs evict-LRU-to-offload).
