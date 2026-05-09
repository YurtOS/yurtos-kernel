//! WASI preview1 shim for user processes.
//!
//! Replaces `wasmtime_wasi::preview1::add_to_linker_sync` with a
//! per-import shim that routes through our `sys_*` syscalls. The
//! point: when `hello-wasm` calls `println!`, the resulting
//! `fd_write` lands in `kernel.wasm` via the trampoline rather than
//! short-circuiting through wasmtime-wasi.
//!
//! Coverage today is the minimum needed by stock `wasm32-wasip1`
//! Rust binaries built without explicit features:
//!   - `fd_write`        → `sys_write` per iovec
//!   - `fd_read`         → `sys_read`  per iovec
//!   - `fd_close`        → `sys_close`
//!   - `proc_exit`       → trap with the exit code
//!   - `environ_get`     → empty environment (writes nothing)
//!   - `environ_sizes_get` → (0 vars, 0 bytes)
//!   - `fd_seek`         → -ESPIPE (we don't seek pipes/streams)
//!   - `fd_fdstat_get`   → minimal stat advertising character-stream
//!                         semantics on fds 0/1/2 so std doesn't try
//!                         to seek them
//!
//! Anything else returns `-ENOSYS`. Real fixtures that need a richer
//! WASI surface (path_open, fd_pread, etc.) will fail with a clear
//! errno; we extend the shim as needed.

use anyhow::{anyhow, Result};
use wasmtime::{Caller, Linker};

use crate::microkernel::UserState;

const WASI: &str = "wasi_snapshot_preview1";

// POSIX errno values used by the shim.
const EBADF: i32 = 9;
const EINVAL: i32 = 22;
const ESPIPE: i32 = 29;
const ENOSYS: i32 = 38;

/// WASI errno mapping. Negative kernel returns become positive WASI
/// errno; 0 stays 0.
fn errno_from_kernel(rc: i64) -> i32 {
    if rc >= 0 {
        0
    } else {
        (-rc) as i32
    }
}

pub fn add_to_linker(linker: &mut Linker<UserState>) -> Result<()> {
    // ── fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) ──────────────
    linker.func_wrap(
        WASI,
        "fd_write",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         iovs_ptr: u32,
         iovs_len: u32,
         nwritten_ptr: u32|
         -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return EINVAL,
            };

            // Read each iovec, accumulate the payload, then write all
            // at once — a single sys_write call per fd_write keeps the
            // semantics simple (fd_write is allowed to be one
            // logical write).
            let mut payload: Vec<u8> = Vec::new();
            for i in 0..iovs_len {
                let iov_addr = iovs_ptr as usize + (i as usize) * 8;
                let mut iov = [0u8; 8];
                if memory.read(&caller, iov_addr, &mut iov).is_err() {
                    return EINVAL;
                }
                let buf_ptr = u32::from_le_bytes(iov[0..4].try_into().unwrap()) as usize;
                let buf_len = u32::from_le_bytes(iov[4..8].try_into().unwrap()) as usize;
                let mut chunk = vec![0u8; buf_len];
                if buf_len > 0 && memory.read(&caller, buf_ptr, &mut chunk).is_err() {
                    return EINVAL;
                }
                payload.extend_from_slice(&chunk);
            }

            // Stage `(u32 fd LE | payload)` in kernel scratch and
            // dispatch sys_write — same shape as the user-process
            // sys_write linker shim does.
            let mut req = Vec::with_capacity(4 + payload.len());
            req.extend_from_slice(&(fd as u32).to_le_bytes());
            req.extend_from_slice(&payload);
            let rc = crate::microkernel::trampoline_request(&mut caller, METHOD_WRITE, &req);
            if rc < 0 {
                return errno_from_kernel(rc);
            }

            // Write nwritten back to user memory.
            let nwritten_bytes = (rc as u32).to_le_bytes();
            if memory
                .write(&mut caller, nwritten_ptr as usize, &nwritten_bytes)
                .is_err()
            {
                return EINVAL;
            }
            0
        },
    )?;

    // ── fd_read(fd, iovs_ptr, iovs_len, nread_ptr) ─────────────────
    linker.func_wrap(
        WASI,
        "fd_read",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         iovs_ptr: u32,
         iovs_len: u32,
         nread_ptr: u32|
         -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return EINVAL,
            };

            // Compute total capacity across iovecs.
            let mut iovs: Vec<(u32, u32)> = Vec::with_capacity(iovs_len as usize);
            let mut total_cap: u32 = 0;
            for i in 0..iovs_len {
                let iov_addr = iovs_ptr as usize + (i as usize) * 8;
                let mut iov = [0u8; 8];
                if memory.read(&caller, iov_addr, &mut iov).is_err() {
                    return EINVAL;
                }
                let buf_ptr = u32::from_le_bytes(iov[0..4].try_into().unwrap());
                let buf_len = u32::from_le_bytes(iov[4..8].try_into().unwrap());
                iovs.push((buf_ptr, buf_len));
                total_cap = total_cap.saturating_add(buf_len);
            }

            // sys_read with caller-supplied capacity == sum of iovec
            // lengths. Stage the response in kernel scratch then
            // scatter back into iovecs.
            let req = (fd as u32).to_le_bytes();
            let mut buf = vec![0u8; total_cap as usize];
            let rc = crate::microkernel::trampoline_request_with_response(
                &mut caller,
                METHOD_READ,
                &req,
                &mut buf,
            );
            if rc < 0 {
                return errno_from_kernel(rc);
            }
            let n = rc as u32;

            // Scatter into iovecs.
            let mut written: u32 = 0;
            for (buf_ptr, buf_len) in iovs {
                if written >= n {
                    break;
                }
                let take = (n - written).min(buf_len);
                if take > 0 {
                    let chunk = &buf[written as usize..(written + take) as usize];
                    if memory.write(&mut caller, buf_ptr as usize, chunk).is_err() {
                        return EINVAL;
                    }
                }
                written += take;
            }

            let nread_bytes = n.to_le_bytes();
            if memory
                .write(&mut caller, nread_ptr as usize, &nread_bytes)
                .is_err()
            {
                return EINVAL;
            }
            0
        },
    )?;

    // ── fd_close(fd) ───────────────────────────────────────────────
    linker.func_wrap(
        WASI,
        "fd_close",
        |mut caller: Caller<'_, UserState>, fd: i32| -> i32 {
            let req = (fd as u32).to_le_bytes();
            let rc = crate::microkernel::trampoline_request(&mut caller, METHOD_CLOSE, &req);
            errno_from_kernel(rc)
        },
    )?;

    // ── proc_exit(rval) → trap ─────────────────────────────────────
    linker.func_wrap(
        WASI,
        "proc_exit",
        |_caller: Caller<'_, UserState>, rval: i32| -> Result<()> {
            Err(anyhow!("user process called proc_exit({rval})"))
        },
    )?;

    // ── args_get(argv: u32, argv_buf: u32) → write argv ────────────
    // WASI layout:
    //   argv:     argc * u32 pointers into argv_buf
    //   argv_buf: NUL-terminated arg bytes packed back-to-back
    linker.func_wrap(
        WASI,
        "args_get",
        |mut caller: Caller<'_, UserState>, argv_ptr: u32, argv_buf_ptr: u32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return EINVAL,
            };
            let argv = caller.data().argv.clone();
            let mut buf_offset: u32 = argv_buf_ptr;
            for (i, arg) in argv.iter().enumerate() {
                let ptr_addr = argv_ptr as usize + i * 4;
                if memory
                    .write(&mut caller, ptr_addr, &buf_offset.to_le_bytes())
                    .is_err()
                {
                    return EINVAL;
                }
                if memory.write(&mut caller, buf_offset as usize, arg).is_err() {
                    return EINVAL;
                }
                if memory
                    .write(&mut caller, buf_offset as usize + arg.len(), &[0u8])
                    .is_err()
                {
                    return EINVAL;
                }
                buf_offset = buf_offset.saturating_add(arg.len() as u32 + 1);
            }
            0
        },
    )?;
    linker.func_wrap(
        WASI,
        "args_sizes_get",
        |mut caller: Caller<'_, UserState>, count_ptr: u32, size_ptr: u32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return EINVAL,
            };
            let argv = &caller.data().argv;
            let count = argv.len() as u32;
            let size: u32 = argv
                .iter()
                .map(|a| a.len() as u32 + 1) // +1 for trailing NUL
                .sum();
            if memory
                .write(&mut caller, count_ptr as usize, &count.to_le_bytes())
                .is_err()
            {
                return EINVAL;
            }
            if memory
                .write(&mut caller, size_ptr as usize, &size.to_le_bytes())
                .is_err()
            {
                return EINVAL;
            }
            0
        },
    )?;

    // ── environ_get / environ_sizes_get → empty env ────────────────
    linker.func_wrap(
        WASI,
        "environ_get",
        |_caller: Caller<'_, UserState>, _envp: u32, _env_buf: u32| -> i32 { 0 },
    )?;
    linker.func_wrap(
        WASI,
        "environ_sizes_get",
        |mut caller: Caller<'_, UserState>, count_ptr: u32, size_ptr: u32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return EINVAL,
            };
            let _ = memory.write(&mut caller, count_ptr as usize, &0u32.to_le_bytes());
            let _ = memory.write(&mut caller, size_ptr as usize, &0u32.to_le_bytes());
            0
        },
    )?;

    // ── fd_seek → ESPIPE (we don't seek streams) ───────────────────
    linker.func_wrap(
        WASI,
        "fd_seek",
        |_caller: Caller<'_, UserState>,
         _fd: i32,
         _offset: i64,
         _whence: i32,
         _new_offset_ptr: u32|
         -> i32 { ESPIPE },
    )?;

    // ── fd_fdstat_get → minimal stat for stream fds (0/1/2) ───────
    linker.func_wrap(
        WASI,
        "fd_fdstat_get",
        |mut caller: Caller<'_, UserState>, fd: i32, statbuf_ptr: u32| -> i32 {
            // WASI fdstat is 24 bytes:
            //   filetype (u8), <pad 7>, fs_flags (u16), <pad 6>,
            //   fs_rights_base (u64), fs_rights_inheriting (u64).
            // For stdio (fds 0/1/2) we report filetype = 2
            // (CHARACTER_DEVICE) so std doesn't try to seek them.
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return EINVAL,
            };
            if !(0..=2).contains(&fd) {
                return EBADF;
            }
            let mut buf = [0u8; 24];
            buf[0] = 2; // CHARACTER_DEVICE
                        // fs_rights_base: allow fd_read | fd_write (bits 1 + 6).
            let rights: u64 = (1 << 1) | (1 << 6);
            buf[8..16].copy_from_slice(&rights.to_le_bytes());
            buf[16..24].copy_from_slice(&rights.to_le_bytes());
            let _ = memory.write(&mut caller, statbuf_ptr as usize, &buf);
            0
        },
    )?;

    // ── clock_time_get: route to sys_clock_gettime ────────────────
    linker.func_wrap(
        WASI,
        "clock_time_get",
        |mut caller: Caller<'_, UserState>, clock_id: i32, _precision: i64, time_ptr: u32| -> i32 {
            // WASI clock ids: 0 = REALTIME, 1 = MONOTONIC, 2 =
            // PROCESS_CPUTIME, 3 = THREAD_CPUTIME. Our kernel handles
            // 0 and 1; map 2/3 → 1 (MONOTONIC) until process-cpu
            // accounting lands.
            let mapped = match clock_id {
                0 => 0u32,
                1 | 2 | 3 => 1u32,
                _ => return EINVAL,
            };
            let req = mapped.to_le_bytes();
            let mut resp = [0u8; 8];
            let rc = crate::microkernel::trampoline_request_with_response(
                &mut caller,
                METHOD_CLOCK_GETTIME,
                &req,
                &mut resp,
            );
            if rc != 8 {
                return errno_from_kernel(rc);
            }
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return EINVAL,
            };
            if memory.write(&mut caller, time_ptr as usize, &resp).is_err() {
                return EINVAL;
            }
            0
        },
    )?;

    // ── Catch-all: any other preview1 call returns ENOSYS ──────────
    // Wasmtime requires every imported function to be defined. We
    // can't do a wildcard, so we list the rest as ENOSYS stubs.
    // (Add to this list as fixtures need them.)
    for name in [
        "clock_res_get",
        "fd_advise",
        "fd_allocate",
        "fd_datasync",
        "fd_fdstat_set_flags",
        "fd_fdstat_set_rights",
        "fd_filestat_get",
        "fd_filestat_set_size",
        "fd_filestat_set_times",
        "fd_pread",
        "fd_prestat_get",
        "fd_prestat_dir_name",
        "fd_pwrite",
        "fd_readdir",
        "fd_renumber",
        "fd_sync",
        "fd_tell",
        "path_create_directory",
        "path_filestat_get",
        "path_filestat_set_times",
        "path_link",
        "path_open",
        "path_readlink",
        "path_remove_directory",
        "path_rename",
        "path_symlink",
        "path_unlink_file",
        "poll_oneoff",
        "proc_raise",
        "random_get",
        "sched_yield",
        "sock_accept",
        "sock_recv",
        "sock_send",
        "sock_shutdown",
    ] {
        linker.func_wrap(WASI, name, |_caller: Caller<'_, UserState>| -> i32 {
            ENOSYS
        })?;
    }

    Ok(())
}

// Method ids we need; mirrors `microkernel::sys_method_id`.
const METHOD_WRITE: u32 = 0x1_0014;
const METHOD_READ: u32 = 0x1_0013;
const METHOD_CLOSE: u32 = 0x1_000E;
const METHOD_CLOCK_GETTIME: u32 = 0x1_0016;
