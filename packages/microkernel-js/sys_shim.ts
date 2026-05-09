/**
 * `sys_*` import shims for user processes.
 *
 * One TS function per syscall, each forwarding to `kernel_dispatch`
 * via the kernel handle. Method ids and request/response shapes
 * mirror `packages/runtime-wasmtime/src/microkernel.rs::register_sys_imports`
 * — same byte layouts, same scalar conventions.
 */

import { METHOD } from "./mod.ts";
import type { KernelInstance } from "./mod.ts";

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
      const buf = new Uint8Array(
        new Uint8Array(um(), pathPtr, pathLen).slice().buffer,
      );
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
      new Uint8Array(um(), outPtr, toCopy).set(response.subarray(0, toCopy));
      return rc;
    },

    sys_getrlimit: (resource, outPtr) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_GETRLIMIT,
        u32(resource),
        16,
      );
      if (rc === 16) {
        new Uint8Array(um(), outPtr, 16).set(response.subarray(0, 16));
        return 0;
      }
      return rc;
    },
    // setrlimit takes (i32, i64, i64) at the wasm import boundary.
    // BigInts aren't representable in this Record signature, so the
    // microkernel registers it directly. See mod.ts.

    sys_close: (fd) => forwardRequestBytes(METHOD.SYS_CLOSE, u32(fd)),
    sys_dup: (oldfd) => forwardRequestBytes(METHOD.SYS_DUP, u32(oldfd)),
    sys_dup2: (oldfd, newfd) => {
      const req = new Uint8Array(8);
      const v = new DataView(req.buffer);
      v.setUint32(0, oldfd >>> 0, true);
      v.setUint32(4, newfd >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_DUP2, req);
    },

    sys_pipe: (outPtr) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_PIPE,
        new Uint8Array(0),
        8,
      );
      if (rc === 8) {
        new Uint8Array(um(), outPtr, 8).set(response.subarray(0, 8));
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
      new Uint8Array(um(), outPtr, rc).set(response.subarray(0, rc));
      return rc;
    },
    sys_write: (fd, bufPtr, len) => {
      const payload = new Uint8Array(
        new Uint8Array(um(), bufPtr, len).slice().buffer,
      );
      const req = new Uint8Array(4 + payload.byteLength);
      new DataView(req.buffer).setUint32(0, fd >>> 0, true);
      req.set(payload, 4);
      return forwardRequestBytes(METHOD.SYS_WRITE, req);
    },

    sys_isatty: (fd) => forwardRequestBytes(METHOD.SYS_ISATTY, u32(fd)),
    sys_getpgid: (pid) => forwardRequestBytes(METHOD.SYS_GETPGID, u32(pid)),
    sys_setpgid: (pid, pgid) => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, pid >>> 0, true);
      view.setUint32(4, pgid >>> 0, true);
      return forwardRequestBytes(METHOD.SYS_SETPGID, req);
    },
    sys_getsid: (pid) => forwardRequestBytes(METHOD.SYS_GETSID, u32(pid)),
    sys_setsid: () => forwardRequestBytes(METHOD.SYS_SETSID, new Uint8Array(0)),
    sys_clock_gettime: (clockId, outPtr) => {
      const { rc, response } = forwardRequestWithResponse(
        METHOD.SYS_CLOCK_GETTIME,
        u32(clockId),
        8,
      );
      if (rc === 8) {
        new Uint8Array(um(), outPtr, 8).set(response.subarray(0, 8));
        return 0;
      }
      return rc;
    },
  };
}
