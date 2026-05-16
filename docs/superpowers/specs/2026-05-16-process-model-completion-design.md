# Process Model Completion (slice B1) — Design

Part of the full-parity initiative (tracking #52, umbrella #57; the original
umbrella #51 was reverted via #56 and reopened as #57). Sequenced after
B0 (the thin parity gate, PR #53): every behavior here is validated TS-vs-Rust
through that gate. **This PR carries the design only** — the implementation
lands as TDD sub-slices once B0 is CI-green, so nothing here is "unmeasured
implementation" (respects approach C).

## Goal

Close the remaining process-model parity gaps so the Rust kernel
(`packages/kernel-wasm`) is behaviorally equivalent to the TS kernel for the
process/signal surface, and pull the maximal-scope items (true `vfork`,
`pthread_cancel`, RT signal queueing) into scope.

## Grounded gap analysis (verified on `origin/main` @ 7bccd04)

- **SIGCHLD on child exit — missing.** `dispatch/process.rs::record_exit` sets
  `process_mut(pid).exit_status =
  Some(status)` and returns; it does **not**
  set `SIGCHLD` in the parent's `pending_signals` bitmask, and does not wake a
  blocked waiter. POSIX requires the parent receive `SIGCHLD` on child
  termination. (Verified by reading `record_exit`, ~L906–920.)
- **`waitid` — absent.** Only `wait_response` (waitpid-shaped) exists; no
  `METHOD_SYS_WAITID`, no `siginfo`-returning wait. TS kernel also lacks it →
  parity here means _add it to the Rust kernel_ (maximal scope) with a matching
  adapter, not match a TS stub.
- **`getpgrp` — only via `getpgid(0)`.** `getpgid` maps `target==0` to the
  caller (~L611–633); there is no distinct `getpgrp` method id. POSIX
  `getpgrp(void)` must resolve to the caller's pgid. Confirm libc maps `getpgrp`
  → `getpgid(0)`; if it calls a dedicated import, add the arm.
- **`siginfo_t` not kernel-populated.** PR47 widened `siginfo_t`
  (`si_pid/si_uid/si_status`) but the guest C (`abi/src/yurt_signal.c`) zeroes
  them; the kernel never fills `si_pid/si_uid/si_status` on
  `SIGCHLD`/`sigtimedwait`. Parent must observe the child's pid/uid/status.
- **Blocking-wait semantics.** `wait_response` returns `-EAGAIN` when no child
  has exited (even without `WNOHANG`); the TS path blocks. Parity requires a
  defined contract: kernel returns a "would-block" signal and the adapter
  suspends (AsyncBridge), or document the retry contract and make both kernels
  identical through the gate.
- **`vfork` — alias to `fork`.** No address-space-sharing / parent-suspend
  semantics. Maximal scope: real `vfork` (parent suspended until child
  `execve`/`_exit`), as a tracked sub-slice.
- **`pthread_cancel` — absent.** Out of prior scope; now in (maximal).
  Deferred-cancellation model + cancellation points; sub-slice.
- **RT signals — absent.** `pending_signals` is a `u64` bitmask (≤64, no
  queueing/multiplicity). Maximal scope: `sigqueue`/`rt_sigaction` with a
  per-process ordered queue carrying `siginfo`; sub-slice.

## Sub-slices (each: spec note → TDD → PR off `main`, gated by B0)

Ordered by value/independence; each flips its matrix rows + ticks #52.

1. **B1.1 SIGCHLD** — ✅ **done (kernel, cargo-verified)**. `record_exit` ORs
   `SIGCHLD` into the parent's `pending_signals`; no-op when `ppid==0`. 2 unit
   tests. Gate fixture (TS-vs-Rust canary) lands with B0.
2. **B1.2 siginfo population** — kernel half ✅ **subsumed by B1.3** (`waitid`
   returns real `si_pid/si_uid/si_status`). Grounded finding: the wasmtime host
   passes the **raw `proc_exit` code** via `last_exit`, and `sys_kill` only sets
   pending bits (no signal-caused termination path), so
   `CLD_EXITED`/`si_status=code` is correct _today_ and `CLD_KILLED`
   discrimination is **downstream of signal delivery (B1.8)**, not a present
   gap. B1.2 remainder = guest/libc stops zeroing and consumes kernel `waitid`
   siginfo (adapter/guest, gate-deferred).
3. **B1.3 waitid** — ✅ **done (kernel, cargo-verified)**. `METHOD_SYS_WAITID`
   (0x1_0060): P_ALL/P_PID/P_PGID, 20-byte siginfo, WNOWAIT/WEXITED,
   EINVAL/ECHILD/EAGAIN guards. 5 unit tests. Adapter (KH/JS/wasmtime) + guest
   libc `waitid` = gate-deferred half.
4. **B1.4 getpgrp** — ✅ **done (contract-locked, cargo-verified)**. Guest maps
   `getpgrp()`→`getpgid(0)`, `setpgrp()`→`setpgid(0,0)`; the target==0 path was
   already POSIX-correct, now regression-locked (2 tests, no production change).
5. **B1.5 blocking-wait contract** — define + implement the would-block/ suspend
   contract; both kernels identical through the gate.
6. **B1.6 true vfork** — parent-suspend-until-exec/_exit; continuation
   interplay; #49 fork-canary extended.
7. **B1.7 pthread_cancel** — ✅ **done (kernel, cargo-verified)**.
   `ThreadRecord.cancel_requested`; `METHOD_SYS_THREAD_CANCEL` (0x1_0061)
   - `METHOD_SYS_THREAD_TESTCANCEL` (0x1_0062); deferred model, ESRCH on
     unknown/exited, 4 tests. Guest cancellation-point unwind = gate-deferred
     half.
8. **B1.8 RT signal queueing** — ordered per-process siginfo queue;
   `sigqueue`/`rt_sigaction`/`sigwaitinfo`. **Not started**: this replaces the
   `pending_signals: u64` bitmask representation, touching every reader/writer
   (kill, B1.1 SIGCHLD, sigaction, wait/poll). It is the most invasive B1 item —
   sequenced strictly after B0's gate so the regression surface is measured, not
   asserted.

**Kernel-side B1 status:** B1.1, B1.3, B1.4, B1.7 are ✅ done & cargo-verified
(308/0, fmt, clippy); B1.2's kernel half is subsumed by B1.3. The remaining B1.5
(blocking-wait/AsyncBridge), B1.6 (true vfork — continuation/host), B1.8
(RT-signal representation change) are the genuinely larger cross-boundary items,
strictly gate-after-B0 so their regression/parity surface is measured. Threads
(pthread lifecycle, PR47)

- pthread_cancel (B1.7) cover the thread half of the sub-goal.

## Non-goals (B1)

- Shared-memory / multithreaded `fork` (separate fork follow-up).
- DNS / sockets / fd-vfs (B3/B2).
- Replacing the global kernel mutex serialization model.

## Tracked divergences (PR #54 review — not done-to-spec, intentionally)

These are self-consistent and contract-documented (`yurt_abi_methods.toml`),
and TS-vs-Rust parity is what the B0 gate enforces — recorded here so they are
not later mistaken for full POSIX conformance, and to be re-measured when the
gate-deferred consumer/blocking halves land:

- **`sigwaitinfo` selection order:** returns the strictly oldest-queued RT
  signal across all selected signos (FIFO). POSIX delivers the
  lowest-numbered pending signal first. Revisit with the blocking/delivery
  sub-slice (B1.8-b); add a differ/matrix note if the POSIX corpus exercises
  multi-signo ordering.
- **`waitid` blocking:** without `WNOHANG`, a matching-but-not-yet-waitable
  child yields `-EAGAIN` (would-block placeholder, same as `sys_wait`) rather
  than blocking — true blocking is AsyncBridge-gated. `WNOHANG` itself is now
  POSIX-correct (success + zeroed siginfo). `waitid(P_PGID, 0)` now matches
  default-inherited (`pgid==0`) children via the parent-walking
  `effective_pgid` resolver (PR #54 review P2, regression-tested).
  **`waitid` / `sys_wait` WNOHANG asymmetry:** `waitid` + `WNOHANG` +
  no waitable child → success with zeroed siginfo (POSIX-correct);
  `sys_wait` (`waitpid`) + `WNOHANG` → `-EAGAIN`. Both match their own
  contract; the gate-deferred libc/adapter half must NOT assume
  symmetric `waitpid`/`waitid` WNOHANG semantics.
- **`pthread_cancel` main-thread id:** `sys_thread_self` presents the
  main thread to guests as `GUEST_MAIN_PTHREAD_ID` (0); `sys_thread_cancel`
  normalizes 0 → `MAIN_THREAD_TID` so self-cancel works. `join`/`detach`
  of the main thread is undefined in POSIX, so they intentionally do
  NOT normalize (a guest id 0 there stays an ESRCH misuse signal).
- **No signal-sender permission check (whole signal subsystem):** `kill`,
  `killpg`, and `sigqueue` let any guest target any pid — there is no
  `EPERM`/credential gate (real POSIX: a sender needs matching uid or
  privilege). The RT-queue cap bounds the memory-DoS, but a hostile guest
  can still flood a victim's 1024-entry RT queue and starve its legitimate
  RT signals (bounded cross-process DoS). Pre-existing and consistent across
  the subsystem (not introduced by B1) — tracked here as a subsystem-wide
  parity item, to land with signal-permission semantics, not patched
  piecemeal in this slice.
- **SIGCHLD is set-only / latched:** `record_exit` ORs the parent's SIGCHLD
  bit; nothing clears it and no waiter is woken (consume/clear + wake is the
  gate-deferred delivery slice, B1.5/B1.8). A guest polling `sigpending()`
  sees SIGCHLD latched permanently after any child ever exits. Flagged so
  the deferred-delivery slice adds the consume/clear + wake path.

## Testing

Per sub-slice: kernel `#[cfg(test)]` first (red→green, fast tier), then a
conformance canary added so the **B0 differ** locks TS-vs-Rust parity for that
row; matrix `Verified@` set on green. No sub-slice merges with an un-baselined
gate divergence.

## Dependency / sequencing

B1 implementation PRs rebase onto `main` after B0 (#53) merges and its gate is
CI-green, so each B1 row is proven at parity, not asserted. This design doc has
no such dependency and lands now to unblock B1.1 TDD.
