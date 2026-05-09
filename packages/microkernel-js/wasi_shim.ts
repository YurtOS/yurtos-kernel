/**
 * WASI preview1 shim for user processes.
 *
 * Routes user-process WASI calls (`fd_write`, `fd_read`, `args_get`,
 * `proc_exit`, …) through our `sys_*` syscalls instead of going to a
 * local WASI ctx. Mirror of
 * `packages/runtime-wasmtime/src/wasi_shim.rs` — same coverage, same
 * fallback to ENOSYS for the rest of preview1.
 */

import { METHOD } from "./mod.ts";
import type { KernelInstance } from "./mod.ts";

const EBADF = 9;
const ESPIPE = 29;
const ENOSYS = 38;

const errnoFromKernel = (rc: number): number => (rc >= 0 ? 0 : -rc);

export function buildWasiShim(
  pid: number,
  kernel: KernelInstance,
  argv: Uint8Array[],
  userMemoryRef: { memory?: WebAssembly.Memory },
): Record<string, (...args: number[] | (number | bigint)[]) => number | never> {
  const um = () => userMemoryRef.memory!.buffer;

  // ── fd_write: read iovecs, sys_write payload (one syscall) ────
  const fd_write = (
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    nwrittenPtr: number,
  ): number => {
    const view = new DataView(um());
    const payload: number[] = [];
    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      const chunk = new Uint8Array(um(), bufPtr, bufLen);
      for (let j = 0; j < bufLen; j++) payload.push(chunk[j]);
    }
    const req = new Uint8Array(4 + payload.length);
    new DataView(req.buffer).setUint32(0, fd >>> 0, true);
    req.set(Uint8Array.from(payload), 4);
    const rc = Number(kernel.syscall(METHOD.SYS_WRITE, pid, req, 0).rc);
    if (rc < 0) return errnoFromKernel(rc);
    view.setUint32(nwrittenPtr, rc, true);
    return 0;
  };

  // ── fd_read: sys_read into kernel scratch, scatter into iovecs ─
  const fd_read = (
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    nreadPtr: number,
  ): number => {
    const view = new DataView(um());
    const iovs: { ptr: number; len: number }[] = [];
    let totalCap = 0;
    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      iovs.push({ ptr: bufPtr, len: bufLen });
      totalCap += bufLen;
    }
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, fd >>> 0, true);
    const cap = Math.min(totalCap, kernel.scratchLen - 4);
    const { rc, response } = kernel.syscall(METHOD.SYS_READ, pid, req, cap);
    const n = Number(rc);
    if (n < 0) return errnoFromKernel(n);
    let written = 0;
    for (const iov of iovs) {
      if (written >= n) break;
      const take = Math.min(n - written, iov.len);
      if (take > 0) {
        new Uint8Array(um(), iov.ptr, take).set(
          response.subarray(written, written + take),
        );
      }
      written += take;
    }
    view.setUint32(nreadPtr, n, true);
    return 0;
  };

  // ── args_get / args_sizes_get: serve UserState.argv ────────────
  const args_get = (argvPtr: number, argvBufPtr: number): number => {
    let bufOff = argvBufPtr;
    const view = new DataView(um());
    for (let i = 0; i < argv.length; i++) {
      view.setUint32(argvPtr + i * 4, bufOff, true);
      new Uint8Array(um(), bufOff, argv[i].byteLength).set(argv[i]);
      new Uint8Array(um(), bufOff + argv[i].byteLength, 1)[0] = 0;
      bufOff += argv[i].byteLength + 1;
    }
    return 0;
  };
  const args_sizes_get = (countPtr: number, sizePtr: number): number => {
    const view = new DataView(um());
    view.setUint32(countPtr, argv.length, true);
    let size = 0;
    for (const a of argv) size += a.byteLength + 1;
    view.setUint32(sizePtr, size, true);
    return 0;
  };

  // ── environ_get / environ_sizes_get: empty env for now ────────
  const environ_get = () => 0;
  const environ_sizes_get = (countPtr: number, sizePtr: number): number => {
    const view = new DataView(um());
    view.setUint32(countPtr, 0, true);
    view.setUint32(sizePtr, 0, true);
    return 0;
  };

  // ── fd_close → sys_close ──────────────────────────────────────
  const fd_close = (fd: number): number => {
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, fd >>> 0, true);
    const rc = Number(kernel.syscall(METHOD.SYS_CLOSE, pid, req, 0).rc);
    return errnoFromKernel(rc);
  };

  // ── fd_seek: ESPIPE; fd_fdstat_get: minimal CHARACTER_DEVICE ──
  const fd_seek = (): number => ESPIPE;
  const fd_fdstat_get = (fd: number, statbuf: number): number => {
    if (fd < 0 || fd > 2) return EBADF;
    const buf = new Uint8Array(um(), statbuf, 24);
    buf.fill(0);
    buf[0] = 2; // CHARACTER_DEVICE
    const view = new DataView(um());
    const rights = (1n << 1n) | (1n << 6n);
    view.setBigUint64(statbuf + 8, rights, true);
    view.setBigUint64(statbuf + 16, rights, true);
    return 0;
  };

  // ── proc_exit: trap with the exit code ────────────────────────
  const proc_exit = (rval: number): never => {
    throw new Error(`user process called proc_exit(${rval})`);
  };

  // ── clock_time_get: route to sys_clock_gettime ────────────────
  const clock_time_get = (
    clockId: number,
    _precision: bigint,
    timePtr: number,
  ): number => {
    const mapped = clockId === 0 ? 0 : clockId === 1 || clockId === 2 ||
        clockId === 3
      ? 1
      : -1;
    if (mapped < 0) return 22; // EINVAL
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, mapped, true);
    const { rc, response } = kernel.syscall(
      METHOD.SYS_CLOCK_GETTIME,
      pid,
      req,
      8,
    );
    const n = Number(rc);
    if (n !== 8) return errnoFromKernel(n);
    new Uint8Array(um(), timePtr, 8).set(response.subarray(0, 8));
    return 0;
  };

  const implemented = {
    fd_write,
    fd_read,
    fd_close,
    fd_seek,
    fd_fdstat_get,
    proc_exit,
    clock_time_get,
    args_get,
    args_sizes_get,
    environ_get,
    environ_sizes_get,
  };

  // Catch-all ENOSYS for the rest of preview1. Stays as data so
  // adding new fixtures only requires moving an entry from this list
  // up into `implemented` above.
  const enosys = (): number => ENOSYS;
  const stubs: Record<string, (...args: number[]) => number> = {};
  for (
    const name of [
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
    ]
  ) {
    stubs[name] = enosys;
  }

  // deno-lint-ignore no-explicit-any
  return { ...implemented, ...stubs } as any;
}
