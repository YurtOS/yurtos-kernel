# Process Model Completion (slice B1) — Plan

Spec: `docs/superpowers/specs/2026-05-16-process-model-completion-design.md`
Branch: `parity-b1-process-model` (design PR now; implementation sub-slices
rebase onto `main` after B0 #53 lands). Tracking: #52 (B1).

TDD, AGENTS.md loop. B1.1–B1.4 are cargo-unit-testable without the wasm
build (fast tier); B1.5–B1.8 are gate-after-B0.

## Sub-slice tasks

- **B1.1 SIGCHLD + reap wake** (`packages/kernel-wasm/src/dispatch/process.rs`
  `record_exit`; kernel signal state in `kernel.rs`):
  red `#[cfg(test)]` — after `record_exit`, the parent's `pending_signals`
  has `SIGCHLD` set and a blocked waiter is woken; green minimal impl;
  add `sigchld-canary` case to `abi/conformance/` for the B0 differ.
- **B1.2 siginfo population**: kernel fills `si_pid/si_uid/si_status`;
  drop the guest-side zeroing in `abi/src/yurt_signal.c`; canary asserts
  the parent reads real values.
- **B1.3 waitid**: add `METHOD_SYS_WAITID` (contract +
  `dispatch/process.rs` arm + adapter); `waitid-canary`
  (`P_PID/P_PGID/P_ALL`, `WEXITED/WSTOPPED/WNOWAIT`).
- **B1.4 getpgrp**: verify libc mapping; add dedicated resolution only if
  a distinct import is used; `getpgrp-canary`.
- **B1.5 blocking-wait contract**: define would-block/suspend; implement;
  both kernels identical through the gate.
- **B1.6 true vfork**, **B1.7 pthread_cancel**, **B1.8 RT signal
  queueing**: larger; each its own spec note + TDD + PR, strictly after
  B0 gate is green.

## Per sub-slice definition of done

`cargo fmt --all -- --check` + `cargo clippy --all-targets -- -D warnings`
+ `cargo test --tests` green; conformance canary added; B0 differ shows
zero TS-vs-Rust diff for the row (or a baselined, slice-tagged exception);
matrix row → `done` with `Verified@`; #52 checkbox state updated.

## Risks

- Blocking-wait (B1.5) likely needs AsyncBridge interplay — scope-check
  before starting; may split.
- RT signal queueing (B1.8) changes the `pending_signals` representation
  (bitmask → queue); audit all readers/writers; large, isolate.
- `getpgrp` may already be satisfied by libc → `getpgid(0)`; B1.4 could
  reduce to a confirming canary only.
