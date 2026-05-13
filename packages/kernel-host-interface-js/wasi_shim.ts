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

// WASI preview1 errno values (NOT the POSIX values — wasi-libc uses
// the spec enum below, e.g. EBADF=8 not 9). These shim returns are
// what wasi-libc reads literally.
const EBADF = 8;
const EINVAL = 28;
const ESPIPE = 70;
const ENOSYS = 52;

/**
 * Map kernel-side POSIX errno → WASI preview1 errno.
 */
const posixToWasi = (posix: number): number => {
  switch (posix) {
    case 0:
      return 0;
    case 1:
      return 63; // EPERM
    case 2:
      return 44; // ENOENT
    case 9:
      return 8; // EBADF
    case 11:
      return 6; // EAGAIN
    case 22:
      return 28; // EINVAL
    case 29:
      return 70; // ESPIPE
    case 32:
      return 64; // EPIPE
    case 38:
      return 52; // ENOSYS
    default:
      return 28; // EINVAL fallback
  }
};

// Synthetic preopen so wasi-libc's preopen walk terminates with one
// match: "/". Mirrors wasi_shim.rs PREOPEN_ROOT_FD / PREOPEN_ROOT_NAME.
const PREOPEN_ROOT_FD = 3;
const PREOPEN_ROOT_NAME = "/";

const errnoFromKernel = (rc: number): number => rc >= 0 ? 0 : posixToWasi(-rc);

export function buildWasiShim(
  pid: number,
  kernel: KernelInstance,
  argv: Uint8Array[],
  userMemoryRef: { memory?: WebAssembly.Memory },
): Record<string, (...args: number[] | (number | bigint)[]) => number | never> {
  const um = () => userMemoryRef.memory!.buffer;
  let nextGuestFd = PREOPEN_ROOT_FD + 1;
  const guestToKernelFd = new Map<number, number>();
  const dirFds = new Map<number, Uint8Array>([
    [PREOPEN_ROOT_FD, new TextEncoder().encode(PREOPEN_ROOT_NAME)],
  ]);

  const preopenAbsPath = (pathPtr: number, pathLen: number): Uint8Array => {
    const rel = new Uint8Array(um(), pathPtr, pathLen).slice();
    const out = new Uint8Array(1 + rel.byteLength);
    out[0] = 0x2f; // '/'
    out.set(rel, 1);
    return out;
  };

  const pathPairRequest = (
    oldPathPtr: number,
    oldPathLen: number,
    newPathPtr: number,
    newPathLen: number,
  ): Uint8Array => {
    const oldAbs = preopenAbsPath(oldPathPtr, oldPathLen);
    const newAbs = preopenAbsPath(newPathPtr, newPathLen);
    const req = new Uint8Array(4 + oldAbs.byteLength + newAbs.byteLength);
    const view = new DataView(req.buffer);
    view.setUint32(0, oldAbs.byteLength, true);
    req.set(oldAbs, 4);
    req.set(newAbs, 4 + oldAbs.byteLength);
    return req;
  };

  const kernelFd = (fd: number): number | undefined => {
    if (fd >= 0 && fd <= 2) return fd;
    return guestToKernelFd.get(fd);
  };

  const allocGuestFd = (kfd: number): number => {
    while (
      guestToKernelFd.has(nextGuestFd) || nextGuestFd === PREOPEN_ROOT_FD
    ) {
      nextGuestFd++;
    }
    const guestFd = nextGuestFd++;
    guestToKernelFd.set(guestFd, kfd);
    return guestFd;
  };

  const writeFilestat = (
    filestatPtr: number,
    response: Uint8Array,
  ): number => {
    const responseView = new DataView(response.buffer, response.byteOffset);
    const size = responseView.getBigUint64(0, true);
    const filetype = responseView.getUint32(8, true);
    const buf = new Uint8Array(64);
    const view = new DataView(buf.buffer);
    buf[16] = filetype & 0xff;
    view.setBigUint64(24, 1n, true); // nlink = 1
    view.setBigUint64(32, size, true);
    new Uint8Array(um(), filestatPtr, 64).set(buf);
    return 0;
  };

  // ── fd_write: read iovecs, sys_write payload (one syscall) ────
  const fd_write = (
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    nwrittenPtr: number,
  ): number => {
    const kfd = kernelFd(fd);
    if (kfd === undefined) return EBADF;
    const view = new DataView(um());
    const payload: number[] = [];
    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      const chunk = new Uint8Array(um(), bufPtr, bufLen);
      for (let j = 0; j < bufLen; j++) payload.push(chunk[j]);
    }
    const req = new Uint8Array(4 + payload.length);
    new DataView(req.buffer).setUint32(0, kfd >>> 0, true);
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
    const kfd = kernelFd(fd);
    if (kfd === undefined) return EBADF;
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
    new DataView(req.buffer).setUint32(0, kfd >>> 0, true);
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
    const kfd = kernelFd(fd);
    if (kfd === undefined) return EBADF;
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, kfd >>> 0, true);
    const rc = Number(kernel.syscall(METHOD.SYS_CLOSE, pid, req, 0).rc);
    if (rc >= 0) {
      dirFds.delete(fd);
      guestToKernelFd.delete(fd);
    }
    return errnoFromKernel(rc);
  };

  // ── fd_seek: route to sys_lseek ────────────────────────────────
  const fd_seek = (
    fd: number,
    offset: bigint | number,
    whence: number,
    newOffsetPtr: number,
  ): number => {
    const kfd = kernelFd(fd);
    if (kfd === undefined) return EBADF;
    const off64 = typeof offset === "bigint" ? offset : BigInt(offset);
    const req = new Uint8Array(16);
    const view = new DataView(req.buffer);
    view.setUint32(0, kfd >>> 0, true);
    view.setBigInt64(4, off64, true);
    view.setUint32(12, whence >>> 0, true);
    const { rc, response } = kernel.syscall(METHOD.SYS_LSEEK, pid, req, 8);
    const n = Number(rc);
    if (n < 0) {
      const err = errnoFromKernel(n);
      return err === EBADF ? ESPIPE : err;
    }
    new Uint8Array(um(), newOffsetPtr, 8).set(response.subarray(0, 8));
    return 0;
  };
  const fd_tell = (fd: number, offsetPtr: number): number => {
    const kfd = kernelFd(fd);
    if (kfd === undefined) return EBADF;
    const req = new Uint8Array(16);
    const view = new DataView(req.buffer);
    view.setUint32(0, kfd >>> 0, true);
    view.setBigInt64(4, 0n, true);
    view.setUint32(12, 1, true); // SEEK_CUR
    const { rc, response } = kernel.syscall(METHOD.SYS_LSEEK, pid, req, 8);
    const n = Number(rc);
    if (n !== 8) return errnoFromKernel(n);
    new Uint8Array(um(), offsetPtr, 8).set(response.subarray(0, 8));
    return 0;
  };
  const fd_fdstat_set_flags = (_fd: number, _fdflags: number): number => 0;
  const fd_fdstat_get = (fd: number, statbuf: number): number => {
    const buf = new Uint8Array(um(), statbuf, 24);
    buf.fill(0);
    const view = new DataView(um());
    if (fd >= 0 && fd <= 2) {
      buf[0] = 2; // CHARACTER_DEVICE
      const rights = (1n << 1n) | (1n << 6n);
      view.setBigUint64(statbuf + 8, rights, true);
      view.setBigUint64(statbuf + 16, rights, true);
      return 0;
    }
    if (fd === PREOPEN_ROOT_FD) {
      buf[0] = 3; // DIRECTORY
      view.setBigUint64(statbuf + 8, 0xffffffffffffffffn, true);
      view.setBigUint64(statbuf + 16, 0xffffffffffffffffn, true);
      return 0;
    }
    if (guestToKernelFd.has(fd)) {
      buf[0] = 4; // REGULAR_FILE
      view.setBigUint64(statbuf + 8, 0xffffffffffffffffn, true);
      view.setBigUint64(statbuf + 16, 0xffffffffffffffffn, true);
      return 0;
    }
    return EBADF;
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

  // ── Preopen surface: fd 3 = "/" ────────────────────────────────
  const fd_prestat_get = (fd: number, prestatPtr: number): number => {
    if (fd !== PREOPEN_ROOT_FD) return EBADF;
    const view = new DataView(um());
    view.setUint8(prestatPtr, 0); // PREOPENTYPE_DIR
    view.setUint32(prestatPtr + 4, PREOPEN_ROOT_NAME.length, true);
    return 0;
  };
  const fd_prestat_dir_name = (
    fd: number,
    pathPtr: number,
    pathLen: number,
  ): number => {
    if (fd !== PREOPEN_ROOT_FD) return EBADF;
    if (pathLen < PREOPEN_ROOT_NAME.length) return EINVAL;
    const bytes = new TextEncoder().encode(PREOPEN_ROOT_NAME);
    new Uint8Array(um(), pathPtr, bytes.length).set(bytes);
    return 0;
  };
  const path_open = (
    dirfd: number,
    _dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    fsRightsBase: bigint,
    _fsRightsInheriting: bigint,
    _fdflags: number,
    retFdPtr: number,
  ): number => {
    if (dirfd !== PREOPEN_ROOT_FD) return EBADF;
    const rel = new Uint8Array(um(), pathPtr, pathLen).slice();
    // Map WASI oflags + rights → kernel sys_open flags.
    // WASI oflags: CREAT=1, DIRECTORY=2, EXCL=4, TRUNC=8.
    // WASI rights: FD_WRITE = bit 6.
    const wantWrite = (fsRightsBase & (1n << 6n)) !== 0n;
    let kFlags = 0;
    if (wantWrite) kFlags |= 0b001;
    if (oflags & 0b0001) kFlags |= 0b010; // CREAT
    if (oflags & 0b1000) kFlags |= 0b100; // TRUNC
    // Build "u32 flags + '/' + relpath".
    const req = new Uint8Array(4 + 1 + rel.length);
    new DataView(req.buffer).setUint32(0, kFlags >>> 0, true);
    req[4] = 0x2f; // '/'
    req.set(rel, 5);
    const { rc } = kernel.syscall(METHOD.SYS_OPEN, pid, req, 0);
    const n = Number(rc);
    if (n < 0) return errnoFromKernel(n);
    const guestFd = allocGuestFd(n);
    new DataView(um()).setUint32(retFdPtr, guestFd >>> 0, true);
    let abs = req.slice(4);
    if (abs.byteLength > 1 && abs[abs.byteLength - 1] === 0x2f) {
      abs = abs.slice(0, abs.byteLength - 1);
    }
    dirFds.set(guestFd, abs);
    return 0;
  };

  const fd_readdir = (
    fd: number,
    bufPtr: number,
    bufLen: number,
    cookie: bigint | number,
    bufusedPtr: number,
  ): number => {
    const path = dirFds.get(fd);
    if (!path) return EBADF;
    const { rc, response } = kernel.syscall(
      METHOD.SYS_READDIR,
      pid,
      path,
      64 * 1024,
    );
    const n = Number(rc);
    if (n < 0) return errnoFromKernel(n);
    if (n < 4) return EINVAL;
    const resp = response.subarray(0, n);
    const responseView = new DataView(
      resp.buffer,
      resp.byteOffset,
      resp.byteLength,
    );
    const count = responseView.getUint32(0, true);
    const start = typeof cookie === "bigint" ? Number(cookie) : cookie;
    let cur = 4;
    let written = 0;
    const mem = new Uint8Array(um());
    const memView = new DataView(um());
    for (let idx = 0; idx < count; idx++) {
      if (cur + 5 > resp.byteLength) break;
      const nameLen = responseView.getUint32(cur, true);
      cur += 4;
      const filetype = resp[cur++];
      if (cur + nameLen > resp.byteLength) break;
      const name = resp.subarray(cur, cur + nameLen);
      cur += nameLen;
      if (idx < start) continue;
      const need = 24 + nameLen;
      if (written + need > bufLen) break;
      const out = bufPtr + written;
      memView.setBigUint64(out, BigInt(idx + 1), true);
      memView.setBigUint64(out + 8, 0n, true);
      memView.setUint32(out + 16, nameLen, true);
      mem[out + 20] = filetype;
      mem.set(name, out + 24);
      written += need;
    }
    memView.setUint32(bufusedPtr, written, true);
    return 0;
  };

  const path_rename = (
    oldDirfd: number,
    oldPathPtr: number,
    oldPathLen: number,
    newDirfd: number,
    newPathPtr: number,
    newPathLen: number,
  ): number => {
    if (oldDirfd !== PREOPEN_ROOT_FD || newDirfd !== PREOPEN_ROOT_FD) {
      return EBADF;
    }
    const req = pathPairRequest(oldPathPtr, oldPathLen, newPathPtr, newPathLen);
    const rc = Number(kernel.syscall(METHOD.SYS_RENAME, pid, req, 0).rc);
    return errnoFromKernel(rc);
  };

  const path_link = (
    oldDirfd: number,
    _oldFlags: number,
    oldPathPtr: number,
    oldPathLen: number,
    newDirfd: number,
    newPathPtr: number,
    newPathLen: number,
  ): number => {
    if (oldDirfd !== PREOPEN_ROOT_FD || newDirfd !== PREOPEN_ROOT_FD) {
      return EBADF;
    }
    const req = pathPairRequest(oldPathPtr, oldPathLen, newPathPtr, newPathLen);
    const rc = Number(kernel.syscall(METHOD.SYS_LINK, pid, req, 0).rc);
    return errnoFromKernel(rc);
  };

  const path_unlink_file = (
    dirfd: number,
    pathPtr: number,
    pathLen: number,
  ): number => {
    if (dirfd !== PREOPEN_ROOT_FD) return EBADF;
    const rc = Number(
      kernel.syscall(
        METHOD.SYS_UNLINK,
        pid,
        preopenAbsPath(pathPtr, pathLen),
        0,
      )
        .rc,
    );
    return errnoFromKernel(rc);
  };

  const path_create_directory = (
    dirfd: number,
    pathPtr: number,
    pathLen: number,
  ): number => {
    if (dirfd !== PREOPEN_ROOT_FD) return EBADF;
    const rc = Number(
      kernel.syscall(
        METHOD.SYS_MKDIR,
        pid,
        preopenAbsPath(pathPtr, pathLen),
        0,
      ).rc,
    );
    return errnoFromKernel(rc);
  };

  const path_remove_directory = (
    dirfd: number,
    pathPtr: number,
    pathLen: number,
  ): number => {
    if (dirfd !== PREOPEN_ROOT_FD) return EBADF;
    const rc = Number(
      kernel.syscall(
        METHOD.SYS_RMDIR,
        pid,
        preopenAbsPath(pathPtr, pathLen),
        0,
      ).rc,
    );
    return errnoFromKernel(rc);
  };

  const path_symlink = (
    oldPathPtr: number,
    oldPathLen: number,
    dirfd: number,
    newPathPtr: number,
    newPathLen: number,
  ): number => {
    if (dirfd !== PREOPEN_ROOT_FD) return EBADF;
    const target = new Uint8Array(um(), oldPathPtr, oldPathLen).slice();
    const linkPath = preopenAbsPath(newPathPtr, newPathLen);
    const req = new Uint8Array(4 + target.byteLength + linkPath.byteLength);
    new DataView(req.buffer).setUint32(0, target.byteLength >>> 0, true);
    req.set(target, 4);
    req.set(linkPath, 4 + target.byteLength);
    const rc = Number(kernel.syscall(METHOD.SYS_SYMLINK, pid, req, 0).rc);
    return errnoFromKernel(rc);
  };

  const path_readlink = (
    dirfd: number,
    pathPtr: number,
    pathLen: number,
    outPtr: number,
    outCap: number,
    outLenPtr: number,
  ): number => {
    if (dirfd !== PREOPEN_ROOT_FD) return EBADF;
    const { rc, response } = kernel.syscall(
      METHOD.SYS_READLINK,
      pid,
      preopenAbsPath(pathPtr, pathLen),
      outCap,
    );
    const n = Number(rc);
    if (n < 0) return errnoFromKernel(n);
    new Uint8Array(um(), outPtr, n).set(response.subarray(0, n));
    new DataView(um()).setUint32(outLenPtr, n >>> 0, true);
    return 0;
  };

  // Typed ENOSYS stubs for calls that have non-no-arg signatures and
  // get invoked by wasi-libc but aren't yet implemented. std::fs::read
  // calls fd_filestat_get to size the buffer; ENOSYS is fine since std
  // falls back to chunked reads.
  const fd_filestat_get = (fd: number, filestatPtr: number): number => {
    const kfd = kernelFd(fd);
    if (kfd === undefined) return EBADF;
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, kfd >>> 0, true);
    const { rc, response } = kernel.syscall(METHOD.SYS_FSTAT, pid, req, 16);
    const n = Number(rc);
    if (n !== 16) return errnoFromKernel(n);
    return writeFilestat(filestatPtr, response);
  };
  const path_filestat_get = (
    dirfd: number,
    _flags: number,
    pathPtr: number,
    pathLen: number,
    filestatPtr: number,
  ): number => {
    if (dirfd !== PREOPEN_ROOT_FD) return EBADF;
    const { rc, response } = kernel.syscall(
      METHOD.SYS_STAT,
      pid,
      preopenAbsPath(pathPtr, pathLen),
      16,
    );
    const n = Number(rc);
    if (n !== 16) return errnoFromKernel(n);
    return writeFilestat(filestatPtr, response);
  };

  const implemented = {
    fd_write,
    fd_read,
    fd_close,
    fd_seek,
    fd_tell,
    fd_fdstat_get,
    fd_fdstat_set_flags,
    fd_filestat_get,
    proc_exit,
    clock_time_get,
    args_get,
    args_sizes_get,
    environ_get,
    environ_sizes_get,
    fd_prestat_get,
    fd_prestat_dir_name,
    fd_readdir,
    path_open,
    path_create_directory,
    path_filestat_get,
    path_link,
    path_readlink,
    path_remove_directory,
    path_rename,
    path_symlink,
    path_unlink_file,
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
      "fd_fdstat_set_rights",
      "fd_filestat_set_size",
      "fd_filestat_set_times",
      "fd_pread",
      "fd_pwrite",
      "fd_renumber",
      "fd_sync",
      "path_filestat_set_times",
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
