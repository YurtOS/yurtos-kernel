# Signal-mask surface — design (issue #90)

> Status: design approved-with-conditions on the issue thread; four review
> tightenings folded in (see §9). Picked up ahead of #91, whose
> `pselect`/`ppoll` block on this issue's kernel-owned blocked-mask state.
> Refs: #83 (tracking), #52, #71, #66 (auth), #54 (B1 RT-signal), #65 (C1
> length-guard class).

## 1. Problem

The kernel has `pending_signals` (and the RT queue `pending_rt`) but **no
blocked mask** and **no alternate signal stack**. `sigprocmask`,
`pthread_sigmask`, `sigsuspend`, `pause` exist only as a **guest-local**
`static yurt_signal_mask` in `abi/src/yurt_signal.c`; `sigaltstack` and
`sigtimedwait` are absent/stubbed. Without a kernel-owned mask, B1 signal
delivery cannot be POSIX-correct, every threaded runtime that calls
`pthread_sigmask` on workers is wrong, and Rust std loses its
`sigaltstack` stack-overflow guard.

## 2. Goals / non-goals

**Goals (ship in this slice):** kernel-owned per-thread blocked mask with
POSIX inheritance; `sigprocmask`/`pthread_sigmask`, `sigaltstack`
round-trip, `sigtimedwait` (`timeout==0`), `sigsuspend`/`pause` mask
install/restore; mask honored by every synchronous path that exists
today; a single canonical `sigset_t` wire encoding; thin C shims.

**Non-goals (gated, documented stubs):** true blocking suspension in
`sigsuspend`/`pause`/`sigtimedwait`-with-nonzero-timeout (AsyncBridge /
B1.5); asynchronous signal *delivery* itself (still B1.8-b / AsyncBridge —
this slice only guarantees the delivery path will read a correct mask once
it lands).

## 3. Architecture

Invert today's guest-local model: **the kernel owns the mask; C shims are
thin binary marshalling** routing to new `METHOD_SYS_*` calls. Consistent
with the repo rules "buffer/parse/format logic in safe Rust, C is a thin
shim" and "typed binary at the ABI boundary, no JSON".

### 3.1 Canonical `sigset_t` encoding (review blocker #1)

**One encoding everywhere: a fixed 64-bit little-endian mask, bit
`sig - 1` for sig in `1..=63`.** This is what the issue's Suggested ABI
already specifies and what every existing kernel API
(`pending_signals`, `sigqueue`, `sigwaitinfo`, `sigpending`) already uses.

The legacy compact-slot scheme in `yurt_signal.c`
(`yurt_signal_compact_slot`: `SIGHUP→0 … SIGPIPE→6`, USR/ALRM sharing
slot 7) is **retired** — it was an artifact of the guest-local-only era
this slice replaces. The guest libc-port `sigset_t` representation and the
`yurt_signal.c` mask helpers (`yurt_sigset_mask_bit`,
`yurt_pending_signal_mask`, the deliver-pending loop) move to the
canonical encoding. The C shim then performs **no transform** — it copies
the 8-byte mask through verbatim. Blast radius is in-scope and explicit;
an end-to-end Rust test asserts `sig-1` alignment (block SIGUSR1=10 ⇒ bit
9 set; `sigpending` reflects it).

### 3.2 Per-thread inherited mask (review blocker #2)

Linux semantics: every thread has its own blocked mask; `sigprocmask`
and `pthread_sigmask` are the same op on the calling thread; a new thread
inherits a copy of its creator's mask.

State added to `ThreadRecord` (`kernel.rs`):

```rust
pub blocked_signals: u64,                 // canonical sig-1 mask
pub sigaltstack: SigAltStack,             // { sp: u32, flags: i32, size: u32 }
```

`SigAltStack::default()` = disabled (`sp=0, size=0, flags=SS_DISABLE`).

**Creator-TID plumbing.** `bind_thread_handle` gains a
`creator_tid: Tid` parameter. `sys_thread_spawn` (which holds
`ctx.caller_tid`) passes it; the new `ThreadRecord` copies
`blocked_signals` from `process.threads[creator_tid]`, falling back to the
main-thread record when the creator is the main thread / not yet
recorded. The alt-stack does **not** inherit (POSIX: reset to disabled in
the new thread). The bare `kernel_spawn_thread(pid, handle)` host export
(`lib.rs:316`) has no caller-thread context — it inherits the **process
main-thread** mask by documented contract (it is not the pthread-create
hot path; that path is `sys_thread_spawn`). Documented limitation, not
silent default-state inheritance.

## 4. ABI

Contiguous sub-block in the `0x1_00A0` sweep (#83: "this sweep starts at
`0x1_00A0`, one contiguous sub-block per child"). Append-only in
`abi/contract/yurt_abi_methods.toml`, mirrored in the partition comment.
The leftover `0x1_0066–0x1_006F` in the B1 block stays logically closed.

| id        | method            | request → response (all LE, typed binary) |
|-----------|-------------------|-------------------------------------------|
| `0x1_00A0`| `sys_sigprocmask` | `i32 how` + `u8 has_set` + `u64 set` → `u64 oset` (prior mask). Serves `sigprocmask` **and** `pthread_sigmask`. |
| `0x1_00A1`| `sys_sigaltstack` | `u8 has_ss` + `{u32 sp,i32 flags,u32 size}` → `{u32 sp,i32 flags,u32 size}` (prior). |
| `0x1_00A2`| `sys_sigsuspend`  | `u64 mask` → (no body; return code only). |
| `0x1_00A3`| `sys_sigtimedwait`| `u64 set` + `u8 has_timeout` + `{i64 tv_sec,i64 tv_nsec}` → 16-byte siginfo (as `sigwaitinfo`). |

`how`: `SIG_BLOCK=0`, `SIG_UNBLOCK=1`, `SIG_SETMASK=2` (else `EINVAL`).
`pause` = thin C `sigsuspend(current mask)`; `pthread_sigmask` = thin C
alias of `sigprocmask`. No separate ids for those two. All variable reads
go through `take_bytes` (wrap-safe, #65/C1 class); fixed records
length-checked up front.

## 5. Handlers (`dispatch/process.rs`)

- **`sys_sigprocmask`** — read prior `blocked_signals` of `caller_tid`
  into `oset`; if `has_set`, apply `how` (`BLOCK |= set`,
  `UNBLOCK &= !set`, `SETMASK = set`); always clear the SIGKILL(9) and
  SIGSTOP(19) bits before storing (Linux: silently unmaskable). `ESRCH`
  if no process/thread record; `EINVAL` on bad `how`/short request.
- **`sys_sigaltstack`** — write prior `{sp,flags,size}` to `oss`; if
  `has_ss`: `EINVAL` when `size < MINSIGSTKSZ` and not `SS_DISABLE`;
  `EPERM` if currently on the alt stack (tracked `SS_ONSTACK` flag);
  `SS_DISABLE` zeroes it. Bookkeeping only (host delivers).
- **`sys_sigtimedwait`** — reuse the `sigwaitinfo` RT-dequeue machinery;
  **select the matching pending signal by `set` regardless of blocked
  state** (review #3 — the canonical idiom blocks then accepts); write
  16-byte siginfo. `timeout==0` (or `has_timeout=0` with nothing pending)
  ⇒ `EAGAIN`; nonzero-timeout blocking is the gated stub (immediate
  `EAGAIN`).
- **`sys_sigsuspend`** — atomically install `mask` on `caller_tid`,
  perform the available non-blocking pending check, restore the prior
  mask, then return the current stub result `-EINTR` until B1.5 (review
  #4 — a tracked stub-compat divergence, not POSIX-complete).

### 5.1 Mask enforcement boundary (review #3)

The blocked mask gates **asynchronous delivery only** (the future
B1.8-b/AsyncBridge delivery path, which this slice does not implement but
guarantees will read `ThreadRecord.blocked_signals`). It does **not**
filter `sigwaitinfo`/`sigtimedwait` synchronous acceptance, which selects
purely by `set`. `sigpending` is already the pending∪RT union and stays
POSIX-correct unchanged.

## 6. C shims (`abi/src/yurt_signal.c`, `yurt_runtime.h`)

Replace the `static yurt_signal_mask` logic with thin kernel-routed
marshalling on the canonical 64-bit encoding; add the `sigaltstack`
shim; add `yurt_host_*` imports for the four methods; fix the existing
`sigtimedwait` copy-paste `YURT_MARKER_CALL(sigsuspend)` bug. `pause` and
`pthread_sigmask` remain thin compositions/aliases. No bit transforms in
C.

## 7. Error handling

`EINVAL` (bad `how`, undersized `ss_size`, short/garbled record),
`ESRCH` (no caller process/thread record), `EPERM` (`sigaltstack` while
on the alt stack), `EAGAIN` (`sigtimedwait` nothing pending / gated
blocking), `EINTR` (`sigsuspend`/`pause` stub return). `EINTR` is not yet
in `abi.rs` — add it (`EINTR = 4`).

## 8. Testing

TDD; Rust dispatch tests are the primary gate (`TestGuard::acquire()`
pattern):

- mask round-trip + `how` semantics; SIGKILL/SIGSTOP stay unmaskable
- **canonical-encoding alignment**: block SIGUSR1(10) ⇒ bit 9; `sigpending` agrees
- **thread inheritance**: set mask on creator, `sys_thread_spawn`, assert child `blocked_signals` copied; alt-stack reset
- `sigaltstack` round-trip, `SS_DISABLE`, undersized ⇒ `EINVAL`
- **`sigtimedwait` selects blocked-by-`set` pending signal** (block + `sigqueue` + `sigtimedwait(set,0)` ⇒ returns it, not `EAGAIN`)
- `sigsuspend` installs+restores mask, returns `-EINTR`

Conformance: wire the 5 Open POSIX interface dirs (`sigprocmask`,
`pthread_sigmask`, `sigaltstack`, `sigsuspend`, `sigtimedwait`); update
`abi/conformance/*.spec.toml`. Parity-matrix row added (with the gated
divergences noted). B0 TS-vs-Rust zero-diff. `cargo fmt` / `clippy`
clean. Note the wasm32-vs-native usize-width test gap (project memory):
length guards use the `take_bytes` u64-bounded pattern.

## 9. Review tightenings folded in

1. **sigset_t encoding** → §3.1 canonical `1<<(sig-1)`, compact-slot retired.
2. **creator-TID** → §3.2 `bind_thread_handle(creator_tid)` plumbing + bare-export contract.
3. **sigwaitinfo/sigtimedwait** → §5/§5.1 select by `set`, never skip blocked.
4. **sigsuspend/pause framing** → §5 tracked stub-compat divergence, not "kernel-correct".

## 10. Acceptance mapping (issue #90)

- blocked-mask state (per-thread + process default) + `sigaltstack` round-trip → §3.2, §5
- ABI + dispatch + safe-Rust handlers; non-blocking/`timeout==0` complete; blocking gated → §4, §5
- mask honored by B1 delivery (xref #66) → §5.1 (delivery path will read the mask; delivery itself out of slice — explicit gap)
- 5 Open POSIX dirs wired + PASS + TS-vs-Rust identical → §8
- TDD green; `fmt`/`clippy`; matrix rows + B0 zero-diff → §8
