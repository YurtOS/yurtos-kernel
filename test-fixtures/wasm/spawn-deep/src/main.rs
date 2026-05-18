//! Deep self-spawn fixture for the F1 regression (shared cross-nesting
//! `host_wait` re-entrancy guard).
//!
//! `main()` reads a remaining-depth countdown `N` from argv, spawns
//! *itself* (`/spawn-deep.wasm`, staged at that path by the test) with
//! `N-1`, and `host_wait`s on it. The child does the same, so the
//! native host drive chain recurses:
//!
//!   host_wait → drain_and_run_pending_spawns → instantiate_with_pid_raw
//!     → child.run_start() → child's host_wait → drain → … (recursion)
//!
//! Before the F1 fix the host's recursion guard was a per-CALL local
//! `iters` that reset to 0 at every nested native frame, so the cap
//! never tripped and the native stack grew without bound → stack
//! overflow / abort (a hard crash with NO errno). After the fix a
//! single depth counter is SHARED across the whole nested chain (cap
//! 256, byte-parity with the JS host's `drainDepth`): the ~257th
//! nested `host_wait` returns a clean `-EDEADLK` (-35) WITHOUT
//! recursing further, the tree unwinds, and the errno propagates back
//! to the root.
//!
//! The argv countdown gives the chain a hard FLOOR: a level only
//! spawns a child while `N > 0`. Without it, every level pre-stages a
//! child via `host_spawn` *before* its `host_wait` hits the depth cap,
//! and the parent's drain loop would run that abandoned orphan, which
//! stages another, forever (unbounded *horizontal* work at fixed
//! depth — the host caps THAT at 100 000 iters, matching JS
//! `runPendingSpawns`'s `RUNAWAY_LIMIT`, but that is slow and asserts
//! -EIO). With the floor the total work is ~`N` levels and the test
//! cleanly observes the depth-256 guard returning -EDEADLK.
//!
//! Root `N` (set by the test) is > 256 so the vertical depth-256 guard
//! fires before the countdown reaches its base case.
//!
//! Expected: the run terminates with exit code 35 (EDEADLK) — NOT a
//! crash / abort / timeout.
//!
//! Deliberately formatting-free / dependency-free (raw FFI, no
//! `println!`, no `yurt_process`): the host re-`Module::new`-compiles
//! this wasm at EVERY nested level, so a small module keeps the test
//! fast. The spawn/wait wire is hand-encoded against the layout in
//! `test-fixtures/yurt-process/src/lib.rs` and the host decoder
//! `packages/runtime-wasmtime/src/wasm/native_abi.rs`.

#[link(wasm_import_module = "yurt")]
extern "C" {
    fn host_spawn(req_ptr: *const u8, req_len: usize, out_ptr: *mut u8, out_cap: usize) -> i32;
    fn host_wait(pid: i32, flags: i32, out_ptr: *mut u8, out_cap: usize) -> i32;
}

const EDEADLK: i32 = 35;

// yurt_spawn_request_v1: 88-byte fixed header, then inline blobs.
// Layout (offsets mirror `native_abi.rs`):
//   @0  u32 logical_size
//   @4  u16 version (= 1)
//   @8  span prog        (u32 data_off, u32 len)
//   @24 u32 args_vec_off  @28 u32 args_count
//   @52 i32 stdout_fd     @56 i32 stderr_fd
const HEADER: usize = 88;
const PROG: &[u8] = b"/spawn-deep.wasm";

/// Build a request that spawns `/spawn-deep.wasm` with a single arg =
/// `next_n` (ASCII decimal). Layout:
///   [0..88)   header
///   [88..104) prog bytes              (104 is 4-aligned)
///   [104..112) args span array (1 span)
///   [112..)   the arg's ASCII digits  (112 is 4-aligned)
fn build_request(buf: &mut [u8; 128], next_n: u32) -> usize {
    let prog_off = HEADER; // 88
    let prog_end = prog_off + PROG.len(); // 104
    let span_arr_off = prog_end; // 104, 4-aligned
    let arg_off = span_arr_off + 8; // 112, 4-aligned

    // ASCII-encode next_n (0..=999 is plenty; root N is ~260).
    let mut digits = [0u8; 3];
    let dlen = if next_n == 0 {
        digits[0] = b'0';
        1usize
    } else {
        let mut tmp = [0u8; 3];
        let mut t = 0;
        let mut v = next_n;
        while v > 0 {
            tmp[t] = b'0' + (v % 10) as u8;
            v /= 10;
            t += 1;
        }
        for i in 0..t {
            digits[i] = tmp[t - 1 - i];
        }
        t
    };

    let total = arg_off + dlen;
    buf[0..4].copy_from_slice(&(total as u32).to_le_bytes());
    buf[4..6].copy_from_slice(&1u16.to_le_bytes()); // RECORD_VERSION_1
    buf[8..12].copy_from_slice(&(prog_off as u32).to_le_bytes());
    buf[12..16].copy_from_slice(&(PROG.len() as u32).to_le_bytes());
    buf[24..28].copy_from_slice(&(span_arr_off as u32).to_le_bytes());
    buf[28..32].copy_from_slice(&1u32.to_le_bytes()); // args_count = 1
    buf[52..56].copy_from_slice(&1i32.to_le_bytes()); // stdout_fd
    buf[56..60].copy_from_slice(&2i32.to_le_bytes()); // stderr_fd
    buf[span_arr_off..span_arr_off + 4].copy_from_slice(&(arg_off as u32).to_le_bytes());
    buf[span_arr_off + 4..span_arr_off + 8].copy_from_slice(&(dlen as u32).to_le_bytes());
    buf[prog_off..prog_end].copy_from_slice(PROG);
    buf[arg_off..arg_off + dlen].copy_from_slice(&digits[..dlen]);
    total
}

fn main() {
    // argv = [program, "<N>"]; read the countdown.
    let n: u32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if n == 0 {
        // Base case: a leaf that spawns NOTHING — guarantees the chain
        // (and any orphan storm) has a hard floor and terminates.
        std::process::exit(0);
    }

    let mut req = [0u8; 128];
    let req_len = build_request(&mut req, n - 1);

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
        // Couldn't even stage a child — surface the errno, don't hang.
        std::process::exit(if rc < 0 { -rc } else { 1 });
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

    if nbytes == -EDEADLK {
        // The shared depth guard fired at THIS level: the host refused
        // to recurse further and returned a clean errno instead of
        // overflowing the native stack. Surface it so it propagates,
        // unchanged, all the way back to the root.
        std::process::exit(EDEADLK);
    }
    if nbytes != core::mem::size_of::<[i32; 4]>() as i32 {
        std::process::exit(if nbytes < 0 { -nbytes } else { 1 });
    }
    // Normal reap: a descendant deeper in the chain hit the guard.
    // Propagate its exit code so EDEADLK (35) bubbles to the root.
    std::process::exit(wait[1]);
}
