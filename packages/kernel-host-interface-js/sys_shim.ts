/**
 * `sys_*` import shims for user processes.
 *
 * One TS function per syscall, each forwarding to `kernel_dispatch`
 * via the kernel handle. Method ids and request/response shapes
 * mirror `packages/runtime-wasmtime/src/kernel_host_interface.rs::register_sys_imports`
 * — same byte layouts, same scalar conventions.
 */

import { METHOD } from "./mod.ts";
import type { KernelInstance } from "./mod.ts";

const EFAULT = 14;
const EINVAL = 22;
const POLLFD_SIZE = 8;

/**
 * Build the env-namespace import object for a user-process linker.
 * `pid` is the caller_pid the kernel sees; `userMemoryRef.memory`
 * resolves the user's exported memory at call time.
 */
export function buildSysImports(
  pid: number,
  kernel: KernelInstance,
  userMemoryRef: { memory?: WebAssembly.Memory },
): Record<string, (...args: number[]) => number> {
  const um = () => userMemoryRef.memory!.buffer;
  const boundsOk = (ptr: number, len: number): boolean => {
    const buf = um();
    ptr = ptr >>> 0;
    len = len >>> 0;
    return ptr <= buf.byteLength && len <= buf.byteLength - ptr;
  };
  const copyIn = (ptr: number, len: number): Uint8Array | number => {
    ptr = ptr >>> 0;
    len = len >>> 0;
    if (!boundsOk(ptr, len)) return -EFAULT;
    return new Uint8Array(um(), ptr, len).slice();
  };
  const copyOut = (ptr: number, bytes: Uint8Array): number => {
    ptr = ptr >>> 0;
    if (!boundsOk(ptr, bytes.byteLength)) return -EFAULT;
    new Uint8Array(um(), ptr, bytes.byteLength).set(bytes);
    return 0;
  };

  const forwardScalar = (methodId: number): number =>
    Number(kernel.syscall(methodId, pid, new Uint8Array(0), 0).rc);

  const forwardRequestBytes = (methodId: number, req: Uint8Array): number =>
    Number(kernel.syscall(methodId, pid, req, 0).rc);

  const forwardRequestWithResponse = (
    methodId: number,
    req: Uint8Array,
    cap: number,
  ): { rc: number; response: Uint8Array } => {
    const r = kernel.syscall(methodId, pid, req, cap);
    return { rc: Number(r.rc), response: r.response };
  };

  const u32 = (n: number): Uint8Array => {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setUint32(0, n >>> 0, true);
    return a;
  };

  return {
    sys_getuid: () => forwardScalar(METHOD.SYS_GETUID),
    sys_geteuid: () => forwardScalar(METHOD.SYS_GETEUID),
    sys_getgid: () => forwardScalar(METHOD.SYS_GETGID),
    sys_getegid: () => forwardScalar(METHOD.SYS_GETEGID),
    sys_getpid: () => forwardScalar(METHOD.SYS_GETPID),
    sys_getppid: () => forwardScalar(METHOD.SYS_GETPPID),

    sys_umask: (mask) => forwardRequestBytes(METHOD.SYS_UMASK, u32(mask)),

    sys_setresuid: (ruid, euid, suid) => {
      const req = new Uint8Array(12);
      const v = new DataView(req.buffer);
      v.setUint32(0, ruid >>> 0, true);
      v.setUint32(4, euid >>> 0, true);
      v.setUint32(8, suid >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_SETRESUID, req);
    },
    sys_setresgid: (rgid, egid, sgid) => {
      const req = new Uint8Array(12);
      const v = new DataView(req.buffer);
      v.setUint32(0, rgid >>> 0, true);
      v.setUint32(4, egid >>> 0, true);
      v.setUint32(8, sgid >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_SETRESGID, req);
    },

    sys_chdir: (pathPtr, pathLen) => {
      const buf = copyIn(pathPtr, pathLen);
      if (typeof buf === "number") return buf;
      return forwardRequestBytes(METHOD.SYS_CHDIR, buf);
    },
    sys_getcwd: (outPtr, outCap) => {
      const cap = Math.min(outCap, kernel.scratchLen);
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_GETCWD,
        new Uint8Array(0),
        cap,
      );
      if (rc <= 0) return rc;
      const toCopy = Math.min(rc, cap);
      const outRc = copyOut(outPtr, response.subarray(0, toCopy));
      if (outRc < 0) return outRc;
      return rc;
    },

    sys_getrlimit: (resource, outPtr) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_GETRLIMIT,
        u32(resource),
        16,
      );
      if (rc === 16) {
        const outRc = copyOut(outPtr, response.subarray(0, 16));
        if (outRc < 0) return outRc;
        return 0;
      }
      return rc;
    },
    // setrlimit takes (i32, i64, i64) at the wasm import boundary.
    // BigInts aren't representable in this Record signature, so the
    // kernel_host_interface registers it directly. See mod.ts.

    sys_close: (fd) => forwardRequestBytes(METHOD.SYS_CLOSE, u32(fd)),
    sys_dup: (oldfd) => forwardRequestBytes(METHOD.SYS_DUP, u32(oldfd)),
    sys_dup2: (oldfd, newfd) => {
      const req = new Uint8Array(8);
      const v = new DataView(req.buffer);
      v.setUint32(0, oldfd >>> 0, true);
      v.setUint32(4, newfd >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_DUP2, req);
    },
    sys_dup_min: (oldfd, minfd) => {
      const req = new Uint8Array(8);
      const v = new DataView(req.buffer);
      v.setUint32(0, oldfd >>> 0, true);
      v.setUint32(4, minfd >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_DUP_MIN, req);
    },
    sys_set_fd_descriptor_flags: (fd, flags) => {
      const req = new Uint8Array(8);
      const v = new DataView(req.buffer);
      v.setUint32(0, fd >>> 0, true);
      v.setUint32(4, flags >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_SET_FD_DESCRIPTOR_FLAGS, req);
    },

    sys_pipe: (outPtr) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_PIPE,
        new Uint8Array(0),
        8,
      );
      if (rc === 8) {
        const outRc = copyOut(outPtr, response.subarray(0, 8));
        if (outRc < 0) return outRc;
        return 0;
      }
      return rc;
    },
    sys_read: (fd, outPtr, outCap) => {
      const cap = Math.min(outCap, kernel.scratchLen - 4);
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_READ,
        u32(fd),
        cap,
      );
      if (rc <= 0) return rc;
      const outRc = copyOut(outPtr, response.subarray(0, rc));
      if (outRc < 0) return outRc;
      return rc;
    },
    sys_write: (fd, bufPtr, len) => {
      const payload = copyIn(bufPtr, len);
      if (typeof payload === "number") return payload;
      const req = new Uint8Array(4 + payload.byteLength);
      new DataView(req.buffer).setUint32(0, fd >>> 0, true);
      req.set(payload, 4);
      return forwardRequestBytes(METHOD.SYS_WRITE, req);
    },
    sys_poll: (fdsPtr, nfds, timeoutMs) => {
      if (nfds < 0) return -EINVAL;
      const len = nfds * POLLFD_SIZE;
      if (!Number.isSafeInteger(len)) return -EINVAL;
      const fds = copyIn(fdsPtr, len);
      if (typeof fds === "number") return fds;
      const req = new Uint8Array(4 + fds.byteLength);
      const view = new DataView(req.buffer);
      view.setInt32(0, timeoutMs | 0, true);
      req.set(fds, 4);
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_POLL,
        req,
        fds.byteLength,
      );
      if (rc >= 0) {
        const outRc = copyOut(fdsPtr, response.subarray(0, fds.byteLength));
        if (outRc < 0) return outRc;
      }
      return rc;
    },

    sys_isatty: (fd) => forwardRequestBytes(METHOD.SYS_ISATTY, u32(fd)),
    sys_tcgetpgrp: (fd) => forwardRequestBytes(METHOD.SYS_TCGETPGRP, u32(fd)),
    sys_tcsetpgrp: (fd, pgid) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, pgid >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_TCSETPGRP, req);
    },
    sys_tcgetattr: (fd, outPtr, outCap) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_TCGETATTR,
        u32(fd),
        outCap >>> 0,
      );
      if (rc >= 0 && rc <= outCap) {
        const outRc = copyOut(outPtr, response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      return rc;
    },
    sys_tcsetattr: (fd, actions) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, actions >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_TCSETATTR, req);
    },
    sys_winsize: (fd, outPtr, outCap) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_WINSIZE,
        u32(fd),
        outCap >>> 0,
      );
      if (rc >= 0 && rc <= outCap) {
        const outRc = copyOut(outPtr, response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      return rc;
    },
    sys_tiocsctty: (fd) => forwardRequestBytes(METHOD.SYS_TIOCSCTTY, u32(fd)),
    sys_getpgid: (pid) => forwardRequestBytes(METHOD.SYS_GETPGID, u32(pid)),
    sys_sched_getaffinity: (pid, maskPtr, cpusetsize) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, pid >>> 0, true);
      view.setUint32(4, cpusetsize >>> 0, true);
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_SCHED_GETAFFINITY,
        req,
        cpusetsize >>> 0,
      );
      if (rc >= 0 && rc <= cpusetsize) {
        const outRc = copyOut(maskPtr, response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      return rc;
    },
    sys_sched_setaffinity: (pid, maskPtr, cpusetsize) => {
      const mask = copyIn(maskPtr, cpusetsize >>> 0);
      if (typeof mask === "number") return mask;
      const req = new Uint8Array(8 + mask.byteLength);
      const view = new DataView(req.buffer);
      view.setUint32(0, pid >>> 0, true);
      view.setUint32(4, cpusetsize >>> 0, true);
      req.set(mask, 8);
      return forwardRequestBytes(METHOD.SYS_SCHED_SETAFFINITY, req);
    },
    sys_setpgid: (pid, pgid) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, pid >>> 0, true);
      view.setUint32(4, pgid >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_SETPGID, req);
    },
    sys_getsid: (pid) => forwardRequestBytes(METHOD.SYS_GETSID, u32(pid)),
    sys_setsid: () => forwardRequestBytes(METHOD.SYS_SETSID, new Uint8Array(0)),
    sys_kill: (pid, sig) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, pid >>> 0, true);
      view.setUint32(4, sig >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_KILL, req);
    },
    sys_killpg: (pgid, sig) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, pgid >>> 0, true);
      view.setUint32(4, sig >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_KILLPG, req);
    },
    sys_sigaction: (sig, disposition) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, sig >>> 0, true);
      view.setUint32(4, disposition >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_SIGACTION, req);
    },
    sys_sched_yield: () =>
      forwardRequestBytes(METHOD.SYS_SCHED_YIELD, new Uint8Array(0)),
    sys_open: (flags, pathPtr, pathLen) => {
      const path = copyIn(pathPtr, pathLen);
      if (typeof path === "number") return path;
      const req = new Uint8Array(4 + path.byteLength);
      new DataView(req.buffer).setUint32(0, flags >>> 0, true);
      req.set(path, 4);
      return forwardRequestBytes(METHOD.SYS_OPEN, req);
    },
    sys_lseek: (fd, offset, whence, outPtr) => {
      const off64 = typeof offset === "bigint" ? offset : BigInt(offset);
      const req = new Uint8Array(16);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setBigInt64(4, off64, true);
      view.setUint32(12, whence >>> 0, true);
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_LSEEK,
        req,
        8,
      );
      if (rc !== 8) return rc;
      const outRc = copyOut(outPtr, response.subarray(0, 8));
      if (outRc < 0) return outRc;
      return 0;
    },
    sys_fstat: (fd, outPtr) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_FSTAT,
        u32(fd),
        16,
      );
      if (rc !== 16) return rc;
      const outRc = copyOut(outPtr, response.subarray(0, 16));
      if (outRc < 0) return outRc;
      return 0;
    },
    sys_nanosleep: (ns) => {
      // `ns` arrives as a JS bigint when the wasm import is declared
      // with an i64 parameter type; coerce defensively for hosts that
      // hand us a number-shaped 32-bit value instead.
      const ns64 = typeof ns === "bigint" ? ns : BigInt(ns >>> 0);
      const req = new Uint8Array(8);
      new DataView(req.buffer).setBigUint64(0, ns64, true);
      return forwardRequestBytes(METHOD.SYS_NANOSLEEP, req);
    },
    sys_clock_gettime: (clockId, outPtr) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_CLOCK_GETTIME,
        u32(clockId),
        8,
      );
      if (rc === 8) {
        const outRc = copyOut(outPtr, response.subarray(0, 8));
        if (outRc < 0) return outRc;
        return 0;
      }
      return rc;
    },
    // ── Networking + KV imports ──────────────────────────────────
    // Mirror the wasmtime side's register_sys_imports surface so
    // user processes call the same env-namespaced symbols on
    // either kernel_host_interface.
    sys_fetch: (reqPtr, reqLen, outPtr, outCap) => {
      const req = copyIn(reqPtr, reqLen);
      if (typeof req === "number") return req;
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_FETCH,
        req,
        outCap,
      );
      if (rc > 0) {
        const outRc = copyOut(outPtr, response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      return rc;
    },
    sys_socket_connect: (fd, addrPtr, addrLen) => {
      const addr = copyIn(addrPtr, addrLen);
      if (typeof addr === "number") return addr;
      const req = new Uint8Array(4 + addr.byteLength);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      req.set(addr, 4);
      return forwardRequestBytes(METHOD.SYS_SOCKET_CONNECT, req);
    },
    sys_socket_send: (fd, dataPtr, dataLen) => {
      const data = copyIn(dataPtr, dataLen);
      if (typeof data === "number") return data;
      const req = new Uint8Array(4 + data.byteLength);
      new DataView(req.buffer).setUint32(0, fd >>> 0, true);
      req.set(data, 4);
      return forwardRequestBytes(METHOD.SYS_SOCKET_SEND, req);
    },
    sys_socket_recv: (fd, outPtr, outCap, flags) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, flags >>> 0, true);
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_SOCKET_RECV,
        req,
        outCap,
      );
      if (rc > 0) {
        const outRc = copyOut(outPtr, response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      return rc;
    },
    sys_socket_close: (fd) =>
      forwardRequestBytes(METHOD.SYS_SOCKET_CLOSE, u32(fd)),
    sys_socketpair: (family, sockType, flags, outPtr) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      req[0] = family & 0xff;
      req[1] = sockType & 0xff;
      view.setUint32(4, flags >>> 0, true);
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_SOCKETPAIR,
        req,
        8,
      );
      if (rc > 0) {
        const outRc = copyOut(outPtr, response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      return rc;
    },
    sys_socket_open: (family, sockType, flags) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      req[0] = family & 0xff;
      req[1] = sockType & 0xff;
      view.setUint32(4, flags >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_SOCKET_OPEN, req);
    },
    sys_socket_bind: (fd, addrPtr, addrLen) => {
      const addr = copyIn(addrPtr, addrLen);
      if (typeof addr === "number") return addr;
      const req = new Uint8Array(4 + addr.byteLength);
      new DataView(req.buffer).setUint32(0, fd >>> 0, true);
      req.set(addr, 4);
      return forwardRequestBytes(METHOD.SYS_SOCKET_BIND, req);
    },
    sys_socket_sendto: (fd, dataPtr, dataLen, flags, addrPtr, addrLen) => {
      const data = copyIn(dataPtr, dataLen);
      if (typeof data === "number") return data;
      const addr = copyIn(addrPtr, addrLen);
      if (typeof addr === "number") return addr;
      const req = new Uint8Array(12 + addr.byteLength + data.byteLength);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, flags >>> 0, true);
      view.setUint32(8, addr.byteLength >>> 0, true);
      req.set(addr, 12);
      req.set(data, 12 + addr.byteLength);
      return forwardRequestBytes(METHOD.SYS_SOCKET_SENDTO, req);
    },
    sys_socket_sendmsg: (fd, dataPtr, dataLen, fdsPtr, fdsCount) => {
      const data = copyIn(dataPtr, dataLen);
      if (typeof data === "number") return data;
      const fdsBytes = fdsCount > 0
        ? copyIn(fdsPtr, fdsCount * 4)
        : new Uint8Array();
      if (typeof fdsBytes === "number") return fdsBytes;
      const req = new Uint8Array(12 + data.byteLength + fdsBytes.byteLength);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, data.byteLength >>> 0, true);
      view.setUint32(8, fdsCount >>> 0, true);
      req.set(data, 12);
      req.set(fdsBytes, 12 + data.byteLength);
      return forwardRequestBytes(METHOD.SYS_SOCKET_SENDMSG, req);
    },
    sys_socket_recvmsg: (fd, outPtr, outCap, fdsPtr, fdsCap, nFdsPtr) => {
      const req = new Uint8Array(12);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, 0, true);
      view.setUint32(8, outCap >>> 0, true);
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_SOCKET_RECVMSG,
        req,
        outCap + 4 + fdsCap * 4,
      );
      if (rc < 0) return rc;
      const outRc = copyOut(outPtr, response.subarray(0, rc));
      if (outRc < 0) return outRc;
      const rights = response.subarray(outCap);
      const nFds = new DataView(
        rights.buffer,
        rights.byteOffset,
        rights.byteLength,
      )
        .getUint32(0, true);
      const copyFds = Math.min(nFds, fdsCap);
      const fdsRc = copyOut(fdsPtr, rights.subarray(4, 4 + copyFds * 4));
      if (fdsRc < 0) return fdsRc;
      const countRc = copyOut(nFdsPtr, u32(copyFds));
      if (countRc < 0) return countRc;
      return rc;
    },
    sys_socket_listen: (fd, backlog) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, backlog >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_SOCKET_LISTEN, req);
    },
    sys_socket_accept: (fd, flags) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, flags >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_SOCKET_ACCEPT, req);
    },
    sys_socket_addr: (fd, outPtr, outCap) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_SOCKET_ADDR,
        u32(fd),
        outCap,
      );
      if (rc > 0) {
        const outRc = copyOut(outPtr, response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      return rc;
    },
    sys_idb_get: (reqPtr, reqLen, outPtr, outCap) => {
      const req = copyIn(reqPtr, reqLen);
      if (typeof req === "number") return req;
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_IDB_GET,
        req,
        outCap,
      );
      if (rc > 0) {
        const outRc = copyOut(outPtr, response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      return rc;
    },
    sys_idb_put: (reqPtr, reqLen) => {
      const req = copyIn(reqPtr, reqLen);
      if (typeof req === "number") return req;
      return forwardRequestBytes(METHOD.SYS_IDB_PUT, req);
    },
    sys_idb_delete: (reqPtr, reqLen) => {
      const req = copyIn(reqPtr, reqLen);
      if (typeof req === "number") return req;
      return forwardRequestBytes(METHOD.SYS_IDB_DELETE, req);
    },
    sys_idb_list: (reqPtr, reqLen, outPtr, outCap) => {
      const req = copyIn(reqPtr, reqLen);
      if (typeof req === "number") return req;
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_IDB_LIST,
        req,
        outCap,
      );
      if (rc > 0) {
        const outRc = copyOut(outPtr, response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      return rc;
    },
  };
}
