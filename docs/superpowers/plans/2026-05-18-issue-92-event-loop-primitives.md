# Issue #92 — Linux event-loop primitives (`epoll` / `eventfd` / `timerfd` / `signalfd`) — implementation plan

> **For agentic workers:** execute slice-by-slice (each slice = its own worktree + PR, TDD, not merged by the agent). Steps use `- [ ]`.

**Goal:** Land the Linux event-loop syscalls that libuv (⇒ Node, anything node-shaped) and Python `asyncio` need on their selector path. The set is **co-dependent**: a working event loop needs `epoll` + `eventfd` + `timerfd` together. `signalfd` is separable but gated on the signal-mask surface.

**Architecture:** Four new `FdEntry` variants in `packages/kernel-wasm/src/kernel.rs`, each integrated into the existing `poll_fds` / `poll_revents_for_fd` readiness path at `packages/kernel-wasm/src/dispatch/mod.rs:997`. Per-fd state lives inside the variant (counter for `eventfd`, expiry/interval for `timerfd`, watched-fd table for `epoll`, signal-mask snapshot for `signalfd`). Blocking `read`/`epoll_wait` is **AsyncBridge-gated** — non-blocking + readiness ships first; the blocking await comes last.

**Tech stack:** Rust, `yurt-kernel-wasm`, `cargo test -p yurt-kernel-wasm --lib`; ABI in `abi/contract/yurt_abi_methods.toml`.

## Key findings (investigation 2026-05-18)

1. **None of the four kinds exist** in `packages/kernel-wasm/src/`. A `grep -rn 'epoll\|eventfd\|timerfd\|signalfd'` against `packages/kernel-wasm/src/` returns zero kernel implementation hits — only vendored libc references in `abi/rust/crate-ports/libc-*`.
2. **The readiness path is the integration point.** `poll_fds` at `dispatch/mod.rs:997` already dispatches per `FdEntry` variant via `poll_revents_for_fd`. Adding new fd kinds = adding match arms here (and in the matching `select`-style code). No new multiplexer needs to be built; we just feed the existing one.
3. **`CLOCK_MONOTONIC` is real now (M5 / #64 closed).** `timerfd` can use it directly — no aliasing-to-REALTIME caveat anymore.
4. **`signalfd` depends on #90** (signal-mask surface — `sigprocmask` / `pthread_sigmask` / blocked-mask state). #90 is OPEN; signalfd's slice is gated on it landing first.
5. **Suggested ABI block** in the issue (`0x1_00A0`) is now stale — the current max is `0x1_00B3` after the `*at` slices + B2 family. Allocate fresh `0x1_00B4` onward at S0 time; check the live max via `grep -E 'id =' abi/contract/yurt_abi_methods.toml | sort -u | tail`.

## Per-primitive design

### `eventfd` (the simplest — S1 foundation)

```c
int eventfd(unsigned int initval, int flags);  // EFD_NONBLOCK / EFD_CLOEXEC / EFD_SEMAPHORE
```

- New `FdEntry::EventFd { counter: u64, flags: u32 }`.
- `write(fd, buf, 8)`: parse u64, saturating-add into counter; readable wake.
- `read(fd, buf, 8)`:
  - default mode: return current counter, reset to 0.
  - `EFD_SEMAPHORE`: return 1, decrement by 1.
  - empty + `EFD_NONBLOCK` → `EAGAIN`.
  - empty + blocking: AsyncBridge gate (S5).
- `POLLIN` ⇔ counter > 0; `POLLOUT` ⇔ counter < u64::MAX (saturating-write headroom).
- Errnos: `EBADF`, `EINVAL` (bad flags / wrong write size), `EAGAIN`.

### `timerfd_create` / `settime` / `gettime`

```c
int timerfd_create(int clockid, int flags);                                                                 // CLOCK_MONOTONIC / REALTIME, TFD_NONBLOCK / CLOEXEC
int timerfd_settime(int fd, int flags, const struct itimerspec *new, struct itimerspec *old);              // TFD_TIMER_ABSTIME
int timerfd_gettime(int fd, struct itimerspec *cur);
```

- New `FdEntry::TimerFd { clockid: u32, flags: u32, value: TimerState, interval: Duration, last_read_ns: u64 }`.
- `value` is `Disarmed | OneShot { deadline_ns } | Periodic { deadline_ns, interval_ns }`.
- `read(fd, buf, 8)`: returns u64 = number of expirations since last read. Empty + `TFD_NONBLOCK` → `EAGAIN`; empty + blocking → AsyncBridge.
- `POLLIN` ⇔ at least one expiration accumulated.
- `itimerspec` wire layout: `{ i64 sec, i64 nsec } interval, { i64 sec, i64 nsec } value` (16 + 16 bytes).
- `TFD_TIMER_ABSTIME`: `it_value` is an absolute deadline on the chosen clock.
- Errnos: `EBADF`, `EINVAL` (bad clockid / flags / unaligned span), `ECANCELED` (clock jump on REALTIME with abs-time — defer to follow-up).

### `epoll_create1` / `ctl` / `wait` / `pwait`

```c
int epoll_create1(int flags);                                                          // EPOLL_CLOEXEC
int epoll_ctl(int epfd, int op, int fd, struct epoll_event *ev);                       // EPOLL_CTL_ADD / MOD / DEL
int epoll_wait(int epfd, struct epoll_event *evs, int maxevents, int timeout);
int epoll_pwait(int epfd, struct epoll_event *evs, int maxevents, int timeout, const sigset_t *sig);
```

- New `FdEntry::EPoll { interest: BTreeMap<u32, EpollEntry>, level_triggered_set: BTreeSet<u32>, et_armed: BTreeSet<u32> }`.
  - `EpollEntry { events: u32, data: u64, oneshot: bool }`.
- `epoll_event` wire layout: `{ u32 events, u64 data }` packed = 12 bytes. (Linux `struct epoll_event` is `__attribute__((packed))` on x86_64; record the exact size in the abi block.)
- `epoll_ctl`:
  - `ADD`: `EEXIST` if fd already in interest set; otherwise insert.
  - `MOD`: `ENOENT` if absent; otherwise replace.
  - `DEL`: `ENOENT` if absent; otherwise remove.
  - `ELOOP` detection: watching an `EPoll` fd is allowed (Linux semantics) but reject cycles (`EPOLLEXCLUSIVE` / nested epoll-watching-self).
- `epoll_wait(timeout=0)`: synchronous scan of interest set → produce up to `maxevents` ready records.
- `epoll_wait(timeout>0)`: AsyncBridge with deadline (S5).
- `epoll_wait(timeout=-1)`: AsyncBridge indefinite (S5).
- `epoll_pwait`: same as `epoll_wait` + temporarily replace signal mask for the wait duration (depends on #90 — defer to S5 alongside signalfd, or implement the non-mask portion in S3).
- `POLLIN` on the epoll fd ⇔ at least one watched fd has matching ready events. (Yes, an epoll fd is itself pollable — required for libuv's nested-loop pattern.)
- Errnos: `EBADF`, `EEXIST` / `ENOENT` (CTL ADD dup / MOD-DEL absent), `EINVAL` (maxevents ≤ 0 / bad op / bad event mask), `ELOOP`, `EMFILE` / `ENFILE` (interest set bound TBD — Linux uses RLIMIT_NOFILE).

### `signalfd`

```c
int signalfd(int fd, const sigset_t *mask, int flags);  // read() → struct signalfd_siginfo
```

- Depends on #90 (signal-mask child). Defer the slice until #90's blocked-mask state lands.
- New `FdEntry::SignalFd { mask: u64, flags: u32 }` (or larger if we model the full sigset; YurtOS currently uses a u64).
- `read(fd, buf, sizeof(signalfd_siginfo))`: dequeue one signal from `mask` ∩ process's pending; populate the 128-byte `signalfd_siginfo` record.
- `POLLIN` ⇔ at least one signal in `mask` is pending.

## Suggested ABI block

Allocate contiguous from current max (`0x1_00B3` at investigation time — re-check at S0):

| Method                    | ID         | Slice |
| ------------------------- | ---------- | ----- |
| `SYS_EVENTFD`             | `0x1_00B4` | S1    |
| `SYS_TIMERFD_CREATE`      | `0x1_00B5` | S2    |
| `SYS_TIMERFD_SETTIME`     | `0x1_00B6` | S2    |
| `SYS_TIMERFD_GETTIME`     | `0x1_00B7` | S2    |
| `SYS_EPOLL_CREATE1`       | `0x1_00B8` | S3    |
| `SYS_EPOLL_CTL`           | `0x1_00B9` | S3    |
| `SYS_EPOLL_WAIT`          | `0x1_00BA` | S3    |
| `SYS_EPOLL_PWAIT`         | `0x1_00BB` | S3 / S5 |
| `SYS_SIGNALFD`            | `0x1_00BC` | S4 (gated on #90) |

Append-only, mirrored in the toml, full layout + every negated errno documented to the `sys_openat` / `sys_faccessat` standard.

## Cross-cutting requirements

- **#65** C1-safe length math on every request decode (`epoll_event` array length, `signalfd_siginfo` count, `itimerspec` span). Wasm32 `usize` is 32-bit — explicit 32-bit-bound guard tests, since 64-bit-host `cargo test` masks overflow.
- **#66** N/A (no per-process authority decisions; fds are caller-owned).
- **CLOCK_MONOTONIC (#64 closed):** `timerfd` uses the real monotonic source; record the dependency in slice S2's commit so it's traceable.
- **#90 signal-mask:** S4 (`signalfd`) is gated on it. If #90 hasn't landed by the time S3 is done, skip S4 and revisit.
- **Readiness integration:** every new `FdEntry` variant adds an arm to `poll_revents_for_fd` in `dispatch/mod.rs`. Do not invent a parallel readiness path.
- **No JSON at the boundary:** `epoll_event` / `itimerspec` / `signalfd_siginfo` are fixed binary records.
- **AsyncBridge gating:** blocking `read` on `eventfd` / `timerfd` / `signalfd` and blocking `epoll_wait` / `epoll_pwait` all go through the AsyncBridge — S5 is the dedicated slice for this so each non-blocking path lands and stabilizes first.

## Slice sequence (each = own PR, TDD, not merged by agent)

- [ ] **S0** ABI scaffold: reserve `0x1_00B4..0x1_00BC` in `abi/contract/yurt_abi_methods.toml`, add `METHOD_SYS_*` constants + dispatch arms returning `-ENOSYS`, document the wire layout for each request/response. *Foundational — every other slice consumes this skeleton.* Includes a `non_existent_event_loop_primitives_return_enosys` test row per method id.
- [ ] **S1** `eventfd`. New `FdEntry::EventFd`, dispatch handler, `poll_revents_for_fd` arm, `read`/`write` integration in `sys_read`/`sys_write` dispatch arms (matching the existing pipe path). `EFD_SEMAPHORE` semantics tested separately. **Acceptance:** non-blocking eventfd round-trip + poll-readiness test + saturating-write guard.
- [ ] **S2** `timerfd_create` / `settime` / `gettime`. New `FdEntry::TimerFd`, three handlers, `poll_revents_for_fd` arm, `read` integration. `TFD_TIMER_ABSTIME` separately covered. Pulls in the M5/#64 monotonic source. **Acceptance:** one-shot + periodic + abs-time fixtures; expiration-count semantics test.
- [ ] **S3** `epoll_create1` / `ctl` / `wait` (non-blocking, `timeout = 0` only). New `FdEntry::EPoll` with interest set, four handlers, `poll_revents_for_fd` arm. ELOOP cycle detection. `EPOLLONESHOT` / level-vs-edge state tracking. **Acceptance:** ADD/MOD/DEL round-trips, ready-set scan under mixed eventfd/timerfd/pipe watched fds, cycle rejection.
- [ ] **S4** `signalfd` (gated on #90). New `FdEntry::SignalFd`, handler, `poll_revents_for_fd` arm, `read` returning `signalfd_siginfo`. **Acceptance:** signal arrives → `POLLIN` → read → record decoded.
- [ ] **S5** AsyncBridge gating for the blocking paths: `eventfd` / `timerfd` / `signalfd` blocking `read`; `epoll_wait` / `epoll_pwait` with `timeout > 0` and `timeout < 0`. **Acceptance:** blocking eventfd-cross-thread-wakeup fixture; epoll_wait deadline expiry; epoll_pwait signal mask swap.
- [ ] **S6** Fixtures + conformance: a libuv-style echo-server fixture exercising the epoll+eventfd+timerfd combo end-to-end; B0 TS-vs-Rust differ zero-diff; justified non-corpus matrix rows per #52. **Optional add-on:** POSIX `timer_create` / `timer_settime` / `timer_gettime` family (corpus-gated) for real conformance coverage of timer semantics.

## Conformance

No `conformance/interfaces/` entry for any of these in either vendored suite — they're Linux-specific, not POSIX. Coverage = named fixtures (libuv echo server, eventfd cross-thread wakeup, timerfd periodic tick) + B0 TS-vs-Rust differ; record justified non-corpus matrix rows per #52 (no silent skip). The recommended POSIX `timer_*` family add-on in S6 *is* corpus-gated and supplies real conformance coverage for timer semantics.

## Risk register

| Risk | Severity | Mitigation |
|------|----------|------------|
| New `FdEntry` variants break exhaustiveness in unrelated match sites | Medium | rustc `non_exhaustive_patterns` catches all match sites; clippy `match_wild_err_arm` keeps wildcards visible. Per-slice CI is the regression guard. |
| epoll level-vs-edge state tracking diverges from Linux | Medium | Cover both modes in the S3 fixture; use the libuv echo server in S6 as the integration oracle. |
| timerfd CLOCK_MONOTONIC depends on host monotonic granularity | Low | M5/#64 already landed; reuse its source directly, don't reinvent. |
| Interest-set unbounded growth in epoll | Low | Bind `EpollEntry` count to `RLIMIT_NOFILE` per #65 sizing discipline (return `EMFILE` at the limit). |
| AsyncBridge for `epoll_wait(timeout > 0)` races against `epoll_ctl(DEL)` from another thread | Medium | S5 design must define the cancellation contract explicitly; cover with a mid-wait DEL fixture. |
| `signalfd` slice starts before #90 lands | High (correctness) | S4 explicitly gated on #90 — do not start until #90's blocked-mask state is in main. |

## Acceptance (maps #92)

- [ ] new fd kinds + readiness integration with `poll`/`select`; ABI + dispatch + safe-Rust handlers
- [ ] `timerfd` uses the real monotonic source (M5/#64); `signalfd` wired to blocked-mask state (#90)
- [ ] blocking paths explicitly AsyncBridge-gated; non-blocking complete
- [ ] (recommended) POSIX `timer_*` family added for real conformance coverage
- [ ] C1-safe decode (#65); TDD `cargo test -p yurt-kernel-wasm --lib` green; `fmt` + `clippy -p yurt-kernel-wasm` clean
- [ ] libuv/asyncio fixture + B0 zero-diff (S6)

## Self-review

Every prototype from #92 maps to a slice + ABI id. Dependencies (#64 closed, #90 open) called out. Risk register names the AsyncBridge cancellation contract as the genuinely non-mechanical bit. The split between S3 (non-blocking) and S5 (blocking AsyncBridge) is the same risk-mitigation pattern used elsewhere in the repo — ship the readiness scan first, AsyncBridge it last.
