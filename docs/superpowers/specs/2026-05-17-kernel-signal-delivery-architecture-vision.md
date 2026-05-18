# Kernel-Authoritative Signal Delivery — Architecture Vision

> **Type:** umbrella vision / alignment artifact. Not an implementation spec.
> Defines the north star, the sub-projects, their contracts, the
> cross-cutting invariants, and the build order. Each sub-project gets
> its own `*-design.md` spec → plan → implement → review → PR slice.
>
> **Origin:** PR #151 (issue #90, per-thread signal mask) was reverted —
> review found a P1 (kernel owned the mask but guest C `yurt_raise_now`
> still adjudicated deliver-vs-defer from orphaned guest-local state; the
> pending-drain loop was deleted). Root cause is architectural: there is
> no unified kernel-owned signal-delivery model. Maintainer decision:
> redesign signals as one clean initiative; re-land #90's mask as a slice
> of it. Prior art to reuse, not rebuild: the #90 rounds-1–7 spec
> (`2026-05-17-signal-mask-surface-design.md`, on the retained
> `worktree-parity-signal-mask` branch) — the 1-byte guest `sigset_t`,
> the compact-slot⇄`sig-1` remap-in-Rust, the `process_mut` sibling
> convention, and the §11 divergence list.

## 1. North star

The **kernel is the sole authority** for every piece of signal state and
policy: the per-thread blocked mask, the pending set, the per-process
disposition (`struct sigaction`: handler token + `sa_mask` + `sa_flags`),
deliverability, default actions, and the during-handler mask.

The **guest libc holds zero signal policy or state.** It is exactly two
things: (1) a thin typed-binary marshaller for the signal syscalls, and
(2) a dumb handler-trampoline that runs *only* a kernel-authorized
handler invocation and reports completion via `sigreturn`. The guest
never reads or decides the mask, pending, disposition, or default
action. A guest that adjudicates delivery from guest-controlled state is
a security defect — that is precisely the #90 regression class, and this
architecture exists to make it structurally impossible.

## 2. Sub-projects

There is **no separate "AsyncBridge" subsystem to build.** Suspend /
resume / scheduling of processes and threads is an **existing host
interface** (the same one the kernel already uses to run, yield, and
resume guest execution — implemented by both host backends: the
**JavaScript host** and the **native Rust host**; the relevant axis is
JS-host vs native-Rust-host, *not* asyncify-vs-JSPI). Signal delivery
*rides that existing interface*; it introduces no new async primitive.
(This **supersedes the prior "AsyncBridge as its own subsystem/trait"
project framing** — see the scoped correction in the
`[AsyncBridge capability matrix]` memory.)

The initiative is therefore **two** sub-projects:

### (B) Kernel signal state ownership — *foundation*

The single source of truth, in kernel state:

- **Per-thread blocked mask** (`ThreadRecord.blocked_signals`) — re-lands
  #90 correctly, *within* this model. Per-thread; `sigprocmask` ==
  `pthread_sigmask` on the calling thread; thread-spawn and `fork()`
  inheritance.
- **Per-process disposition table** — full `struct sigaction`:
  kernel-opaque handler token (the handler *code* is inherently guest;
  the kernel stores only an opaque token the guest trampoline maps back
  to a function), plus `sa_mask` and `sa_flags` (SA_RESTART, SA_SIGINFO,
  SA_NODEFER, SA_RESETHAND, SA_ONSTACK…). SIG_DFL/SIG_IGN are kernel
  decisions, not guest convention. **SIGKILL and SIGSTOP have no
  settable disposition:** `sigaction`/`signal` on them MUST return
  `EINVAL` (never catchable or ignorable; no handler/SIG_IGN ever
  stored) and they always take their default action; `sigprocmask`
  silently excludes them from the blocked mask. (Today's kernel
  `sigaction` accepting any `1..=63` and storing the disposition —
  `process.rs` — is a known gap this slice closes.)
- **Unified pending model — two pools.** Reconciles standard signals
  (coalesced; one bit) and RT signals (queued, multiplicity + siginfo),
  AND distinguishes **process-directed** pending (`kill`/`killpg` —
  pending on the *process*, delivered to exactly one arbitrarily-chosen
  thread that does not block it; the kernel owns that thread-selection
  rule) from **thread-directed** pending (`pthread_kill`/`tgkill`/`tkill`
  — pending on a *specific thread*). Synchronous faults are **not** in
  this pending model at all (separate control-transfer class — §2(C)).
  The
  separated-producer patchwork (`pending_signals` bitmask vs `pending_rt`
  queue vs guest-local raise) is replaced by one kernel-owned
  representation that still tracks both pools. A flat per-thread set is
  wrong.
- **Producer funnel (complete).** `raise`/self, `kill`, `killpg`,
  `pthread_kill`/`tgkill`/`tkill`, `sigqueue`, `alarm`/timer, SIGCHLD —
  all funnel into the one representation. **Synchronous faults
  (SIGSEGV/SIGBUS/SIGFPE/SIGILL/SIGTRAP) are NOT funnel producers and
  are out of scope for (B)** — they are a separate control-transfer
  class whose treatment is a documented divergence owned solely by
  §2(C). (B) is never held to funnel or pend them.
- **Consumer surface — eventual consumers of the one authority.**
  (B) implements **none** of these; (B) ships only the kernel-owned
  pending-state + the read contract they consume. Each is its own later
  slice: handler delivery (§2(C)); the synchronous-accept family
  (`sigwait`/`sigwaitinfo`/`sigtimedwait`); the mask-swap-then-wait
  consumers (`sigsuspend`, `pselect`/`ppoll` — #91). **`signalfd` is
  explicitly its own separate later slice — not (B) and not (C)**: it
  adds fd creation, read semantics, readiness/blocking, and fd
  lifecycle, well beyond signal-state ownership; it merely *will*
  consume the same authority. The umbrella fixes only that every
  consumer reads the one kernel authority, never guest state; exact
  per-consumer semantics live in each owning slice's spec.
- **Deliverability authority** — `deliverable = pending(process ∪
  thread) ∧ ¬blocked(thread)`, disposition applied kernel-side (SIG_IGN
  drops in the kernel; SIG_DFL resolves to the kernel-decided default
  action: terminate / stop / cont / ignore). SIGKILL/SIGSTOP unmaskable.
  Job-control coupling is kernel signal-state: a delivered SIGCONT
  discards pending stop signals and a delivered stop discards pending
  SIGCONT — stop/cont are not modeled as ordinary signals.
- **`fork()`/`execve()` signal-state contract.** `fork()`: child
  inherits the calling thread's blocked mask (per-thread bullet) and the
  disposition table, but the child's **pending set is empty**.
  `execve()`: caught dispositions reset to `SIG_DFL` (SIG_IGN stays
  ignored); the blocked mask and the pending set are **preserved**.

Asyncify/scheduler-independent. **Unblocks #91** (`pselect`/`ppoll` need
the kernel blocked mask). Ships before (C).

### (C) Delivery + sigreturn protocol — over the existing scheduler interface

At a **suspension point** the kernel selects the next deliverable signal
for the target thread and builds a **delivery frame** (signo + siginfo +
an opaque restore token). At this **delivery step (handler entry)** the
kernel computes the during-handler mask (`sa_mask ∪ {signo} ∪ current`,
modulo `SA_NODEFER`) **and applies `SA_RESETHAND`** — the disposition
resets to `SIG_DFL` *before the handler runs*, so a same-signal re-raise
during the handler (with `SA_NODEFER`) takes the default action (POSIX;
applying the reset at `sigreturn` would be wrong). The guest trampoline
runs the handler and calls `sigreturn(token)`; the kernel then does
**only** the **atomic** mask-restore + deliverability re-eval (drain
loop until nothing is deliverable). `sigreturn` is the *only*
mask-restore path. At a **syscall-boundary** delivery point an
interrupted restartable syscall is restarted iff the handler's
`SA_RESTART` is set, else it returns `EINTR`.

**Injection-point invariant (fundamental):** the kernel can inject a
signal **only when the guest is suspended**. The available suspension
points are:

1. **The syscall boundary** — every kh_/syscall is a suspension point.
   *Always available*, on every engine and both host backends.
2. **Scheduler preemption** — the scheduler forcibly taking control of a
   running guest. *Only if the engine supports preemptiveness* (an
   engine capability, queried, not assumed).

Consequence (documented, POSIX-acceptable): a CPU-bound guest making no
syscalls, on a non-preemptive engine, sees a pending signal only at its
next syscall — i.e. delivered "at the next safe point." This is the
standard model, not a defect. "Async preemption" is **not a separate
mechanism**: it is this same (C) protocol with injection allowed at a
scheduler-preemption point in addition to syscall boundaries — gated
purely by the engine-preemptiveness capability.

**Third control-transfer class — synchronous faults (divergence).**
SIGSEGV/SIGBUS/SIGFPE/SIGILL/SIGTRAP are semantically required *at the
faulting instruction*, not at a suspension point. In a wasm guest a trap
unwinds the instance, so faithful at-fault delivery is not generally
possible. This is a **documented, POSIX-acceptable divergence** (same
register as the CPU-bound case): the synchronous class is a **non-goal**
of the synchronous-delivery model; its exact treatment (trap→terminate
mapping vs. best-effort) is decided and documented in **(C)'s** own
spec, never silently.

## 3. Build order & relationship to other work

```
(B) kernel signal state  ──►  (C) delivery + sigreturn protocol
        │                              │
        └─ unblocks #91                └─ "async preemption" = (C) with
           (pselect/ppoll)                scheduler-preemption injection
                                          point, iff engine supports it
```

`(B)` → `(C)`. Each is its own spec → plan → implement → review → PR
slice (slice discipline; never a mega-PR). #91 resumes after **(B)**
lands. The existing scheduler/suspend-resume host interface is consumed
as-is by (C); if (C) needs a new control-point hook it is specified in
(C)'s own design, not invented here.

## 4. Cross-cutting invariants (the contracts that keep slices coherent)

1. One kernel-owned pending representation; no guest-side pending state.
2. The guest never reads or decides mask / pending / disposition /
   default action. Ever.
3. `sigreturn` is the sole mask-restore path; restore is atomic with
   deliverability re-evaluation.
4. Typed-binary ABI, no JSON; 1-byte guest `sigset_t` carried verbatim,
   compact-slot⇄`sig-1` remap lives in safe Rust (reuse #90 prior art).
5. Method-id discipline. **#90's old `0x1_00A0` ids are NOT reclaimable
   — `main` advanced and that range is now in use** (`0x1_00A0` =
   `sys_getrandom`; `0x1_00A4`–`0x1_00A9` = `ftruncate`/`truncate`/
   `fsync`/`fdatasync`/`sync`/`syncfs`). Each signal slice MUST, in
   order: (a) correct the stale partition comment in
   `yurt_abi_methods.toml` (canonical umbrella **#57** / tracking #52,
   not the reverted #51) and add its own block line; (b) re-check the
   live `0x1_00A*` high-water mark at slice time (it moves) and allocate
   a **fresh contiguous block after the current highest user**;
   append-only, never renumber, never reuse.
6. Conformance gate: the `signal-canary` cases — explicitly including
   `case_blocked_host_signal_delivers_after_unblock` (the #90 regression
   repro) — plus the Open POSIX `sig*` interface dirs.
7. Per-engine honesty: capability (preemptiveness) is queried; behavior
   and the parity-matrix row state per-backend reality (JS host / native
   Rust host), never an over-claimed "all adapters".
8. **Two-pool pending:** process-directed (`kill`/`killpg` → one
   arbitrary non-blocking thread; kernel owns the selection rule) vs
   thread-directed (`pthread_kill`/`tgkill`/`tkill`, synchronous
   faults). A flat per-thread set is wrong (§2(B)).
9. **`fork()`/`execve()` state:** `fork()` clears the child's pending
   set (mask + dispositions inherit); `execve()` resets caught
   dispositions to `SIG_DFL` (SIG_IGN preserved), preserving mask +
   pending (§2(B)).
10. **Disposition/restart timing:** `SA_RESETHAND` resets at handler
    entry (delivery), never at `sigreturn`; syscall-boundary delivery
    restarts iff `SA_RESTART` else returns `EINTR`; job-control
    stop/cont are kernel signal-state, not ordinary signals (§2(C)/§2(B)).
11. **Synchronous-fault divergence:** SIGSEGV/SIGBUS/SIGFPE/SIGILL/
    SIGTRAP cannot be faithfully delivered (wasm trap unwinds the
    instance); a documented divergence whose treatment is owned by
    (C)'s spec, not implicit. They are **not** (B) funnel producers
    (§2(B)/§2(C)).
12. **SIGKILL/SIGSTOP are absolute:** `sigaction`/`signal` → `EINVAL`
    (never catchable/ignorable), never blockable, always default action
    (terminate / stop). (B) closes the current `sigaction`
    accept-any-`1..=63` gap (§2(B)).

## 5. Explicit deltas vs. today

- Reverts #90 (PR #151 closed); supersedes the separated-producer model.
- `sigaction` moves from guest-local `yurt_signal_actions[]` to
  kernel-owned disposition; the guest keeps only an opaque token→fn
  table (handler code is guest, policy is kernel).
- Default-action termination is a kernel decision, not guest `_Exit`.
- Guest `yurt_signal_mask` / `yurt_pending_signal_mask` and the
  guest-side deliver/defer decision are deleted outright.

## 6. Non-goals / boundaries

- Not redesigning the non-signal syscall/scheduler runtime; (C) consumes
  the existing scheduler/suspend-resume host interface.
- Not specifying (B)/(C) implementation here — that is each
  sub-project's own design spec.
- Engine preemptiveness itself is an existing engine capability; this
  initiative consumes/queries it, it does not implement preemption.
