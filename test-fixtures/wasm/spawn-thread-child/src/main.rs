/// Child fixture for P2-1 regression test.
///
/// Calls yurt.host_thread_spawn directly (bypassing std::thread, which on
/// wasm32-wasip1 uses a different emulation path and does NOT import
/// host_thread_spawn).  This exercises the exact kh_thread_spawn path that
/// fails with -ESRCH when the child is not registered in handlesByPid.
///
/// The thread function returns 42.  The child joins the thread and checks
/// the retval propagated through host_thread_join/host_thread_join:
///   - Pre-fix: host_thread_spawn returns negative (-ESRCH or -EIO) → exit(1)
///   - Post-fix: thread runs, join retval=42 → exit(0)
///
/// Note: the wasm binary owns its own memory (wasm32-wasip1 model), so the
/// thread instance gets a fresh memory copy — RESULT-style globals cannot be
/// observed from the main instance.  Instead we rely on the join return value.

use std::ffi::c_int;

/// The thread function: receives arg and returns a distinctive value (42).
/// The return value is the signal that the thread actually ran.
extern "C" fn thread_fn(arg: c_int) -> c_int {
    let _ = arg;
    42 // distinctive retval to prove the thread ran
}

#[link(wasm_import_module = "yurt")]
extern "C" {
    fn host_thread_spawn(fn_ptr: c_int, arg: c_int) -> c_int;
    fn host_thread_join(tid: c_int, out_retval: *mut u32) -> c_int;
}

fn main() {
    // SAFETY: host imports are provided by the Yurt JS host via buildUserYurtImports.
    // fn_ptr is the wasm table index of thread_fn; arg is 0.
    let fn_ptr = thread_fn as *const () as usize as c_int;
    let tid = unsafe { host_thread_spawn(fn_ptr, 0) };
    if tid < 0 {
        // Pre-fix failure path: child not in handlesByPid → -ESRCH, or
        // function table not exported → -EIO.
        std::process::exit(1);
    }
    let mut retval: u32 = 0;
    let join_rc = unsafe { host_thread_join(tid, &mut retval as *mut u32) };
    if join_rc < 0 {
        // Join failed.
        std::process::exit(1);
    }
    // Thread return value is propagated via recordThreadExitAuthenticated →
    // kernel → SYS_THREAD_JOIN response → host_thread_join outRetvalPtr.
    // If the thread ran, retval should be 42.
    if retval != 42 {
        std::process::exit(1);
    }
    std::process::exit(0);
}
