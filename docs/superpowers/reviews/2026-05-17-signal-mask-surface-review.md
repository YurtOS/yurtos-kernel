# Review — signal-mask surface design (issue #90)

Design-spec review of `docs/superpowers/specs/2026-05-17-signal-mask-surface-design.md`
(branch `worktree-parity-signal-mask`; no implementation commits — spec only).

## Disposition summary

All items verified against the tree and **accepted**. One factual
correction to the review itself (noted inline). Spec reworked in
"round-5" (spec §9/§11); this doc is the durable record.

| # | Severity | Status |
|---|----------|--------|
| 1 | Critical | **Verified true** (`abi/include/signal.h:26` `typedef unsigned char sigset_t`). §3.1/§6/§8 reworked. |
| 2 | Critical | **Verified true** (`signal.h:91` `NSIG 32`, gnulib `verify_NSIG_constraint`). Range/RT story added. |
| 3 | High | **Verified true** (`kernel.rs:746` fork child = `ThreadRecord::main(None)`; `:738` `pending_signals=0`). Fork inheritance specified. |
| 4 | High | Accepted — busy-spin/livelock risk surfaced in spec §5/§11 + matrix note. |
| 5 | Medium | **Verified true** (≥3 `ThreadRecord` ctor sites). Single-constructor mandate added. |
| 6 | Medium | **Verified true** (`stack_t`/`SS_*`/`MINSIGSTKSZ`/`sigaltstack` absent from `signal.h`). Header surface enumerated. |
| 7 | Medium | Accepted — spawn install-ordering guarantee sentence added (spec §2). |
| nits | Minor | Accepted — `#51`→`#57/#52` partition-comment fix (matches project history: #51 reverted by #56), `0x1_00A0` added, wasm32-only `SigAltStack` note, §10 new-wiring note. |

Factual correction: the review's parenthetical that the Rust libc-port
`signal.rs` is "already a modified file on this branch" is not accurate
for `worktree-parity-signal-mask` (= `origin/main` + one `docs(spec)`
commit; `git status --porcelain` clean of libc/signal files). The 1-byte
typedef is real regardless, asserted by `signal.h:26` itself, so the
substance of Critical #1 stands unchanged.

---

## Original review (verbatim)

> The spec inverts today's guest-local signal-mask model to a kernel-owned,
> per-thread blocked mask plus alternate-stack bookkeeping. Structure is
> disciplined; most codebase claims check out (`take_bytes` wrap-safe,
> `EINTR` absent/`=4` correct, `pending_signals`/`pending_rt`, the real
> `YURT_MARKER_CALL(sigsuspend)` copy-paste bug in `sigtimedwait`). But the
> central §3.1 decision rests on a false premise about the guest ABI.

### Critical
1. `sigset_t` is `typedef unsigned char` (8 bits), not 64-bit. "Copy the
   8-byte mask verbatim, no transform in C" is physically impossible: the
   shim gets a pointer to one byte; it must expand/narrow. The compact-slot
   scheme exists *because* `sizeof(sigset_t)==1`, not as a guest-local-era
   artifact. The "SIGUSR1(10) ⇒ bit 9" test is unrepresentable in one byte.
   Widening the typedef is a cross-language ABI change (Rust libc-port,
   wasi-libc, every `zeroed::<sigset_t>` site, snapshot layouts) — own it
   or specify the explicit shim transform; either way §3.1/§6/§8 rework.
2. `NSIG` hard-capped at 32 (gnulib `verify_NSIG_constraint`). Canonical
   `1..=63` is unreachable from the guest; RT-signal interaction
   unspecified. State real usable range + RT story.

### High
3. `fork()` signal-mask inheritance unaddressed — POSIX: child inherits
   the calling thread's mask. Specify it or scope it out by name.
4. Immediate-`-EINTR` `pause()`/`sigsuspend` is a busy-spin/livelock
   hazard in real `while`-loop callers, not just an API footnote.

### Medium
5. `ThreadRecord` built at ≥3 sites — adding fields by hand invites drift;
   mandate a single constructor / `Default` init.
6. `stack_t`/`SS_DISABLE`/`SS_ONSTACK`/`MINSIGSTKSZ`/`SIGSTKSZ`/
   `sigaltstack` proto / `siginfo_t` for `sigtimedwait` not in
   `signal.h` — enumerate header additions, pin constants to Rust-std's
   stack-guard expectation.
7. Spawn install-ordering: `kh::thread_spawn` runs before
   `bind_thread_handle` installs the inherited mask — latent race once
   async delivery lands; one explicit guarantee sentence.

### Minor
- Partition comment cites reverted #51; canonical is #57/#52; add
  `0x1_00A0` to the list.
- State `SigAltStack` wasm32-only assumption explicitly.
- §10: the 5 Open POSIX dirs are new wiring, not extensions of the
  legacy `signal.spec.toml` canary.

### Verdict
Approve-blocking on Critical #1–#2; fold #1–#3 + the rest as a round-5
tightening before implementation.

---

## Round-6 review

Disposition: 4 accepted, 1 reasoned pushback (premise rejected, valid
core folded). Issue thread:
`github.com/YurtOS/yurtos-kernel/issues/90#issuecomment-4470176218`.

| # | Severity | Status |
|---|----------|--------|
| 1 | Blocker | **Accepted.** Verified `pause()` `yurt_signal.c:343-347` is `sigprocmask`-read+`sigsuspend`. `sys_sigsuspend` gains `has_mask`; `pause`=`sys_sigsuspend(has_mask=0)`, atomic, C thin (spec §4/§5/§6). |
| 2 | Blocker | **Premise rejected, core folded.** "Migrate every `sigset_t` to `1<<(sig-1)`" / "`sigaddset(SIGUSR1)`→bit 9" contradicts the round-5-verified 1-byte `sigset_t` (bit 9 unrepresentable). Guest representation unchanged; explicit touched/untouched enumeration (spec §3.3), `sa_mask` boundary documented (§11.5), corrected representable round-trip test (§8). Repo-wide widening is a separate out-of-scope initiative. |
| 3 | Should-fix | **Accepted, documented divergence.** Verified `sys_sigwaitinfo` (`process.rs:796-820`) is RT-queue-only, never `pending_signals`. §11.6 + pinned test (§8). |
| 4 | Should-fix | **Accepted.** Precise initial state + fallback chain + explicit `MAIN_THREAD_TID` for the bare export (spec §3.2). |
| 5 | Minor | **Accepted.** `sigaltstack` new C symbol named (§6); stale `*.spec.toml` rewritten not extended (§8); partition+umbrella one atomic edit (§4); pending-check no-observable-effect stated (§5/§11.4). |

Pushback rationale (item 2): receiving-code-review discipline — the
remedy as written reverts to the pre-round-5 "canonical everywhere"
model that round-5 abandoned *because* `signal.h:26` is
`typedef unsigned char sigset_t` with gnulib `NSIG≤32`. Pushed back with
code-grounded reasoning; salvaged the legitimate sub-points (touched/
untouched scoping, `sa_mask` encoding boundary, corrected test).

### Round-6 verdict
"With 1 and 2 resolved in the spec and 3–5 documented, ready to proceed
to the plan doc." 1 resolved; 2 resolved via reasoned alternative;
3–5 documented. Gate condition met pending maintainer ack of the item-2
pushback.

---

## Round-7 review

All 5 accepted; verified against the tree. None design-blocking. Issue
thread continues on #90.

| # | Severity | Status |
|---|----------|--------|
| 1 | Should-fix | **Accepted (correction).** Verified `prepare_fork` (`kernel.rs:715`) takes only `parent_pid` and is single-thread-gated (`:720` `threads.len()>1 → EAGAIN`). `forking_tid` is phantom — spec §3.2 rewritten: child main inherits `parent.threads[MAIN_THREAD_TID].blocked_signals`, no plumbing. |
| 2 | Should-fix | **Accepted.** Explicit deliberate-deviation note added (§5): `sigprocmask` treated per-calling-thread (= `pthread_sigmask`); POSIX leaves MT `sigprocmask` unspecified so conformant; differs from #90's "process-wide" wording on purpose. |
| 3 | Should-fix | **Accepted.** §11.7 added: `sigaltstack` `EPERM`/`SS_ONSTACK` is a structural placeholder, unreachable until B1.8-b delivery — same honesty lens as §11.4. |
| 4 | Minor | **Accepted.** `take_bytes` citation removed (§4/§8): all four records fixed-length, exact `len != N` guard; #101/`take_bytes` is the caller-length-split helper, inapplicable; usize-width gap N/A (no length-derived offsets). |
| 5 | Minor | **Accepted (correction).** Verified only `kernel.rs:1600` is a `ThreadRecord {` literal; `:431/:746/:820` are `::main` calls. §3.2 census corrected to two real sites; single-constructor mandate unchanged. |

### Round-7 verdict
"With #1 and #2 folded in and #3 documented, ready for the plan doc;
none of the five is a design blocker." #1/#2 folded, #3 documented,
#4/#5 corrected. No outstanding pushback (the round-6 item-2 reasoning
stands; round-7 raised no objection to it). Gate condition met.
