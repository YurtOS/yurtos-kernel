# Signal-mask surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a kernel-owned per-thread blocked-signal mask plus `sigaltstack`/`sigsuspend`/`sigtimedwait` with thin C shims, so threaded runtimes and Rust std work and #91's `pselect`/`ppoll` are unblocked.

**Architecture:** Kernel owns the mask (per-thread on `ThreadRecord`, inherited on thread-spawn and fork); C shims pass the guest's native 1-byte `sigset_t` verbatim; a safe-Rust table remaps compact-slot⇄`sig-1`. Four fixed-length ABI methods in the `0x1_00A0` block. True blocking is AsyncBridge/B1.5-gated (documented stubs).

**Tech Stack:** Rust (`packages/kernel-wasm`), C ABI shims (`abi/src`, `abi/include`), TOML ABI contract (`abi/contract/yurt_abi_methods.toml`), Deno conformance harness.

**Spec:** `docs/superpowers/specs/2026-05-17-signal-mask-surface-design.md` (rounds 1–7). **Review record:** `docs/superpowers/reviews/2026-05-17-signal-mask-surface-review.md`.

**Conventions:**
- All commands run from the worktree root `/Users/sunny/work/yurtos/yurtos-kernel/.claude/worktrees/parity-signal-mask`.
- Rust tests: `cargo test -p kernel-wasm <name>`. Format/lint gate: `cargo fmt --all && cargo clippy -p kernel-wasm --all-targets -- -D warnings`.
- `METHOD_SYS_*` constants are **generated** by `packages/kernel-wasm/build.rs` from the TOML — never hand-write them; a `cargo build` regenerates `methods_generated.rs`.
- Commit message trailer (every commit): `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## File structure

- `abi/contract/yurt_abi_methods.toml` — add 4 `[method.sys_*]` entries (ids `0x1_00A0`–`0x1_00A3`); fix partition comment (`#51`→`#57/#52`, add `0x1_00A0` line).
- `packages/kernel-wasm/src/abi.rs` — add `EINTR = 4`.
- `packages/kernel-wasm/src/kernel.rs` — `SigAltStack` type; `ThreadRecord.blocked_signals`/`.sigaltstack`; single `ThreadRecord::new`; `::main` delegates; `bind_thread_handle` gains `creator_tid`; fork inherits main mask.
- `packages/kernel-wasm/src/dispatch/sigmask.rs` — **new** module: compact⇄canonical remap table + the four handlers.
- `packages/kernel-wasm/src/dispatch/mod.rs` — `mod sigmask;`, 4 dispatch arms, `bind_thread_handle` call sites updated.
- `packages/kernel-wasm/src/dispatch/thread.rs` — pass `ctx.caller_tid` as `creator_tid`.
- `packages/kernel-wasm/src/dispatch/tests.rs` — dispatch tests (primary gate).
- `abi/include/signal.h` — `stack_t`, `SS_ONSTACK`/`SS_DISABLE`, `MINSIGSTKSZ`/`SIGSTKSZ`, `sigaltstack` proto.
- `abi/src/yurt_signal.c` — thin kernel-routed shims; new `sigaltstack`; marker-bug fix.
- `abi/src/yurt_runtime.h` — 4 `yurt_host_*` imports.
- host-interface import registration (located in Task 8).
- `abi/conformance/*.spec.toml` + `scripts/open-posix-harness.ts` + parity-matrix doc — Task 9.

---

## Task 1: ABI method registration + `EINTR`

**Files:**
- Modify: `abi/contract/yurt_abi_methods.toml` (append block; partition comment ~`:571-579`)
- Modify: `packages/kernel-wasm/src/abi.rs:6-8`

- [ ] **Step 1: Add the four method entries to the TOML**

Append to `abi/contract/yurt_abi_methods.toml` (after the last `[method.*]` entry):

```toml
[method.sys_sigprocmask]
id = 0x1_00A0
kind = "syscall"
doc = "POSIX sigprocmask/pthread_sigmask on the calling thread. Request: i32 how LE + u8 has_set + u8 set (guest 1-byte compact sigset_t). Response: u8 oset (prior mask, compact). how: 0=BLOCK 1=UNBLOCK 2=SETMASK. SIGKILL/SIGSTOP silently unmaskable. Per-calling-thread (POSIX leaves MT sigprocmask unspecified). -EINVAL bad how/short, -ESRCH no record."

[method.sys_sigaltstack]
id = 0x1_00A1
kind = "syscall"
doc = "POSIX sigaltstack. Request: u8 has_ss + {u32 sp,i32 flags,u32 size}. Response: {u32 sp,i32 flags,u32 size} (prior). Bookkeeping only (host delivers). -EINVAL size<MINSIGSTKSZ unless SS_DISABLE, -EPERM while on alt stack (placeholder until delivery)."

[method.sys_sigsuspend]
id = 0x1_00A2
kind = "syscall"
doc = "POSIX sigsuspend / pause. Request: u8 has_mask + u8 mask. has_mask=1 swaps caller-thread mask for the wait; has_mask=0 leaves it (pause). Non-blocking pending check, restore prior mask, return -EINTR (true blocking AsyncBridge/B1.5-gated)."

[method.sys_sigtimedwait]
id = 0x1_00A3
kind = "syscall"
doc = "POSIX sigtimedwait. Request: u8 set (compact) + u8 has_timeout + {i64 tv_sec,i64 tv_nsec}. Reuses sigwaitinfo RT-queue dequeue selected by set regardless of blocked state; 16-byte siginfo response. Nothing pending / timeout==0 => -EAGAIN; nonzero-timeout blocking is the gated stub. RT-queue-only (kill bitmask divergence, documented)."
```

- [ ] **Step 2: Add `EINTR` to the errno mirror**

In `packages/kernel-wasm/src/abi.rs`, after `pub const ESRCH: i32 = 3;` add:

```rust
pub const EINTR: i32 = 4;
```

- [ ] **Step 3: Build to regenerate method constants and verify**

Run: `cargo build -p kernel-wasm 2>&1 | tail -5`
Expected: builds; `METHOD_SYS_SIGPROCMASK`/`SIGALTSTACK`/`SIGSUSPEND`/`SIGTIMEDWAIT` now exist.

Run: `cargo test -p kernel-wasm --no-run 2>&1 | tail -3 && grep -rl "METHOD_SYS_SIGPROCMASK" $(find target -name methods_generated.rs | head -1)`
Expected: the generated file path prints (constant present).

- [ ] **Step 4: Commit**

```bash
git add abi/contract/yurt_abi_methods.toml packages/kernel-wasm/src/abi.rs
git commit -m "feat(abi): register sigprocmask/sigaltstack/sigsuspend/sigtimedwait methods + EINTR (#90)
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Kernel state — per-thread mask + single constructor + inheritance

**Files:**
- Modify: `packages/kernel-wasm/src/kernel.rs` (`ThreadRecord` ~`:81`, `::main` ~`:96`, `bind_thread_handle` ~`:1588`, `prepare_fork` ~`:715-748`)
- Modify: `packages/kernel-wasm/src/dispatch/thread.rs` (`bind_thread_handle` call ~`:46`)
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs` (other `bind_thread_handle`/`spawn_thread` call sites if any)
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`

- [ ] **Step 1: Write the failing test**

Append to `packages/kernel-wasm/src/dispatch/tests.rs`:

```rust
#[test]
fn thread_spawn_inherits_creator_blocked_mask_altstack_resets() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(1).threads.get_mut(&crate::kernel::MAIN_THREAD_TID).unwrap()
            .blocked_signals = 0b1010;
        let tid = k.spawn_thread(1, Some(7)).expect("spawn");
        let t = &k.process_mut(1).threads[&tid];
        assert_eq!(t.blocked_signals, 0b1010, "worker inherits creator mask");
        assert!(t.sigaltstack.is_disabled(), "alt-stack resets on new thread");
    });
}

#[test]
fn fork_child_main_inherits_forking_main_mask_pending_empty() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(1).threads.get_mut(&crate::kernel::MAIN_THREAD_TID).unwrap()
            .blocked_signals = 0b0100;
        k.process_mut(1).pending_signals = 0xFF;
        let child = k.prepare_fork(1).expect("fork");
        let cm = &k.process_mut(child).threads[&crate::kernel::MAIN_THREAD_TID];
        assert_eq!(cm.blocked_signals, 0b0100, "child main inherits forking main mask");
        assert_eq!(k.process_mut(child).pending_signals, 0, "child pending empty");
    });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kernel-wasm thread_spawn_inherits_creator_blocked_mask_altstack_resets 2>&1 | tail -5`
Expected: FAIL — `no field blocked_signals on ThreadRecord`.

- [ ] **Step 3: Add `SigAltStack` and `ThreadRecord` fields + single constructor**

In `packages/kernel-wasm/src/kernel.rs`, immediately before `pub struct ThreadRecord {`:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SigAltStack {
    pub sp: u32,
    pub flags: i32,
    pub size: u32,
}

pub const SS_ONSTACK: i32 = 1;
pub const SS_DISABLE: i32 = 2;

impl SigAltStack {
    pub const fn disabled() -> Self {
        Self { sp: 0, flags: SS_DISABLE, size: 0 }
    }
    pub fn is_disabled(&self) -> bool {
        self.flags & SS_DISABLE != 0 || self.size == 0
    }
}
```

Add two fields to `pub struct ThreadRecord` (after `cancel_requested: bool,`):

```rust
    /// Canonical `1<<(sig-1)` blocked mask (kernel-internal width).
    /// Inherited from the creating thread on spawn and from the
    /// forking main thread on `fork()`.
    pub blocked_signals: u64,
    /// Alternate signal stack bookkeeping. Round-trips only; the
    /// `SS_ONSTACK`/`EPERM` path is dormant until delivery (B1.8-b).
    pub sigaltstack: SigAltStack,
```

Replace the entire `impl ThreadRecord { fn main(...) {...} }` block with:

```rust
impl ThreadRecord {
    /// The single `ThreadRecord` constructor. Every record is built
    /// here so the mask-inheritance contract lives in one place.
    pub fn new(tid: Tid, host_thread_handle: Option<i32>, blocked_signals: u64) -> Self {
        Self {
            tid,
            state: ThreadState::Runnable,
            detached: false,
            exit_value: None,
            host_thread_handle,
            wait_reason: None,
            waiter_tid: None,
            cancel_requested: false,
            blocked_signals,
            sigaltstack: SigAltStack::disabled(),
        }
    }

    fn main(host_thread_handle: Option<i32>) -> Self {
        Self::new(MAIN_THREAD_TID, host_thread_handle, 0)
    }
}
```

- [ ] **Step 4: Route `bind_thread_handle` through the constructor with `creator_tid`**

In `packages/kernel-wasm/src/kernel.rs`, change `bind_thread_handle` signature and body:

```rust
    pub fn bind_thread_handle(
        &mut self,
        pid: Pid,
        tid: Tid,
        host_thread_handle: Option<i32>,
        creator_tid: Tid,
    ) -> Result<(), i32> {
        let p = self.processes.get_mut(&pid).ok_or(crate::abi::ESRCH)?;
        if p.threads.contains_key(&tid) {
            return Err(crate::abi::EEXIST);
        }
        // Inheritance chain: creator thread → main thread → empty.
        let inherited = p
            .threads
            .get(&creator_tid)
            .or_else(|| p.threads.get(&MAIN_THREAD_TID))
            .map(|t| t.blocked_signals)
            .unwrap_or(0);
        p.threads
            .insert(tid, ThreadRecord::new(tid, host_thread_handle, inherited));
        Ok(())
    }
```

- [ ] **Step 5: Update `spawn_thread` and all `bind_thread_handle` callers**

In `packages/kernel-wasm/src/kernel.rs`, `spawn_thread` body — change the bind call to pass the main thread as creator (bare host-export contract, §3.2):

```rust
    pub fn spawn_thread(&mut self, pid: Pid, host_thread_handle: Option<i32>) -> Option<Tid> {
        let tid = self.reserve_thread_id(pid).ok()?;
        self.bind_thread_handle(pid, tid, host_thread_handle, MAIN_THREAD_TID)
            .ok()?;
        Some(tid)
    }
```

In `packages/kernel-wasm/src/dispatch/thread.rs`, the `sys_thread_spawn` call to `bind_thread_handle` — pass `ctx.caller_tid`:

```rust
    match kernel::with_kernel(|k| {
        k.bind_thread_handle(ctx.caller_pid, tid, Some(host_thread_handle), ctx.caller_tid)
    }) {
```

Run: `grep -rn "bind_thread_handle(" packages/kernel-wasm/src | grep -v "fn bind_thread_handle"`
For every remaining caller, add a final `MAIN_THREAD_TID` argument (test helpers) or the correct creator tid. Expected after edits: all call sites have 4 args.

- [ ] **Step 6: Fork inherits the forking (main) thread's mask**

In `packages/kernel-wasm/src/kernel.rs` `prepare_fork`, capture the parent main mask **before** `child.threads.clear()` and apply it after the main `ThreadRecord` is inserted. Replace the existing `child.threads.clear(); child.threads.insert(MAIN_THREAD_TID, ThreadRecord::main(None));` lines with:

```rust
        let parent_main_mask = parent
            .threads
            .get(&MAIN_THREAD_TID)
            .map(|t| t.blocked_signals)
            .unwrap_or(0);
        child.threads.clear();
        child.threads.insert(
            MAIN_THREAD_TID,
            ThreadRecord::new(MAIN_THREAD_TID, None, parent_main_mask),
        );
```

(`parent` is the immutable borrow at the top of `prepare_fork`; read `parent_main_mask` before `let mut child = parent.clone();` if the borrow checker requires — move the `let parent_main_mask = …` line up to just after the `parent.threads.len() > 1` guard.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test -p kernel-wasm thread_spawn_inherits_creator_blocked_mask_altstack_resets fork_child_main_inherits_forking_main_mask_pending_empty 2>&1 | tail -8`
Expected: both PASS.

Run: `cargo test -p kernel-wasm 2>&1 | tail -5`
Expected: full suite green (no regression from the signature/constructor change).

- [ ] **Step 8: Commit**

```bash
git add packages/kernel-wasm/src/kernel.rs packages/kernel-wasm/src/dispatch/thread.rs packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "feat(kernel): per-thread blocked_signals + sigaltstack, single ctor, spawn/fork inheritance (#90)
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: compact-slot ⇄ canonical `sig-1` remap (safe Rust)

**Files:**
- Create: `packages/kernel-wasm/src/dispatch/sigmask.rs`
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs` (add `mod sigmask;`)
- Test: same file (`#[cfg(test)]`)

- [ ] **Step 1: Write the failing test**

Create `packages/kernel-wasm/src/dispatch/sigmask.rs`:

```rust
//! Guest 1-byte compact `sigset_t` ⇄ canonical `1<<(sig-1)` u64 remap.
//! The wire carries the guest byte verbatim (thin C); this is the only
//! place the slot table lives (spec §3.1). Slot map (yurt_signal.c
//! `yurt_signal_compact_slot`): SIGHUP1→0 SIGINT2→1 SIGQUIT3→2
//! SIGTERM15→3 SIGCHLD17→4 SIGWINCH28→5 SIGPIPE13→6
//! SIGUSR1/USR2/ALRM(10,12,14)→7.

/// (compact_slot, &[signo...]) — slot 7 aliases three signals.
const SLOTS: &[(u8, &[u32])] = &[
    (0, &[1]), (1, &[2]), (2, &[3]), (3, &[15]),
    (4, &[17]), (5, &[28]), (6, &[13]), (7, &[10, 12, 14]),
];

/// Guest compact byte → canonical `1<<(sig-1)` u64.
pub fn expand(compact: u8) -> u64 {
    let mut out = 0u64;
    for &(slot, signos) in SLOTS {
        if compact & (1 << slot) != 0 {
            for &s in signos {
                out |= 1u64 << (s - 1);
            }
        }
    }
    out
}

/// Canonical u64 → guest compact byte (any aliased signo ⇒ slot 7).
pub fn narrow(canonical: u64) -> u8 {
    let mut out = 0u8;
    for &(slot, signos) in SLOTS {
        if signos.iter().any(|&s| canonical & (1u64 << (s - 1)) != 0) {
            out |= 1 << slot;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sigusr1_roundtrips_through_slot7_with_documented_aliasing() {
        let c = narrow(1u64 << (10 - 1)); // SIGUSR1
        assert_eq!(c, 1 << 7, "SIGUSR1 → slot 7");
        let e = expand(c);
        // slot-7 aliasing: expanding slot 7 yields USR1|USR2|ALRM
        assert_eq!(e, (1u64<<9)|(1u64<<11)|(1u64<<13));
    }
    #[test]
    fn sigint_exact_roundtrip() {
        let c = narrow(1u64 << (2 - 1)); // SIGINT
        assert_eq!(c, 1 << 1);
        assert_eq!(expand(c), 1u64 << 1);
    }
}
```

- [ ] **Step 2: Wire the module and run the test (expect fail → pass)**

Add to `packages/kernel-wasm/src/dispatch/mod.rs` near the other `mod` lines:

```rust
mod sigmask;
```

Run: `cargo test -p kernel-wasm sigmask:: 2>&1 | tail -6`
Expected: `sigint_exact_roundtrip` and `sigusr1_roundtrips_through_slot7_with_documented_aliasing` PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/sigmask.rs packages/kernel-wasm/src/dispatch/mod.rs
git commit -m "feat(dispatch): compact-slot<->sig-1 sigset_t remap, safe Rust (#90)
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `sys_sigprocmask` handler

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch/sigmask.rs` (add handler)
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs` (dispatch arm)
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`

- [ ] **Step 1: Write the failing test**

Append to `packages/kernel-wasm/src/dispatch/tests.rs`:

```rust
fn sigprocmask_req(how: i32, set: Option<u8>) -> Vec<u8> {
    let mut r = how.to_le_bytes().to_vec();
    match set { Some(s) => { r.push(1); r.push(s); } None => { r.push(0); r.push(0); } }
    r
}

#[test]
fn sigprocmask_block_setmask_oset_and_kill_unmaskable() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut out = [0u8; 1];
    // SETMASK to SIGINT (slot 1) → prior was empty (0)
    assert_eq!(dispatch(METHOD_SYS_SIGPROCMASK, 1, &sigprocmask_req(2, Some(1<<1)), &mut out), 1);
    assert_eq!(out[0], 0);
    // BLOCK SIGUSR1 (slot 7) → prior oset is the SIGINT byte (1<<1)
    assert_eq!(dispatch(METHOD_SYS_SIGPROCMASK, 1, &sigprocmask_req(0, Some(1<<7)), &mut out), 1);
    assert_eq!(out[0], 1<<1);
    // kernel mask has canonical SIGINT bit + slot-7 expansion; SIGKILL/STOP never settable
    let m = crate::kernel::with_kernel(|k|
        k.process_mut(1).threads[&crate::kernel::MAIN_THREAD_TID].blocked_signals);
    assert_ne!(m & (1u64<<(2-1)), 0, "SIGINT blocked");
    assert_eq!(m & (1u64<<(9-1)), 0, "SIGKILL never maskable");
    // bad how → EINVAL
    assert_eq!(dispatch(METHOD_SYS_SIGPROCMASK, 1, &sigprocmask_req(9, Some(0)), &mut out),
               -(crate::abi::EINVAL as i64));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kernel-wasm sigprocmask_block_setmask_oset_and_kill_unmaskable 2>&1 | tail -5`
Expected: FAIL — `METHOD_SYS_SIGPROCMASK` arm unhandled (returns `-ENOSYS`/default).

- [ ] **Step 3: Implement the handler**

Append to `packages/kernel-wasm/src/dispatch/sigmask.rs`:

```rust
use crate::abi;
use crate::dispatch::DispatchContext;
use crate::kernel::with_kernel;

const SIG_BLOCK: i32 = 0;
const SIG_UNBLOCK: i32 = 1;
const SIG_SETMASK: i32 = 2;
/// SIGKILL=9, SIGSTOP=19 — never maskable (Linux).
const UNMASKABLE: u64 = (1u64 << (9 - 1)) | (1u64 << (19 - 1));

pub(super) fn sys_sigprocmask(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() != 6 || response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let how = i32::from_le_bytes(request[0..4].try_into().expect("4"));
    let has_set = request[4] != 0;
    let set = expand(request[5]);
    with_kernel(|k| {
        let Some(p) = k.process_existing_mut(ctx.caller_pid) else {
            return -(abi::ESRCH as i64);
        };
        let Some(t) = p.threads.get_mut(&ctx.caller_tid) else {
            return -(abi::ESRCH as i64);
        };
        response[0] = narrow(t.blocked_signals);
        if has_set {
            let next = match how {
                SIG_BLOCK => t.blocked_signals | set,
                SIG_UNBLOCK => t.blocked_signals & !set,
                SIG_SETMASK => set,
                _ => return -(abi::EINVAL as i64),
            };
            t.blocked_signals = next & !UNMASKABLE;
        }
        1
    })
}
```

- [ ] **Step 4: Add the dispatch arm**

In `packages/kernel-wasm/src/dispatch/mod.rs`, in the `match method_id` next to the other signal arms (~`:192`):

```rust
        METHOD_SYS_SIGPROCMASK => sigmask::sys_sigprocmask(ctx, request, response),
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cargo test -p kernel-wasm sigprocmask_block_setmask_oset_and_kill_unmaskable 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/sigmask.rs packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "feat(dispatch): sys_sigprocmask per-thread mask handler (#90)
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `sys_sigaltstack` handler

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch/sigmask.rs`
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`

- [ ] **Step 1: Write the failing test**

Append to `tests.rs`:

```rust
fn sigaltstack_req(ss: Option<(u32,i32,u32)>) -> Vec<u8> {
    let mut r = Vec::new();
    match ss {
        Some((sp,fl,sz)) => { r.push(1); r.extend_from_slice(&sp.to_le_bytes());
            r.extend_from_slice(&fl.to_le_bytes()); r.extend_from_slice(&sz.to_le_bytes()); }
        None => { r.push(0); r.extend_from_slice(&[0u8;12]); }
    }
    r
}

#[test]
fn sigaltstack_roundtrip_and_undersized_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut out = [0u8; 12];
    // install a valid stack (size >= MINSIGSTKSZ=2048), prior was disabled
    assert_eq!(dispatch(METHOD_SYS_SIGALTSTACK, 1, &sigaltstack_req(Some((0x1000, 0, 4096))), &mut out), 0);
    // query (has_ss=0) returns what we set
    assert_eq!(dispatch(METHOD_SYS_SIGALTSTACK, 1, &sigaltstack_req(None), &mut out), 0);
    assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 0x1000);
    assert_eq!(u32::from_le_bytes(out[8..12].try_into().unwrap()), 4096);
    // undersized & not SS_DISABLE → EINVAL
    assert_eq!(dispatch(METHOD_SYS_SIGALTSTACK, 1, &sigaltstack_req(Some((0x2000, 0, 16))), &mut out),
               -(crate::abi::EINVAL as i64));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kernel-wasm sigaltstack_roundtrip_and_undersized_einval 2>&1 | tail -5`
Expected: FAIL — arm unhandled.

- [ ] **Step 3: Implement the handler**

Append to `sigmask.rs`:

```rust
use crate::kernel::{SigAltStack, SS_DISABLE};

const MINSIGSTKSZ: u32 = 2048;

pub(super) fn sys_sigaltstack(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() != 13 || response.len() < 12 {
        return -(abi::EINVAL as i64);
    }
    let has_ss = request[0] != 0;
    let sp = u32::from_le_bytes(request[1..5].try_into().expect("4"));
    let flags = i32::from_le_bytes(request[5..9].try_into().expect("4"));
    let size = u32::from_le_bytes(request[9..13].try_into().expect("4"));
    with_kernel(|k| {
        let Some(p) = k.process_existing_mut(ctx.caller_pid) else {
            return -(abi::ESRCH as i64);
        };
        let Some(t) = p.threads.get_mut(&ctx.caller_tid) else {
            return -(abi::ESRCH as i64);
        };
        let prev = t.sigaltstack;
        response[0..4].copy_from_slice(&prev.sp.to_le_bytes());
        response[4..8].copy_from_slice(&prev.flags.to_le_bytes());
        response[8..12].copy_from_slice(&prev.size.to_le_bytes());
        if has_ss {
            if flags & SS_DISABLE != 0 {
                t.sigaltstack = SigAltStack::disabled();
            } else if size < MINSIGSTKSZ {
                return -(abi::EINVAL as i64);
            } else {
                t.sigaltstack = SigAltStack { sp, flags, size };
            }
        }
        0
    })
}
```

- [ ] **Step 4: Dispatch arm**

`packages/kernel-wasm/src/dispatch/mod.rs`:

```rust
        METHOD_SYS_SIGALTSTACK => sigmask::sys_sigaltstack(ctx, request, response),
```

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p kernel-wasm sigaltstack_roundtrip_and_undersized_einval 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/sigmask.rs packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "feat(dispatch): sys_sigaltstack round-trip bookkeeping (#90)
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `sys_sigsuspend` handler (`has_mask`)

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch/sigmask.rs`
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`

- [ ] **Step 1: Write the failing test**

Append to `tests.rs`:

```rust
#[test]
fn sigsuspend_swaps_and_restores_returns_eintr_pause_leaves_mask() {
    let _g = crate::kernel::TestGuard::acquire();
    // set a known mask first
    let mut o = [0u8;1];
    dispatch(METHOD_SYS_SIGPROCMASK, 1, &sigprocmask_req(2, Some(1<<1)), &mut o);
    // sigsuspend(has_mask=1, mask=slot7) → -EINTR, prior mask restored
    let req = vec![1u8, 1<<7];
    assert_eq!(dispatch(METHOD_SYS_SIGSUSPEND, 1, &req, &mut []), -(crate::abi::EINTR as i64));
    let m = crate::kernel::with_kernel(|k|
        k.process_mut(1).threads[&crate::kernel::MAIN_THREAD_TID].blocked_signals);
    assert_ne!(m & (1u64<<(2-1)), 0, "prior SIGINT mask restored after sigsuspend");
    // pause path: has_mask=0 leaves mask unchanged, still -EINTR
    let req0 = vec![0u8, 0u8];
    assert_eq!(dispatch(METHOD_SYS_SIGSUSPEND, 1, &req0, &mut []), -(crate::abi::EINTR as i64));
    let m2 = crate::kernel::with_kernel(|k|
        k.process_mut(1).threads[&crate::kernel::MAIN_THREAD_TID].blocked_signals);
    assert_eq!(m, m2, "pause (has_mask=0) leaves caller mask unchanged");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kernel-wasm sigsuspend_swaps_and_restores_returns_eintr_pause_leaves_mask 2>&1 | tail -5`
Expected: FAIL — arm unhandled.

- [ ] **Step 3: Implement the handler**

Append to `sigmask.rs`:

```rust
pub(super) fn sys_sigsuspend(ctx: DispatchContext, request: &[u8], _response: &mut [u8]) -> i64 {
    if request.len() != 2 {
        return -(abi::EINVAL as i64);
    }
    let has_mask = request[0] != 0;
    let mask = expand(request[1]) & !UNMASKABLE;
    with_kernel(|k| {
        let Some(p) = k.process_existing_mut(ctx.caller_pid) else {
            return -(abi::ESRCH as i64);
        };
        let Some(t) = p.threads.get_mut(&ctx.caller_tid) else {
            return -(abi::ESRCH as i64);
        };
        let prior = t.blocked_signals;
        if has_mask {
            t.blocked_signals = mask;
        }
        // Non-blocking pending check is a structural placeholder — no
        // observable effect until delivery (B1.8-b). Restore + EINTR
        // (true blocking AsyncBridge/B1.5-gated). spec §5/§11.4.
        t.blocked_signals = prior;
        -(abi::EINTR as i64)
    })
}
```

- [ ] **Step 4: Dispatch arm**

`mod.rs`:

```rust
        METHOD_SYS_SIGSUSPEND => sigmask::sys_sigsuspend(ctx, request, response),
```

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p kernel-wasm sigsuspend_swaps_and_restores_returns_eintr_pause_leaves_mask 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/sigmask.rs packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "feat(dispatch): sys_sigsuspend has_mask install/restore, EINTR stub (#90)
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `sys_sigtimedwait` handler (reuse RT dequeue, select by `set`)

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch/sigmask.rs`
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`

- [ ] **Step 1: Write the failing test**

Append to `tests.rs` (`sigqueue_req` helper already exists in tests.rs from prior signal tests; if not, build the 12-byte `target|sig|value` request inline):

```rust
#[test]
fn sigtimedwait_selects_by_set_even_when_blocked_else_eagain() {
    let _g = crate::kernel::TestGuard::acquire();
    // block SIGUSR1 then queue an RT SIGUSR1 (signo 10)
    let mut o=[0u8;1];
    dispatch(METHOD_SYS_SIGPROCMASK, 1, &sigprocmask_req(0, Some(1<<7)), &mut o);
    let mut sq = 1u32.to_le_bytes().to_vec(); // target pid 1
    sq.extend_from_slice(&10u32.to_le_bytes()); // SIGUSR1
    sq.extend_from_slice(&42i32.to_le_bytes()); // value
    assert_eq!(dispatch(METHOD_SYS_SIGQUEUE, 1, &sq, &mut []), 0);
    // sigtimedwait(set=slot7, has_timeout=1, {0,0}) → accepts SIGUSR1 despite block
    let mut req = vec![1u8<<7, 1u8];
    req.extend_from_slice(&0i64.to_le_bytes());
    req.extend_from_slice(&0i64.to_le_bytes());
    let mut info = [0u8;16];
    assert_eq!(dispatch(METHOD_SYS_SIGTIMEDWAIT, 1, &req, &mut info), 16);
    assert_eq!(i32::from_le_bytes(info[0..4].try_into().unwrap()), 10);
    // nothing pending now → EAGAIN
    assert_eq!(dispatch(METHOD_SYS_SIGTIMEDWAIT, 1, &req, &mut info),
               -(crate::abi::EAGAIN as i64));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kernel-wasm sigtimedwait_selects_by_set_even_when_blocked_else_eagain 2>&1 | tail -5`
Expected: FAIL — arm unhandled.

- [ ] **Step 3: Implement the handler**

Append to `sigmask.rs`:

```rust
/// `sigtimedwait` — reuse the RT-queue dequeue (separated-producer:
/// RT queue only, never the kill bitmask — documented divergence
/// §11.6). Selection is by `set` regardless of blocked state (§5.1).
/// `timeout==0`/nothing pending ⇒ EAGAIN; nonzero-timeout blocking is
/// the gated stub (also immediate EAGAIN).
pub(super) fn sys_sigtimedwait(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() != 18 || response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    let set = expand(request[0]);
    with_kernel(|k| {
        let Some(p) = k.process_existing_mut(ctx.caller_pid) else {
            return -(abi::ESRCH as i64);
        };
        let Some(idx) = p
            .pending_rt
            .iter()
            .position(|s| (1..=63).contains(&s.signo) && (set & (1u64 << (s.signo - 1))) != 0)
        else {
            return -(abi::EAGAIN as i64);
        };
        let sig = p.pending_rt.remove(idx).expect("idx from position");
        const SI_QUEUE: i32 = -1;
        response[0..4].copy_from_slice(&(sig.signo as i32).to_le_bytes());
        response[4..8].copy_from_slice(&SI_QUEUE.to_le_bytes());
        response[8..12].copy_from_slice(&sig.sender_pid.to_le_bytes());
        response[12..16].copy_from_slice(&sig.value.to_le_bytes());
        16
    })
}
```

- [ ] **Step 4: Dispatch arm**

`mod.rs`:

```rust
        METHOD_SYS_SIGTIMEDWAIT => sigmask::sys_sigtimedwait(ctx, request, response),
```

- [ ] **Step 5: Run to verify pass + full gate**

Run: `cargo test -p kernel-wasm sigtimedwait_selects_by_set_even_when_blocked_else_eagain 2>&1 | tail -5`
Expected: PASS.

Run: `cargo test -p kernel-wasm 2>&1 | tail -3 && cargo fmt --all && cargo clippy -p kernel-wasm --all-targets -- -D warnings 2>&1 | tail -3`
Expected: full suite green; clippy clean.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/sigmask.rs packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "feat(dispatch): sys_sigtimedwait, select-by-set RT dequeue (#90)
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: thin C shims + headers + host-import registration

**Files:**
- Modify: `abi/include/signal.h`
- Modify: `abi/src/yurt_signal.c`
- Modify: `abi/src/yurt_runtime.h`
- Modify: host-interface import table (located in Step 1)

- [ ] **Step 1: Locate the host-import → METHOD registration**

Run: `grep -rn "host_kill\|METHOD_SYS_KILL\|host_sigaction\|\"host_" packages/*/src/*.rs runtime-wasmtime/src/*.rs 2>/dev/null | grep -i "kill\|sigaction" | head`
This finds where guest wasm imports like `host_kill` are bound to `METHOD_SYS_*` and routed through `dispatch_with_context`. Record the file + the pattern (one line per method). The four new imports (`host_sigprocmask`, `host_sigaltstack`, `host_sigsuspend`, `host_sigtimedwait`) are added there exactly mirroring the `host_kill`→`METHOD_SYS_KILL` line, passing the per-thread `DispatchContext` (the thread-aware path already used by `host`-thread imports).

- [ ] **Step 2: Add the header surface to `signal.h`**

In `abi/include/signal.h`, after the `siginfo_t` typedef block, add:

```c
#ifndef __DEFINED_stack_t
#define __DEFINED_stack_t
typedef struct { void *ss_sp; int ss_flags; size_t ss_size; } stack_t;
#endif
#ifndef SS_ONSTACK
#define SS_ONSTACK 1
#endif
#ifndef SS_DISABLE
#define SS_DISABLE 2
#endif
#ifndef MINSIGSTKSZ
#define MINSIGSTKSZ 2048
#endif
#ifndef SIGSTKSZ
#define SIGSTKSZ 8192
#endif
int sigaltstack(const stack_t *restrict ss, stack_t *restrict oss);
_Static_assert(MINSIGSTKSZ == 2048 && SIGSTKSZ == 8192,
               "sigaltstack constants must match the libc-port (#90 spec §6)");
```

- [ ] **Step 3: Add the four host imports to `yurt_runtime.h`**

In `abi/src/yurt_runtime.h`, alongside the existing `yurt_host_kill` import:

```c
__attribute__((import_module("yurt"), import_name("host_sigprocmask")))
int yurt_host_sigprocmask(int req_ptr, int req_len, int resp_ptr, int resp_len);
__attribute__((import_module("yurt"), import_name("host_sigaltstack")))
int yurt_host_sigaltstack(int req_ptr, int req_len, int resp_ptr, int resp_len);
__attribute__((import_module("yurt"), import_name("host_sigsuspend")))
int yurt_host_sigsuspend(int req_ptr, int req_len);
__attribute__((import_module("yurt"), import_name("host_sigtimedwait")))
int yurt_host_sigtimedwait(int req_ptr, int req_len, int resp_ptr, int resp_len);
```

(Match the exact argument-passing convention of the neighbouring imports — `host_poll` uses `(ptr,len,timeout)`; use the request/response-buffer convention the dispatch layer expects for typed-binary methods, as the other `METHOD_SYS_*`-backed imports do. Confirm against the `host_kill` import’s signature found in Step 1.)

- [ ] **Step 4: Rewrite the mask shims thin + add `sigaltstack` + fix the marker bug**

In `abi/src/yurt_signal.c`:
- Replace the bodies of `sigprocmask`, `sigsuspend`, `sigtimedwait` so they **marshal the guest's 1-byte `*set`/`*mask`/`*oldset` verbatim** into the typed request record and call the corresponding `yurt_host_*`; no `yurt_signal_mask` arithmetic. `pthread_sigmask` stays `return sigprocmask(...)`. `pause()` becomes:

```c
int pause(void) {
  YURT_MARKER_CALL(pause);
  unsigned char req[2] = {0, 0}; /* has_mask=0 */
  int rc = yurt_host_sigsuspend((int)(intptr_t)req, 2);
  errno = -rc;            /* kernel returns -EINTR */
  return -1;
}
```

- `sigprocmask` (illustrative shape; `has_set`/`set` are single bytes):

```c
int sigprocmask(int how, const sigset_t *restrict set, sigset_t *restrict oldset) {
  YURT_MARKER_CALL(sigprocmask);
  unsigned char req[6];
  *(int *)req = how;
  req[4] = set ? 1 : 0;
  req[5] = set ? (unsigned char)*set : 0;
  unsigned char resp[1] = {0};
  int rc = yurt_host_sigprocmask((int)(intptr_t)req, 6, (int)(intptr_t)resp, 1);
  if (rc < 0) { errno = -rc; return -1; }
  if (oldset) *oldset = (sigset_t)resp[0];
  return 0;
}
```

- Add the new `sigaltstack` shim with its own marker:

```c
YURT_DECLARE_MARKER(sigaltstack);
YURT_DEFINE_MARKER(sigaltstack, 0x73616c74u) /* "salt" */
int sigaltstack(const stack_t *restrict ss, stack_t *restrict oss) {
  YURT_MARKER_CALL(sigaltstack);
  unsigned char req[13];
  req[0] = ss ? 1 : 0;
  unsigned sp = ss ? (unsigned)(uintptr_t)ss->ss_sp : 0;
  int fl = ss ? ss->ss_flags : 0;
  unsigned sz = ss ? (unsigned)ss->ss_size : 0;
  *(unsigned *)(req+1) = sp; *(int *)(req+5) = fl; *(unsigned *)(req+9) = sz;
  unsigned char resp[12] = {0};
  int rc = yurt_host_sigaltstack((int)(intptr_t)req, 13, (int)(intptr_t)resp, 12);
  if (rc < 0) { errno = -rc; return -1; }
  if (oss) { oss->ss_sp = (void *)(uintptr_t)*(unsigned *)resp;
             oss->ss_flags = *(int *)(resp+4);
             oss->ss_size = *(unsigned *)(resp+8); }
  return 0;
}
```

- Fix the copy-paste bug at the old `sigtimedwait`: it currently calls `YURT_MARKER_CALL(sigsuspend)` — change to `YURT_MARKER_CALL(sigtimedwait)` (declare/define a `sigtimedwait` marker if absent).
- Delete the now-dead `static yurt_signal_mask` / `yurt_pending_signal_mask` / `yurt_signal_deliver_pending` mask machinery only where it is no longer referenced (leave `sigemptyset/fillset/addset/delset/ismember` and `yurt_signal_compact_slot` untouched — spec §3.3).

- [ ] **Step 5: Build the ABI objects**

Run: `make -C abi 2>&1 | tail -8`
Expected: `yurt_signal.o` (incl. new `sigaltstack`) compiles; `_Static_assert`s pass; no warnings.

- [ ] **Step 6: Commit**

```bash
git add abi/include/signal.h abi/src/yurt_signal.c abi/src/yurt_runtime.h <host-interface-file-from-step-1>
git commit -m "feat(abi): thin signal-mask shims + sigaltstack + host imports (#90)
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: conformance, parity matrix, partition comment, final gate

**Files:**
- Modify: `abi/contract/yurt_abi_methods.toml` (partition comment ~`:571-579`)
- Modify: `abi/conformance/sigprocmask.spec.toml`, `sigsuspend.spec.toml`; create `sigaltstack.spec.toml`, `pthread_sigmask.spec.toml`, `sigtimedwait.spec.toml`
- Modify: `scripts/open-posix-harness.ts`
- Modify: `docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md`

- [ ] **Step 1: Fix the partition comment + add the sweep block**

In `abi/contract/yurt_abi_methods.toml`, edit the comment block (~`:578-579`):

```toml
# Future slices take the next free block. The umbrella matrix (#57;
# tracking #52 — #51 was reverted by #56) mirrors this table as the
# canonical record.
#   signal-mask  #90      → 0x1_00A0–0x1_00A3  (0x1_00A0 sweep, #83)
```

- [ ] **Step 2: Rewrite stale conformance specs (not extend)**

Rewrite `abi/conformance/sigprocmask.spec.toml` — replace the stale `note = "guest-local mask only; no observation of external signals"` and summary with kernel-owned wording:

```toml
canary = "signal-canary"
summary = "Kernel-owned per-thread signal mask round-trip (§Runtime Semantics > Signals)."

[[case]]
name = "sigprocmask_roundtrip"
inputs = "SIG_SETMASK(SIGINT) then SIG_SETMASK(NULL,&old)"
expected.exit = 0
expected.stdout = "sigprocmask:roundtrip"
expected.note = "kernel-owned per-calling-thread mask; SIGKILL/SIGSTOP unmaskable"
```

Apply the same de-stale pass to `sigsuspend.spec.toml`, and create `pthread_sigmask.spec.toml`, `sigaltstack.spec.toml`, `sigtimedwait.spec.toml` following the same schema (`canary`, `summary`, one `[[case]]`).

- [ ] **Step 3: Wire the 5 Open POSIX interface dirs**

In `scripts/open-posix-harness.ts`, add `sigprocmask`, `pthread_sigmask`, `sigaltstack`, `sigsuspend`, `sigtimedwait` to the curated `--cases` list (new wiring, not extensions of the legacy `signal` canary).

Run: `deno run -A scripts/open-posix-harness.ts --cases sigprocmask,pthread_sigmask,sigaltstack,sigsuspend,sigtimedwait 2>&1 | tail -15`
Expected: the five interface dirs execute; record PASS/known-divergence per the spec §11 list (slot-7 aliasing, RT-only `sigtimedwait`, `EINTR` stub). Any divergence must map to a documented §11 item, not a silent failure.

- [ ] **Step 4: Add the parity-matrix row**

In `docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md`, add a row mirroring the `host_kill` row format:

```
| process | signal-mask: sigprocmask/pthread_sigmask/sigaltstack/sigsuspend/sigtimedwait | METHOD_SYS_SIGPROCMASK, METHOD_SYS_SIGALTSTACK, METHOD_SYS_SIGSUSPEND, METHOD_SYS_SIGTIMEDWAIT | kernel-wasm per-thread mask state | all KH adapters | partial (blocking AsyncBridge/B1.5-gated; divergences spec §11) | sigmask dispatch tests, open-posix sig* dirs |
```

- [ ] **Step 5: Full gate**

Run: `cargo test -p kernel-wasm 2>&1 | tail -3`
Expected: full suite green.

Run: `cargo fmt --all && cargo clippy -p kernel-wasm --all-targets -- -D warnings 2>&1 | tail -3`
Expected: clean.

Run: `make -C abi 2>&1 | tail -3`
Expected: ABI builds clean.

- [ ] **Step 6: Commit**

```bash
git add abi/contract/yurt_abi_methods.toml abi/conformance/ scripts/open-posix-harness.ts docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md
git commit -m "test(conformance): wire 5 sig* Open POSIX dirs, matrix row, partition fix (#90)
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** §3.1 remap → Task 3; §3.2 per-thread/single-ctor/spawn+fork inheritance → Task 2; §3.3 touched/untouched → Task 8 Step 4 (helpers untouched); §4 ABI ids/fixed-length → Task 1 + handler `len != N` guards (Tasks 4–7); §5 four handlers incl. `has_mask` → Tasks 4–7; §5.1 select-by-`set` → Task 7; §6 headers/thin shims/marker-bug/new `sigaltstack` symbol → Task 8; §7 errnos (`EINTR=4`) → Task 1; §8 dispatch tests + conformance + matrix → Tasks 2–9; §9/§11 divergences → carried as code comments + Task 9 matrix note + conformance divergence mapping. No spec section unmapped.

**Placeholder scan:** Task 8 Step 1/3 require locating the host-import registration (an existing mechanical pattern not in the spec's surface) — given as a concrete grep + mirror instruction with the exact lines to add, not a vague TODO. All Rust code is complete and exact.

**Type consistency:** `ThreadRecord::new(tid, host_handle, blocked_signals)`, `SigAltStack { sp:u32, flags:i32, size:u32 }`, `bind_thread_handle(pid,tid,handle,creator_tid)`, `expand(u8)->u64`/`narrow(u64)->u8`, handler sig `(ctx: DispatchContext, request, response) -> i64`, request lengths (6/13/2/18) consistent across handler bodies, tests, and ABI doc strings.
