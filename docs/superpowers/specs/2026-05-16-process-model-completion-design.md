# Process Model Completion (slice B1) — Design

Part of the full-parity initiative (tracking #52, umbrella #51). Sequenced
after B0 (the thin parity gate, PR #53): every behavior here is validated
TS-vs-Rust through that gate. **This PR carries the design only** — the
implementation lands as TDD sub-slices once B0 is CI-green, so nothing here
is "unmeasured implementation" (respects approach C).

## Goal

Close the remaining process-model parity gaps so the Rust kernel
(`packages/kernel-wasm`) is behaviorally equivalent to the TS kernel for
the process/signal surface, and pull the maximal-scope items
(true `vfork`, `pthread_cancel`, RT signal queueing) into scope.

## Grounded gap analysis (verified on `origin/main` @ 7bccd04)

- **SIGCHLD on child exit — missing.**
  `dispatch/process.rs::record_exit` sets `process_mut(pid).exit_status =
  Some(status)` and returns; it does **not** set `SIGCHLD` in the parent's
  `pending_signals` bitmask, and does not wake a blocked waiter. POSIX
  requires the parent receive `SIGCHLD` on child termination. (Verified by
  reading `record_exit`, ~L906–920.)
- **`waitid` — absent.** Only `wait_response` (waitpid-shaped) exists; no
  `METHOD_SYS_WAITID`, no `siginfo`-returning wait. TS kernel also lacks it
  → parity here means *add it to the Rust kernel* (maximal scope) with a
  matching adapter, not match a TS stub.
- **`getpgrp` — only via `getpgid(0)`.** `getpgid` maps `target==0` to the
  caller (~L611–633); there is no distinct `getpgrp` method id. POSIX
  `getpgrp(void)` must resolve to the caller's pgid. Confirm libc maps
  `getpgrp` → `getpgid(0)`; if it calls a dedicated import, add the arm.
- **`siginfo_t` not kernel-populated.** PR47 widened `siginfo_t`
  (`si_pid/si_uid/si_status`) but the guest C (`abi/src/yurt_signal.c`)
  zeroes them; the kernel never fills `si_pid/si_uid/si_status` on
  `SIGCHLD`/`sigtimedwait`. Parent must observe the child's pid/uid/status.
- **Blocking-wait semantics.** `wait_response` returns `-EAGAIN` when no
  child has exited (even without `WNOHANG`); the TS path blocks. Parity
  requires a defined contract: kernel returns a "would-block" signal and
  the adapter suspends (AsyncBridge), or document the retry contract and
  make both kernels identical through the gate.
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

1. **B1.1 SIGCHLD + reap wake** — `record_exit` ORs `SIGCHLD` into the
   parent's `pending_signals` and wakes a blocked waiter; kernel
   `#[cfg(test)]` covers exit→parent-pending; gate fixture: a
   waitpid/SIGCHLD canary diffed TS-vs-Rust. Highest value, fully
   cargo-unit-testable.
2. **B1.2 siginfo population** — kernel fills `si_pid/si_uid/si_status`
   for `SIGCHLD` and the `sigtimedwait`/`waitid` paths; guest stops
   zeroing.
3. **B1.3 waitid** — `METHOD_SYS_WAITID` + adapter + conformance canary
   (`WEXITED/WSTOPPED/WNOWAIT`, `idtype` P_PID/P_PGID/P_ALL).
4. **B1.4 getpgrp** — confirm/добавить the dedicated resolution; canary.
5. **B1.5 blocking-wait contract** — define + implement the would-block/
   suspend contract; both kernels identical through the gate.
6. **B1.6 true vfork** — parent-suspend-until-exec/_exit; continuation
   interplay; #49 fork-canary extended.
7. **B1.7 pthread_cancel** — deferred cancellation + points.
8. **B1.8 RT signal queueing** — ordered per-process siginfo queue;
   `sigqueue`/`rt_sigaction`/`sigwaitinfo`.

B1.1–B1.4 are pure kernel-state changes, unit-testable via
`cargo test --tests` with no wasm build (fast tier) — they can progress
even before B0's CI is green, validated by Rust unit tests, then
gate-confirmed once B0 lands. B1.5–B1.8 are larger and strictly
gate-after-B0.

## Non-goals (B1)

- Shared-memory / multithreaded `fork` (separate fork follow-up).
- DNS / sockets / fd-vfs (B3/B2).
- Replacing the global kernel mutex serialization model.

## Testing

Per sub-slice: kernel `#[cfg(test)]` first (red→green, fast tier), then a
conformance canary added so the **B0 differ** locks TS-vs-Rust parity for
that row; matrix `Verified@` set on green. No sub-slice merges with an
un-baselined gate divergence.

## Dependency / sequencing

B1 implementation PRs rebase onto `main` after B0 (#53) merges and its
gate is CI-green, so each B1 row is proven at parity, not asserted. This
design doc has no such dependency and lands now to unblock B1.1 TDD.
