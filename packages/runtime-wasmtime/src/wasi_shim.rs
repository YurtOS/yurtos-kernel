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
//!   - `fd_fdstat_get`   → minimal stat advertising character-stream semantics
//!     on fds 0/1/2 so std doesn't try to seek them
//!
//! Anything else returns `-ENOSYS`. Real fixtures that need a richer
//! WASI surface (path_open, fd_pread, etc.) will fail with a clear
//! errno; we extend the shim as needed.

use anyhow::{anyhow, Result};
use wasmtime::{Caller, Linker};

use std::sync::atomic::{AtomicU8, Ordering};
use wasmtime::{Memory, SharedMemory};

use crate::kernel_host_interface::UserState;
use yurt_kernel_host_interface_core::{checked_guest_buffer_len, checked_guest_buffer_sum};

/// Unified handle over guest user memory that transparently falls
/// back from linear `Memory` to `SharedMemory` (#132). Threaded
/// guests (`wasm32-wasip1-threads`) import a `SharedMemory`, on
/// which `Extern::into_memory()` returns `None` — so the pre-#132
/// shim bailed on every WASI call for those guests. This handle
/// mirrors the `sys_*` trampoline's `read_user_guest_bytes` /
/// `write_user_guest_bytes` fallback, with the same `AtomicU8` SeqCst
/// access for `SharedMemory` cells.
///
/// Existing call sites keep their `memory.read(&caller, addr, &mut buf)`
/// / `memory.write(&mut caller, addr, &bytes)` shape; the enum routes
/// to the correct backend.
enum GuestMemoryHandle {
    Linear(Memory),
    Shared(SharedMemory),
}

impl GuestMemoryHandle {
    fn from_caller(caller: &mut Caller<'_, UserState>) -> Option<Self> {
        if let Some(extern_) = caller.get_export("memory") {
            if let Some(m) = extern_.clone().into_memory() {
                return Some(GuestMemoryHandle::Linear(m));
            }
            if let Some(m) = extern_.into_shared_memory() {
                return Some(GuestMemoryHandle::Shared(m));
            }
        }
        None
    }

    fn read(
        &self,
        caller: &Caller<'_, UserState>,
        addr: usize,
        buf: &mut [u8],
    ) -> std::result::Result<(), ()> {
        match self {
            GuestMemoryHandle::Linear(m) => m.read(caller, addr, buf).map_err(|_| ()),
            GuestMemoryHandle::Shared(m) => {
                let data = m.data();
                let end = addr.checked_add(buf.len()).ok_or(())?;
                let cells = data.get(addr..end).ok_or(())?;
                for (out, cell) in buf.iter_mut().zip(cells) {
                    let ptr = cell.get().cast::<AtomicU8>();
                    // SAFETY: Wasmtime exposes shared memory as
                    // `UnsafeCell<u8>` because concurrent wasm threads
                    // may access it. `AtomicU8` is layout-compatible.
                    *out = unsafe { (*ptr).load(Ordering::SeqCst) };
                }
                Ok(())
            }
        }
    }

    fn write(
        &self,
        caller: &mut Caller<'_, UserState>,
        addr: usize,
        bytes: &[u8],
    ) -> std::result::Result<(), ()> {
        match self {
            GuestMemoryHandle::Linear(m) => m.write(caller, addr, bytes).map_err(|_| ()),
            GuestMemoryHandle::Shared(m) => {
                let data = m.data();
                let end = addr.checked_add(bytes.len()).ok_or(())?;
                let cells = data.get(addr..end).ok_or(())?;
                for (cell, byte) in cells.iter().zip(bytes) {
                    let ptr = cell.get().cast::<AtomicU8>();
                    // SAFETY: same as `read` — atomic store on the
                    // `UnsafeCell<u8>` exposed by Wasmtime.
                    unsafe { (*ptr).store(*byte, Ordering::SeqCst) };
                }
                Ok(())
            }
        }
    }
}

const WASI: &str = "wasi_snapshot_preview1";

// WASI preview1 errno values (NOT the POSIX values — wasi-libc
// uses the spec enum below, so e.g. EBADF=8 here vs 9 in POSIX).
// These shim returns are what wasi-libc reads literally.
const EBADF: i32 = 8;
const EINVAL: i32 = 28;
const ESPIPE: i32 = 70;
const ENOSYS: i32 = 52;
const EFAULT: i32 = 21;
const EIO: i32 = 29;

/// Map kernel-side POSIX errno → WASI preview1 errno. The kernel
/// uses POSIX values (matching abi/contract/yurt_abi.toml); the WASI
/// preview1 spec assigns its own integer enum that differs from
/// POSIX. Anything we can't map gets bucketed to EINVAL.
fn posix_to_wasi(posix: i32) -> i32 {
    match posix {
        0 => 0,
        1 => 63,  // EPERM
        2 => 44,  // ENOENT
        9 => 8,   // EBADF
        11 => 6,  // EAGAIN
        14 => 21, // EFAULT — the guest-memory helpers return this on
        //                  short/out-of-bounds reads (incl. SharedMemory
        //                  fallback failures).
        22 => 28, // EINVAL
        29 => 70, // ESPIPE
        32 => 64, // EPIPE
        38 => 52, // ENOSYS
        _ => 28,  // fallback EINVAL
    }
}

/// WASI errno mapping. Negative kernel returns become positive WASI
/// errno; 0 stays 0.
fn errno_from_kernel(rc: i64) -> i32 {
    if rc >= 0 {
        0
    } else {
        posix_to_wasi((-rc) as i32)
    }
}

fn checked_wasi_guest_len(len: u32) -> std::result::Result<usize, i32> {
    checked_guest_buffer_len(len).map_err(|_| EINVAL)
}

fn checked_wasi_guest_sum(parts: &[u32]) -> std::result::Result<usize, i32> {
    checked_guest_buffer_sum(parts).map_err(|_| EINVAL)
}

fn checked_wasi_iovec_bytes(iovs_len: u32) -> std::result::Result<usize, i32> {
    let bytes = iovs_len.checked_mul(8).ok_or(EINVAL)?;
    checked_wasi_guest_len(bytes)
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
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };

            let iovs_cap = match checked_wasi_iovec_bytes(iovs_len) {
                Ok(n) => n / 8,
                Err(rc) => return rc,
            };

            // Read each iovec, accumulate the payload, then write all
            // at once — a single sys_write call per fd_write keeps the
            // semantics simple (fd_write is allowed to be one
            // logical write).
            let mut iovs: Vec<(u32, u32)> = Vec::with_capacity(iovs_cap);
            let mut total_len: u32 = 0;
            for i in 0..iovs_len {
                let iov_addr = iovs_ptr as usize + (i as usize) * 8;
                let mut iov = [0u8; 8];
                if memory.read(&caller, iov_addr, &mut iov).is_err() {
                    return EINVAL;
                }
                let buf_ptr = u32::from_le_bytes(iov[0..4].try_into().unwrap());
                let buf_len = u32::from_le_bytes(iov[4..8].try_into().unwrap());
                total_len = match checked_wasi_guest_sum(&[total_len, buf_len]) {
                    Ok(n) => n as u32,
                    Err(rc) => return rc,
                };
                iovs.push((buf_ptr, buf_len));
            }

            let mut payload: Vec<u8> = Vec::with_capacity(total_len as usize);
            for (buf_ptr, buf_len) in iovs {
                let len = match checked_wasi_guest_len(buf_len) {
                    Ok(n) => n,
                    Err(rc) => return rc,
                };
                let mut chunk = vec![0u8; len];
                if len > 0 && memory.read(&caller, buf_ptr as usize, &mut chunk).is_err() {
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
            let rc = crate::kernel_host_interface::trampoline_request(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_WRITE,
                &req,
            );
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
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };

            let iovs_cap = match checked_wasi_iovec_bytes(iovs_len) {
                Ok(n) => n / 8,
                Err(rc) => return rc,
            };

            // Compute total capacity across iovecs.
            let mut iovs: Vec<(u32, u32)> = Vec::with_capacity(iovs_cap);
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
                total_cap = match checked_wasi_guest_sum(&[total_cap, buf_len]) {
                    Ok(n) => n as u32,
                    Err(rc) => return rc,
                };
            }

            // sys_read with caller-supplied capacity == sum of iovec
            // lengths. Stage the response in kernel scratch then
            // scatter back into iovecs.
            let req = (fd as u32).to_le_bytes();
            let total_cap_len = match checked_wasi_guest_len(total_cap) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut buf = vec![0u8; total_cap_len];
            let rc = crate::kernel_host_interface::trampoline_request_with_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
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
            caller.data_mut().dir_fds.remove(&fd);
            let req = (fd as u32).to_le_bytes();
            let rc = crate::kernel_host_interface::trampoline_request(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_CLOSE,
                &req,
            );
            errno_from_kernel(rc)
        },
    )?;

    // ── fd_sync(fd) / fd_datasync(fd) — POSIX fsync / fdatasync ──────
    // Route to METHOD_SYS_FSYNC / METHOD_SYS_FDATASYNC (issue #88) so
    // sqlite, write-temp-then-rename atomic save, and Rust's
    // File::sync_all see a successful no-op on the in-memory ramfs
    // instead of -ENOSYS. Kernel-side gate: regular-file / directory
    // fd → 0; pipe / socket → EINVAL; closed / unknown → EBADF.
    linker.func_wrap(
        WASI,
        "fd_sync",
        |mut caller: Caller<'_, UserState>, fd: i32| -> i32 {
            let req = (fd as u32).to_le_bytes();
            let rc = crate::kernel_host_interface::trampoline_request(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_FSYNC,
                &req,
            );
            errno_from_kernel(rc)
        },
    )?;
    linker.func_wrap(
        WASI,
        "fd_datasync",
        |mut caller: Caller<'_, UserState>, fd: i32| -> i32 {
            let req = (fd as u32).to_le_bytes();
            let rc = crate::kernel_host_interface::trampoline_request(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_FDATASYNC,
                &req,
            );
            errno_from_kernel(rc)
        },
    )?;

    // ── proc_exit(rval) → trap ─────────────────────────────────────
    linker.func_wrap(
        WASI,
        "proc_exit",
        |mut caller: Caller<'_, UserState>, rval: i32| -> Result<()> {
            // Side-channel the exit code to the embedder before
            // trapping; run_pending_spawns reads it via
            // UserProcess::last_exit() and feeds record_exit so
            // the parent's sys_wait sees the right status.
            caller.data_mut().last_exit = Some(rval);
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
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
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
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
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
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            let _ = memory.write(&mut caller, count_ptr as usize, &0u32.to_le_bytes());
            let _ = memory.write(&mut caller, size_ptr as usize, &0u32.to_le_bytes());
            0
        },
    )?;

    // ── fd_seek → sys_lseek ────────────────────────────────────────
    // WASI whence: 0=SET, 1=CUR, 2=END (matches POSIX). The kernel's
    // sys_lseek refuses non-file fds with -EBADF; for stdio/pipe we
    // map that to ESPIPE which is the WASI errno user code expects.
    linker.func_wrap(
        WASI,
        "fd_seek",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         offset: i64,
         whence: i32,
         new_offset_ptr: u32|
         -> i32 {
            let mut req = Vec::with_capacity(16);
            req.extend_from_slice(&(fd as u32).to_le_bytes());
            req.extend_from_slice(&offset.to_le_bytes());
            req.extend_from_slice(&(whence as u32).to_le_bytes());
            let mut resp = [0u8; 8];
            let rc = crate::kernel_host_interface::trampoline_request_with_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_LSEEK,
                &req,
                &mut resp,
            );
            if rc < 0 {
                // EBADF on a stream → ESPIPE for WASI compliance.
                let err = errno_from_kernel(rc);
                return if err == EBADF { ESPIPE } else { err };
            }
            // Spec: write the new offset as u64 LE into *new_offset_ptr.
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            // sys_lseek returns i64; widen to u64 for WASI.
            let new_off = i64::from_le_bytes(resp);
            if memory
                .write(
                    &mut caller,
                    new_offset_ptr as usize,
                    &(new_off as u64).to_le_bytes(),
                )
                .is_err()
            {
                return EINVAL;
            }
            0
        },
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
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            let mut buf = [0u8; 24];
            match fd {
                0..=2 => {
                    buf[0] = 2; // CHARACTER_DEVICE
                    let rights: u64 = (1 << 1) | (1 << 6);
                    buf[8..16].copy_from_slice(&rights.to_le_bytes());
                    buf[16..24].copy_from_slice(&rights.to_le_bytes());
                }
                f if f == PREOPEN_ROOT_FD => {
                    // The synthetic root preopen. wasi-libc expects
                    // DIRECTORY (3) with rights that include path_open.
                    buf[0] = 3; // DIRECTORY
                                // path_open + path_filestat_get + path_create_directory…
                                // Granting all path_* + fd_readdir is enough for std::fs.
                    let rights: u64 = u64::MAX;
                    buf[8..16].copy_from_slice(&rights.to_le_bytes());
                    buf[16..24].copy_from_slice(&rights.to_le_bytes());
                }
                _ => return EBADF,
            }
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
                1..=3 => 1u32,
                _ => return EINVAL,
            };
            let req = mapped.to_le_bytes();
            let mut resp = [0u8; 8];
            let rc = crate::kernel_host_interface::trampoline_request_with_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_CLOCK_GETTIME,
                &req,
                &mut resp,
            );
            if rc != 8 {
                return errno_from_kernel(rc);
            }
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            if memory.write(&mut caller, time_ptr as usize, &resp).is_err() {
                return EINVAL;
            }
            0
        },
    )?;

    // ── Preopen surface: fd 3 = "/" ─────────────────────────────────
    // wasi-libc walks preopens (`fd_prestat_get(3..)`) at startup,
    // matches by prefix, then calls `path_open` against that fd with
    // the *relative* path. We expose exactly one preopen — root —
    // because Phase 2 has a flat ramfs with absolute-path keys; that
    // lets `std::fs::File::open("/etc/motd")` route through.
    linker.func_wrap(
        WASI,
        "fd_prestat_get",
        |mut caller: Caller<'_, UserState>, fd: i32, prestat_ptr: u32| -> i32 {
            if fd != PREOPEN_ROOT_FD {
                return EBADF;
            }
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            // Layout: tag (u8) + 3 pad + dir_name_len (u32). tag 0 = dir.
            let mut buf = [0u8; 8];
            buf[0] = 0; // PREOPENTYPE_DIR
            buf[4..8].copy_from_slice(&(PREOPEN_ROOT_NAME.len() as u32).to_le_bytes());
            if memory
                .write(&mut caller, prestat_ptr as usize, &buf)
                .is_err()
            {
                return EINVAL;
            }
            0
        },
    )?;
    linker.func_wrap(
        WASI,
        "fd_prestat_dir_name",
        |mut caller: Caller<'_, UserState>, fd: i32, path_ptr: u32, path_len: u32| -> i32 {
            if fd != PREOPEN_ROOT_FD {
                return EBADF;
            }
            if (path_len as usize) < PREOPEN_ROOT_NAME.len() {
                return EINVAL;
            }
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            if memory
                .write(&mut caller, path_ptr as usize, PREOPEN_ROOT_NAME.as_bytes())
                .is_err()
            {
                return EINVAL;
            }
            0
        },
    )?;
    // ── fd_readdir(fd, buf, buf_len, cookie, bufused_ptr) ────────────
    // WASI dirent layout (24 bytes header + name): d_next(u64) at 0,
    // d_ino(u64) at 8, d_namlen(u32) at 16, d_type(u8) at 20, pad to
    // 24, then `d_namlen` name bytes. `cookie` is the index of the
    // *next* entry to return; we serialize entries from cookie..,
    // writing as many full records (header + name) as fit. Truncated
    // tail is silently dropped so the caller will iterate again with
    // an updated cookie. Bufused = bytes actually written.
    linker.func_wrap(
        WASI,
        "fd_readdir",
        |mut caller: Caller<'_, UserState>,
         fd: i32,
         buf: u32,
         buf_len: u32,
         cookie: i64,
         bufused_ptr: u32|
         -> i32 {
            let path = match caller.data().dir_fds.get(&fd).cloned() {
                Some(p) => p,
                None => return 8, // EBADF (WASI errno)
            };
            // Ask the kernel for the listing. Allocate a generously
            // sized response — entries are bounded by mount size in
            // practice; 64 KiB covers any sane directory and saves a
            // round-trip-with-resize. If a real fixture overflows,
            // bump this; the kernel surface returns the actual byte
            // count it filled.
            let mut resp = vec![0u8; 64 * 1024];
            let rc = crate::kernel_host_interface::trampoline_request_with_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_SYS_READDIR,
                &path,
                &mut resp,
            );
            if rc < 0 {
                return errno_from_kernel(rc);
            }
            let used = rc as usize;
            if used < 4 {
                return 28; // EINVAL
            }
            let count = u32::from_le_bytes(resp[0..4].try_into().unwrap()) as usize;
            // Walk records to find offsets we need (skip the first
            // `cookie` entries, write the rest as WASI dirents).
            let mut cur = 4usize;
            let mut written = 0usize;
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return 28, // EINVAL
            };
            for idx in 0..count {
                if cur + 5 > used {
                    break;
                }
                let nlen = u32::from_le_bytes(resp[cur..cur + 4].try_into().unwrap()) as usize;
                cur += 4;
                let ty = resp[cur];
                cur += 1;
                if cur + nlen > used {
                    break;
                }
                if (idx as i64) < cookie {
                    cur += nlen;
                    continue;
                }
                let name = &resp[cur..cur + nlen];
                cur += nlen;
                let need = 24 + nlen;
                if written + need > buf_len as usize {
                    break;
                }
                // 24-byte WASI dirent header. d_type comes straight
                // from the kernel's per-entry type byte (0/3/4/7);
                // libc readdir() honors it and skips the per-entry
                // stat fast-path miss when it's nonzero.
                let mut hdr = [0u8; 24];
                hdr[0..8].copy_from_slice(&((idx as u64) + 1).to_le_bytes());
                // d_ino zero is fine for now.
                hdr[16..20].copy_from_slice(&(nlen as u32).to_le_bytes());
                hdr[20] = ty;
                if memory
                    .write(&mut caller, buf as usize + written, &hdr)
                    .is_err()
                {
                    return 28;
                }
                if memory
                    .write(&mut caller, buf as usize + written + 24, name)
                    .is_err()
                {
                    return 28;
                }
                written += need;
            }
            let written_u32 = (written as u32).to_le_bytes();
            if memory
                .write(&mut caller, bufused_ptr as usize, &written_u32)
                .is_err()
            {
                return 28;
            }
            0
        },
    )?;

    // ── path_rename(old_dirfd, old_path, old_len,
    //                new_dirfd, new_path, new_len) ─────────────────
    // Both dirfds must be the synthetic preopen root. Maps to
    // sys_rename with the same wire format as path_link/sys_link.
    linker.func_wrap(
        WASI,
        "path_rename",
        |mut caller: Caller<'_, UserState>,
         old_dirfd: i32,
         old_path_ptr: u32,
         old_path_len: u32,
         new_dirfd: i32,
         new_path_ptr: u32,
         new_path_len: u32|
         -> i32 {
            if old_dirfd != PREOPEN_ROOT_FD || new_dirfd != PREOPEN_ROOT_FD {
                return EBADF;
            }
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            let old_len = match checked_wasi_guest_len(old_path_len) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut old_rel = vec![0u8; old_len];
            if old_path_len > 0
                && memory
                    .read(&caller, old_path_ptr as usize, &mut old_rel)
                    .is_err()
            {
                return EINVAL;
            }
            let new_len = match checked_wasi_guest_len(new_path_len) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut new_rel = vec![0u8; new_len];
            if new_path_len > 0
                && memory
                    .read(&caller, new_path_ptr as usize, &mut new_rel)
                    .is_err()
            {
                return EINVAL;
            }
            let mut old_abs = Vec::with_capacity(1 + old_rel.len());
            old_abs.push(b'/');
            old_abs.extend_from_slice(&old_rel);
            let mut new_abs = Vec::with_capacity(1 + new_rel.len());
            new_abs.push(b'/');
            new_abs.extend_from_slice(&new_rel);

            let req_cap =
                match checked_wasi_guest_sum(&[4, old_abs.len() as u32, new_abs.len() as u32]) {
                    Ok(n) => n,
                    Err(rc) => return rc,
                };
            let mut req = Vec::with_capacity(req_cap);
            req.extend_from_slice(&(old_abs.len() as u32).to_le_bytes());
            req.extend_from_slice(&old_abs);
            req.extend_from_slice(&new_abs);
            let rc = crate::kernel_host_interface::trampoline_request(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_SYS_RENAME,
                &req,
            );
            errno_from_kernel(rc)
        },
    )?;

    // ── path_link(old_dirfd, _old_flags, old_path, old_len,
    //              new_dirfd, new_path, new_len) ─────────────────────
    // Both dirfds must be the synthetic preopen root (fd 3); we have
    // no other directory fds yet. Maps to sys_link with our path
    // wire format: u32 target_len LE + target_bytes + linkpath_bytes.
    linker.func_wrap(
        WASI,
        "path_link",
        |mut caller: Caller<'_, UserState>,
         old_dirfd: i32,
         _old_flags: i32,
         old_path_ptr: u32,
         old_path_len: u32,
         new_dirfd: i32,
         new_path_ptr: u32,
         new_path_len: u32|
         -> i32 {
            if old_dirfd != PREOPEN_ROOT_FD || new_dirfd != PREOPEN_ROOT_FD {
                return EBADF;
            }
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            let old_len = match checked_wasi_guest_len(old_path_len) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut old_rel = vec![0u8; old_len];
            if old_path_len > 0
                && memory
                    .read(&caller, old_path_ptr as usize, &mut old_rel)
                    .is_err()
            {
                return EINVAL;
            }
            let new_len = match checked_wasi_guest_len(new_path_len) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut new_rel = vec![0u8; new_len];
            if new_path_len > 0
                && memory
                    .read(&caller, new_path_ptr as usize, &mut new_rel)
                    .is_err()
            {
                return EINVAL;
            }
            // Restore preopen prefix on both paths.
            let mut target = Vec::with_capacity(1 + old_rel.len());
            target.push(b'/');
            target.extend_from_slice(&old_rel);
            let mut link_path = Vec::with_capacity(1 + new_rel.len());
            link_path.push(b'/');
            link_path.extend_from_slice(&new_rel);

            let req_cap =
                match checked_wasi_guest_sum(&[4, target.len() as u32, link_path.len() as u32]) {
                    Ok(n) => n,
                    Err(rc) => return rc,
                };
            let mut req = Vec::with_capacity(req_cap);
            req.extend_from_slice(&(target.len() as u32).to_le_bytes());
            req.extend_from_slice(&target);
            req.extend_from_slice(&link_path);
            let rc = crate::kernel_host_interface::trampoline_request(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_SYS_LINK,
                &req,
            );
            errno_from_kernel(rc)
        },
    )?;

    linker.func_wrap(
        WASI,
        "path_open",
        |mut caller: Caller<'_, UserState>,
         dirfd: i32,
         _dirflags: i32,
         path_ptr: u32,
         path_len: u32,
         oflags: i32,
         fs_rights_base: i64,
         _fs_rights_inheriting: i64,
         _fdflags: i32,
         ret_fd_ptr: u32|
         -> i32 {
            if dirfd != PREOPEN_ROOT_FD {
                return EBADF;
            }
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            let rel_len = match checked_wasi_guest_len(path_len) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut rel = vec![0u8; rel_len];
            if path_len > 0 && memory.read(&caller, path_ptr as usize, &mut rel).is_err() {
                return EINVAL;
            }
            // Map WASI oflags + rights → kernel sys_open flags.
            // WASI oflags: CREAT=1, DIRECTORY=2, EXCL=4, TRUNC=8.
            // WASI rights: FD_WRITE = bit 6.
            let want_write = (fs_rights_base as u64) & (1 << 6) != 0;
            let mut k_flags: u32 = 0;
            if want_write {
                k_flags |= 0b001;
            }
            if oflags & 0b0001 != 0 {
                k_flags |= 0b010; // CREAT
            }
            if oflags & 0b1000 != 0 {
                k_flags |= 0b100; // TRUNC
            }
            if oflags & 0b0010 != 0 {
                k_flags |= 0b1000; // DIRECTORY
            }
            if oflags & 0b0100 != 0 {
                k_flags |= 0b10000; // EXCL
            }
            // Build "u32 flags + '/' + relpath" — wasi-libc strips
            // the preopen prefix, we restore it.
            let req_cap = match checked_wasi_guest_sum(&[4, 1, rel.len() as u32]) {
                Ok(n) => n,
                Err(rc) => return rc,
            };
            let mut req = Vec::with_capacity(req_cap);
            req.extend_from_slice(&k_flags.to_le_bytes());
            req.push(b'/');
            req.extend_from_slice(&rel);
            let rc = crate::kernel_host_interface::trampoline_request_with_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_OPEN,
                &req,
                &mut [],
            );
            if rc < 0 {
                return errno_from_kernel(rc);
            }
            let new_fd_u32 = rc as u32;
            // Record the absolute path for this fd so a later
            // fd_readdir on this fd can ask sys_readdir by path.
            // Build the absolute path the same way the request did
            // (preopen prefix `/` + the relative path bytes).
            let mut abs = Vec::with_capacity(1 + rel.len());
            abs.push(b'/');
            abs.extend_from_slice(&rel);
            // Strip any trailing slash for parity with how kernel
            // paths look (sys_readdir compares to canonical paths).
            if abs.len() > 1 && abs.last() == Some(&b'/') {
                abs.pop();
            }
            caller.data_mut().dir_fds.insert(new_fd_u32 as i32, abs);
            let new_fd = new_fd_u32.to_le_bytes();
            if memory
                .write(&mut caller, ret_fd_ptr as usize, &new_fd)
                .is_err()
            {
                return EINVAL;
            }
            0
        },
    )?;

    // ── fd_filestat_get → sys_fstat (precise size) ──────────────────
    // WASI filestat layout (64 bytes): dev(u64) ino(u64) filetype(u8)
    // pad(7) nlink(u64) size(u64) atim(u64) mtim(u64) ctim(u64). We
    // fill size + filetype from sys_fstat; everything else stays 0.
    linker.func_wrap(
        WASI,
        "fd_filestat_get",
        |mut caller: Caller<'_, UserState>, fd: i32, filestat_ptr: u32| -> i32 {
            let req = (fd as u32).to_le_bytes();
            let mut resp = [0u8; 16];
            let rc = crate::kernel_host_interface::trampoline_request_with_response(
                &mut crate::engine::WasmtimeCtx::new(&mut caller),
                METHOD_FSTAT,
                &req,
                &mut resp,
            );
            if rc != 16 {
                return errno_from_kernel(rc);
            }
            let size = u64::from_le_bytes(resp[0..8].try_into().unwrap());
            let filetype = u32::from_le_bytes(resp[8..12].try_into().unwrap()) as u8;
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EINVAL,
            };
            let mut buf = [0u8; 64];
            // dev / ino zeros are fine.
            buf[16] = filetype;
            // nlink at offset 24: we report 1.
            buf[24..32].copy_from_slice(&1u64.to_le_bytes());
            buf[32..40].copy_from_slice(&size.to_le_bytes());
            // atim/mtim/ctim left zero.
            if memory
                .write(&mut caller, filestat_ptr as usize, &buf)
                .is_err()
            {
                return EINVAL;
            }
            0
        },
    )?;

    // ── path_filestat_get → ENOSYS (typed stub) ─────────────────────
    linker.func_wrap(
        WASI,
        "path_filestat_get",
        |_caller: Caller<'_, UserState>,
         _dirfd: i32,
         _flags: i32,
         _path_ptr: u32,
         _path_len: u32,
         _filestat_ptr: u32|
         -> i32 { ENOSYS },
    )?;

    // random_get: WASI's primary entropy entry point. Rust std
    // (HashMap RandomState), the `getrandom` crate, and wasi-libc
    // (getentropy/getrandom/arc4random) all bottom out here, so it
    // must NOT be an ENOSYS stub. Filled directly from the host OS
    // CSPRNG via the `getrandom` crate (same source as kh_random,
    // PR #95) — mirrors the JS wasi-host's crypto.getRandomValues.
    linker.func_wrap(
        WASI,
        "random_get",
        |mut caller: Caller<'_, UserState>, buf_ptr: u32, buf_len: u32| -> i32 {
            // Bound the guest-controlled length BEFORE allocating.
            // `checked_guest_buffer_len` caps at MAX_GUEST_BUFFER_LEN
            // (1 MiB) — the same checked helper the kernel trampolines
            // use. Without it a guest passing e.g. u32::MAX would drive
            // a multi-GB host allocation (OOM DoS).
            let len = match checked_guest_buffer_len(buf_len) {
                Ok(n) => n,
                Err(_) => return EINVAL,
            };
            if len == 0 {
                return 0;
            }
            let memory = match GuestMemoryHandle::from_caller(&mut caller) {
                Some(m) => m,
                None => return EFAULT,
            };
            let mut buf = vec![0u8; len];
            if getrandom::getrandom(&mut buf).is_err() {
                return EIO;
            }
            if memory.write(&mut caller, buf_ptr as usize, &buf).is_err() {
                return EFAULT;
            }
            0
        },
    )?;

    // ── Catch-all: any other preview1 call returns ENOSYS ──────────
    // Wasmtime requires every imported function to be defined. We
    // can't do a wildcard, so we list the rest as no-arg ENOSYS stubs.
    // Calls with real signatures get typed stubs above; add here only
    // calls that no fixture needs yet.
    for name in [
        "clock_res_get",
        "fd_advise",
        "fd_allocate",
        "fd_fdstat_set_flags",
        "fd_fdstat_set_rights",
        "fd_filestat_set_size",
        "fd_filestat_set_times",
        "fd_pread",
        "fd_pwrite",
        "fd_renumber",
        "fd_tell",
        "path_create_directory",
        "path_filestat_set_times",
        "path_readlink",
        "path_remove_directory",
        "path_symlink",
        "path_unlink_file",
        "poll_oneoff",
        "proc_raise",
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

// Method ids we need; mirrors `kernel_host_interface::sys_method_id`.
const METHOD_WRITE: u32 = 0x1_0014;
const METHOD_READ: u32 = 0x1_0013;
const METHOD_CLOSE: u32 = 0x1_000E;
const METHOD_FSYNC: u32 = 0x1_00A6;
const METHOD_FDATASYNC: u32 = 0x1_00A7;
const METHOD_CLOCK_GETTIME: u32 = 0x1_0016;
const METHOD_OPEN: u32 = 0x1_001F;
const METHOD_LSEEK: u32 = 0x1_0020;
const METHOD_FSTAT: u32 = 0x1_0021;
const METHOD_SYS_READDIR: u32 = 0x1_002B;
const METHOD_SYS_LINK: u32 = 0x1_002D;
const METHOD_SYS_RENAME: u32 = 0x1_002E;

/// Synthetic preopen fd we expose to wasi-libc so its preopen walk
/// terminates with one match: "/". Matches the lowest fd that's
/// neither stdio nor pre-allocated by the kernel-side fd_table.
const PREOPEN_ROOT_FD: i32 = 3;
const PREOPEN_ROOT_NAME: &str = "/";

#[cfg(test)]
mod tests {
    use super::*;
    use yurt_kernel_host_interface_core::MAX_GUEST_BUFFER_LEN;

    #[test]
    fn checked_wasi_guest_len_rejects_oversized_allocations() {
        assert_eq!(
            checked_wasi_guest_len(MAX_GUEST_BUFFER_LEN + 1),
            Err(EINVAL)
        );
    }

    #[test]
    fn checked_wasi_guest_sum_rejects_oversized_iovec_total() {
        assert_eq!(
            checked_wasi_guest_sum(&[MAX_GUEST_BUFFER_LEN, 1]),
            Err(EINVAL)
        );
    }

    #[test]
    fn checked_wasi_iovec_bytes_rejects_too_many_descriptors() {
        assert_eq!(
            checked_wasi_iovec_bytes((MAX_GUEST_BUFFER_LEN / 8) + 1),
            Err(EINVAL)
        );
    }

    #[test]
    fn checked_wasi_iovec_bytes_rejects_descriptor_byte_overflow() {
        assert_eq!(checked_wasi_iovec_bytes(u32::MAX), Err(EINVAL));
    }
}
