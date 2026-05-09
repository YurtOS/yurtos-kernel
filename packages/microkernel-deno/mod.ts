/**
 * Sandboxed-kernel microkernel — Deno / browser backend.
 *
 * Loads `yurt-kernel-wasm` (compiled to `wasm32-wasip1`) into the JS
 * WebAssembly engine, satisfies the documented `kh_*` import surface,
 * and forwards user-process syscalls into `kernel_dispatch`. Same
 * architectural shape as `packages/runtime-wasmtime/src/microkernel.rs`
 * — this is the second microkernel implementation, validating that
 * the contract (`kernel_dispatch` + `kh_*` imports) is genuinely
 * runtime-agnostic.
 *
 * Deno is the testing surrogate for the browser microkernel: the
 * import shapes and user-process linking flow are identical. A
 * browser version reuses this code modulo `Deno.readFile` → `fetch`
 * and `Deno.Command` removal.
 *
 * Async / suspension (future work — *do not reinvent*):
 *
 *   The TS kernel ships `AsyncBridge` at
 *   `packages/kernel/src/async-bridge.ts`, with `jspi`, `asyncify`,
 *   and `threads` modes already implemented and in production for the
 *   user-process loaders, setjmp/longjmp, and the process manager.
 *   The sandboxed-kernel reuses it verbatim:
 *
 *     - kh_* imports that go async become `bridge.wrapImport(asyncFn)`.
 *     - kernel_dispatch is wrapped via `bridge.wrapExport(...)` so
 *       callers await the result.
 *     - kernel.wasm gets an `-asyncify` variant matching
 *       `bridge.binarySuffix` for Safari / Bun.
 *
 *   Two architectural absolutes for JS hosts (irrelevant on native
 *   wasmtime, where Tokio + epoch interruption cover everything):
 *
 *     - Cooperative multitasking *requires* JSPI or asyncify. WASM on
 *       JS engines has no preemption; suspending one process to run
 *       another is impossible without one of those mechanisms.
 *     - setjmp / longjmp *requires* asyncify, regardless of whether
 *       JSPI is otherwise active — the unwind/rewind machinery is
 *       the long-jump. (See `needsSetjmpBridge` in
 *       `process/manager.ts`.)
 *
 *   The current sync path here is correct because no `kh_*` is async
 *   yet and there's only one user process at a time. When the first
 *   blocking syscall (kh_yield, sys_recv, sys_wait) or the second
 *   concurrent process lands, this file plugs into AsyncBridge.
 *
 * See `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.
 */

// Method ids must match `abi/contract/yurt_abi_methods.toml`. Drift is
// caught by `methods_test.ts`.
export const METHOD = {
  KERNEL_ECHO: 1,
  KERNEL_NOW_REALTIME: 2,
  KERNEL_LOG_TEST: 3,
  SYS_GETUID: 0x1_0001,
  SYS_GETEUID: 0x1_0002,
  SYS_GETGID: 0x1_0003,
  SYS_GETEGID: 0x1_0004,
  SYS_GETPID: 0x1_0005,
  SYS_GETPPID: 0x1_0006,
  SYS_UMASK: 0x1_0007,
  SYS_SETRESUID: 0x1_0008,
  SYS_SETRESGID: 0x1_0009,
  SYS_CHDIR: 0x1_000A,
  SYS_GETCWD: 0x1_000B,
  SYS_EXTENSION_INVOKE: 0x1_0010,
} as const;

/** Reserved pid for direct microkernel→kernel calls. */
export const KERNEL_PID = 0;

/**
 * Microkernel-side handler for `sys_extension_invoke`. Mirrors the
 * Rust `ExtensionRegistry` trait: opaque request bytes in, opaque
 * response bytes out. Return value: bytes written, or negated POSIX
 * errno (e.g. -ENOENT = -2 if no handler matches).
 */
export interface ExtensionRegistry {
  invoke(request: Uint8Array, responseCap: number): Uint8Array | number;
}

/**
 * Microkernel-side sink for `kh_log` messages from kernel.wasm.
 * Severity: 0=debug, 1=info, 2=warn, 3=error.
 */
export interface LogSink {
  emit(severity: number, message: string): void;
}

export interface HostState {
  nowRealtimeNs: bigint;
  extensions: ExtensionRegistry;
  logSink: LogSink;
}

const ENOENT = 2;
const EFAULT = 14;

class EmptyExtensionRegistry implements ExtensionRegistry {
  invoke(_req: Uint8Array, _cap: number): number {
    return -ENOENT;
  }
}

class DiscardLogSink implements LogSink {
  emit(_severity: number, _message: string): void {}
}

export function defaultHostState(): HostState {
  return {
    nowRealtimeNs: 0n,
    extensions: new EmptyExtensionRegistry(),
    logSink: new DiscardLogSink(),
  };
}

// WASI preview1 pulled in by std-on-wasi for panic infrastructure
// (fd_write, proc_exit, environ_*). The kernel doesn't actually use
// WASI for I/O; we satisfy these imports with no-op stubs that match
// the panic/abort path. If kernel.wasm panics, proc_exit terminates.
function wasiStubs(memoryRef: { memory?: WebAssembly.Memory }) {
  return {
    environ_get: (_envp: number, _envBuf: number) => 0,
    environ_sizes_get: (countPtr: number, sizePtr: number) => {
      // Return zero environment.
      const m = memoryRef.memory!;
      const view = new DataView(m.buffer);
      view.setUint32(countPtr, 0, true);
      view.setUint32(sizePtr, 0, true);
      return 0;
    },
    fd_write: (
      _fd: number,
      _iovs: number,
      _iovsLen: number,
      _nwritten: number,
    ) => 0,
    fd_close: (_fd: number) => 0,
    fd_seek: (
      _fd: number,
      _offset: bigint,
      _whence: number,
      _newOffsetPtr: number,
    ) => 0,
    fd_fdstat_get: (_fd: number, _statPtr: number) => 0,
    proc_exit: (code: number): never => {
      throw new Error(`kernel.wasm proc_exit(${code}) — kernel terminated`);
    },
    random_get: (bufPtr: number, bufLen: number) => {
      const m = memoryRef.memory!;
      const buf = new Uint8Array(m.buffer, bufPtr, bufLen);
      crypto.getRandomValues(buf);
      return 0;
    },
    clock_time_get: (
      _clockId: number,
      _precision: bigint,
      timePtr: number,
    ) => {
      const m = memoryRef.memory!;
      const view = new DataView(m.buffer);
      view.setBigUint64(timePtr, BigInt(Date.now()) * 1_000_000n, true);
      return 0;
    },
  };
}

/** A loaded kernel.wasm instance, owned by the microkernel. */
class KernelInstance {
  constructor(
    readonly instance: WebAssembly.Instance,
    readonly memory: WebAssembly.Memory,
    readonly scratchPtr: number,
    readonly scratchLen: number,
    readonly dispatch: (
      methodId: number,
      callerPid: number,
      inPtr: number,
      inLen: number,
      outPtr: number,
      outCap: number,
    ) => bigint,
  ) {}

  /** Invoke a syscall via the trampoline. */
  syscall(
    methodId: number,
    callerPid: number,
    request: Uint8Array,
    responseCap: number,
  ): { rc: bigint; response: Uint8Array } {
    if (request.byteLength + responseCap > this.scratchLen) {
      throw new Error(
        `request+response (${
          request.byteLength + responseCap
        } bytes) exceeds scratch capacity (${this.scratchLen})`,
      );
    }
    const inPtr = this.scratchPtr;
    const inLen = request.byteLength;
    const outPtr = this.scratchPtr + inLen;
    if (inLen > 0) {
      new Uint8Array(this.memory.buffer, inPtr, inLen).set(request);
    }
    const rc = this.dispatch(
      methodId,
      callerPid,
      inPtr,
      inLen,
      outPtr,
      responseCap,
    );
    let response = new Uint8Array(0);
    if (responseCap > 0) {
      response = new Uint8Array(
        new Uint8Array(this.memory.buffer, outPtr, responseCap).slice().buffer,
      );
    }
    return { rc, response };
  }
}

/** A spawned user-process instance. */
export class UserProcess {
  constructor(
    readonly pid: number,
    private readonly instance: WebAssembly.Instance,
    private readonly memory: WebAssembly.Memory,
  ) {}

  callExportI32(name: string): number {
    const f = this.instance.exports[name];
    if (typeof f !== "function") {
      throw new Error(`user-process missing '${name}' export`);
    }
    const rc = (f as () => number)();
    return rc;
  }

  readMemory(addr: number, len: number): Uint8Array {
    return new Uint8Array(
      new Uint8Array(this.memory.buffer, addr, len).slice().buffer,
    );
  }
}

/**
 * The microkernel. Loads kernel.wasm and instantiates user processes
 * whose `sys_*` imports forward into the kernel.
 */
export class Microkernel {
  private kernel: KernelInstance;
  private hostState: HostState;
  private nextPid = 1;

  private constructor(kernel: KernelInstance, hostState: HostState) {
    this.kernel = kernel;
    this.hostState = hostState;
  }

  static async load(
    kernelWasmBytes: Uint8Array,
    hostState: HostState = defaultHostState(),
  ): Promise<Microkernel> {
    const memoryRef: { memory?: WebAssembly.Memory } = {};

    // Closures capture hostState through the wrapping object so that
    // mutations from `hostStateMut()` are visible to subsequent kh_*
    // calls. The same trick we use on the Rust side via &mut.
    const hostBox = { state: hostState };

    const khImports = {
      kh_now_realtime: (outPtr: number): number => {
        const view = new DataView(memoryRef.memory!.buffer);
        view.setBigUint64(outPtr, hostBox.state.nowRealtimeNs, true);
        return 0;
      },
      kh_log: (severity: number, msgPtr: number, msgLen: number): number => {
        const bytes = new Uint8Array(memoryRef.memory!.buffer, msgPtr, msgLen);
        const msg = new TextDecoder().decode(bytes);
        hostBox.state.logSink.emit(severity, msg);
        return 0;
      },
      kh_extension_invoke: (
        reqPtr: number,
        reqLen: number,
        outPtr: number,
        outCap: number,
      ): bigint => {
        const request = new Uint8Array(
          new Uint8Array(memoryRef.memory!.buffer, reqPtr, reqLen).slice()
            .buffer,
        );
        const result = hostBox.state.extensions.invoke(request, outCap);
        if (typeof result === "number") {
          return BigInt(result); // negated errno
        }
        if (result.byteLength > outCap) {
          return BigInt(-EFAULT);
        }
        new Uint8Array(memoryRef.memory!.buffer, outPtr, result.byteLength).set(
          result,
        );
        return BigInt(result.byteLength);
      },
    };

    const module = await WebAssembly.compile(
      kernelWasmBytes as unknown as BufferSource,
    );
    const instance = await WebAssembly.instantiate(module, {
      kh: khImports,
      wasi_snapshot_preview1: wasiStubs(memoryRef),
    });
    const memory = instance.exports.memory as WebAssembly.Memory;
    memoryRef.memory = memory;

    const scratchPtr = (instance.exports.kernel_scratch_ptr as () => number)();
    const scratchLen = (instance.exports.kernel_scratch_len as () => number)();
    const dispatch = instance.exports.kernel_dispatch as (
      methodId: number,
      callerPid: number,
      inPtr: number,
      inLen: number,
      outPtr: number,
      outCap: number,
    ) => bigint;

    const kernel = new KernelInstance(
      instance,
      memory,
      scratchPtr,
      scratchLen,
      dispatch,
    );

    // Replace hostState reference: the closures captured hostBox.state
    // by reference, so swapping the field updates them.
    hostBox.state = hostState;

    const mk = new Microkernel(kernel, hostState);
    // Stash hostBox so hostStateMut() can swap it.
    (mk as unknown as { hostBox: typeof hostBox }).hostBox = hostBox;
    return mk;
  }

  /** Direct microkernel→kernel call (no user process; pid 0). */
  syscall(
    methodId: number,
    request: Uint8Array,
    responseCap: number,
  ): { rc: bigint; response: Uint8Array } {
    return this.kernel.syscall(methodId, KERNEL_PID, request, responseCap);
  }

  hostStateMut(): HostState {
    return this.hostState;
  }

  spawnUserProcess(userWasmBytes: Uint8Array): UserProcess {
    const pid = this.nextPid++;
    const kernel = this.kernel;

    const forwardScalar = (methodId: number): number =>
      Number(kernel.syscall(methodId, pid, new Uint8Array(0), 0).rc);

    const forwardRequestBytes = (methodId: number, req: Uint8Array): bigint =>
      kernel.syscall(methodId, pid, req, 0).rc;

    const forwardUserPtrLen = (
      methodId: number,
      ptr: number,
      len: number,
    ): number => {
      const buf = new Uint8Array(
        new Uint8Array(userMemory!.buffer, ptr, len).slice().buffer,
      );
      return Number(kernel.syscall(methodId, pid, buf, 0).rc);
    };

    const forwardResponseToUser = (
      methodId: number,
      outPtr: number,
      outCap: number,
    ): number => {
      const cap = Math.min(outCap, kernel.scratchLen);
      const { rc, response } = kernel.syscall(
        methodId,
        pid,
        new Uint8Array(0),
        cap,
      );
      const rcNum = Number(rc);
      if (rcNum <= 0) return rcNum;
      const toCopy = Math.min(rcNum, cap);
      new Uint8Array(userMemory!.buffer, outPtr, toCopy).set(
        response.subarray(0, toCopy),
      );
      return rcNum;
    };

    const sysImports = {
      sys_getuid: () => forwardScalar(METHOD.SYS_GETUID),
      sys_geteuid: () => forwardScalar(METHOD.SYS_GETEUID),
      sys_getgid: () => forwardScalar(METHOD.SYS_GETGID),
      sys_getegid: () => forwardScalar(METHOD.SYS_GETEGID),
      sys_getpid: () => forwardScalar(METHOD.SYS_GETPID),
      sys_getppid: () => forwardScalar(METHOD.SYS_GETPPID),
      sys_umask: (mask: number) => {
        const req = new Uint8Array(4);
        new DataView(req.buffer).setUint32(0, mask >>> 0, true);
        return Number(forwardRequestBytes(METHOD.SYS_UMASK, req));
      },
      sys_setresuid: (ruid: number, euid: number, suid: number) => {
        const req = new Uint8Array(12);
        const v = new DataView(req.buffer);
        v.setUint32(0, ruid >>> 0, true);
        v.setUint32(4, euid >>> 0, true);
        v.setUint32(8, suid >>> 0, true);
        return Number(forwardRequestBytes(METHOD.SYS_SETRESUID, req));
      },
      sys_setresgid: (rgid: number, egid: number, sgid: number) => {
        const req = new Uint8Array(12);
        const v = new DataView(req.buffer);
        v.setUint32(0, rgid >>> 0, true);
        v.setUint32(4, egid >>> 0, true);
        v.setUint32(8, sgid >>> 0, true);
        return Number(forwardRequestBytes(METHOD.SYS_SETRESGID, req));
      },
      sys_chdir: (pathPtr: number, pathLen: number) =>
        forwardUserPtrLen(METHOD.SYS_CHDIR, pathPtr, pathLen),
      sys_getcwd: (outPtr: number, outCap: number) =>
        forwardResponseToUser(METHOD.SYS_GETCWD, outPtr, outCap),
    };

    const userModule = new WebAssembly.Module(
      userWasmBytes as unknown as BufferSource,
    );
    const userInstance = new WebAssembly.Instance(userModule, {
      env: sysImports,
    });
    const userMemory = userInstance.exports.memory as
      | WebAssembly.Memory
      | undefined;
    return new UserProcess(pid, userInstance, userMemory!);
  }
}
