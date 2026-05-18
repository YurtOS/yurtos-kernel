//! Trap-child fixture for the P2-2 cross-host bug.
//!
//! This child takes a GENUINE wasm trap (the `unreachable` opcode)
//! BEFORE it ever reaches `proc_exit` — it never calls
//! `proc_exit`/`std::process::exit` at all, and it does NOT panic
//! (the wasi panic path would `fd_write` + `proc_exit`, which the WASI
//! shim turns into a `last_exit`-setting trap — that would be
//! misclassified as a `proc_exit`, not a genuine trap). It emits the
//! raw wasm `unreachable` instruction directly, so:
//!
//!   * Rust: `child.run_start()` returns `Err` and `last_exit()` is
//!     `None` — the "genuine trap" arm of the host's three-way split.
//!     Pre-fix `last_exit().unwrap_or(0)` recorded this as exit 0 (a
//!     false success); the fix maps it to `CHILD_TRAP_EXIT = 134`.
//!   * JS: `runCachedChild`'s `catch` saw a non-`proc_exit` message and
//!     re-threw, unwinding out through the parent's `host_wait` import
//!     and crashing the *parent*; the fix returns 134 instead.
//!
//! Uses a normal `fn main()` (the wasi-libc `crt1-command.o` provides
//! `_start`, so defining our own would be a duplicate-symbol link
//! error — same `std` entry shape as `spawn-deep`).

fn main() {
    // A genuine wasm `unreachable` trap. NOT a `proc_exit` and NOT a
    // panic: nothing on this path sets `last_exit`, so `run_start()` is
    // `Err` while `last_exit()` stays `None` — precisely the arm the
    // host must reap as CHILD_TRAP_EXIT (134).
    core::arch::wasm32::unreachable()
}
