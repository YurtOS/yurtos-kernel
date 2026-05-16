/**
 * Phase 7.2 macro layer: factory that builds the legacy
 * TS-kernel-shaped `host_*` import object from the Rust
 * kernel.wasm via kernel-host-interface-deno's KernelHostInterface. Hand-writing
 * each of the ~60 host_* wrappers would be a lot of code; this
 * module instead reads a small declarative table (HOST_BINDINGS)
 * and generates the wrapper functions.
 *
 * Each binding describes its argument shape with one of a small
 * set of `ArgSpec` kinds:
 *
 *   "scalar"      — a single u32; packed inline as LE bytes
 *   "scalar64"    — a single u64; packed inline as 8 LE bytes
 *   "ptr_len"     — a (ptr,len) pair; bytes read from user memory
 *                   and appended to the request
 *   "out_cap"     — a (ptr,cap) pair; the syscall's response
 *                   bytes are written back into user memory at
 *                   `ptr` (up to `cap`), and the function returns
 *                   bytes-written
 *
 * Bindings are async by construction — every wrapper returns
 * Promise<number> because the underlying KernelHostInterface.syscallAsync
 * is async (JSPI / asyncify). The legacy TS Sandbox's
 * `WebAssembly.Suspending` wrap of host_* imports already
 * accepts Promise-returning functions.
 *
 * Imports without a Rust-side sys_* equivalent stay -ENOSYS;
 * those entries simply aren't in the table. As more sys_*
 * methods land on the Rust side, more rows go here.
 */

import {
  type KernelHostInterface,
  METHOD,
} from "../kernel-host-interface-js/mod.ts";

const ESRCH = 3;
const EFAULT = 14;
const EIO = 5;
const EAGAIN = 11;
const EAFNOSUPPORT = 97;
const ENOTCONN = 107;
const HOST_UNIX_NOT_AF_UNIX = -1;
const HOST_ASYNC_EAGAIN = -2;

export type ArgSpec =
  | "scalar"
  | "scalar64"
  | "ptr_len"
  /**
   * Like ptr_len but prefixes the consumed bytes with a u32 LE
   * length on the wire. Used by multi-path syscalls (rename,
   * symlink, link) whose kernel-side decoder needs an embedded
   * length to split the parts.
   */
  | "prefixed_ptr_len"
  | "out_cap"
  /**
   * (ptr) consumed from the call; the response is always
   * exactly `cap` bytes written into user memory at that ptr.
   * Used by C-ABI-shaped imports that don't pass a cap because
   * the record size is statically known (rlimit = 16,
   * clock_time = 8).
   */
  | { kind: "fixed_out"; cap: number }
  /**
   * Consumes (ptr, cap). After the call: if rc >= 0 and cap >= 4,
   * the rc is written as i32 LE into user memory at ptr and the
   * wrapper returns 4 (bytes written). If rc < 0 or cap < 4, the
   * wrapper returns rc directly. Used by host_dup-style imports
   * where the kernel returns the new fd as rc but the TS-side
   * caller expects it written into an out pointer.
   */
  | "rc_to_out"
  /**
   * Consumes one scalar slot from the incoming args and emits
   * nothing on the wire. Used when the TS-side host_* declares an
   * extra scalar that the kernel doesn't need (e.g. host_remove's
   * `recursive` flag — SYS_UNLINK is non-recursive by design).
   */
  | "ignore_scalar";

/**
 * Custom builder escape hatch. Used for host_* whose
 * wire-format requirements don't fit the ArgSpec vocabulary
 * (e.g. host_time needs to read 8 bytes from a clock_gettime
 * response and convert ns→seconds-as-float). When supplied,
 * the factory ignores `method`/`args` for this binding and
 * uses the builder's returned function directly.
 */
export type CustomBuilder = (
  mk: KernelHostInterface,
  memBuf: () => ArrayBuffer,
  callerPid: number,
  callerTid: number,
  options?: BuildWasmKernelImportsOptions,
) => (...args: number[]) => Promise<number>;

export interface HostBinding {
  /** The legacy TS-kernel-shaped name, e.g. "host_pipe". */
  name: string;
  /** Method id the call forwards to, e.g. METHOD.SYS_PIPE. */
  method: number;
  /** Positional arg shape. */
  args: ArgSpec[];
  /**
   * When set, overrides the macro factory entirely — the
   * builder's returned function becomes the binding. `method`
   * and `args` are still required (for documentation) but
   * unused at call time.
   */
  custom?: CustomBuilder;
  /**
   * Permutation applied to the wrapper's incoming `args` before
   * walking the `args` spec. Each entry is the index of the
   * incoming arg to consume at that wire position. Used when the
   * TS-side host_* declares args in a different order than the
   * kernel's request layout (e.g. host_chmod takes
   * (pathPtr,pathLen,mode) but SYS_CHMOD packs mode first).
   *
   * Length must match the number of incoming arg slots — i.e. the
   * sum of slots consumed by each ArgSpec.
   */
  argOrder?: number[];
  /**
   * Does the binding return bytes-written from the syscall
   * response? Most "out_cap"-shape calls do. When false, the
   * function returns the syscall's rc directly (0/-errno).
   */
  returnsBytes?: boolean;
}

function socketOptionRequest(
  fd: number,
  option: number,
  hasValue: number,
  value: number,
): Uint8Array {
  const req = new Uint8Array(16);
  const view = new DataView(req.buffer);
  view.setUint32(0, fd >>> 0, true);
  view.setUint32(4, option >>> 0, true);
  view.setUint32(8, hasValue >>> 0, true);
  view.setInt32(12, value | 0, true);
  return req;
}

function scalarRequest(...values: number[]): Uint8Array {
  const req = new Uint8Array(values.length * 4);
  const view = new DataView(req.buffer);
  values.forEach((value, index) => {
    view.setUint32(index * 4, value >>> 0, true);
  });
  return req;
}

const buildSchedGetAffinity: CustomBuilder =
  (mk, memBuf, callerPid) =>
  async (pid: number, maskPtr: number, cpusetsize: number): Promise<number> => {
    const cap = cpusetsize >>> 0;
    const out = await mk.kernelSyscallAsync(
      METHOD.SYS_SCHED_GETAFFINITY,
      callerPid,
      scalarRequest(pid, cap),
      cap,
    );
    const rc = Number(out.rc);
    if (rc >= 0 && rc <= cap && out.response.byteLength >= rc) {
      const outRc = copyOut(memBuf, maskPtr, out.response.subarray(0, rc));
      if (outRc < 0) return outRc;
    }
    return rc;
  };

const buildSchedSetAffinity: CustomBuilder =
  (mk, memBuf, callerPid) =>
  async (pid: number, maskPtr: number, cpusetsize: number): Promise<number> => {
    const len = cpusetsize >>> 0;
    const mask = copyIn(memBuf, maskPtr, len);
    if (typeof mask === "number") return mask;
    const req = new Uint8Array(8 + mask.byteLength);
    const view = new DataView(req.buffer);
    view.setUint32(0, pid >>> 0, true);
    view.setUint32(4, len, true);
    req.set(mask, 8);
    const out = await mk.kernelSyscallAsync(
      METHOD.SYS_SCHED_SETAFFINITY,
      callerPid,
      req,
      0,
    );
    return Number(out.rc);
  };

export interface WasmProcessThreadHost {
  spawn(tid: number, fnPtr: number, arg: number): number;
  release(handle: number): number;
  cancel(handle: number): number;
}

export interface WasmThreadHostRegistry {
  registerProcess(pid: number, host: WasmProcessThreadHost): () => void;
  threadExitVersion(pid: number, tid: number): number;
  waitForThreadExit(pid: number, tid: number, version: number): Promise<void>;
  threadExited(
    pid: number,
    tid: number,
    localHandle: number,
    retval: number,
  ): void;
  threadSpawn(
    callerPid: number,
    callerTid: number,
    fnPtr: number,
    arg: number,
  ): number;
  threadYield(callerPid: number, callerTid: number): number;
}

export function createWasmThreadHostRegistry(
  mk: KernelHostInterface,
): WasmThreadHostRegistry {
  const hosts = new Map<number, WasmProcessThreadHost>();
  const handles = new Map<number, { pid: number; localHandle: number }>();
  const exitVersions = new Map<string, number>();
  const exitWaiters = new Map<string, Array<() => void>>();
  let nextHandle = 1;

  const exitKey = (pid: number, tid: number) => `${pid}:${tid}`;

  function notifyThreadExit(pid: number, tid: number) {
    const key = exitKey(pid, tid);
    exitVersions.set(key, (exitVersions.get(key) ?? 0) + 1);
    const waiters = exitWaiters.get(key);
    if (!waiters) return;
    exitWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }

  mk.hostStateMut().threadHost = {
    spawn(pid, tid, fnPtr, arg) {
      const host = hosts.get(pid);
      if (!host) return -ESRCH;
      const localHandle = host.spawn(tid, fnPtr, arg);
      if (localHandle < 0) return localHandle;
      const handle = nextHandle++;
      handles.set(handle, { pid, localHandle });
      return handle;
    },
    release(handle) {
      const entry = handles.get(handle);
      if (!entry) return -ESRCH;
      const host = hosts.get(entry.pid);
      if (!host) return -ESRCH;
      const rc = host.release(entry.localHandle);
      if (rc === 0) handles.delete(handle);
      return rc;
    },
    cancel(handle) {
      const entry = handles.get(handle);
      if (!entry) return -ESRCH;
      const host = hosts.get(entry.pid);
      if (!host) return -ESRCH;
      const rc = host.cancel(entry.localHandle);
      if (rc === 0) handles.delete(handle);
      return rc;
    },
  };

  return {
    threadExitVersion(pid, tid) {
      return exitVersions.get(exitKey(pid, tid)) ?? 0;
    },
    waitForThreadExit(pid, tid, version) {
      const key = exitKey(pid, tid);
      if ((exitVersions.get(key) ?? 0) !== version) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const waiters = exitWaiters.get(key) ?? [];
        waiters.push(resolve);
        exitWaiters.set(key, waiters);
      });
    },
    threadExited(pid, tid, localHandle, retval) {
      for (const [handle, entry] of handles) {
        if (entry.pid !== pid || entry.localHandle !== localHandle) continue;
        try {
          mk.recordThreadExitAuthenticated(pid, tid, handle, retval >>> 0);
          notifyThreadExit(pid, tid);
        } catch {
          // Stale worker completion reports are ignored; Rust remains
          // authoritative and rejects mismatched handles.
        }
        return;
      }
    },
    threadSpawn(callerPid, callerTid, fnPtr, arg) {
      return Number(
        mk.kernelThreadSyscall(
          METHOD.SYS_THREAD_SPAWN,
          callerPid,
          callerTid,
          scalarRequest(fnPtr, arg),
          0,
        ).rc,
      );
    },
    threadYield(callerPid, callerTid) {
      return Number(
        mk.kernelThreadSyscall(
          METHOD.SYS_THREAD_YIELD,
          callerPid,
          callerTid,
          new Uint8Array(0),
          0,
        ).rc,
      );
    },
    registerProcess(pid, host) {
      hosts.set(pid, host);
      return () => {
        hosts.delete(pid);
        for (const [handle, entry] of handles) {
          if (entry.pid === pid) handles.delete(handle);
        }
        const prefix = `${pid}:`;
        for (const key of exitVersions.keys()) {
          if (key.startsWith(prefix)) exitVersions.delete(key);
        }
        for (const [key, waiters] of exitWaiters) {
          if (!key.startsWith(prefix)) continue;
          exitWaiters.delete(key);
          for (const resolve of waiters) resolve();
        }
      };
    },
  };
}

export interface BuildWasmKernelImportsOptions {
  threadEvents?: Pick<
    WasmThreadHostRegistry,
    "threadExitVersion" | "waitForThreadExit"
  >;
  processEvents?: Pick<
    WasmProcessHostRegistry,
    "processExitVersion" | "waitForProcessExit"
  >;
}

export interface WasmProcessHostRegistry {
  processExitVersion(pid: number): number;
  waitForProcessExit(pid: number, version: number): Promise<void>;
  prepareFork(parentPid: number): number;
  commitFork(parentPid: number, childPid: number): number;
  rollbackFork(parentPid: number, childPid: number): number;
  recordExit(pid: number, exitStatus: number): number;
}

export function createWasmProcessHostRegistry(
  mk: KernelHostInterface,
): WasmProcessHostRegistry {
  const exitVersions = new Map<number, number>();
  const exitWaiters = new Map<number, Array<() => void>>();

  const notifyProcessExit = (pid: number) => {
    exitVersions.set(pid, (exitVersions.get(pid) ?? 0) + 1);
    const waiters = exitWaiters.get(pid);
    if (!waiters) return;
    exitWaiters.delete(pid);
    for (const resolve of waiters) resolve();
  };

  return {
    processExitVersion(pid) {
      return exitVersions.get(pid) ?? 0;
    },
    waitForProcessExit(pid, version) {
      if ((exitVersions.get(pid) ?? 0) !== version) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const waiters = exitWaiters.get(pid) ?? [];
        waiters.push(resolve);
        exitWaiters.set(pid, waiters);
      });
    },
    prepareFork(parentPid) {
      return mk.prepareFork(parentPid);
    },
    commitFork(parentPid, childPid) {
      mk.commitFork(parentPid, childPid);
      return 0;
    },
    rollbackFork(parentPid, childPid) {
      mk.rollbackFork(parentPid, childPid);
      return 0;
    },
    recordExit(pid, exitStatus) {
      mk.recordExit(pid, exitStatus);
      notifyProcessExit(pid);
      return 0;
    },
  };
}

/**
 * Adapt a {@link WasmProcessHostRegistry} into the `wasmForkLifecycle`
 * hooks `Sandbox.create` expects. This is the *substantive* sync that
 * keeps the Rust kernel's process registry in step with the TS
 * ProcessKernel mirror across guest fork()/exit. Without it, fork-based
 * workloads run under `kernelImpl: "wasm"` desync the two kernels
 * (the differ and the Open POSIX wasm runner both need this so the same
 * corpus behaves identically under either kernel).
 *
 * The registry already implements the lifecycle shape, so with no
 * `forkEvents` it is returned directly. When `forkEvents` is supplied
 * (test observation only), calls are still delegated to the registry
 * and additionally appended as `prepare|commit|rollback|exit:…` strings.
 */
export function createWasmForkLifecycle(
  registry: WasmProcessHostRegistry,
  forkEvents?: string[],
): Pick<
  WasmProcessHostRegistry,
  "prepareFork" | "commitFork" | "rollbackFork" | "recordExit"
> {
  if (!forkEvents) return registry;
  return {
    prepareFork(parentPid) {
      const childPid = registry.prepareFork(parentPid);
      forkEvents.push(`prepare:${parentPid}:${childPid}`);
      return childPid;
    },
    commitFork(parentPid, childPid) {
      const result = registry.commitFork(parentPid, childPid);
      forkEvents.push(`commit:${parentPid}:${childPid}`);
      return result;
    },
    rollbackFork(parentPid, childPid) {
      const result = registry.rollbackFork(parentPid, childPid);
      forkEvents.push(`rollback:${parentPid}:${childPid}`);
      return result;
    },
    recordExit(pid, exitStatus) {
      const result = registry.recordExit(pid, exitStatus);
      forkEvents.push(`exit:${pid}:${exitStatus}`);
      return result;
    },
  };
}

function threadImport(
  method: number,
  request: Uint8Array,
  responseCap: number,
  mk: KernelHostInterface,
  callerPid: number,
  callerTid: number,
): { rc: number; response: Uint8Array } {
  const out = mk.kernelThreadSyscall(
    method,
    callerPid,
    callerTid,
    request,
    responseCap,
  );
  return { rc: Number(out.rc), response: out.response };
}

/**
 * The starting binding table — covers the simple scalar surface
 * the Rust kernel already implements. The full surface fills
 * in as more sys_* methods land (signals, fcntl, etc.) and as
 * the wasm-mode integration tests demand them.
 */
export const HOST_BINDINGS: HostBinding[] = [
  // Identity — these take no args and return a scalar.
  { name: "host_getuid", method: METHOD.SYS_GETUID, args: [] },
  { name: "host_geteuid", method: METHOD.SYS_GETEUID, args: [] },
  { name: "host_getgid", method: METHOD.SYS_GETGID, args: [] },
  { name: "host_getegid", method: METHOD.SYS_GETEGID, args: [] },
  { name: "host_getpid", method: METHOD.SYS_GETPID, args: [] },
  { name: "host_getppid", method: METHOD.SYS_GETPPID, args: [] },

  {
    name: "host_thread_spawn",
    method: METHOD.SYS_THREAD_SPAWN,
    args: ["scalar", "scalar"],
    custom: (mk, _memBuf, callerPid, callerTid) => async (fnPtr, arg) =>
      threadImport(
        METHOD.SYS_THREAD_SPAWN,
        scalarRequest(fnPtr, arg),
        0,
        mk,
        callerPid,
        callerTid,
      ).rc,
  },
  {
    name: "host_thread_self",
    method: METHOD.SYS_THREAD_SELF,
    args: [],
    custom: (mk, _memBuf, callerPid, callerTid) => async () =>
      threadImport(
        METHOD.SYS_THREAD_SELF,
        new Uint8Array(0),
        0,
        mk,
        callerPid,
        callerTid,
      ).rc,
  },
  {
    name: "host_thread_join",
    method: METHOD.SYS_THREAD_JOIN,
    args: ["scalar", { kind: "fixed_out", cap: 4 }],
    custom:
      (mk, memBuf, callerPid, callerTid, options) =>
      async (tid, outRetvalPtr) => {
        let version = options?.threadEvents?.threadExitVersion(callerPid, tid);
        let out = threadImport(
          METHOD.SYS_THREAD_JOIN,
          scalarRequest(tid),
          4,
          mk,
          callerPid,
          callerTid,
        );
        while (out.rc === -EAGAIN && options?.threadEvents) {
          await options.threadEvents.waitForThreadExit(
            callerPid,
            tid,
            version ?? 0,
          );
          version = options.threadEvents.threadExitVersion(callerPid, tid);
          out = threadImport(
            METHOD.SYS_THREAD_JOIN,
            scalarRequest(tid),
            4,
            mk,
            callerPid,
            callerTid,
          );
        }
        if (out.rc !== 0) return out.rc;
        return copyOut(memBuf, outRetvalPtr, out.response.subarray(0, 4));
      },
  },
  {
    name: "host_thread_detach",
    method: METHOD.SYS_THREAD_DETACH,
    args: ["scalar"],
    custom: (mk, _memBuf, callerPid, callerTid) => async (tid) =>
      threadImport(
        METHOD.SYS_THREAD_DETACH,
        scalarRequest(tid),
        0,
        mk,
        callerPid,
        callerTid,
      ).rc,
  },
  {
    name: "host_thread_exit",
    method: METHOD.SYS_THREAD_EXIT,
    args: ["scalar"],
    custom: (mk, _memBuf, callerPid, callerTid) => async (retval) =>
      threadImport(
        METHOD.SYS_THREAD_EXIT,
        scalarRequest(retval),
        0,
        mk,
        callerPid,
        callerTid,
      ).rc,
  },
  {
    name: "host_thread_yield",
    method: METHOD.SYS_THREAD_YIELD,
    args: [],
    custom: (mk, _memBuf, callerPid, callerTid) => async () =>
      threadImport(
        METHOD.SYS_THREAD_YIELD,
        new Uint8Array(0),
        0,
        mk,
        callerPid,
        callerTid,
      ).rc,
  },

  // Single-scalar args returning a scalar.
  { name: "host_umask", method: METHOD.SYS_UMASK, args: ["scalar"] },
  {
    name: "host_setresuid",
    method: METHOD.SYS_SETRESUID,
    args: ["scalar", "scalar", "scalar"],
  },
  {
    name: "host_setresgid",
    method: METHOD.SYS_SETRESGID,
    args: ["scalar", "scalar", "scalar"],
  },
  { name: "host_kill", method: METHOD.SYS_KILL, args: ["scalar", "scalar"] },
  {
    name: "host_killpg",
    method: METHOD.SYS_KILLPG,
    args: ["scalar", "scalar"],
  },
  {
    name: "host_getpriority",
    method: METHOD.SYS_GETPRIORITY,
    args: ["scalar", "scalar"],
  },
  {
    name: "host_setpriority",
    method: METHOD.SYS_SETPRIORITY,
    args: ["scalar", "scalar", "scalar"],
  },
  {
    name: "host_sched_getscheduler",
    method: METHOD.SYS_SCHED_GETSCHEDULER,
    args: ["scalar"],
  },
  {
    name: "host_sched_getparam",
    method: METHOD.SYS_SCHED_GETPARAM,
    args: ["scalar"],
  },
  {
    name: "host_sched_setscheduler",
    method: METHOD.SYS_SCHED_SETSCHEDULER,
    args: ["scalar", "scalar", "scalar"],
  },
  {
    name: "host_sched_setparam",
    method: METHOD.SYS_SCHED_SETPARAM,
    args: ["scalar", "scalar"],
  },
  {
    name: "host_sched_getaffinity",
    method: METHOD.SYS_SCHED_GETAFFINITY,
    args: ["scalar", "out_cap"],
    returnsBytes: true,
    custom: buildSchedGetAffinity,
  },
  {
    name: "host_sched_setaffinity",
    method: METHOD.SYS_SCHED_SETAFFINITY,
    args: ["scalar", "prefixed_ptr_len"],
    custom: buildSchedSetAffinity,
  },
  { name: "host_getpgid", method: METHOD.SYS_GETPGID, args: ["scalar"] },
  {
    name: "host_setpgid",
    method: METHOD.SYS_SETPGID,
    args: ["scalar", "scalar"],
  },
  { name: "host_getsid", method: METHOD.SYS_GETSID, args: ["scalar"] },
  { name: "host_setsid", method: METHOD.SYS_SETSID, args: [] },
  { name: "host_isatty", method: METHOD.SYS_ISATTY, args: ["scalar"] },
  { name: "host_tcgetpgrp", method: METHOD.SYS_TCGETPGRP, args: ["scalar"] },
  {
    name: "host_tcsetpgrp",
    method: METHOD.SYS_TCSETPGRP,
    args: ["scalar", "scalar"],
  },
  {
    name: "host_tcgetattr",
    method: METHOD.SYS_TCGETATTR,
    args: ["scalar", "out_cap"],
    returnsBytes: true,
  },
  {
    name: "host_tcsetattr",
    method: METHOD.SYS_TCSETATTR,
    args: ["scalar", "scalar", "ignore_scalar"],
  },
  {
    name: "host_winsize",
    method: METHOD.SYS_WINSIZE,
    args: ["scalar", "out_cap"],
    returnsBytes: true,
  },
  { name: "host_tiocsctty", method: METHOD.SYS_TIOCSCTTY, args: ["scalar"] },
  { name: "host_sched_yield", method: METHOD.SYS_SCHED_YIELD, args: [] },
  { name: "host_nanosleep", method: METHOD.SYS_NANOSLEEP, args: ["scalar64"] },

  // fd ops.
  { name: "host_close_fd", method: METHOD.SYS_CLOSE, args: ["scalar"] },

  // path + payload: (ptr,len) → scalar.
  { name: "host_chdir", method: METHOD.SYS_CHDIR, args: ["ptr_len"] },

  // (ptr,cap) → bytes-written: response copied into user memory.
  {
    name: "host_getcwd",
    method: METHOD.SYS_GETCWD,
    args: ["out_cap"],
    returnsBytes: true,
  },

  // host_read_fd(fd, outPtr, outCap) → bytes
  {
    name: "host_read_fd",
    method: METHOD.SYS_READ,
    args: ["scalar", "out_cap"],
    returnsBytes: true,
  },
  // host_write_fd(fd, dataPtr, dataLen) → bytes
  {
    name: "host_write_fd",
    method: METHOD.SYS_WRITE,
    args: ["scalar", "ptr_len"],
    returnsBytes: true,
  },

  // ── fd ops ────────────────────────────────────────────────
  // host_pipe(outPtr, outCap) → writes 8 bytes (u32 read_fd + u32 write_fd)
  {
    name: "host_pipe",
    method: METHOD.SYS_PIPE,
    args: ["out_cap"],
    returnsBytes: true,
  },
  // ── Resource limits ───────────────────────────────────────
  // host_getrlimit(resource, outPtr) — rlimit record is 16 bytes
  // (u64 soft + u64 hard) on the Rust side.
  {
    name: "host_getrlimit",
    method: METHOD.SYS_GETRLIMIT,
    args: ["scalar", { kind: "fixed_out", cap: 16 }],
    returnsBytes: true,
  },
  // host_clock_gettime(clockId, outPtr) — writes u64 ns (8 bytes).
  {
    name: "host_clock_gettime",
    method: METHOD.SYS_CLOCK_GETTIME,
    args: ["scalar", { kind: "fixed_out", cap: 8 }],
    returnsBytes: true,
  },
  // host_setrlimit(resource, soft, hard) → 3 scalars
  // soft and hard are typically u64. Use scalar64 to be safe.
  {
    name: "host_setrlimit",
    method: METHOD.SYS_SETRLIMIT,
    args: ["scalar", "scalar64", "scalar64"],
  },

  // ── File ops via path ─────────────────────────────────────
  // host_realpath(pathPtr, pathLen, outPtr, outCap) → bytes
  {
    name: "host_realpath",
    method: METHOD.SYS_REALPATH,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },

  // ── Wait / process tree ───────────────────────────────────
  // host_wait(pid, flags, outPtr, outCap) — SYS_WAIT writes the kernel-internal
  // 8-byte record (u32 pid + normalized i32 exit status). POSIX wait-status
  // bit packing is done later in abi/src/yurt_process.c. The C ABI expects
  // yurt_wait_result_v1: i32 pid + i32 exit_code + i32 signal + i32 flags.
  {
    name: "host_wait",
    method: METHOD.SYS_WAIT,
    args: [],
    custom: (mk, memBuf, callerPid, _callerTid, options) =>
    async (
      pid: number,
      flags: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> => {
      const req = new Uint8Array(8);
      const reqView = new DataView(req.buffer);
      reqView.setUint32(0, pid >>> 0, true);
      reqView.setUint32(4, flags >>> 0, true);
      let version = pid > 0
        ? options?.processEvents?.processExitVersion(pid)
        : undefined;
      let out = await mk.kernelSyscallAsync(
        METHOD.SYS_WAIT,
        callerPid,
        req,
        8,
      );
      let rc = Number(out.rc);
      while (rc === -EAGAIN && pid > 0 && options?.processEvents) {
        await options.processEvents.waitForProcessExit(pid, version ?? 0);
        version = options.processEvents.processExitVersion(pid);
        out = await mk.kernelSyscallAsync(
          METHOD.SYS_WAIT,
          callerPid,
          req,
          8,
        );
        rc = Number(out.rc);
      }
      if (rc < 0) return rc;
      if (rc !== 8 || outCap < 16) return -7; // -E2BIG/malformed for this ABI.
      const kernelView = new DataView(
        out.response.buffer,
        out.response.byteOffset,
        8,
      );
      const exitedPid = kernelView.getUint32(0, true);
      const status = kernelView.getInt32(4, true);
      const signal = status >= 128 && status < 192 ? status - 128 : 0;
      const exitCode = signal === 0 ? status : 0;
      const resultBytes = new Uint8Array(16);
      const result = new DataView(resultBytes.buffer);
      result.setInt32(0, exitedPid, true);
      result.setInt32(4, exitCode, true);
      result.setInt32(8, signal, true);
      result.setInt32(12, 0, true);
      const outRc = copyOut(memBuf, outPtr, resultBytes);
      if (outRc < 0) return outRc;
      return 16;
    },
  },

  // ── fd duplication ────────────────────────────────────────
  // host_dup2(srcFd, dstFd) → newfd or -EBADF.
  { name: "host_dup2", method: METHOD.SYS_DUP2, args: ["scalar", "scalar"] },
  {
    name: "host_dup_min",
    method: METHOD.SYS_DUP_MIN,
    args: ["scalar", "scalar"],
  },
  {
    name: "host_set_fd_descriptor_flags",
    method: METHOD.SYS_SET_FD_DESCRIPTOR_FLAGS,
    args: ["scalar", "scalar"],
  },

  // ── Path-based fs ops (single path) ────────────────────────
  // host_mkdir(pathPtr, pathLen) → 0 / -errno.
  { name: "host_mkdir", method: METHOD.SYS_MKDIR, args: ["ptr_len"] },
  // host_rmdir doesn't have a TS-side counterpart of identical
  // shape — bash uses host_remove for both. Leave SYS_RMDIR
  // unbound until a caller materializes.
  // host_stat(pathPtr, pathLen, outPtr, outCap) → bytes-written
  // (kernel writes a 16-byte fstat record).
  {
    name: "host_stat",
    method: METHOD.SYS_STAT,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },
  // host_readlink(pathPtr, pathLen, outPtr, outCap) → bytes-written.
  {
    name: "host_readlink",
    method: METHOD.SYS_READLINK,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },
  // host_readdir(pathPtr, pathLen, outPtr, outCap) → bytes-written.
  {
    name: "host_readdir",
    method: METHOD.SYS_READDIR,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },

  // ── Chmod / chown / utimens ───────────────────────────────
  // host_chmod(pathPtr, pathLen, mode) → 0 / -errno. Kernel wire
  // expects (u32 mode, path); permute the incoming args.
  {
    name: "host_chmod",
    method: METHOD.SYS_CHMOD,
    args: ["scalar", "ptr_len"],
    argOrder: [2, 0, 1],
  },
  {
    name: "host_chown",
    method: METHOD.SYS_CHOWN,
    args: ["scalar", "scalar", "ptr_len"],
    argOrder: [2, 3, 0, 1],
  },
  {
    name: "host_fchown",
    method: METHOD.SYS_FCHOWN,
    args: ["scalar", "scalar", "scalar"],
  },
  { name: "host_fchdir", method: METHOD.SYS_FCHDIR, args: ["scalar"] },

  // ── Multi-path ops (rename, symlink, link) ────────────────
  // host_rename(fromPtr, fromLen, toPtr, toLen) → 0 / -errno.
  // Kernel wire: u32 old_len + old + new.
  {
    name: "host_rename",
    method: METHOD.SYS_RENAME,
    args: ["prefixed_ptr_len", "ptr_len"],
  },
  // host_symlink(targetPtr, targetLen, linkPtr, linkLen) → 0/-errno.
  // Kernel wire: u32 target_len + target + linkpath.
  {
    name: "host_symlink",
    method: METHOD.SYS_SYMLINK,
    args: ["prefixed_ptr_len", "ptr_len"],
  },

  // ── Misc ──────────────────────────────────────────────────
  // host_yield() — async fairness hint. Maps to SYS_SCHED_YIELD;
  // TS host_yield returns void, our wrapper returns Promise<number>
  // (rc), but wasm-side discards rc here.
  { name: "host_yield", method: METHOD.SYS_SCHED_YIELD, args: [] },

  // ── fd duplicate (rc_to_out shape) ────────────────────────
  // host_dup(fd, outPtr, outCap) — kernel SYS_DUP returns the
  // new fd as rc; the rc_to_out spec writes it into outPtr as
  // i32 LE and returns bytes-written (4).
  {
    name: "host_dup",
    method: METHOD.SYS_DUP,
    args: ["scalar", "rc_to_out"],
  },

  // ── Path-with-ignored-flag ─────────────────────────────────
  // host_remove(pathPtr, pathLen, recursive). SYS_UNLINK is
  // non-recursive; recursive scalar is consumed and dropped.
  // Bash callers that want recursive removal walk readdir
  // themselves — same as TS behavior on the platform.
  {
    name: "host_remove",
    method: METHOD.SYS_UNLINK,
    args: ["ptr_len", "ignore_scalar"],
  },

  // ── Networking ────────────────────────────────────────────
  // host_network_fetch(reqPtr, reqLen, outPtr, outCap) → bytes.
  // SYS_FETCH consumes the native fetch request record and writes
  // the native fetch response record.
  {
    name: "host_network_fetch",
    method: METHOD.SYS_FETCH,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },
  // host_socket_open(domain, type, protocol) -> fd / -errno.
  // SYS_SOCKET_OPEN accepts u8 family + u8 sock_type + u16 pad +
  // u32 flags. The native ABI passes flags ORed into type.
  {
    name: "host_socket_open",
    method: METHOD.SYS_SOCKET_OPEN,
    args: [],
    custom: (mk, _memBuf, callerPid) =>
    async (
      domain: number,
      type: number,
      _protocol: number,
    ): Promise<number> => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      req[0] = domain & 0xff;
      req[1] = type & 0xff;
      view.setUint32(4, (type & ~0xff) >>> 0, true);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_OPEN,
        callerPid,
        req,
        0,
      );
      return Number(out.rc);
    },
  },
  // host_socket_connect(fd, addrPtr, addrLen, flags) -> 0/-errno.
  // SYS_SOCKET_CONNECT accepts u32 fd + POSIX sockaddr bytes.
  {
    name: "host_socket_connect",
    method: METHOD.SYS_SOCKET_CONNECT,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      addrPtr: number,
      addrLen: number,
      _flags: number,
    ): Promise<number> => {
      const addr = copyIn(memBuf, addrPtr, addrLen);
      if (typeof addr === "number") return addr;
      const req = new Uint8Array(4 + addr.length);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      req.set(addr, 4);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_CONNECT,
        callerPid,
        req,
        0,
      );
      return Number(out.rc);
    },
  },
  // host_socket_bind(fd, addrPtr, addrLen) -> 0/-errno.
  // SYS_SOCKET_BIND accepts u32 fd + POSIX sockaddr bytes.
  {
    name: "host_socket_bind",
    method: METHOD.SYS_SOCKET_BIND,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      addrPtr: number,
      addrLen: number,
    ): Promise<number> => {
      const addr = copyIn(memBuf, addrPtr, addrLen);
      if (typeof addr === "number") return addr;
      const req = new Uint8Array(4 + addr.length);
      new DataView(req.buffer).setUint32(0, fd >>> 0, true);
      req.set(addr, 4);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_BIND,
        callerPid,
        req,
        0,
      );
      return Number(out.rc);
    },
  },
  // host_socket_bind_unix(fd, pathPtr, pathLen, isAbstract) -> 0/-errno.
  // SYS_SOCKET_BIND uses the Rust kernel's unified fd table and accepts
  // u32 fd + POSIX sockaddr_un bytes.
  {
    name: "host_socket_bind_unix",
    method: METHOD.SYS_SOCKET_BIND,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      pathPtr: number,
      pathLen: number,
      isAbstract: number,
    ): Promise<number> => {
      const addr = unixSocketAddrBytes(memBuf, pathPtr, pathLen, isAbstract);
      if (typeof addr === "number") return addr;
      const req = new Uint8Array(4 + addr.length);
      new DataView(req.buffer).setUint32(0, fd >>> 0, true);
      req.set(addr, 4);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_BIND,
        callerPid,
        req,
        0,
      );
      return Number(out.rc);
    },
  },
  // host_socket_connect_unix(fd, pathPtr, pathLen, isAbstract) -> 0/-errno.
  {
    name: "host_socket_connect_unix",
    method: METHOD.SYS_SOCKET_CONNECT,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      pathPtr: number,
      pathLen: number,
      isAbstract: number,
    ): Promise<number> => {
      const addr = unixSocketAddrBytes(memBuf, pathPtr, pathLen, isAbstract);
      if (typeof addr === "number") return addr;
      const req = new Uint8Array(4 + addr.length);
      new DataView(req.buffer).setUint32(0, fd >>> 0, true);
      req.set(addr, 4);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_CONNECT,
        callerPid,
        req,
        0,
      );
      return Number(out.rc);
    },
  },
  // host_socket_listen(fd, backlog) -> 0/-errno.
  // SYS_SOCKET_LISTEN accepts u32 fd + u32 backlog.
  {
    name: "host_socket_listen",
    method: METHOD.SYS_SOCKET_LISTEN,
    args: ["scalar", "scalar"],
  },
  // host_socket_listen_unix(fd, backlog) -> 0/-errno.
  {
    name: "host_socket_listen_unix",
    method: METHOD.SYS_SOCKET_LISTEN,
    args: ["scalar", "scalar"],
  },
  // host_socket_accept(fd, outPtr, outCap) -> yurt_socket_accept_result_v1.
  // SYS_SOCKET_ACCEPT returns the accepted fd as rc; this adapter writes
  // the native ABI result struct expected by yurt_socket.c.
  {
    name: "host_socket_accept",
    method: METHOD.SYS_SOCKET_ACCEPT,
    args: [],
    custom:
      (mk, memBuf, callerPid) =>
      async (fd: number, outPtr: number, outCap: number): Promise<number> => {
        const req = new Uint8Array(8);
        const view = new DataView(req.buffer);
        view.setUint32(0, fd >>> 0, true);
        view.setUint32(4, 0, true);
        const out = await mk.kernelSyscallAsync(
          METHOD.SYS_SOCKET_ACCEPT,
          callerPid,
          req,
          0,
        );
        const rc = Number(out.rc);
        if (rc < 0) return rc;
        if (outCap < 16) return -7;
        const result = new Uint8Array(16);
        new DataView(result.buffer).setInt32(0, rc, true);
        const outRc = copyOut(memBuf, outPtr, result);
        if (outRc < 0) return outRc;
        return 16;
      },
  },
  // host_socket_addr(fd, which, outPtr, outCap) → bytes.
  // SYS_SOCKET_ADDR accepts u32 handle and writes the packed address record.
  {
    name: "host_socket_addr",
    method: METHOD.SYS_SOCKET_ADDR,
    args: ["scalar", "scalar", "out_cap"],
    returnsBytes: true,
  },
  // host_socket_addr_unix(fd, isPeer, pathPtr, pathCap, isAbstractPtr).
  // SYS_SOCKET_ADDR returns raw AF_UNIX address bytes. Abstract addresses
  // carry the kernel's leading NUL marker; this wrapper strips it and sets
  // *isAbstractPtr for the C ABI.
  {
    name: "host_socket_addr_unix",
    method: METHOD.SYS_SOCKET_ADDR,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      isPeer: number,
      pathPtr: number,
      pathCap: number,
      isAbstractPtr: number,
    ): Promise<number> => {
      const req = new Uint8Array(8);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, isPeer ? 1 : 0, true);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_ADDR,
        callerPid,
        req,
        pathCap >>> 0,
      );
      const rc = Number(out.rc);
      if (rc === -EAFNOSUPPORT) return HOST_UNIX_NOT_AF_UNIX;
      if (rc === -ENOTCONN) return HOST_ASYNC_EAGAIN;
      if (rc < 0) return rc;
      const isAbstract = rc > 0 && out.response[0] === 0;
      const pathStart = isAbstract ? 1 : 0;
      const pathLen = Math.max(0, rc - pathStart);
      if (pathLen > 0) {
        const outRc = copyOut(
          memBuf,
          pathPtr,
          out.response.subarray(pathStart, pathStart + pathLen),
        );
        if (outRc < 0) return outRc;
      }
      if (isAbstractPtr) {
        const flag = new Uint8Array(4);
        new DataView(flag.buffer).setInt32(0, isAbstract ? 1 : 0, true);
        const outRc = copyOut(memBuf, isAbstractPtr, flag);
        if (outRc < 0) return outRc;
      }
      return pathLen;
    },
  },
  // host_socket_send(fd, dataPtr, dataLen, flags) → bytes.
  // SYS_SOCKET_SEND accepts u32 handle + payload bytes. The
  // direct host ABI still carries flags, but this syscall method
  // has no flags slot.
  {
    name: "host_socket_send",
    method: METHOD.SYS_SOCKET_SEND,
    args: ["scalar", "ptr_len"],
    argOrder: [0, 1, 2],
  },
  // host_socket_recv(fd, outPtr, outCap, flags) → bytes.
  // SYS_SOCKET_RECV accepts u32 handle + u32 flags and returns
  // recv bytes in the response buffer.
  {
    name: "host_socket_recv",
    method: METHOD.SYS_SOCKET_RECV,
    args: ["scalar", "scalar", "out_cap"],
    argOrder: [0, 3, 1, 2],
    returnsBytes: true,
  },
  // host_socket_sendto_unix(fd, bufPtr, bufLen, pathPtr, pathLen, isAbstract).
  {
    name: "host_socket_sendto_unix",
    method: METHOD.SYS_SOCKET_SENDTO,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      dataPtr: number,
      dataLen: number,
      pathPtr: number,
      pathLen: number,
      isAbstract: number,
    ): Promise<number> => {
      const data = copyIn(memBuf, dataPtr, dataLen);
      if (typeof data === "number") return data;
      const addr = unixSocketAddrBytes(memBuf, pathPtr, pathLen, isAbstract);
      if (typeof addr === "number") return addr;
      const req = new Uint8Array(12 + addr.length + data.length);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, 0, true);
      view.setUint32(8, addr.length >>> 0, true);
      req.set(addr, 12);
      req.set(data, 12 + addr.length);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_SENDTO,
        callerPid,
        req,
        0,
      );
      return Number(out.rc);
    },
  },
  // host_socket_recvfrom_unix(fd, outPtr, outCap, fromPathPtr, fromPathCap,
  // fromPathLenPtr, fromIsAbstractPtr).
  {
    name: "host_socket_recvfrom_unix",
    method: METHOD.SYS_SOCKET_RECVFROM,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      outPtr: number,
      outCap: number,
      fromPathPtr: number,
      fromPathCap: number,
      fromPathLenPtr: number,
      fromIsAbstractPtr: number,
    ): Promise<number> => {
      const req = new Uint8Array(16);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, 0, true);
      view.setUint32(8, outCap >>> 0, true);
      view.setUint32(12, fromPathCap >>> 0, true);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_RECVFROM,
        callerPid,
        req,
        (outCap + 8 + fromPathCap) >>> 0,
      );
      const rc = Number(out.rc);
      if (rc === -EAGAIN) return HOST_ASYNC_EAGAIN;
      if (rc < 0) return rc;
      if (rc > 0) {
        const outRc = copyOut(memBuf, outPtr, out.response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      const metaOffset = outCap >>> 0;
      const pathOffset = metaOffset + 8;
      const responseView = new DataView(
        out.response.buffer,
        out.response.byteOffset,
        out.response.byteLength,
      );
      const pathLen = out.response.byteLength >= pathOffset
        ? responseView.getUint32(metaOffset, true)
        : 0;
      const isAbstract = out.response.byteLength >= pathOffset
        ? responseView.getUint32(metaOffset + 4, true)
        : 0;
      const pathCopyLen = Math.min(
        pathLen,
        fromPathCap >>> 0,
        Math.max(0, out.response.byteLength - pathOffset),
      );
      if (pathCopyLen > 0) {
        const outRc = copyOut(
          memBuf,
          fromPathPtr,
          out.response.subarray(pathOffset, pathOffset + pathCopyLen),
        );
        if (outRc < 0) return outRc;
      }
      const record = new Uint8Array(4);
      const recordView = new DataView(record.buffer);
      if (fromPathLenPtr) {
        recordView.setUint32(0, pathLen, true);
        const outRc = copyOut(memBuf, fromPathLenPtr, record);
        if (outRc < 0) return outRc;
      }
      if (fromIsAbstractPtr) {
        recordView.setUint32(0, isAbstract, true);
        const outRc = copyOut(memBuf, fromIsAbstractPtr, record);
        if (outRc < 0) return outRc;
      }
      return rc;
    },
  },
  // host_socket_socketpair(family, type, svPtr) -> 0/-errno.
  {
    name: "host_socket_socketpair",
    method: METHOD.SYS_SOCKETPAIR,
    args: [],
    custom:
      (mk, memBuf, callerPid) =>
      async (family: number, type: number, svPtr: number): Promise<number> => {
        const req = new Uint8Array(8);
        const view = new DataView(req.buffer);
        req[0] = family & 0xff;
        req[1] = type & 0xff;
        view.setUint32(4, (type & ~0xff) >>> 0, true);
        const out = await mk.kernelSyscallAsync(
          METHOD.SYS_SOCKETPAIR,
          callerPid,
          req,
          8,
        );
        const rc = Number(out.rc);
        if (rc < 0) return rc;
        if (rc !== 8 || out.response.byteLength < 8) return -5;
        const outRc = copyOut(memBuf, svPtr, out.response.subarray(0, 8));
        return outRc < 0 ? outRc : 0;
      },
  },
  // host_socket_sendmsg(fd, dataPtr, dataLen, fdsPtr, fdsCount).
  {
    name: "host_socket_sendmsg",
    method: METHOD.SYS_SOCKET_SENDMSG,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      dataPtr: number,
      dataLen: number,
      fdsPtr: number,
      fdsCount: number,
    ): Promise<number> => {
      const data = copyIn(memBuf, dataPtr, dataLen);
      if (typeof data === "number") return data;
      const fdBytes = fdsCount > 0
        ? copyIn(memBuf, fdsPtr, (fdsCount >>> 0) * 4)
        : new Uint8Array();
      if (typeof fdBytes === "number") return fdBytes;
      const req = new Uint8Array(12 + data.length + fdBytes.length);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, data.length >>> 0, true);
      view.setUint32(8, fdsCount >>> 0, true);
      req.set(data, 12);
      req.set(fdBytes, 12 + data.length);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_SENDMSG,
        callerPid,
        req,
        0,
      );
      return Number(out.rc);
    },
  },
  // host_socket_recvmsg(fd, bufPtr, bufCap, fdsPtr, fdsCap, nFdsPtr).
  {
    name: "host_socket_recvmsg",
    method: METHOD.SYS_SOCKET_RECVMSG,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      bufPtr: number,
      bufCap: number,
      fdsPtr: number,
      fdsCap: number,
      nFdsPtr: number,
    ): Promise<number> => {
      const req = new Uint8Array(12);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd >>> 0, true);
      view.setUint32(4, 0, true);
      view.setUint32(8, bufCap >>> 0, true);
      const responseCap = (bufCap >>> 0) + 4 + (fdsCap >>> 0) * 4;
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_RECVMSG,
        callerPid,
        req,
        responseCap,
      );
      const rc = Number(out.rc);
      if (rc === -EAGAIN) return HOST_ASYNC_EAGAIN;
      if (rc < 0) return -EIO;
      if (rc > 0) {
        const outRc = copyOut(memBuf, bufPtr, out.response.subarray(0, rc));
        if (outRc < 0) return outRc;
      }
      const rightsStart = bufCap >>> 0;
      const totalFds = out.response.byteLength >= rightsStart + 4
        ? new DataView(
          out.response.buffer,
          out.response.byteOffset + rightsStart,
          4,
        ).getUint32(0, true)
        : 0;
      const fit = Math.min(totalFds, fdsCap >>> 0);
      if (fit > 0 && fdsPtr !== 0) {
        const start = rightsStart + 4;
        const outRc = copyOut(
          memBuf,
          fdsPtr,
          out.response.subarray(start, start + fit * 4),
        );
        if (outRc < 0) return outRc;
      }
      if (nFdsPtr !== 0) {
        const count = new Uint8Array(4);
        new DataView(count.buffer).setUint32(0, totalFds, true);
        const outRc = copyOut(memBuf, nFdsPtr, count);
        if (outRc < 0) return outRc;
      }
      return rc;
    },
  },
  {
    name: "host_socket_is_dgram",
    method: METHOD.SYS_SOCKET_INFO,
    args: [],
    custom: (mk, _memBuf, callerPid) => async (fd: number) => {
      const req = new Uint8Array(4);
      new DataView(req.buffer).setUint32(0, fd >>> 0, true);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_INFO,
        callerPid,
        req,
        24,
      );
      if (Number(out.rc) !== 24 || out.response.byteLength < 8) return -1;
      const sockType = new DataView(
        out.response.buffer,
        out.response.byteOffset,
        out.response.byteLength,
      ).getUint32(4, true);
      return sockType === 2 || sockType === 5 ? 1 : 0;
    },
  },
  {
    name: "host_socket_peercred",
    method: METHOD.SYS_SOCKET_PEERCRED,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      fd: number,
      pidPtr: number,
      uidPtr: number,
      gidPtr: number,
    ): Promise<number> => {
      // Wire SO_PEERCRED to the dedicated kernel syscall (0x1_0081),
      // NOT sys_socket_info — only sys_socket_peercred returns the
      // *captured* peer pid/uid/gid for the accept/connect cases.
      // Response is 12 bytes: i32 pid LE + i32 uid LE + i32 gid LE; the
      // kernel returns the byte count (12) on success, negative errno
      // on failure (the libc shim wants 0 on success, so map any
      // non-negative return to 0).
      const req = new Uint8Array(4);
      new DataView(req.buffer).setUint32(0, fd >>> 0, true);
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_PEERCRED,
        callerPid,
        req,
        12,
      );
      if (Number(out.rc) < 0 || out.response.byteLength < 12) return -1;
      const view = new DataView(
        out.response.buffer,
        out.response.byteOffset,
        out.response.byteLength,
      );
      const record = new Uint8Array(4);
      const recordView = new DataView(record.buffer);
      recordView.setInt32(0, view.getInt32(0, true), true);
      let outRc = copyOut(memBuf, pidPtr, record);
      if (outRc < 0) return outRc;
      recordView.setInt32(0, view.getInt32(4, true), true);
      outRc = copyOut(memBuf, uidPtr, record);
      if (outRc < 0) return outRc;
      recordView.setInt32(0, view.getInt32(8, true), true);
      outRc = copyOut(memBuf, gidPtr, record);
      if (outRc < 0) return outRc;
      return 0;
    },
  },
  {
    name: "host_socket_option",
    method: METHOD.SYS_SOCKET_OPTION,
    args: [],
    custom: (mk, _memBuf, callerPid) =>
    async (
      fd: number,
      option: number,
      hasValue: number,
      value: number,
    ): Promise<number> => {
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_SOCKET_OPTION,
        callerPid,
        socketOptionRequest(fd, option, hasValue, value),
        0,
      );
      return Number(out.rc);
    },
  },
  {
    name: "host_socket_set_no_delay",
    method: METHOD.SYS_SOCKET_OPTION,
    args: [],
    custom:
      (mk, _memBuf, callerPid) =>
      async (fd: number, enabled: number): Promise<number> => {
        const out = await mk.kernelSyscallAsync(
          METHOD.SYS_SOCKET_OPTION,
          callerPid,
          socketOptionRequest(fd, 1, 1, enabled),
          0,
        );
        return Number(out.rc);
      },
  },
  // host_socket_close(fd) → 0 / -errno.
  // SYS_SOCKET_CLOSE: u32 handle in request, no response.
  {
    name: "host_socket_close",
    method: METHOD.SYS_SOCKET_CLOSE,
    args: ["scalar"],
  },

  // ── Durable KV / IndexedDB-shaped persistence ─────────────
  // host_idb_get(reqPtr, reqLen, outPtr, outCap) → bytes.
  {
    name: "host_idb_get",
    method: METHOD.SYS_IDB_GET,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },
  // host_idb_put(reqPtr, reqLen) → 0 / -errno.
  {
    name: "host_idb_put",
    method: METHOD.SYS_IDB_PUT,
    args: ["ptr_len"],
  },
  // host_idb_delete(reqPtr, reqLen) → 0 / -errno.
  {
    name: "host_idb_delete",
    method: METHOD.SYS_IDB_DELETE,
    args: ["ptr_len"],
  },
  // host_idb_list(reqPtr, reqLen, outPtr, outCap) → bytes.
  {
    name: "host_idb_list",
    method: METHOD.SYS_IDB_LIST,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },

  // ── Custom builders (wire-format adapters) ────────────────
  // host_time() → seconds-as-float. TS impl returns
  // `Date.now() / 1000`. We route through SYS_CLOCK_GETTIME
  // with CLOCK_REALTIME (=0) and divide the u64 ns response
  // by 1e9 to match. Demonstrates the `custom` escape hatch
  // for bindings whose shape doesn't fit ArgSpec.
  {
    name: "host_time",
    method: METHOD.SYS_CLOCK_GETTIME,
    args: [],
    custom: (mk, _memBuf, callerPid) => async (): Promise<number> => {
      const req = new Uint8Array(4); // CLOCK_REALTIME = 0
      const out = await mk.kernelSyscallAsync(
        METHOD.SYS_CLOCK_GETTIME,
        callerPid,
        req,
        8,
      );
      if (Number(out.rc) !== 8) return 0;
      const ns = new DataView(
        out.response.buffer,
        out.response.byteOffset,
        8,
      ).getBigUint64(0, true);
      return Number(ns) / 1e9;
    },
  },

  // host_read_file(pathPtr, pathLen, outPtr, outCap) → bytes.
  // Compound: SYS_OPEN(flags=0, path) → fd → SYS_READ(fd) →
  // SYS_CLOSE(fd). Close happens even if read fails.
  {
    name: "host_read_file",
    method: METHOD.SYS_OPEN, // first hop; documentation only
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      pathPtr: number,
      pathLen: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> => {
      const path = copyIn(memBuf, pathPtr, pathLen);
      if (typeof path === "number") return path;
      const openReq = new Uint8Array(4 + path.length);
      // flags=0 → read-only.
      openReq.set(path, 4);
      const openOut = await mk.kernelSyscallAsync(
        METHOD.SYS_OPEN,
        callerPid,
        openReq,
        0,
      );
      const fd = Number(openOut.rc);
      if (fd < 0) return fd;
      try {
        const readReq = new Uint8Array(4);
        new DataView(readReq.buffer).setUint32(0, fd, true);
        const readOut = await mk.kernelSyscallAsync(
          METHOD.SYS_READ,
          callerPid,
          readReq,
          outCap,
        );
        const n = Number(readOut.rc);
        if (n > 0) {
          const outRc = copyOut(
            memBuf,
            outPtr,
            readOut.response.subarray(0, n),
          );
          if (outRc < 0) return outRc;
        }
        return n;
      } finally {
        const closeReq = new Uint8Array(4);
        new DataView(closeReq.buffer).setUint32(0, fd, true);
        await mk.kernelSyscallAsync(METHOD.SYS_CLOSE, callerPid, closeReq, 0);
      }
    },
  },

  // host_write_file(pathPtr, pathLen, dataPtr, dataLen, mode) → bytes.
  // Compound: SYS_OPEN(O_WRITE|O_CREAT [|O_TRUNC]) → optional
  // SYS_LSEEK(SEEK_END) for mode=1 (append) → SYS_WRITE →
  // SYS_CLOSE.
  {
    name: "host_write_file",
    method: METHOD.SYS_OPEN,
    args: [],
    custom: (mk, memBuf, callerPid) =>
    async (
      pathPtr: number,
      pathLen: number,
      dataPtr: number,
      dataLen: number,
      mode: number,
    ): Promise<number> => {
      const path = copyIn(memBuf, pathPtr, pathLen);
      if (typeof path === "number") return path;
      // mode 0 = overwrite (truncate); mode 1 = append.
      const flags = mode === 1 ? 0b011 : 0b111; // W|C [|T]
      const openReq = new Uint8Array(4 + path.length);
      new DataView(openReq.buffer).setUint32(0, flags, true);
      openReq.set(path, 4);
      const openOut = await mk.kernelSyscallAsync(
        METHOD.SYS_OPEN,
        callerPid,
        openReq,
        0,
      );
      const fd = Number(openOut.rc);
      if (fd < 0) return fd;
      try {
        if (mode === 1) {
          // Seek to end. Request: u32 fd + i64 offset (0) + u32
          // whence (SEEK_END=2). Response: 8-byte new offset.
          const lseekReq = new Uint8Array(16);
          const lv = new DataView(lseekReq.buffer);
          lv.setUint32(0, fd, true);
          lv.setBigInt64(4, 0n, true);
          lv.setUint32(12, 2, true);
          await mk.kernelSyscallAsync(
            METHOD.SYS_LSEEK,
            callerPid,
            lseekReq,
            8,
          );
        }
        const data = copyIn(memBuf, dataPtr, dataLen);
        if (typeof data === "number") return data;
        const writeReq = new Uint8Array(4 + data.length);
        new DataView(writeReq.buffer).setUint32(0, fd, true);
        writeReq.set(data, 4);
        const writeOut = await mk.kernelSyscallAsync(
          METHOD.SYS_WRITE,
          callerPid,
          writeReq,
          0,
        );
        return Number(writeOut.rc);
      } finally {
        const closeReq = new Uint8Array(4);
        new DataView(closeReq.buffer).setUint32(0, fd, true);
        await mk.kernelSyscallAsync(METHOD.SYS_CLOSE, callerPid, closeReq, 0);
      }
    },
  },
  // ── Signals ───────────────────────────────────────────────
  // sigaction(sig, actPtr, actLen) — TS host_sigaction shape.
  // Not in our common test path; left to a future expansion.

  // ── Clock ─────────────────────────────────────────────────
  // host_clock_gettime(clockId, outPtr) → 8 bytes (u64 ns)
  // Existing TS signature is (clockId, outPtr) without a cap;
  // the fixed_out arg spec supplies the 8-byte response capacity.
];

/**
 * Build the host_*-shaped import object that drives the Rust
 * kernel via the supplied KernelHostInterface. Each entry in
 * HOST_BINDINGS is materialized as one Promise-returning
 * wrapper. Imports not in the table are *absent* — callers
 * should fill any required gaps with their own stubs (or
 * accept the WebAssembly link error and add the binding).
 *
 * `memBuf()` resolves the calling wasm's `memory` export at
 * call time (it's set after instantiation).
 */
export function buildWasmKernelImports(
  mk: KernelHostInterface,
  memBuf: () => ArrayBuffer,
  callerPid = 0,
  initialCwd?: string,
  callerTid = 1,
  options?: BuildWasmKernelImportsOptions,
): Record<string, (...args: number[]) => Promise<number>> {
  if (initialCwd) {
    mk.kernelSyscall(
      METHOD.SYS_CHDIR,
      callerPid,
      new TextEncoder().encode(initialCwd),
      0,
    );
  }
  const imports: Record<string, (...args: number[]) => Promise<number>> = {};
  for (const b of HOST_BINDINGS) {
    imports[b.name] = b.custom
      ? b.custom(mk, memBuf, callerPid, callerTid, options)
      : makeWrapper(b, mk, memBuf, callerPid);
  }
  return imports;
}

function boundsOk(buffer: ArrayBuffer, ptr: number, len: number): boolean {
  ptr = ptr >>> 0;
  len = len >>> 0;
  return ptr <= buffer.byteLength && len <= buffer.byteLength - ptr;
}

function copyIn(
  memBuf: () => ArrayBuffer,
  ptr: number,
  len: number,
): Uint8Array | number {
  ptr = ptr >>> 0;
  len = len >>> 0;
  const buffer = memBuf();
  if (!boundsOk(buffer, ptr, len)) return -EFAULT;
  return new Uint8Array(buffer, ptr, len).slice();
}

function copyOut(
  memBuf: () => ArrayBuffer,
  ptr: number,
  bytes: Uint8Array,
): number {
  ptr = ptr >>> 0;
  const buffer = memBuf();
  if (!boundsOk(buffer, ptr, bytes.byteLength)) return -EFAULT;
  new Uint8Array(buffer, ptr, bytes.byteLength).set(bytes);
  return 0;
}

function unixSocketAddrBytes(
  memBuf: () => ArrayBuffer,
  pathPtr: number,
  pathLen: number,
  isAbstract: number,
): Uint8Array | number {
  const path = copyIn(memBuf, pathPtr, pathLen);
  if (typeof path === "number") return path;
  const out = new Uint8Array(2 + (isAbstract ? 1 : 0) + path.byteLength);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(
    0,
    1,
    true,
  );
  const pathOffset = isAbstract ? 3 : 2;
  if (isAbstract) out[2] = 0;
  out.set(path, pathOffset);
  return out;
}

function makeWrapper(
  b: HostBinding,
  mk: KernelHostInterface,
  memBuf: () => ArrayBuffer,
  callerPid: number,
): (...args: number[]) => Promise<number> {
  return async (...args: number[]): Promise<number> => {
    // Apply optional argument permutation. The reordered view is
    // what the spec walker consumes; the original `args` is the
    // shape bash (or any TS-host-shaped caller) passes.
    const ordered = b.argOrder ? b.argOrder.map((i) => args[i]) : args;
    const reqParts: Uint8Array[] = [];
    let outPtr = 0;
    let outCap = 0;
    let rcToOutPtr: number | null = null;
    let rcToOutCap = 0;
    let ai = 0;
    for (const spec of b.args) {
      if (spec === "scalar") {
        const v = ordered[ai++] >>> 0;
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, v, true);
        reqParts.push(bytes);
      } else if (spec === "scalar64") {
        const raw = ordered[ai++];
        const v = typeof raw === "bigint" ? raw : BigInt(raw >>> 0);
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, v as bigint, true);
        reqParts.push(bytes);
      } else if (spec === "ptr_len") {
        const ptr = ordered[ai++] >>> 0;
        const len = ordered[ai++] >>> 0;
        const slice = copyIn(memBuf, ptr, len);
        if (typeof slice === "number") return slice;
        reqParts.push(slice);
      } else if (spec === "prefixed_ptr_len") {
        const ptr = ordered[ai++] >>> 0;
        const len = ordered[ai++] >>> 0;
        const lenBytes = new Uint8Array(4);
        new DataView(lenBytes.buffer).setUint32(0, len, true);
        const slice = copyIn(memBuf, ptr, len);
        if (typeof slice === "number") return slice;
        reqParts.push(lenBytes);
        reqParts.push(slice);
      } else if (spec === "out_cap") {
        outPtr = ordered[ai++] >>> 0;
        outCap = ordered[ai++] >>> 0;
      } else if (typeof spec === "object" && spec.kind === "fixed_out") {
        outPtr = ordered[ai++] >>> 0;
        outCap = spec.cap;
      } else if (spec === "rc_to_out") {
        rcToOutPtr = ordered[ai++] >>> 0;
        rcToOutCap = ordered[ai++] >>> 0;
      } else if (spec === "ignore_scalar") {
        ai++;
      } else {
        throw new Error(`unknown arg spec ${String(spec)}`);
      }
    }
    // Concatenate request parts.
    let total = 0;
    for (const p of reqParts) total += p.byteLength;
    const req = new Uint8Array(total);
    let cursor = 0;
    for (const p of reqParts) {
      req.set(p, cursor);
      cursor += p.byteLength;
    }
    const out = await mk.kernelSyscallAsync(b.method, callerPid, req, outCap);
    const rc = Number(out.rc);
    if (
      b.returnsBytes && rc > 0 && outCap > 0 && rc <= outCap &&
      out.response.byteLength >= rc
    ) {
      const outRc = copyOut(memBuf, outPtr, out.response.subarray(0, rc));
      if (outRc < 0) return outRc;
    }
    if (rcToOutPtr !== null) {
      if (rc >= 0 && rcToOutCap >= 4) {
        const buffer = new Uint8Array(4);
        const view = new DataView(buffer.buffer);
        view.setInt32(0, rc, true);
        const outRc = copyOut(memBuf, rcToOutPtr, buffer);
        if (outRc < 0) return outRc;
        return 4;
      }
      return rc;
    }
    return rc;
  };
}
