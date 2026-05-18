//! Task 0 characterization fixture: snapshot-vs-rebuild probe for the
//! `yurt.host_fork` continuation contract.
//!
//! This is the Rust analogue of `abi/conformance/c/fork-canary.c`'s
//! `expect_continuation_split` case, reduced to the single observable
//! that distinguishes a TRUE continuation snapshot from a REBUILD:
//!
//!   1. Write a non-default sentinel (`0x2A == 42`) into a `static mut`
//!      BEFORE calling `host_fork`. (Its zero-init default is `0`; the
//!      pre-fork program path sets it to `42`.)
//!   2. Call `yurt.host_fork()` — the raw guest import (module "yurt",
//!      name "host_fork", `() -> i32`), declared exactly as
//!      `abi/src/yurt_runtime.h:137` / `abi/src/yurt_fork.c` do.
//!   3. Print, on a single deterministic host-invariant line, the
//!      branch taken, the raw `host_fork()` return value, and the
//!      observed sentinel.
//!
//! Interpreting the captured stdout:
//!
//! * **TRUE snapshot** (correct `fork()`): `host_fork()` returns twice.
//!   The parent observes `rc = <child_pid> (>0)`. The child resumes
//!   *at the fork() call site* with `rc = 0`, and — because a real fork
//!   gives the child the parent's post-`SENTINEL=42` memory image — the
//!   child sees `sentinel = 42`. Two lines, one `rc>0 sentinel=42`
//!   (parent) and one `rc=0 sentinel=42` (child).
//!
//! * **REBUILD** (semantically wrong): the host builds a fresh child
//!   instance and force-returns 0 from *its* `host_fork`. The child does
//!   NOT resume at the call site — it re-enters from the module entry.
//!   With the current `runtime-wasmtime` host the child instance is
//!   driven via `call_run()` (an exported `run`), which a standard
//!   wasm32-wasip1 binary does not export, so the child never runs at
//!   all; only the parent line is observed (`rc>0`). Either way the
//!   absence of a `rc=0` child line proves "not a continuation".
//!
//! * **-ENOSYS stub**: `host_fork()` returns `-38`. One line,
//!   `rc=-38`, no fork happened.
//!
//! The fixture itself asserts nothing — the `fixture_parity` test
//! (`fork_twice_characterizes_current_host_fork`) owns the assertion on
//! the *current* observed behavior and is marked as characterizing.

use std::io::Write;

#[link(wasm_import_module = "yurt")]
extern "C" {
    fn host_fork() -> i32;
}

// Asyncify save-state buffer.  Exported by address so the runtime can
// locate it post-instantiation without needing malloc.  Mirrors the
// same buffer that `abi/src/yurt_setjmp.c` exports for C-compiled
// binaries; required by T1.5+ asyncify bridge initialisation.
const YURT_ASYNCIFY_BUF_SIZE: usize = 65536;

#[repr(align(16))]
struct AlignedBuf([u8; YURT_ASYNCIFY_BUF_SIZE]);

static mut ASYNCIFY_BUF: AlignedBuf = AlignedBuf([0u8; YURT_ASYNCIFY_BUF_SIZE]);

#[export_name = "yurt_asyncify_buf_addr"]
pub unsafe extern "C" fn yurt_asyncify_buf_addr() -> *mut u8 {
    std::ptr::addr_of_mut!(ASYNCIFY_BUF.0) as *mut u8
}

#[export_name = "yurt_asyncify_buf_size"]
pub extern "C" fn yurt_asyncify_buf_size() -> i32 {
    YURT_ASYNCIFY_BUF_SIZE as i32
}

// Zero-initialized by definition (wasm .bss). The pre-fork path sets
// it to 42; a child that genuinely resumed from the parent's snapshot
// at the fork() site sees 42, a freshly-rebuilt child sees 0.
static mut FORK_SENTINEL: i32 = 0;

fn main() {
    // SAFETY: single-threaded fixture; this static is touched only
    // here, before and after the (non-threaded) fork point.
    unsafe {
        FORK_SENTINEL = 42;
    }

    let rc = unsafe { host_fork() };
    let sentinel = unsafe { FORK_SENTINEL };

    let branch = if rc < 0 {
        "errno"
    } else if rc == 0 {
        "child"
    } else {
        "parent"
    };

    // One deterministic, host-invariant line. No pid (pid values are
    // host/kernel allocation-order dependent and would break the
    // byte-identical cross-host oracle); the sentinel + rc sign is the
    // load-bearing snapshot-vs-rebuild signal, exactly as
    // `fork-canary.c` uses `fork_memory_probe`.
    let line = format!("fork-twice {branch} rc={rc} sentinel={sentinel}\n");
    std::io::stdout().write_all(line.as_bytes()).unwrap();
    std::io::stdout().flush().unwrap();

    // Child (rc == 0) exits 7 like fork-canary's continuation-split
    // child; parent exits 0. An errno return exits abs(errno) so the
    // host can observe it as the process exit code.
    let code = if rc < 0 {
        -rc
    } else if rc == 0 {
        7
    } else {
        0
    };
    std::process::exit(code);
}
