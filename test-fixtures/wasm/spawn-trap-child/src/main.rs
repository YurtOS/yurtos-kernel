//! Parent half of the P2-2 cross-host fixture.
//!
//! `main()` `host_spawn`s `/trap-child.wasm` (staged at that path by
//! the test) — a child that takes a GENUINE wasm trap (`unreachable`)
//! before ever calling `proc_exit` — then `host_wait`s on it and prints
//! the reaped status.
//!
//! The bug (P2-2): a trapped child was mis-reaped *divergently* across
//! hosts — Rust recorded exit 0 (false success); JS re-threw the trap,
//! which unwound out through the parent's `host_wait` import and
//! crashed the parent with no errno. The fix reaps a trapped child with
//! a deterministic abnormal-termination status (`CHILD_TRAP_EXIT =
//! 134` = 128 + SIGABRT, the shell `$?` convention) on BOTH hosts, the
//! parent is unaffected, and the drain continues.
//!
//! `host_wait` writes `yurt_wait_result_v1 {i32 pid, i32 exit_code, i32
//! signal, i32 _}`. The kernel status 134 lies in [128,192), so BOTH
//! hosts' `host_wait` decode it identically as `{exit_code=0,
//! signal=6}` (`signal = status-128`). The POSIX `$?` value for a
//! signalled child is `128 + signal`, so the parent reconstructs
//! `128 + signal == 134` and prints it. That printed line is the
//! byte-identical cross-host parity oracle (asserted verbatim by both
//! the Rust `fixture_parity` test and the deno test).
//!
//! Spawn/wait wire is hand-encoded (raw FFI), same discipline as
//! `spawn-deep`, against the layout in `test-fixtures/yurt-process`.

use std::io::Write;

#[link(wasm_import_module = "yurt")]
extern "C" {
    fn host_spawn(req_ptr: *const u8, req_len: usize, out_ptr: *mut u8, out_cap: usize) -> i32;
    fn host_wait(pid: i32, flags: i32, out_ptr: *mut u8, out_cap: usize) -> i32;
}

// yurt_spawn_request_v1: 88-byte fixed header, then inline blobs.
// Offsets mirror `native_abi.rs` / `yurt-process`:
//   @0  u32 logical_size   @4  u16 version (= 1)
//   @8  span prog (u32 data_off, u32 len)
//   @52 i32 stdout_fd       @56 i32 stderr_fd
const HEADER: usize = 88;
const PROG: &[u8] = b"/trap-child.wasm";

/// Build a request that spawns `/trap-child.wasm` with no args.
/// Layout: [0..88) header, [88..104) prog bytes (104 is 4-aligned).
fn build_request(buf: &mut [u8; 128]) -> usize {
    let prog_off = HEADER; // 88
    let prog_end = prog_off + PROG.len(); // 104
    let total = prog_end;
    buf[0..4].copy_from_slice(&(total as u32).to_le_bytes());
    buf[4..6].copy_from_slice(&1u16.to_le_bytes()); // RECORD_VERSION_1
    buf[8..12].copy_from_slice(&(prog_off as u32).to_le_bytes());
    buf[12..16].copy_from_slice(&(PROG.len() as u32).to_le_bytes());
    buf[52..56].copy_from_slice(&1i32.to_le_bytes()); // stdout_fd
    buf[56..60].copy_from_slice(&2i32.to_le_bytes()); // stderr_fd
    buf[prog_off..prog_end].copy_from_slice(PROG);
    total
}

fn main() {
    let mut req = [0u8; 128];
    let req_len = build_request(&mut req);

    let mut spawn_pid: i32 = -1;
    let rc = unsafe {
        host_spawn(
            req.as_ptr(),
            req_len,
            (&mut spawn_pid as *mut i32).cast::<u8>(),
            core::mem::size_of::<i32>(),
        )
    };
    if rc != core::mem::size_of::<i32>() as i32 || spawn_pid < 0 {
        println!("host_spawn failed: rc={rc}");
        std::process::exit(1);
    }

    // yurt_wait_result_v1: {i32 pid, i32 exit_code, i32 signal, i32 _}.
    let mut wait = [0i32; 4];
    let nbytes = unsafe {
        host_wait(
            spawn_pid,
            0,
            wait.as_mut_ptr().cast::<u8>(),
            core::mem::size_of::<[i32; 4]>(),
        )
    };
    if nbytes != core::mem::size_of::<[i32; 4]>() as i32 {
        // If the parent ever reaches here on the trap path, the child's
        // trap was NOT absorbed by the drain (the bug). A clean fix
        // never lands here for a trapped child.
        println!("host_wait failed: rc={nbytes}");
        std::process::exit(1);
    }

    let exit_code = wait[1];
    let signal = wait[2];
    // POSIX `$?` convention: a process killed/aborted by a signal
    // reports `128 + signal`. The host decodes kernel status 134 as
    // {exit_code=0, signal=6}, so this reconstructs exactly 134 —
    // byte-identical across hosts (same decode on both sides).
    let status = if signal != 0 { 128 + signal } else { exit_code };

    println!("child reaped status {status}");
    // Flush before the proc_exit trap so the kernel stdout buffer has
    // the line when the test drains it.
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}
