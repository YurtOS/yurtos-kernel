# Sub-project (B): Kernel Signal State Ownership — design

> **Parent vision:** `2026-05-17-kernel-signal-delivery-architecture-vision.md`
> (umbrella, approved 4 review rounds). This is **Stage 1** of the
> initiative — the foundation slice. Its own spec → plan → implement →
> review → PR slice. **Prior art** (reuse, don't rebuild): the #90
> rounds-1–7 spec, reachable on the retained `worktree-parity-signal-mask`
> branch at `docs/superpowers/specs/2026-05-17-signal-mask-surface-design.md`
> — the 1-byte guest `sigset_t`, the compact-slot⇄`sig-1` remap-in-Rust,
> the per-thread-mask + fork/spawn inheritance pattern, the `process_mut`
> sibling convention, the §11 divergence list.

## 0. Staging & convergence contract (BINDING)

(B) is **Stage 1, not the destination.** It makes the kernel the
authority for signal *state* and the *deliver/defer decision*. The guest
libc *handler-execution / `sigreturn` / drain / preemption* path is
deliberately left as a documented stage, finished by sub-project (C).

**Hard rule — no stage may ship the #90 over-delivery bug** (a *blocked*
signal being run). (B) satisfies this by **neutralising guest-local
adjudication wherever it kernel-routes**: when (B) makes the mask
kernel-owned it also routes the deliver/defer *decision* to the kernel,
so the guest never decides delivery from now-stale guest-local state.
Interim observable behaviour is correct *withholding* of blocked signals
+ kernel-pending until (C) drains/runs them — a documented, acceptable
gated **under-delivery**, never the security **over-delivery** bug.

**Convergence obligation (recorded so a future reader cannot mistake the
stage for the goal):** the initiative is "done" only when (C) + the
consumer slices reach the end state — guest libc thin, kernel sole
authority, full delivery+`sigreturn`+drain+preemption, all consumers.
(C) MUST atomically convert the remaining guest libc signal path onto
(B)'s authority and delete any residual guest-local mask/pending/
disposition/delivery adjudication. (B)'s PR description and this section
state explicitly that (B) alone is a non-terminal stage.

## 1. Kernel state (`packages/kernel-wasm/src/kernel.rs`)

```rust
pub struct PendingSet {
    /// Standard signals: coalesced, one bit, `1<<(sig-1)`.
    pub standard: u64,
    /// POSIX RT signals: queued with multiplicity + siginfo.
    pub rt: VecDeque<RtSignal>,
}
```

- **`Process`** holds the **process-directed** `PendingSet` — migrate
  the existing `pending_signals: u64` and `pending_rt: VecDeque<RtSignal>`
  into `Process.pending: PendingSet` (one mechanical refactor; every
  current reader/writer updated).
- **`ThreadRecord`** gains a **thread-directed** `PendingSet` +
  `blocked_signals: u64` (canonical `1<<(sig-1)`; re-lands #90's mask,
  prior-art design). New `ThreadRecord` is built through one
  constructor (the #90 "single ctor" prior-art lesson) so the
  mask/PendingSet init contract lives in one place.
- **Disposition:** replace `signal_dispositions: [u32; 63]` with
  `[SigDisposition; 63]`:
  ```rust
  #[derive(Clone, Copy)]
  pub struct SigDisposition { pub handler: u32, pub sa_mask: u64, pub sa_flags: u32 }
  ```
  `handler`: opaque token, `0`=SIG_DFL, `1`=SIG_IGN, else guest function
  token. Per-**process** (POSIX). `sa_mask`/`sa_flags` are *stored*
  state (B owns them); they are *consumed* by (C).
- **Inheritance & the spawn-plumbing change (High):** a new thread
  copies the **creating thread's** `blocked_signals` (its `PendingSet`
  starts empty). The full call chain is
  `kernel_spawn_thread` (`lib.rs:316`) → `kernel::spawn_thread`
  (`kernel.rs:1555`) → `bind_thread_handle`. **Single-ctor invariant
  (High — covers `::main` too):** there are **two** construction sites,
  not one — the `ThreadRecord {…}` struct literal in `bind_thread_handle`
  (`kernel.rs:1592`) **and** the `ThreadRecord::main` constructor
  (`Self { … }` in the `impl ThreadRecord` block, `kernel.rs:96–97`;
  used by `fork()`@746 and `ensure_main_thread`). The init contract MUST
  live in exactly one place: introduce one `ThreadRecord::new(tid,
  host_handle, blocked_signals)` (extending the existing `impl` at
  `kernel.rs:96`, not a new impl); **`ThreadRecord::main` MUST delegate
  to it** (`Self::new(MAIN_THREAD_TID, h, 0)` — empty mask + empty
  `PendingSet`) and the `bind_thread_handle` literal MUST be replaced by
  a `::new(…)` call. No `blocked_signals`/`PendingSet` field is
  initialized at any site except inside `::new` — that is the #90
  "single ctor" lesson made enforceable (drift across `main()` + literal
  is exactly what was reverted). `creator_tid: Tid` must be threaded through
  **every** layer, none of which carries it today: `bind_thread_handle`
  **and** the intermediate `spawn_thread(pid, handle)` both gain the
  param (an unnamed middle layer is exactly how #90's
  adjudication-vs-mask split slipped through). Sources:
  `sys_thread_spawn` (dispatch) passes `DispatchContext.caller_tid`
  (available `dispatch/thread.rs:46`); the **bare host-control export
  `kernel_spawn_thread(pid, host_thread_handle)`** has *no* caller-thread
  context, so by **documented contract** it passes the
  **`MAIN_THREAD_TID` sentinel** and the new thread inherits the
  **process main-thread** `blocked_signals` (the #90 round-7 resolution
  — not a silent default). The signature change to `bind_thread_handle`
  *and* `spawn_thread`, plus both sources, are explicit (B) deliverables.
  `fork()` child (the exact site is `kernel.rs:746`
  `.insert(MAIN_THREAD_TID, ThreadRecord::main(None))`; the crate is
  single-threaded by design — `kernel.rs:12` — so the forking thread is
  always the main thread, hence no `forking_tid`): process+main-thread
  `PendingSet` **empty** (keep existing `pending_signals=0`/
  `pending_rt.clear()` → now `pending = PendingSet::empty()`), child
  main-thread `blocked_signals` = forking (main) thread's mask,
  dispositions inherited via `parent.clone()` (the wider
  `[SigDisposition;63]` array clones with `Process` exactly as the old
  `[u32;63]` did — no extra fork plumbing, just a wider element).
  `execve()`: caught dispositions reset to `SIG_DFL` (SIG_IGN stays);
  `blocked_signals` preserved; `PendingSet` per the existing fork-like
  clear (the exec-equivalent is `spawn_cached_process`
  (`dispatch/process.rs:1109`), which is fork-like and clears pending —
  POSIX-execve "preserves pending" is **not** achievable through
  today's fork-like spawn and is recorded as a (C)/follow-up obligation,
  **not** a free consequence of "(B) owns dispositions"). **The
  disposition reset wiring is a REQUIRED (B) deliverable, not
  deferrable (P2):** `spawn_cached_process` today copies the parent's
  dispositions verbatim (`child.signal_dispositions =
  parent_signal_dispositions`, `process.rs:~1485`). Once (B) widens +
  kernel-owns dispositions, that exact copy site **must** apply
  `Process::exec_reset_signal_state()` (caught→`SIG_DFL`, `SIG_IGN`
  preserved) in the **same** slice — otherwise caught handlers leak into
  the replacement program. (B) provides the method **and wires it into
  `spawn_cached_process`**; both, plus the test, are in (B)'s diff (no
  "follow-up wires the call" escape).

## 2. Deliverability authority (B's core — decision only, not execution)

`deliverable(thread t) = ((proc.pending ∪ t.pending) ∧ ¬t.blocked)` with
disposition applied kernel-side:

- **Disposition applied at produce-time, by EVERY producer.** A signo
  whose disposition is `SIG_IGN` is **discarded — not enqueued** —
  uniformly by `kill`, `killpg`, `sigqueue`, and `sys_signal_raise`
  (not only `sys_signal_raise`). One shared kernel helper
  (`fn pend(target_pool, signo, …)`) enforces SIG_IGN-drop +
  SIGKILL/SIGSTOP rules so no producer can diverge. (Standard POSIX
  nuance preserved: a disposition later set to `SIG_IGN` discards
  already-pending instances of that signo **process-wide — the purge
  walks the process pool AND every `Process.threads[*].pending`**, not
  just the caller/target thread (disposition is per-process, so an
  ignored signo must not survive on *any* sibling thread to be revived
  if the handler is later restored); SIGCHLD/SIG_IGN special-case
  resolved via the SIG_DFL default-action classifier, not a producer.)
- `SIG_DFL` ⇒ **the kernel** resolves the default-action class
  (terminate / stop / cont / ignore-by-default e.g.
  SIGCHLD/SIGURG/SIGWINCH) and returns it as the `sys_signal_raise`
  action enum (§3). The guest holds **no** signo→default-action policy
  table; it only *executes* the kernel's verdict (`_Exit` on
  `DFL_TERMINATE`, etc.) — a guest that decided terminate-vs-ignore
  itself would be the #90-class "guest retains policy" defect.
- **Produce-vs-execute split (Open-Question — explicit).** Only
  `sys_signal_raise` (synchronous self-signal, calling thread present)
  carries an action-enum response that the guest executes *in (B)*. The
  **non-`raise` producers (`kill`/`killpg`/`sigqueue`) in (B) ONLY
  pend** (or SIG_IGN-drop / job-control-discard) into the `PendingSet`
  — they **never deliver, never terminate/stop/cont, never run a
  handler** during (B). Default-action *execution* for signals pended
  by `kill`/`killpg`/`sigqueue` is the **asynchronous delivery path of
  (C)** (drain → act). Implementers MUST NOT `_Exit`/terminate from
  `kill`/`killpg`/`sigqueue` in (B). (B) = enqueue/withhold for those;
  execute-the-verdict only for `raise`.
- **SIGKILL(9)/SIGSTOP(19):** never blockable, never ignorable, no
  settable disposition; always their default action.
- **Job-control coupling is a (B) produce-time rule (M1 — scoped).**
  POSIX performs the mutual discard at signal **generation**, not at
  delivery: it is therefore owned by **(B)'s shared `pend(…)` helper**,
  not (C)'s acceptance step. When `pend()` enqueues **SIGCONT** for a
  target it first **purges that target's pending stop signals**
  (SIGSTOP/SIGTSTP/SIGTTIN/SIGTTOU) from **both** pools; when it
  enqueues a **stop** signal it first **purges pending SIGCONT**. This
  is a fourth invariant of the single `pend()` funnel (alongside
  SIG_IGN-drop, SIGKILL/SIGSTOP, pool routing) so no producer can
  diverge and (C) inherits an already-consistent state. (Actual
  stop/cont *effect* — suspending/resuming the process — is still
  (C)/job-control-slice; only the pending-set mutual-discard is (B).)
- **Pool routing:** process-directed sends (`kill`/`killpg`) enqueue in
  the **process** pool — takeable by *any* thread that does not block
  it, remaining there until accepted (not deposited into a thread at
  send time). Thread/self-directed sends enqueue in the **target
  thread's** `PendingSet`. **(B)'s ONLY thread-directed producer is
  `sys_signal_raise`** (the caller-thread pool — `raise()` =
  `pthread_kill(self)`), never the process pool (so the
  process-directed selection rule cannot let another thread consume a
  self-directed signal). **`pthread_kill`/`tgkill`/`tkill` have NO (B)
  ABI surface** — there is no `sys_pthread_kill`/`tgkill`/`tkill` method
  and (B) adds none; cross-thread directed signalling is a **future
  slice** (an implementer must not hunt for routing code that does not
  exist in (B)). The two-pool model still exists in (B) for the
  `raise`/self path + fork/spawn inheritance; arbitrary cross-thread
  producers arrive later. (B) owns this routing; it does not *run*
  anything.

(B) implements the **decision + pend**, never handler execution. Handler
execution, the during-handler mask, `sigreturn` atomicity, the
unblock-drain that *runs* pending handlers, preemption, and the
synchronous-accept/`signalfd`/`pselect` consumers are (C)/own slices.

**Documented interim semantic — process-pending spurious wakeup
(`sys_signal_query`/`pselect`/`ppoll` ONLY).** `sys_signal_query` is a
non-destructive *readiness* probe — it does **not** accept or remove.
So a process-directed pending signal stays in the process pool (until
**(C)**'s asynchronous handler-delivery accepts it), and two threads
each calling `sys_signal_query` *both* observe it as deliverable. For
#91's `pselect`/`ppoll` `EINTR` edge this is a harmless,
**POSIX-permitted spurious wakeup** ((C) delivers it exactly once).
Stated explicitly so a future reader does not misread "two waiters wake
on one process signal" as a bug. **This `no-acceptance` claim is scoped
to the query/`pselect` path only — it does NOT apply to
`sys_sigwaitinfo`**, which is by design a *synchronous-accept*
consumer: it removes the matched signal from the pool (see §3).

## 3. ABI (`abi/contract/yurt_abi_methods.toml`, dispatch, guest C)

**Method-id block.** Fix the stale partition comment (umbrella ref
`#51` → **`#57`**, tracking `#52`). The comment currently documents only
B1–B4 (`0x1_0060–0x1_009F`); the **live `0x1_00A*` block is itself
undocumented there** — since (B) is editing this comment anyway, add
*both* the missing `#   misc/fs (post-B4) → 0x1_00A0, 0x1_00A4–0x1_00A9`
line and the new `#   signal-state (B) #90-redesign → 0x1_00B0–0x1_00BF`
line, so the comment is a complete record, not a partial one. Re-verify
the live high-water at implementation time (currently `0x1_00A9` =
`sys_syncfs`; `0x1_00B*` unused) and allocate the **fresh contiguous
`0x1_00B0`-block**, append-only, never renumber. `METHOD_*` consts are
generated by `build.rs` from the toml.

**`sys_sigaction` is EVOLVED IN PLACE, not re-allocated (High).**
`[method.sys_sigaction]` already exists at **`0x1_001C`**. Its
**current** wire is `{u32 sig, u32 disposition}` → `i64
prev_disposition` (two u32s; `sig` is already the first field; no
`sa_mask`/`sa_flags` on the wire at all). (B) widens *that* method in
place to: `{u32 sig, u32 handler, u64 sa_mask, u32 sa_flags}` → prior
`{u32 handler, u64 sa_mask, u32 sa_flags}`, **SIGKILL/SIGSTOP ⇒
`EINVAL`** (closes the accept-any-`1..=63` gap). **No renumber, no new id, no second `sys_sigaction`
symbol.** This is sound because the ABI is co-versioned in-tree (kernel
+ guest libc built together; no external stability contract); the
never-renumber rule forbids changing an *id*, not widening a method's
binary record when both ends change together. The guest `sigaction`/
`signal` shim and the kernel handler change in the same commit.

**New methods (typed-binary; 1-byte guest `sigset_t` verbatim;
compact-slot⇄`sig-1` remap in safe Rust — reuse #90 prior-art table):**

| id | method | request → response |
|----|--------|--------------------|
| `0x1_00B0` | `sys_sigprocmask` | `i32 how + u8 has_set + u8 set` → `u8 oset`. Per-**calling-thread** `blocked_signals` (serves `pthread_sigmask` too — guest `pthread_sigmask` shim calls this). SIGKILL/SIGSTOP cleared silently. `EINVAL` bad `how`. |
| `0x1_00B1` | `sys_signal_raise` | `u32 sig` → `{i32 action, u32 handler_token}` where `action` is a **kernel-authored verdict enum** — `0 NONE` (pended because blocked, *or* discarded because `SIG_IGN`: guest does nothing), `1 RUN_HANDLER` (guest maps `handler_token`→fn via its execution-only registry and runs it — staged interim; (C) hardens with the during-handler mask/`sigreturn`), `2 DFL_TERMINATE` (guest mechanically `_Exit(128+sig)` — executing the kernel's verdict, **not** a guest signo→action decision), `3 DFL_STOP` / `4 DFL_CONT` (job-control; classification is the kernel's — real stop/cont effect is (C)-gated, guest treats as a documented interim no-op). The **kernel** owns: blocked⇒pend in the CALLER THREAD's `PendingSet` (thread-directed — `raise`=`pthread_kill(self)`; never the process pool); `SIG_IGN`⇒discard; `SIG_DFL`⇒resolve the default-action *class* (incl. default-ignore SIGCHLD/SIGURG/SIGWINCH ⇒ `NONE`). The guest holds **no** signo→default-action policy table and never adjudicates — it only executes the returned enum. |
| `0x1_00B2` | `sys_signal_query` | `(no args)` → `u8`: does the caller **thread** have any *deliverable* signal (`(proc∪thread).pending ∧ ¬thread.blocked`, disposition≠IGN)? The primitive **#91** `pselect`/`ppoll` (and later `sigsuspend`/`sigtimedwait`) consume for the `EINTR`/readiness edge. (B) ships the primitive; #91 is its own slice. |

Block `0x1_00B0–0x1_00BF` is reserved for the signal redesign;
`0x1_00B0–0x1_00B2` used now, rest free for later slices. `sys_sigaction`
stays at `0x1_001C` (evolved, above). Two more **evolved-in-place**
methods (co-versioned, like `sys_sigaction`; no renumber): `sys_sigpending`
unions the **two-pool** `PendingSet` (process ∪ caller thread);
**`sys_sigwaitinfo`** is evolved to synchronously accept from the
two-pool `PendingSet` **selected by the request `set`, regardless of
blocked state** (POSIX synchronous-accept — it must NOT mutate the
blocked mask); it **removes+returns** the matched signal or `EAGAIN`
when none. **Dual-pool removal priority (explicit):** the caller
**thread's** `PendingSet` is searched first, then the **process** pool;
within a pool, RT signals lowest-signo-first then FIFO, standard
lowest-signo-first; the accepted instance is removed from exactly the
one pool it was taken from (this is a real acceptance — it *does*
consume, unlike `sys_signal_query`). `kill`/`killpg`/`sigqueue` route via the
shared `pend(…)` helper — its four invariants (§2): SIG_IGN-drop;
SIGKILL/SIGSTOP rules; pool routing; **job-control mutual-discard at
produce-time** (SIGCONT purges pending stops; a stop purges pending
SIGCONT) — otherwise behaviour-preserving.

**Guest C scope in (B)** (`abi/src/yurt_signal.c`, `yurt_runtime.h`):
kernel-route `sigprocmask`/`pthread_sigmask` → `sys_sigprocmask`;
`sigaction`/`signal` → `sys_sigaction`; `raise`/`yurt_raise_now`'s
deliver/defer decision → `sys_signal_raise` (guest no longer consults
`yurt_signal_mask` *or any default-action policy*; it `switch`es on the
kernel's `action` enum — `RUN_HANDLER`⇒map `handler_token`→fn & run
(staged interim; (C) hardens), `DFL_TERMINATE`⇒`_Exit(128+sig)`,
`NONE`⇒nothing, `DFL_STOP`/`DFL_CONT`⇒documented interim no-op).
**Known (B)-interim property (not an oversight):** in (B) the
`RUN_HANDLER` path runs the handler with **no during-handler mask and
no `sigreturn` atomicity** (a re-entrant same-signal raise inside the
handler is not blocked) — (C) adds that hardening. This cannot
reintroduce #90 over-delivery because the kernel's `NONE` verdict for a
*blocked* signal strictly precedes any `RUN_HANDLER` (blocked ⇒ pend,
never run); explicitly recorded so the interim re-entrancy is read as
scoped, not a bug.

**Exec-emulation forward — order corrected & preserved (High).**
Correct "today" (`yurt_signal.c:362–372`): the **block-mask check is
FIRST** — a *blocked* signal pends locally and **`return`s before** the
forward (the forward never runs for a blocked signal); the
`yurt_forward_signal_to_exec_child(sig)` hook (`yurt_exec.c:58` over
`static pid_t yurt_exec_child_pid`) runs **after** the block check but
**before** the disposition (IGN/handler/default) is applied. The
earlier "forward is the first thing, ahead of the kernel call" wording
was wrong and is replaced. To **genuinely preserve order** (option b)
the rewritten `raise`/`yurt_raise_now` shim is:
`v = sys_signal_raise(sig)` **first** (kernel does the block/defer +
disposition verdict: blocked⇒`NONE`+kernel-pend; `SIG_IGN`⇒`NONE`;
else `RUN_HANDLER`/`DFL_*`); **if `v.action == NONE` ⇒ return
immediately (no forward)** — this reproduces today's "blocked ⇒ pend &
return before the forward"; **otherwise call
`yurt_forward_signal_to_exec_child(sig)`; if it relays ⇒ return; else
execute `v.action`** — reproducing today's "forward before applying the
handler/default". This is **not** #90-class guest policy — it is
exec-emulation *plumbing* (relay this signo to that pid; the relay
itself goes through the kernel `kill`), gated by the *kernel's* verdict,
no guest mask/pending/disposition decision.
**One deliberate, documented, exec-emulation-scoped divergence:** today
an *unblocked* `SIG_IGN` signal with an exec child *is* forwarded
(the forward precedes the in-guest `SIG_IGN` check); under (B) the
kernel classifies `SIG_IGN`⇒`NONE` so the guest returns and does **not**
forward it. This is accepted intentionally (keeping the kernel from
classifying IGN would put disposition policy back guest-side — the #90
defect) and pinned by a characterization test, not silent. The
exec-child *identity* staying guest-side in `yurt_exec.c` is an
**exec-emulation** concern, explicitly **out of (B)**; moving it into
kernel-owned state is a separate future exec slice. Deleting the
forward is **not** an option in (B). The
guest-local globals `yurt_signal_mask`, `yurt_pending_signal_mask`, and
`yurt_signal_deliver_pending()` are **deleted** (no stale guest
adjudication survives ⇒ no #90 over-delivery).

**Execution-only token→fn registry (High).** The kernel owns disposition
*policy* (token + `sa_mask` + `sa_flags`, via the evolved
`sys_sigaction`) but cannot call guest code, so the guest `sigaction`/
`signal` shim keeps a **local token↔function-pointer table used solely
to execute** a handler the kernel has already authorized (it returns the
token from `sys_signal_raise`/delivery). This table carries **no mask,
no pending, no disposition policy and makes no deliver/defer decision** —
it is the umbrella's "kernel stores an opaque token the guest trampoline
maps back to a function". **`static struct sigaction
yurt_signal_actions[NSIG]` (`yurt_signal.c:39`) is explicitly reduced to
a pure token→fn-pointer map:** its `sa_mask`/`sa_flags` fields **cease
to be guest-consulted entirely** (the kernel owns them via the evolved
`sys_sigaction`; the guest never reads them for masking or any decision)
— only the `sa_handler`/token slot survives, used solely to execute a
kernel-authorized handler. (B) does **not** leave `yurt_signal_actions[]`
as a guest source of truth for `sa_mask`/`sa_flags` — doing so would be
exactly the "guest retains policy state" defect #90 was reverted for
(vision §1/§5). This is the single highest-value invariant of (B)'s
guest-C scope; the plan must verify no guest path reads
`yurt_signal_actions[].sa_mask`/`.sa_flags` after (B).

**Compile-closure (Medium):** the deleted globals are *also* referenced
today by `sigsuspend`, `sigtimedwait`, and `yurt_raise_now`'s old loop.
Deleting them while "leaving those staged" would not compile and could
silently regress. So (B) **also thins `sigsuspend`/`sigtimedwait` to
kernel-routed *gated stubs*** (no global deps):
- `sigsuspend(set)` — `old = sys_sigprocmask(SETMASK, set)` (returns the
  prior mask); optional non-blocking deliverable check (`sys_signal_query`);
  **`sys_sigprocmask(SETMASK, old)` to RESTORE the prior mask** (High —
  POSIX `sigsuspend` restores the original mask on return; a stub that
  left the temporary mask installed would corrupt persistent thread
  state); then guest-side `errno=EINTR; return -1`. Net blocked-mask on
  return is unchanged.
- `pause()` — **unchanged; not a stub (High).** `pause()`
  (`yurt_signal.c:343`) is already a pure composition
  `sigprocmask(SIG_SETMASK,NULL,&m); return sigsuspend(&m);` — it
  references **no** globals. Once `sigprocmask`/`sigsuspend` are
  kernel-routed it works as-is; (B) writes **no `pause`-specific stub**.
- `sigtimedwait(set, …)` — non-blocking call to the **evolved
  `sys_sigwaitinfo`** with `set` as the **accept selector** (synchronous
  accept from the two-pool PendingSet regardless of blocked state); it
  returns the matched signal (removed) or `EAGAIN`. It **must NOT**
  `sys_sigprocmask`/mutate the caller's blocked mask. Timeout is ignored
  in the gated form.

They do **not** get full (C) blocking — only a compiling,
documented-gated, non-regressing form.
`sigaltstack` is **not implemented in the guest signal shim at all**
(absent from `abi/src/*.c`/`abi/include/*.h`) — there is no code to
touch in (B); it is its own later slice (don't send a reader hunting for
"code that stays"). True blocking, the unblock-drain that *runs*
handlers, `sigreturn` atomicity, preemption: **(C)/own slices, not (B)**.

## 4. Error handling

`EINVAL` (bad `how`, SIGKILL/SIGSTOP to `sigaction`, malformed record),
`ESRCH` (no caller process/thread), `EAGAIN` (RT queue cap; `sigtimedwait`
gated-stub empty), `EPERM` (kill authorisation, unchanged). No kernel
`EINTR` const is added in (B): the `sigsuspend` gated stub sets
`errno = EINTR` **guest-side in the C shim** (after the
`sys_sigprocmask` round-trip) and returns `-1` (`pause` inherits this
transitively via its `sigsuspend` call — it is not a stub itself) —
kernel methods never return `-EINTR` in (B). Errno mirror `abi.rs`
unchanged.

## 5. Non-goals (explicit — owned elsewhere)

Handler execution / during-handler mask / `sigreturn` / the
unblock-drain that *runs* handlers / async preemption / **full
blocking** semantics of `sigsuspend`/`pause`/`sigtimedwait` /
`signalfd` / synchronous faults (SIGSEGV/…): **all (C) or their own
slices** (umbrella §2(C), §11). NOTE: (B) *does* land the **gated-stub**
forms of `sigsuspend` and `sigtimedwait` (kernel-routed, no global deps
— §3 compile-closure); only their real blocking/drain is out of scope.
`pause` is **not** a gated stub — it stays a pure
`sigprocmask`+`sigsuspend` composition (works unchanged once those are
kernel-routed). `sigaltstack` is **not implemented in the guest signal
shim** (own later slice; nothing to touch in (B)). (B) otherwise ships
state + decision + query only.

## 6. Gate / testing (slice discipline)

- **Primary gate — kernel dispatch tests** (`dispatch/tests.rs`,
  `TestGuard` pattern): `PendingSet` two-pool correctness; per-thread
  mask round-trip + spawn/fork inheritance; SIGKILL/SIGSTOP →
  `sigaction` `EINVAL` and never blockable; `sys_signal_raise` action
  enum for blocked⇒`NONE`+pended / `SIG_IGN`⇒`NONE` / handler⇒
  `RUN_HANDLER`+token / `SIG_DFL`-terminate⇒`DFL_TERMINATE` /
  default-ignore (SIGCHLD/SIGURG/SIGWINCH)⇒`NONE`.
- **Producer-invariant tests (highest-risk — separated-producer was the
  original sin):** the shared `pend(…)` SIG_IGN-drop **and**
  SIGKILL/SIGSTOP rule are tested for **every** producer —
  `kill`, `killpg`, `sigqueue`, *and* `sys_signal_raise` (not just
  raise) — plus "**setting a disposition to `SIG_IGN` purges
  already-pending instances** of that signo **process-wide: the process
  pool AND *every* `Process.threads[*].pending`** (multi-thread test:
  signo pending on a *sibling* thread must also be purged, not just the
  caller's)";
  **job-control mutual-discard at produce-time** (`pend(SIGCONT)` purges
  pending stops; `pend(stop)` purges pending SIGCONT — both pools, M1);
  and the `sys_sigwaitinfo` dual-pool removal-priority order
  (thread-before-process; RT/standard ordering).
- `sys_signal_query` deliverability incl. job-control coupling +
  the documented process-pending spurious-wakeup interim; `sigpending`
  two-pool union; fork clears child PendingSet + inherits mask;
  `execve` disposition reset.
- **#91 unblock check:** a test (or the #91 slice consuming it)
  demonstrating `pselect`/`ppoll` can compute its `EINTR`/readiness from
  `sys_sigprocmask` + `sys_signal_query` against the **kernel** mask.
- The `case_blocked_host_signal_delivers_after_unblock` canary needs
  handlers to *run* on unblock ⇒ **(C)'s gate, not (B)'s.** (B) adds a
  characterization test pinning the *interim*: blocked self-signal is
  **withheld** and **kernel-pending** (not run, not lost).
- **Exec-forward order pins (High):** (i) **blocked** `raise(sig)` with
  an exec child set ⇒ kernel verdict `NONE` ⇒ **withheld+kernel-pending,
  NOT forwarded** (reproduces today's block-before-forward); (ii)
  **unblocked handler** `raise(sig)` with an exec child ⇒ **forwarded
  via `yurt_forward_signal_to_exec_child` (short-circuits) BEFORE the
  handler runs** (reproduces today's forward-before-disposition); (iii)
  the documented divergence: **unblocked `SIG_IGN` + exec child ⇒ NOT
  forwarded** (kernel `NONE`) — pinned as the accepted, deliberate
  exec-emulation-scoped behavior change.
- **Producer no-terminate pin (Open-Question):** a test asserting
  `kill`/`killpg`/`sigqueue` of an unblocked `SIG_DFL`-terminate signo
  in (B) **only pends** (target `PendingSet` bit/queue set) and does
  **not** terminate/deliver — execution is (C)'s.
- `cargo test -p yurt-kernel-wasm`; **`cargo clippy -p yurt-kernel-wasm
  --all-targets -- -D warnings` run LOCALLY** — `yurt-kernel-wasm` is
  excluded from workspace default-members so **CI clippy does not cover
  it** (project memory); the slice gate must run it explicitly. `cargo
  fmt --all`; `make -C abi` clean; parity-matrix row added stating
  per-backend reality + the Stage-1 scope; no JSON at ABI; `take_bytes`
  wrap-safe length guards (#65/C1 prior-art class; usize-width test-gap
  memory).

## 7. Build order within the initiative

(B) ⇒ then #91 resumes (consumes `sys_sigprocmask`+`sys_signal_query`)
⇒ then (C) (delivery+`sigreturn`+drain+preemption, converts the
remaining guest libc path, makes the unblock canary pass) ⇒ consumer
slices (`sigsuspend`/`sigtimedwait`/`signalfd`). Each its own
spec→plan→implement→review→PR; no mega-PR.
