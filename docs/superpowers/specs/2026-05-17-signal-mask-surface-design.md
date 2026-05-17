# Signal-mask surface — design (issue #90)

> Status: design under review. Round-4/5/6 reviews folded in (§9);
> round-5 reworked §3.1/§6/§8 + added §11; round-6 added §3.3, the
> `sys_sigsuspend` `has_mask` contract, and three §11 divergences.
> Picked up ahead of #91, whose `pselect`/`ppoll` block on this issue's
> kernel-owned blocked-mask state. Refs: #83 (tracking), #52/#57 (umbrella),
> #71, #66 (auth), #54 (B1 RT-signal), #65 (C1 length-guard class).

## 1. Problem

The kernel has `pending_signals: u64` (`kernel.rs:336`) and the RT queue
`pending_rt` but **no blocked mask** and **no alternate signal stack**.
`sigprocmask`/`pthread_sigmask`/`sigsuspend`/`pause` exist only as a
**guest-local** `static yurt_signal_mask` in `abi/src/yurt_signal.c`;
`sigaltstack` and a proper `sigtimedwait` are absent/stubbed. Without a
kernel-owned mask, B1 signal delivery cannot be POSIX-correct, every
threaded runtime that calls `pthread_sigmask` on workers is wrong, and
Rust std loses its `sigaltstack` stack-overflow guard.

## 2. Goals / non-goals

**Goals (ship in this slice):** kernel-owned per-thread blocked mask with
POSIX thread- and fork-inheritance; `sigprocmask`/`pthread_sigmask`,
`sigaltstack` round-trip, `sigtimedwait` (`timeout==0`),
`sigsuspend`/`pause` mask install/restore; mask honored by every
synchronous path that exists today; thin C shims over the guest's native
`sigset_t`.

**Non-goals (gated, documented stubs):** true blocking suspension in
`sigsuspend`/`pause`/`sigtimedwait`-with-nonzero-timeout (AsyncBridge /
B1.5); asynchronous signal *delivery* itself (B1.8-b / AsyncBridge).

**Ordering invariant recorded now (round-5 #7):** `sys_thread_spawn`
(`dispatch/thread.rs:34`) calls `kh::thread_spawn` (host may start the
thread) *before* `bind_thread_handle` installs the inherited mask. This
is safe under this slice (no async delivery; reads are synchronous and
post-bind). The spec records the invariant that the future async-delivery
slice **must not deliver to a worker before its inherited
`blocked_signals` is installed** — the install must move to/under the
reservation, or delivery must gate on a "thread fully bound" flag.

## 3. Architecture

Invert today's guest-local model: **the kernel owns the mask; C shims are
thin binary marshalling** routing to new `METHOD_SYS_*` calls. Consistent
with "buffer/parse/format logic in safe Rust, C is a thin shim" and
"typed binary at the ABI boundary, no JSON".

### 3.1 `sigset_t` encoding — guest byte verbatim on the wire, remap in Rust (round-5 #1/#2)

**Verified constraint:** `abi/include/signal.h:26` is
`typedef unsigned char sigset_t;` — **one byte**, deliberately mirroring
wasi-libc and the Rust libc-port (`c_uchar`); `signal.h:91` pins
`NSIG 32` because gnulib's `verify_NSIG_constraint` statically requires
`NSIG ≤ 32`. The guest `sigset_t` is a compact 8-bit mask via
`yurt_signal_compact_slot()`:

```
SIGHUP→0  SIGINT→1  SIGQUIT→2  SIGTERM→3
SIGCHLD→4 SIGWINCH→5 SIGPIPE→6  SIGUSR1|SIGUSR2|SIGALRM→7
```

Widening the typedef is a cross-language ABI change (wasi-libc compat,
the Rust libc-port `sigset_t`, every `zeroed::<sigset_t>` site, snapshot
layouts) and is **out of scope** — gnulib also blocks `NSIG > 32`.

**Decision:** the ABI wire carries the guest's **native 1-byte compact
`sigset_t` verbatim**. The C shim is therefore genuinely thin — a 1-byte
copy in/out, *no* signo arithmetic. The **kernel-side safe Rust** owns
the single canonical compact-slot⇄`sig-1` mapping table and:

- **expands** an inbound guest byte → internal `u64` (`bit sig-1`),
- **narrows** an internal `u64` → outbound guest byte.

The kernel stores the full `u64` `1<<(sig-1)` mask internally
(consistent with `pending_signals`/`sigqueue`/`sigwaitinfo`/`sigpending`).
This achieves the original "no transform in C" intent **correctly for the
real 1-byte type**, and keeps the remap (a small fixed table) in safe
Rust per the repo rule. §3.1's earlier "verbatim 64-bit, retire the
compact map" framing was wrong (the map is load-bearing because
`sizeof(sigset_t)==1`) and is replaced by this.

Consequent **known divergences** (§11): only the compact-slot signals are
guest-addressable via these calls; slot-7 aliases SIGUSR1/SIGUSR2/SIGALRM
(blocking one blocks all three *at the guest boundary*) — a pre-existing
lossy property of the guest libc, not introduced here; RT signals (#54)
cannot be named in a 1-byte guest `sigset_t`. The kernel `u64` mask can
still represent `1..=63` for kernel-origin signals and the future
delivery path.

### 3.2 Per-thread mask, single constructor, thread + fork inheritance (round-5 #3/#5)

State added to `ThreadRecord` (`kernel.rs:81`):

```rust
pub blocked_signals: u64,      // canonical sig-1 mask (kernel-internal width)
pub sigaltstack: SigAltStack,  // { sp: u32, flags: i32, size: u32 } — wasm32-only widths
```

**Single constructor (round-5 #5).** `ThreadRecord` is built at ≥3 sites
(`::main()` `kernel.rs:97`, the literal in `bind_thread_handle`
`kernel.rs:1600`, fork child `kernel.rs:746`). Replace all with one
constructor `ThreadRecord::new(tid, host_handle, blocked_signals)` (alt-
stack always starts disabled — POSIX resets it per thread). The three
callers differ only in the `blocked_signals` argument, so the inheritance
contract lives in exactly one place:

- main thread / cold start: `blocked_signals = 0`
- `sys_thread_spawn`: `bind_thread_handle` gains `creator_tid: Tid`;
  passes `ctx.caller_tid`; new thread copies
  `process.threads[creator_tid].blocked_signals` (fallback: main thread).
  The bare `kernel_spawn_thread(pid, handle)` host export (`lib.rs:316`)
  has no caller-thread context → inherits the **process main-thread**
  mask by documented contract (not the pthread hot path).
- **`fork()` child (round-5 #3):** `kernel.rs:746` currently builds the
  child main thread as `ThreadRecord::main(None)` (zero mask) and resets
  `child.pending_signals = 0` (`:738`, correct POSIX — empty pending in
  the child). POSIX additionally requires the child to inherit the
  **forking thread's** signal mask. The fork path must set the child main
  `ThreadRecord.blocked_signals = parent.threads[forking_tid]
  .blocked_signals`. Pending stays 0 (unchanged).

**Precise initial state & fallback chain (round-6 #4).**
`ensure_main_thread` seeds `blocked_signals = 0` (POSIX initial empty
mask) and `sigaltstack` disabled (`SS_DISABLE`, `sp=0,size=0`).
`spawn_thread` copies the creator's `blocked_signals` and **resets**
`sigaltstack` to disabled. Creator resolution is an explicit chain:
`process.threads[creator_tid]` → if absent, the main-thread record → if
that too is absent, empty (`0`). The bare `kernel_spawn_thread` host
export (`lib.rs:316`) has no caller-thread context and therefore passes
an **explicit `MAIN_THREAD_TID`** as the new `creator_tid` argument to
`bind_thread_handle` (`kernel.rs:1588`) — a named contract, never a
silent `Default`.

### 3.3 Guest `sigset_t` symbols — touched vs untouched (round-6 #2)

Because the guest representation does **not** change (§3.1, wire carries
the 1-byte compact `sigset_t` verbatim; remap is Rust-side), this slice
has a precise, small footprint in the libc port:

- **Touched** (guest-local logic removed → kernel-routed): the mask
  bodies of `sigprocmask`/`sigsuspend`/`pause`/`sigtimedwait`, the
  `static yurt_signal_mask` / `yurt_pending_signal_mask`, and
  `yurt_signal_deliver_pending`.
- **Untouched** (stay compact 1-byte, byte-identical behavior):
  `sigemptyset`/`sigfillset`/`sigaddset`/`sigdelset`/`sigismember`
  (`yurt_signal.c:152-210`), `struct sigaction` storage and `sa_mask`
  (`yurt_signal.c:230-249`), `yurt_signal_compact_slot`/
  `yurt_sigset_mask_bit` (still the guest's `sigset_t` representation).

There is **no partial-migration window** because there is no guest-side
migration. Widening `sigset_t` repo-wide (wasi-libc + libc-port + gnulib
`NSIG`) is a separate larger initiative, explicitly **out of scope** —
to be filed as its own issue if ever desired, never smuggled through #90.
The `sa_mask`↔kernel-mask encoding boundary is a documented divergence
(§11.5).

## 4. ABI

Contiguous sub-block in the `0x1_00A0` sweep (#83). Append-only in
`abi/contract/yurt_abi_methods.toml`. **Partition-comment fix (round-5
nit):** the comment at `yurt_abi_methods.toml:578` cites umbrella **#51**
as canonical record — #51 was reverted by #56; canonical is **#57** /
tracking **#52**. The mirror edit corrects `#51 → #57/#52` and appends
`signal-mask #90 → 0x1_00A0–0x1_00A3` (confirmed free: B4 ends `0x1_009F`).

| id        | method            | request → response (LE, typed binary; `sigset_t` = **1 guest byte**) |
|-----------|-------------------|----------------------------------------------------------------------|
| `0x1_00A0`| `sys_sigprocmask` | `i32 how` + `u8 has_set` + `u8 set` → `u8 oset` (prior). Serves `sigprocmask` **and** `pthread_sigmask`. |
| `0x1_00A1`| `sys_sigaltstack` | `u8 has_ss` + `{u32 sp,i32 flags,u32 size}` → `{u32 sp,i32 flags,u32 size}` (prior). |
| `0x1_00A2`| `sys_sigsuspend`  | `u8 has_mask` + `u8 mask` → (return code only). `has_mask=0` ⇒ caller-thread mask unchanged (this is `pause`). |
| `0x1_00A3`| `sys_sigtimedwait`| `u8 set` + `u8 has_timeout` + `{i64 tv_sec,i64 tv_nsec}` → 16-byte siginfo (as `sigwaitinfo`). |

`how`: `SIG_BLOCK=0`, `SIG_UNBLOCK=1`, `SIG_SETMASK=2` (else `EINVAL`).
`pause` = `sys_sigsuspend(has_mask=0)` (one atomic kernel call — round-6
#1, replaces the old non-atomic two-syscall C composition);
`pthread_sigmask` = thin C alias of `sys_sigprocmask`. No separate ids.
Every variable read uses `take_bytes` (wrap-safe, #65/C1); fixed records
length-checked up front. The kernel expands the 1-byte `set`/`mask` to
`u64` (§3.1) before applying; narrows `blocked_signals` for `oset`.

## 5. Handlers (`dispatch/process.rs`)

- **`sys_sigprocmask`** — narrow prior `blocked_signals(caller_tid)` →
  `oset` byte; if `has_set`, expand `set` byte → `u64`, apply `how`
  (`BLOCK |=`, `UNBLOCK &= !`, `SETMASK =`), clear SIGKILL(9)/SIGSTOP(19)
  bits, store. `ESRCH` (no record), `EINVAL` (bad `how`/short request).
- **`sys_sigaltstack`** — write prior `{sp,flags,size}` to `oss`; if
  `has_ss`: `EINVAL` when `size < MINSIGSTKSZ` and not `SS_DISABLE`;
  `EPERM` if on the alt stack (tracked `SS_ONSTACK`); `SS_DISABLE`
  zeroes. Bookkeeping only (host delivers).
- **`sys_sigtimedwait`** — reuse the `sigwaitinfo` RT-dequeue machinery;
  **select the pending signal by `set` regardless of blocked state**
  (round-4 #3 — the canonical idiom blocks then synchronously accepts);
  write 16-byte siginfo. Nothing pending / `timeout==0` ⇒ `EAGAIN`;
  nonzero-timeout blocking is the gated stub (immediate `EAGAIN`).
- **`sys_sigsuspend`** (round-6 #1) — if `has_mask=1`, atomically swap
  the `caller_tid` mask to `mask` for the wait; if `has_mask=0`, leave
  the caller-thread mask unchanged (`pause`). Either way: perform the
  available non-blocking pending check, restore the prior mask (no-op
  when `has_mask=0`), then **return the stub result `-EINTR` until
  B1.5** (round-4 #4). The pending check has **no observable effect
  today** — delivery is B1.8-b-gated; it is a structural placeholder,
  not partial behavior (round-6 #5).

### 5.1 Mask-enforcement boundary (round-4 #3)

The blocked mask gates **asynchronous delivery only** (the future
B1.8-b/AsyncBridge path, which this slice does not implement but
guarantees will read `ThreadRecord.blocked_signals`). It does **not**
filter `sigwaitinfo`/`sigtimedwait` synchronous acceptance (selected by
`set`). `sigpending` stays the pending∪RT union, unchanged.

### 5.2 Busy-spin / livelock risk (round-5 #4)

Until B1.5, `sigsuspend`/`pause` return `-EINTR` immediately and
`sigtimedwait`-with-timeout returns `EAGAIN` immediately. Real callers
loop (`while (1) pause();`, `do { } while (sigsuspend(...) && errno==EINTR)`)
and will **busy-spin at 100% CPU** until the bridge lands. This is a
runtime hazard, not just an API footnote: called out here, in the
parity-matrix divergence note, and in §11. Action item: grep in-tree
fixtures/canaries for `pause(`/`sigsuspend(` loop usage and record
whether any exercised fixture hits it; if so, gate or skip that fixture
with an explicit reference to this divergence rather than letting CI
wall-clock-hang.

## 6. C shims & headers (`abi/src/yurt_signal.c`, `abi/include/signal.h`, `yurt_runtime.h`)

- Replace the `static yurt_signal_mask` logic with thin kernel-routed
  marshalling: the shim copies the guest's 1-byte `*set`/`*mask`/`*oldset`
  **verbatim** into/out of the typed record — **no signo arithmetic in
  C** (the expand/narrow lives in Rust, §3.1).
- Add `yurt_host_*` imports for the four methods in `yurt_runtime.h`.
- Fix the existing copy-paste bug: `sigtimedwait` uses
  `YURT_MARKER_CALL(sigsuspend)` (`yurt_signal.c:311`) — must be
  `sigtimedwait`.
- `pthread_sigmask` stays a thin alias of `sigprocmask`. **`pause`
  becomes `sys_sigsuspend(has_mask=0)`** — one atomic kernel call, not
  the old `sigprocmask`-read + `sigsuspend` C composition (round-6 #1).
- **`sigaltstack` is a brand-new C symbol** (no marker/impl exists
  today): new shim in `yurt_signal.c` with its own
  `YURT_DECLARE/DEFINE_MARKER(sigaltstack)`, routed to `0x1_00A1`.
- **Header surface to add to `signal.h` (round-5 #6)** — currently absent:
  `stack_t { void *ss_sp; int ss_flags; size_t ss_size; }`,
  `SS_ONSTACK 1`, `SS_DISABLE 2`,
  `int sigaltstack(const stack_t *restrict, stack_t *restrict);`,
  and pinned `#define MINSIGSTKSZ 2048` / `#define SIGSTKSZ 8192`
  (musl-consistent; must equal the Rust libc-port values Rust std's
  stack-overflow guard reads — verified against the libc-port during
  implementation, asserted by a `_Static_assert`). `siginfo_t` already
  exists (`signal.h:39`).

## 7. Error handling

`EINVAL` (bad `how`, undersized `ss_size`, short/garbled record), `ESRCH`
(no caller record), `EPERM` (`sigaltstack` while on alt stack), `EAGAIN`
(`sigtimedwait` none / gated blocking), `EINTR` (`sigsuspend`/`pause`
stub). `EINTR` is absent from `abi.rs` — add `EINTR = 4` (correct Linux
value; slot 4 free between `ESRCH=3` and `EIO=5`).

## 8. Testing

TDD; Rust dispatch tests are the primary gate (`TestGuard::acquire()`):

- mask round-trip + `how` semantics; SIGKILL/SIGSTOP stay unmaskable
- **compact⇄canonical table unit test (round-5)**: every compact slot
  expands to the right `sig-1` bit(s) and narrows back; slot-7 aliasing
  asserted as the documented divergence (block SIGUSR1 ⇒ canonical bits
  for the slot-7 set; narrow ⇒ slot 7)
- **guest round-trip through the real helpers (round-6 #2)**:
  `sigemptyset(&s); sigaddset(&s, SIGUSR1)` (→ compact slot 7) →
  `sys_sigprocmask(SETMASK)` → kernel expands → `sigpending` → narrow →
  slot 7 observed via `sigismember`. Asserts the remap round-trips at
  the representable boundary (no unrepresentable "bit 9" assertion)
- **`sigtimedwait` kill-bitmask divergence (round-6 #3)**: a test
  documenting that `sigprocmask(block SIGTERM)` + `kill(SIGTERM)` +
  `sigtimedwait` returns `EAGAIN` here (RT-queue-only) vs. SIGTERM on
  Linux — asserts the *documented* behavior so the divergence is pinned,
  not silently regressible
- **thread inheritance**: set mask on creator → `sys_thread_spawn` →
  child `blocked_signals` copied; alt-stack reset
- **fork inheritance (round-5 #3)**: forking thread blocks SIGTERM →
  `fork` → child main `blocked_signals` has it; `pending_signals == 0`
- `sigaltstack` round-trip, `SS_DISABLE`, undersized ⇒ `EINVAL`,
  on-stack ⇒ `EPERM`
- **`sigtimedwait` selects blocked-by-`set` pending signal** (block +
  `sigqueue` + `sigtimedwait(set,0)` ⇒ returns it, not `EAGAIN`)
- `sigsuspend` installs+restores mask, returns `-EINTR`

Conformance: wire the **5 new** Open POSIX interface dirs (`sigprocmask`,
`pthread_sigmask`, `sigaltstack`, `sigsuspend`, `sigtimedwait`) — new
wiring, *not* extensions of the legacy single-case `signal.spec.toml`
canary (round-5 nit). Stale `*.spec.toml` expectation notes that assert
guest-local semantics (e.g. `sigprocmask.spec.toml`: "guest-local mask
only; no observation of external signals") are **rewritten, not
extended**, to reflect kernel-owned semantics (round-6 #5). Parity-matrix row added with the §11 divergences
noted. B0 TS-vs-Rust zero-diff. `cargo fmt`/`clippy` clean. Length guards
use the `take_bytes` u64-bounded pattern (wasm32-vs-native usize-width
test gap, project memory).

## 9. Review tightenings folded in

**Round-4:** (1) per-thread inherited mask; (2) creator-TID plumbing;
(3) `sigwaitinfo`/`sigtimedwait` select by `set`; (4) `sigsuspend`/`pause`
framed as tracked stub-compat divergence.

**Round-5** (durable record: `docs/superpowers/reviews/2026-05-17-signal-mask-surface-review.md`):
(1) `sigset_t` is 1 byte → wire carries the guest byte verbatim, remap in
Rust (§3.1); (2) `NSIG=32` / RT story stated (§3.1, §11); (3) fork
inheritance specified (§3.2); (4) busy-spin/livelock risk surfaced
(§5.2, §11); (5) single `ThreadRecord` constructor (§3.2); (6) `signal.h`
header surface enumerated + constants pinned (§6); (7) spawn
install-ordering invariant recorded (§2); nits: partition-comment
`#51→#57/#52` + `0x1_00A0` (§4), wasm32-only `SigAltStack` (§3.2),
new-wiring conformance note (§8).

**Round-6:** (1) **blocker accepted** — `sys_sigsuspend` gains
`has_mask`; `pause` = `sys_sigsuspend(has_mask=0)`, one atomic kernel
call, no C composition (§4, §5, §6); (2) **blocker premise rejected,
core folded** — "migrate every `sigset_t` to `sig-1`" contradicts the
verified 1-byte typedef; guest representation unchanged, explicit
touched/untouched enumeration added (§3.3), `sa_mask` boundary →
§11.5, corrected round-trip test (§8); (3) `sigtimedwait` ignores the
`kill` bitmask → documented divergence §11.6 + test (§8); (4) precise
initial state + fallback chain + explicit `MAIN_THREAD_TID` (§3.2);
(5) `sigaltstack` new C symbol named (§6), stale `*.spec.toml`
rewritten not extended (§8), partition+umbrella edited atomically
(§4), pending-check no-observable-effect stated (§5, §11.4).

## 10. Acceptance mapping (issue #90)

- blocked-mask state (per-thread; fork+thread inherit) + `sigaltstack`
  round-trip → §3.2, §5, §6
- ABI + dispatch + safe-Rust handlers; non-blocking/`timeout==0`
  complete; blocking gated → §4, §5
- mask honored by B1 delivery (xref #66) → §5.1 (delivery path will read
  the mask; delivery itself out of slice — explicit gap, §11)
- 5 Open POSIX dirs wired (new) + PASS + TS-vs-Rust identical → §8
- TDD green; `fmt`/`clippy`; matrix rows + B0 zero-diff → §8

## 11. Known divergences (carried into the matrix note)

1. **Guest-addressable signal set is the 8 compact slots only** — a
   1-byte guest `sigset_t` (wasi-libc/libc-crate/gnulib-constrained,
   `NSIG=32`). Signals outside the compact map and RT signals (#54)
   cannot be named via guest `sigprocmask`/`sigsuspend`/`sigtimedwait`.
   The kernel `u64` mask still represents `1..=63` for kernel-origin
   signals and the future delivery path.
2. **Slot-7 aliasing** — SIGUSR1/SIGUSR2/SIGALRM share compact bit 7;
   blocking one blocks all three at the guest boundary. **Pre-existing**
   guest-libc property, not introduced by this slice; documented, not
   "fixed" (fixing it requires widening `sigset_t`, out of scope).
3. **No true blocking until B1.5** — `sigsuspend`/`pause`/timed
   `sigtimedwait` return immediately; looping callers busy-spin (§5.2).
4. **Async delivery out of slice** — the mask is enforced only on
   synchronous paths that exist today; B1.8-b delivery inherits a correct
   mask to consult once it lands. The `sigsuspend`/`pause` non-blocking
   pending check therefore has **no observable effect today** — it is a
   structural placeholder, not partial behavior (round-6 #5).
5. **`sa_mask` encoding boundary (round-6 #2)** — `sigaction` stores
   `sa_mask` guest-side in compact 1-byte form (`yurt_signal.c:230-249`);
   the kernel blocked mask is `sig-1` `u64`. They only interact when a
   handler is invoked (sa_mask applied during delivery), which is
   B1.8-b-gated. Reconciliation is the same Rust remap, performed by the
   delivery slice — documented, not silently carried.
6. **`sigtimedwait` is RT-queue-only (round-6 #3)** — it reuses
   `sigwaitinfo` machinery (`dispatch/process.rs:796-820`), which drains
   `pending_rt` only and never inspects `pending_signals` (separated-
   producer model). A `kill()`-pending non-RT signal is not synchronously
   accepted: `sigprocmask(block SIGTERM)` + `kill` + `sigtimedwait` ⇒
   `EAGAIN` here vs. SIGTERM on Linux. Draining `pending_signals` too is
   a follow-up (touches the separated-producer invariant).
