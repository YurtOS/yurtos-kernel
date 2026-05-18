# Running-Sandbox Checkpoint/Restore (`.yurtsnap` v2)

**Date:** 2026-05-18 **Status:** Draft

## Summary

Make a _running_ YurtOS sandbox serializable: quiesce it, capture its full state
into a single kernel-authored `.yurtsnap` envelope, and restore it later on the
same host with identical observable behavior. This is the keystone primitive for
the larger goal — an app that manages thousands of concurrent sandboxes,
suspends/offloads idle ones from memory, and transports sandboxes between client
and servers — because suspend-to-disk and cross-host transport are both just
serialization targets of this one format.

Scope of _this_ spec is deliberately narrow: **checkpoint and restore a running
sandbox on a single native/Wasmtime host.** Offload-on-idle, cross-host
transport, the shared-executable memory-density work, and the LLM-facing control
plane are separate follow-on specs (see [Decomposition](#decomposition)).

This is not greenfield. The pieces exist but are scattered and partial:
`kernel_snapshot` already emits a `YURTSNP\0` envelope with
process/thread/wait/runnable sections
(`packages/kernel-wasm/src/dispatch/process.rs`); the asyncify path already
captures a full linear-memory + stack image
(`packages/kernel/src/async-bridge.ts` `snapshotForkContinuation`);
`exportState` / `runtime-wasmtime` `vfs::export_bytes` already serialize
VFS+env. The work is **unifying these into one coherent kernel-authored v2
envelope and adding the missing sections (memory, fd-graph, signal/timer,
resume-cursor)** — per the existing direction in
`docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md` ("Suspend,
Resume, and Teleport").

## Why

The target clients are LLM-driven agents that want to spin up many sandboxes and
not have them recycled after a few minutes. That requires the ability to evict
an idle sandbox from RAM and bring it back exactly as it was, and to move a
sandbox between machines. None of that is possible while a sandbox's only
serializable state is its filesystem. The architectural reason this is
_tractable_ in YurtOS (and miserable under CRIU/Firecracker-fiber approaches):
the kernel lives **inside** the sandbox, every user→kernel call goes through a
host trampoline, and WebAssembly keeps the entire C/runtime stack in linear
memory. So a thread stopped at a syscall boundary has no hidden machine state.

## Scope & v1 boundary (decisions)

- **Host target:** native / Wasmtime only. Web/JSPI is later — JSPI
  continuations cannot be serialized today.
- **Serializable safepoint =** `{syscall/import boundary}` ∪
  `{asyncify unwind point}`. **Fuel/epoch interruption is a scheduling
  primitive, never a checkpoint primitive**: a sync trap destroys the stack; an
  async fiber yield is resumable only in-process and is not serializable. v1
  captures **syscall-quiesced threads only**.
- **Stragglers:** a thread that will not reach a syscall safepoint within
  `T_quiesce` (e.g. a pure-CPU NumPy loop in a non-asyncify module) is
  **killed**, and reported. Asyncify-built guests (so a periodic unwind is a
  serializable safepoint) are the _only_ real fix for capturing mid-computation
  threads, and are a documented later enhancement — not fuel.
- **External resources — drop-and-observe:** open TCP connections, host-bound
  listeners, in-flight `kh_fetch`, and hostfs fds are recorded as _dead_. On
  restore they return `ECONNRESET`/`EBADF`; the guest reconnects. Internal
  resources (pipes, sibling AF_UNIX, ramfs files, memory, threads, timers)
  restore faithfully.
- **Resume notification — portable floor:** deliver `SIGCONT` to every process
  on restore (POSIX-exact for "continued"; harmless default action). A handler
  distinguishes a migrate/restore from an ordinary continue by reading
  kernel-provided state (a bumped **yurt epoch counter** + a per-process
  **stale-fd flag**). A dedicated `SIGRTMIN+n` lifecycle signal with `si_code`
  is a deferred, opt-in richer channel for when we own the guest runtime.
- **Default straggler policy:** drop the offending thread and report it;
  abort-the-whole-checkpoint is an opt-in flag.

### Completeness theorem (load-bearing)

For a syscall-quiesced wasm thread, the complete resumable state is exactly:

> **linear memory ∪ exported mutable globals ∪ pending syscall**

WebAssembly exposes no caller-saved machine registers across a host-import
boundary, and the C/runtime stack lives inside linear memory. Therefore
syscall-quiesced capture is provably complete — there is no hidden execution
state to lose. This is why Approach 1 (below) works and why fuel-quiesced
(stack-live) threads are the _only_ uncapturable case.

## Architecture

**Chosen approach: extend the kernel-authored `.yurtsnap` envelope**
(alternatives — host-side Wasmtime Store snapshot; asyncify-as-universal — are
rejected as primary: the first is engine-locked and reintroduces host-owned
process state the architecture deliberately moved into the kernel; the second
taxes every module and is single-threaded. Both may return _under_ this format —
a native Store fast-path, an asyncify web backend — without changing it.)

Two kinds of state, captured two ways:

- **Kernel logical state** — process/thread/wait/runnable/fd/signal tables,
  authored _logically_ (no pointers, no host objects) by kernel.wasm. Portable
  by construction. Extends the existing `kernel_snapshot`.
- **Per-user-process state** —
  `(module_digest, linear-memory image,
  exported globals, pending syscall)`.
  The kernel cannot read a user process's linear memory directly; capture is
  **kernel-orchestrated, host-assisted**: the kernel walks its process table and
  pulls each process's memory bytes + module digest from the host via the
  existing `kh_process_mem_*` / module-cache (SHA-256) plumbing
  (`packages/kernel-wasm/src/kh.rs`,
  `packages/kernel/src/process/module-cache.ts` and the native equivalent). The
  host stays a byte-mover; the kernel stays the single source of truth.

This ownership split is what makes the follow-on specs nearly mechanical:
offload = write the envelope to disk; transport = ship the envelope +
re-instantiate modules by digest.

## The `.yurtsnap` v2 envelope

Header unchanged: `YURTSNP\0`, `version` (bumped `1 → 2`), `section_count`,
`flags`, then typed `(section_type, section_len, bytes)` records. Existing
section types 1–4 (process-list / thread-groups / wait-records /
runnable-threads) are retained. New sections:

| ID  | Section            | Contents                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S5  | Memory image       | per pid: `module_digest` (SHA-256), `cur_pages`, exported mutable globals (incl. `__stack_pointer`), page records. v1 = full dump; record reserves `base_image_digest` (zero in v1) so the future CoW/dedup work stores only pages differing from a shared base **without a format bump**.                                                     |
| S6  | FD/handle graph    | per process `fd → kernel-object-id`. Objects: pipe (buffered bytes + ends + EOF), internal AF_UNIX pair, ramfs open file (inode+offset+flags), epoll/eventfd/timerfd. Shared endpoints dedupe by object id (both ends restore to the same object). External handles become **tombstones** (`was_tcp`/`was_listener`/`was_fetch`/`was_hostfs`). |
| S7  | Signal/timer state | pending sets, blocked masks, `sigaction` dispositions (handler = funcref value in memory). Timers stored as **remaining duration**, not absolute deadline.                                                                                                                                                                                     |
| S8  | Resume cursor      | per quiesced thread: in-flight `(method_id, request_bytes, out_cap)` **plus an effect-boundary marker** (captured before vs after the syscall's kernel mutation). Tiny — there is no stack to save.                                                                                                                                            |
| S10 | VFS image          | kernel-authored ramfs tree; virtual `/proc`, `/dev`, hostfs excluded (matches `exportState`'s allowlist). Supersedes the split `exportState`/`vfs::export_bytes` paths with one kernel-owned section.                                                                                                                                          |
| S9  | Rebase/manifest    | monotonic base, realtime offset, the **yurt epoch counter**, and the list of `module_digest`s the envelope depends on (target verifies it can supply them before accepting).                                                                                                                                                                   |

Compat: a v2 reader lacking S5/S6/S8 **refuses** (cannot fabricate memory).
Forward-compat is via typed-section iteration — additive fields (e.g. CoW) need
no version bump.

## Quiesce protocol

1. **Trigger:** `kernel_checkpoint_begin(sandbox)` — new host-control export,
   same family as `kernel_snapshot`.
2. **Barrier:** kernel sets `checkpointing` → (a) new spawn/thread-create is
   queued, not run; (b) each thread, at its next trampoline entry, is parked as
   "quiesced @ S8" instead of dispatched; (c) already-blocked threads
   (`read`/`waitpid`/`sleep`/futex) are inherently at a safepoint — they are the
   existing wait-records (S3), zero extra work.
3. **Bounded wait + straggler-kill:** wait ≤ `T_quiesce` for all threads to
   reach a safepoint. Non-quiescing threads are killed; the result **reports
   every force-killed pid/tid** (orchestrator decides retry-later vs
   accept-loss). Killing a process's main thread records it
   exited-by-checkpoint, not silently resurrected.
4. **Atomicity:** author the envelope in one pass while the world is stopped.
   Any mid-capture failure → discard the partial envelope, un-quiesce, return
   error; the sandbox keeps running untouched. Checkpoint is side-effect-free on
   failure.
5. **Kernel self-consistency is free:** kernel.wasm is single-threaded and
   dispatch is serialized under the KH per-instance lock, so
   `kernel_checkpoint_*` is just another serialized dispatch — no separate
   kernel-quiesce step.

Open knobs resolved in implementation, not here: `T_quiesce` global vs
per-sandbox-class; abort-all opt-in flag default off.

## Restore + reattach

1. **Manifest gate (S9):** target verifies it can supply every `module_digest`
   (local module-cache or bundled). Missing + unbundled → refuse up front with
   exact missing digests. Never a mid-restore failure.
2. **Rebuild kernel objects:** fresh (or warm) kernel.wasm;
   `kernel_restore_begin` feeds the envelope. Kernel rebuilds
   process/thread/wait/runnable tables and the fd-graph — pipes/socketpairs
   re-created with buffered bytes, ramfs files reopened at saved offsets,
   tombstones installed for dead externals.
3. **Repaint processes:** per pid, host instantiates the module _by digest_ (N
   restored sandboxes of the same image share one compiled `Module` — the
   memory-density win compounds here), writes back S5 pages, sets exported
   globals. No stack rebuild — memory _is_ the stack.
4. **Rebase:** remaining-durations → new monotonic deadlines; bump the yurt
   epoch; set the per-process stale-fd flag for any process that held externals.
5. **Resume:** re-enter the trampoline per thread with its S8 cursor — the
   effect-boundary marker decides re-dispatch vs return-saved-result. Deliver
   `SIGCONT` to every process. Blocked threads remain blocked on rebuilt kernel
   objects (correct by construction).

Invariant: **restore = rebuild objects → repaint memory → rebase clocks →
re-enter trampoline → `SIGCONT`.** Zero execution-state reconstruction.

## Failure modes & invariants

- **Atomic & side-effect-free:** failed checkpoint → sandbox runs on untouched;
  failed restore → no half-live sandbox, source envelope intact (retry
  elsewhere). Never a partially-live sandbox.
- **Exactly-once syscall across a checkpoint:** the S8 effect-boundary marker
  guarantees an in-flight syscall is neither lost nor double-applied. This is
  what makes later transport safe (ship → fail → restore elsewhere cannot
  double-apply the effect).
- **Version/compat:** `version = 2`; readers without S5/S6/S8 refuse;
  typed-section iteration keeps future fields additive.
- **Module mismatch:** handled at the manifest gate (precheck), never
  mid-restore.
- **Straggler honesty:** force-killed threads appear in the result report.
- **External truthfulness enforced:** tombstones deterministically return
  `ECONNRESET`/`EBADF`; no fd ever silently rebinds to a stale host socket
  (security boundary — ties to the embedder PolicyEnforcer at the `kh_*`
  crossing).
- **Envelope is untrusted input:** on restore, validate section bounds, page
  counts vs declared `cur_pages`, and digest match with the same rigor the
  kernel applies to guest syscall buffers — note the 32-bit `usize` length-guard
  discipline (kernel-wasm ships wasm32; native `cargo test` is 64-bit, so
  overflow bugs can pass CI invisibly).

## Test matrix

Native/Wasmtime. Tests must exercise the **real wasm kernel path**, not
native-only unit logic (the usize-width gap means native-only tests miss 32-bit
overflow).

1. Compute + periodic `write()` → checkpoint at a syscall → restore → output
   continues unbroken.
2. Reader blocked in `read()`, separate writer → restore → writer writes →
   reader wakes with correct bytes (S6 pipe buffer + S3 reconstruction).
3. Parent+child over internal AF_UNIX mid-exchange → restore → conversation
   resumes (shared-object dedupe).
4. `nanosleep(10s)` checkpointed at t=3s, restored a minute later → wakes ~7s
   post-restore (timer rebase).
5. Open TCP conn → restore → next `recv` = `ECONNRESET`; `SIGCONT` handler sees
   stale-fd flag + bumped epoch and reconnects (drop-and-observe + notification
   contract).
6. Pure-CPU thread beside a normal one → checkpoint → CPU thread killed within
   `T_quiesce`, reported; the rest restores clean.
7. **Transport-shaped, single host:** checkpoint → teardown → restore into a
   _fresh kernel instance_ in the same process → all of the above still hold
   (proves the envelope is self-contained; de-risks the transport spec).

## Decomposition

This spec is sub-project **B** of a larger platform. Sequencing:

- **B (this spec):** running-sandbox checkpoint/restore, single host. Keystone.
- **C:** offload/rehydrate on idle (evict envelope to disk/remote, fault back).
  Depends on B; mostly orchestration + a storage backend.
- **D:** cross-host transport (client↔server, server↔server) — B's envelope + a
  wire protocol + module-bundle negotiation + the dead-external contract.
- **E (parallel, independent):** shared-executable memory density — CoW
  post-init memory image, Wasmtime pooling allocator, cross-sandbox
  module/side-module dedup. The economic lever for "thousands, never recycled";
  slots under S5's reserved `base_image_digest`.
- **A/F:** control plane + LLM-facing SDK ("start, keep, attach, never
  recycled"). Product shell on top of B/C/D.

## Existing code this builds on / replaces

- Extend: `packages/kernel-wasm/src/dispatch/process.rs` (`kernel_snapshot`,
  `SNAPSHOT_*`, section encoders) → v2 + S5–S10; add `kernel_checkpoint_begin` /
  `kernel_restore_begin` control exports.
- Reuse: `kh_process_mem_*` (`packages/kernel-wasm/src/kh.rs`) + module-cache
  SHA-256 for host-assisted memory/module capture.
- Supersede: `Sandbox.exportState`/`importState` and `runtime-wasmtime`
  `vfs::export_bytes`/`import_bytes` → unified S10.
- Later backend, not v1: asyncify `snapshotForkContinuation`
  (`packages/kernel/src/async-bridge.ts`) for mid-computation capture once a
  web/asyncify slice is in scope.
- Boundary: enforce dead-external tombstones at the embedder PolicyEnforcer
  (`kh_*` crossing).

## Open questions (resolve in the plan, not blocking the design)

1. `T_quiesce` value and whether it is per-sandbox-class.
2. Exact wire layout of S5 page records (run-length vs fixed 64 KiB pages) —
   pick the one that makes the future CoW diff cheapest.
3. Whether `kernel_restore_begin` reuses a warm kernel.wasm or always a fresh
   instance (warm is faster for offload churn; fresh is simpler/safer for v1).
4. The exact readable discriminator surface (`/proc/self/yurt/epoch` file vs a
   dedicated tiny syscall) for the `SIGCONT` handler.
