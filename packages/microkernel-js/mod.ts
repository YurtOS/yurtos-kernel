/**
 * Sandboxed-kernel microkernel — portable JS / WebAssembly core.
 *
 * Runs unchanged in every JS engine: Deno, browsers (with JSPI or
 * asyncify when blocking syscalls land), Node, Bun. Browsers and
 * Deno share enough — WebAssembly, fetch, crypto, IndexedDB,
 * WebSocket — that there's no separate `microkernel-browser`. They
 * use *this* package directly.
 *
 * No host-specific APIs (no `Deno.*`, no `fs`, no `Worker`); only
 * `crypto` and `WebAssembly`, which are universal.
 *
 * Loads `yurt-kernel-wasm` (compiled to `wasm32-wasip1`), satisfies
 * the documented `kh_*` import surface, and runs the same kernel.wasm
 * artifact the wasmtime backend uses.
 *
 * Where engines actually differ:
 *   - **Real TCP sockets, real filesystem, real subprocess.** Only
 *     Deno (and Node) have these natively. They live in
 *     `packages/microkernel-deno/` as a thin extension consumed on
 *     top of this core.
 *   - **Service-Worker fetch routing, OPFS, IndexedDB persistence,**
 *     **postMessage to a host page.** Those are browser-page concerns
 *     above the microkernel — they live in the application layer
 *     (e.g. PR15's `sandbox.net` / `ListenerRegistry`), not as a
 *     parallel microkernel package.
 *
 * User-process syscall plumbing lives in two sibling files inside
 * this package:
 *   - `sys_shim.ts` — `sys_*` imports that forward to `kernel_dispatch`.
 *   - `wasi_shim.ts` — preview1 imports that route through `sys_*`.
 *
 * This file is the engine binding plus `kh_*` plus the spawn glue.
 *
 * Async / suspension story (future):
 *   The TS kernel ships `AsyncBridge` at
 *   `packages/kernel/src/async-bridge.ts` with jspi / asyncify /
 *   threads modes. When this microkernel grows blocking syscalls or
 *   a scheduler with multiple concurrent processes, the sys_*
 *   wrappers in `sys_shim.ts` become `bridge.wrapImport(asyncFn)` and
 *   `kernel_dispatch` is wrapped with `bridge.wrapExport(...)`. Every
 *   sys_* call is a suspension point on JS engines — that's the only
 *   way the scheduler can preempt a process.
 *
 * See `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.
 */

import { buildSysImports } from "./sys_shim.ts";
import { buildWasiShim } from "./wasi_shim.ts";

// ── Method IDs (must match abi/contract/yurt_abi_methods.toml) ────────────

export const METHOD = {
  KERNEL_ECHO: 1,
  KERNEL_NOW_REALTIME: 2,
  KERNEL_LOG_TEST: 3,
  KERNEL_PROVIDE_STDIN: 4,
  KERNEL_CLOSE_STDIN: 5,
  KERNEL_DRAIN_STDOUT: 6,
  KERNEL_DRAIN_STDERR: 7,
  KERNEL_REGISTER_FILE: 8,
  KERNEL_SET_ARGV: 9,
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
  SYS_GETRLIMIT: 0x1_000C,
  SYS_SETRLIMIT: 0x1_000D,
  SYS_CLOSE: 0x1_000E,
  SYS_DUP: 0x1_000F,
  SYS_EXTENSION_INVOKE: 0x1_0010,
  SYS_DUP2: 0x1_0011,
  SYS_PIPE: 0x1_0012,
  SYS_READ: 0x1_0013,
  SYS_WRITE: 0x1_0014,
  SYS_ISATTY: 0x1_0015,
  SYS_CLOCK_GETTIME: 0x1_0016,
  SYS_GETPGID: 0x1_0017,
  SYS_SETPGID: 0x1_0018,
  SYS_GETSID: 0x1_0019,
  SYS_SETSID: 0x1_001A,
  SYS_KILL: 0x1_001B,
  SYS_SIGACTION: 0x1_001C,
  SYS_SCHED_YIELD: 0x1_001D,
  SYS_NANOSLEEP: 0x1_001E,
  SYS_OPEN: 0x1_001F,
  SYS_LSEEK: 0x1_0020,
  SYS_FSTAT: 0x1_0021,
} as const;

export const KERNEL_PID = 0;

// ── Embedder-supplied traits ──────────────────────────────────────────────

export interface ExtensionRegistry {
  invoke(request: Uint8Array, responseCap: number): Uint8Array | number;
}

export interface LogSink {
  emit(severity: number, message: string): void;
}

/**
 * Policy decisions returned from {@link PolicyEnforcer} hooks.
 * Synchronous so embedders can plug in any blocking prompt
 * (browser dialog, CLI, "ask the human") behind a single method.
 */
export type PolicyDecision = "allow" | "deny";

/**
 * Embedder-supplied gate that sits at every `kh_*` crossing where
 * kernel.wasm is about to reach the outside world. Mirrors the
 * Rust-side `PolicyEnforcer` trait exactly so the same harness can
 * gate either microkernel backend.
 *
 * Defaults to Allow on every hook so embedders that don't care
 * about policy don't have to implement it. Embedders that do care
 * override the relevant methods.
 *
 * Hooks fire *before* the embedder's I/O code (extension registry,
 * log sink, eventual fs/socket bridges); a Deny short-circuits with
 * `-EACCES`.
 */
export interface PolicyEnforcer {
  /** Gate kh_extension_invoke. Default Allow. */
  mayInvokeExtension?(request: Uint8Array): PolicyDecision;
  /** Gate kh_real_fs_* (not wired yet). */
  mayOpenPath?(path: Uint8Array, write: boolean): PolicyDecision;
  /** Gate kh_socket_connect (not wired yet). */
  mayConnect?(host: string, port: number): PolicyDecision;
  /** Gate kh_socket_listen (not wired yet). */
  mayListen?(port: number): PolicyDecision;
  /** Gate kh_log emissions per message. */
  mayLog?(severity: number, message: string): PolicyDecision;
  /** Gate kh_now_realtime. */
  mayGetRealtime?(): PolicyDecision;
}

export interface HostState {
  nowRealtimeNs: bigint;
  extensions: ExtensionRegistry;
  logSink: LogSink;
  policy: PolicyEnforcer;
}

const ENOENT = 2;
const EFAULT = 14;
const EACCES = 13;

class EmptyExtensionRegistry implements ExtensionRegistry {
  invoke(): number {
    return -ENOENT;
  }
}

class DiscardLogSink implements LogSink {
  emit(): void {}
}

/**
 * Capabilities an {@link AsyncBridge} impl exposes. **Two flags are
 * per-host (jspi, threads) and one is per-loaded-wasm (asyncify)**.
 * See project memory `project_async_bridge` for the matrix.
 *
 * - `jspi`: host supports `WebAssembly.Suspending` /
 *   `WebAssembly.promising`. V8 / SpiderMonkey: yes; **Safari
 *   (JavaScriptCore) not yet** — re-check
 *   `webassembly.org/features` before relying on it.
 * - `asyncify`: kernel.wasm + user wasm were built with binaryen
 *   `--asyncify`. Engine-agnostic — works on every wasm engine
 *   because the instrumentation is wasm-level. Universal fallback
 *   when JSPI / stack switching aren't available.
 * - `stackSwitching`: engine supports the WebAssembly Stack
 *   Switching proposal (`cont.new`, `suspend`, `resume`).
 *   First-class wasm suspend/resume — supersedes asyncify and
 *   JSPI. Wasmer ships it; Chrome has experimental support.
 *   When available, prefer over asyncify.
 * - `threads`: host supports wasi-threads / wasm-threads. Widely
 *   supported across modern engines and JS hosts (Safari ≥ 14.1
 *   included).
 */
export interface AsyncCapabilities {
  jspi: boolean;
  asyncify: boolean;
  stackSwitching: boolean;
  threads: boolean;
}

/**
 * Host-supplied bridge to the JS event loop. Lets blocking
 * syscalls — sys_nanosleep, sys_read on an empty pipe, sys_wait
 * once spawn lands — suspend the calling wasm until the host work
 * completes. Capability-dependent: when nothing suspends
 * (Safari without asyncify-built wasm), `suspendUntil` throws
 * `"NOT_SUSPENDABLE"` and callers fall back to non-blocking
 * semantics (EAGAIN / immediate-return).
 *
 * Mirrors the Rust-side `AsyncBridge` trait.
 */
export interface AsyncBridge {
  capabilities(): AsyncCapabilities;
  /**
   * Suspend the calling wasm until `task` resolves; return its
   * payload. Throws `"NOT_SUSPENDABLE"` (literal string) if neither
   * JSPI nor asyncify is available.
   */
  suspendUntil(task: () => Promise<Uint8Array>): Uint8Array;
}

/**
 * Default no-suspension bridge. Used by hosts that have neither
 * JSPI nor asyncify-built wasm. Blocking syscalls fall back to
 * non-blocking semantics through this.
 */
export const noopAsyncBridge: AsyncBridge = {
  capabilities() {
    return { jspi: false, asyncify: false, stackSwitching: false, threads: false };
  },
  suspendUntil() {
    throw new Error("NOT_SUSPENDABLE");
  },
};

/**
 * Probe the current host for AsyncBridge capabilities. Returns a
 * fresh capability descriptor; the actual bridge that uses these
 * is plugged in by the embedder. JSPI detection is conservative —
 * presence of the `WebAssembly.Suspending` constructor.
 *
 * Asyncify detection requires inspecting the loaded user wasm
 * (the binaryen pass adds `asyncify_*` exports); detection is
 * deferred to the engine impl that knows which module to inspect.
 */
export function detectAsyncCapabilities(): AsyncCapabilities {
  // deno-lint-ignore no-explicit-any
  const W = (globalThis as any).WebAssembly;
  const hasJspi = typeof W?.Suspending === "function" &&
    typeof W?.promising === "function";
  // Stack Switching detection is similarly conservative — the
  // proposal exposes a `WebAssembly.Suspending` (used by JSPI) plus
  // `WebAssembly.Tag` etc.; for now mark unknown so engines fill
  // in after a feature probe of their choosing.
  return {
    jspi: hasJspi,
    asyncify: false, // engine fills this in after instantiation by checking
    //                  for `asyncify_*` exports in the loaded module
    stackSwitching: false, // engine fills this in via runtime probe
    threads: false, // wasi-threads detection is engine-level
  };
}

/**
 * Default policy: every hook returns "allow". Equivalent to having
 * no policy enforcer at all.
 */
export const allowAllPolicy: PolicyEnforcer = {};

/**
 * Strict policy: every hook returns "deny". Tests and embedders
 * that want zero outside-world access use this.
 */
export const denyAllPolicy: PolicyEnforcer = {
  mayInvokeExtension: () => "deny",
  mayOpenPath: () => "deny",
  mayConnect: () => "deny",
  mayListen: () => "deny",
  mayLog: () => "deny",
  mayGetRealtime: () => "deny",
};

export function defaultHostState(): HostState {
  return {
    nowRealtimeNs: 0n,
    extensions: new EmptyExtensionRegistry(),
    logSink: new DiscardLogSink(),
    policy: allowAllPolicy,
  };
}

// ── KernelInstance: loaded kernel.wasm + dispatch handle ──────────────────

/**
 * Public so `sys_shim.ts` and `wasi_shim.ts` can drive `syscall`
 * from inside the user-process linker. Construction is internal.
 */
export class KernelInstance {
  constructor(
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

// ── User process ──────────────────────────────────────────────────────────

export class UserProcess {
  constructor(
    readonly pid: number,
    private readonly instance: WebAssembly.Instance,
    private readonly memory: WebAssembly.Memory,
    private readonly kernel: KernelInstance,
  ) {}

  callExportI32(name: string): number {
    const f = this.instance.exports[name];
    if (typeof f !== "function") {
      throw new Error(`user-process missing '${name}' export`);
    }
    return (f as () => number)();
  }

  runStart(): void {
    const f = this.instance.exports._start;
    if (typeof f !== "function") {
      throw new Error("user-process missing '_start' (not a WASI command)");
    }
    (f as () => void)();
  }

  readMemory(addr: number, len: number): Uint8Array {
    return new Uint8Array(
      new Uint8Array(this.memory.buffer, addr, len).slice().buffer,
    );
  }

  feedStdin(bytes: Uint8Array): void {
    const req = new Uint8Array(4 + bytes.byteLength);
    new DataView(req.buffer).setUint32(0, this.pid, true);
    req.set(bytes, 4);
    this.kernel.syscall(METHOD.KERNEL_PROVIDE_STDIN, KERNEL_PID, req, 0);
  }

  closeStdin(): void {
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, this.pid, true);
    this.kernel.syscall(METHOD.KERNEL_CLOSE_STDIN, KERNEL_PID, req, 0);
  }

  capturedStdout(): Uint8Array {
    return this.drainStream(METHOD.KERNEL_DRAIN_STDOUT);
  }
  capturedStderr(): Uint8Array {
    return this.drainStream(METHOD.KERNEL_DRAIN_STDERR);
  }

  private drainStream(methodId: number): Uint8Array {
    const out: number[] = [];
    const cap = Math.max(0, this.kernel.scratchLen - 4);
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, this.pid, true);
    while (true) {
      const { rc, response } = this.kernel.syscall(
        methodId,
        KERNEL_PID,
        req,
        cap,
      );
      const n = Number(rc);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) out.push(response[i]);
      if (n < cap) break;
    }
    return Uint8Array.from(out);
  }
}

// ── Microkernel ───────────────────────────────────────────────────────────

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
    const hostBox = { state: hostState };

    const khImports = {
      kh_now_realtime: (outPtr: number): number => {
        // Policy gate fires before any state read.
        if (
          hostBox.state.policy.mayGetRealtime?.() === "deny"
        ) {
          return -EACCES;
        }
        new DataView(memoryRef.memory!.buffer).setBigUint64(
          outPtr,
          hostBox.state.nowRealtimeNs,
          true,
        );
        return 0;
      },
      kh_log: (severity: number, msgPtr: number, msgLen: number): number => {
        const bytes = new Uint8Array(memoryRef.memory!.buffer, msgPtr, msgLen);
        const message = new TextDecoder().decode(bytes);
        // Policy may suppress per message; default Allow.
        if (
          hostBox.state.policy.mayLog?.(severity, message) === "deny"
        ) {
          return 0;
        }
        hostBox.state.logSink.emit(severity, message);
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
        // Policy gate at the kh_* boundary — denied calls don't
        // reach the registry.
        if (
          hostBox.state.policy.mayInvokeExtension?.(request) === "deny"
        ) {
          return BigInt(-EACCES);
        }
        const result = hostBox.state.extensions.invoke(request, outCap);
        if (typeof result === "number") return BigInt(result);
        if (result.byteLength > outCap) return BigInt(-EFAULT);
        new Uint8Array(memoryRef.memory!.buffer, outPtr, result.byteLength).set(
          result,
        );
        return BigInt(result.byteLength);
      },
    };

    // std-on-wasi panic-infra stubs for kernel.wasm itself.
    const wasiKernelStubs = {
      environ_get: () => 0,
      environ_sizes_get: (countPtr: number, sizePtr: number) => {
        const view = new DataView(memoryRef.memory!.buffer);
        view.setUint32(countPtr, 0, true);
        view.setUint32(sizePtr, 0, true);
        return 0;
      },
      fd_write: () => 0,
      fd_close: () => 0,
      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      proc_exit: (code: number): never => {
        throw new Error(`kernel.wasm proc_exit(${code}) — kernel terminated`);
      },
      random_get: (bufPtr: number, bufLen: number) => {
        crypto.getRandomValues(
          new Uint8Array(memoryRef.memory!.buffer, bufPtr, bufLen),
        );
        return 0;
      },
      clock_time_get: (
        _clockId: number,
        _precision: bigint,
        timePtr: number,
      ) => {
        new DataView(memoryRef.memory!.buffer).setBigUint64(
          timePtr,
          BigInt(Date.now()) * 1_000_000n,
          true,
        );
        return 0;
      },
    };

    const module = await WebAssembly.compile(
      kernelWasmBytes as unknown as BufferSource,
    );
    const instance = await WebAssembly.instantiate(module, {
      kh: khImports,
      wasi_snapshot_preview1: wasiKernelStubs,
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

    const kernel = new KernelInstance(memory, scratchPtr, scratchLen, dispatch);
    hostBox.state = hostState;
    const mk = new Microkernel(kernel, hostState);
    (mk as unknown as { hostBox: typeof hostBox }).hostBox = hostBox;
    return mk;
  }

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

  /**
   * Install a file blob into kernel.wasm's in-memory ramfs at `path`,
   * replacing any existing content. Phase 2 ramfs is read-only from
   * userland; this is the only way bytes get in today.
   */
  registerRamfsFile(path: Uint8Array, content: Uint8Array): void {
    const req = new Uint8Array(4 + path.byteLength + content.byteLength);
    new DataView(req.buffer).setUint32(0, path.byteLength >>> 0, true);
    req.set(path, 4);
    req.set(content, 4 + path.byteLength);
    const { rc } = this.syscall(METHOD.KERNEL_REGISTER_FILE, req, 0);
    if (Number(rc) !== 0) {
      throw new Error(`kernel_register_file failed: rc=${rc}`);
    }
  }

  spawnUserProcess(userWasmBytes: Uint8Array): UserProcess {
    return this.spawnUserProcessWithArgs(userWasmBytes, []);
  }

  spawnUserProcessWithArgs(
    userWasmBytes: Uint8Array,
    argv: Uint8Array[],
  ): UserProcess {
    const pid = this.nextPid++;
    const userMemoryRef: { memory?: WebAssembly.Memory } = {};

    // Push argv to the kernel so /proc/<pid>/cmdline + comm have
    // content to serve. Format: u32 pid + (u32 arg_len + arg_bytes)*.
    let argvSize = 4;
    for (const a of argv) argvSize += 4 + a.byteLength;
    const argvReq = new Uint8Array(argvSize);
    const argvView = new DataView(argvReq.buffer);
    argvView.setUint32(0, pid >>> 0, true);
    let cursor = 4;
    for (const a of argv) {
      argvView.setUint32(cursor, a.byteLength >>> 0, true);
      cursor += 4;
      argvReq.set(a, cursor);
      cursor += a.byteLength;
    }
    this.kernel.syscall(METHOD.KERNEL_SET_ARGV, KERNEL_PID, argvReq, 0);

    const sysImports = buildSysImports(pid, this.kernel, userMemoryRef);
    // sys_setrlimit takes (i32, i64, i64); BigInt at the wasm boundary
    // doesn't fit the unified signature in sys_shim, so it's wired
    // here directly.
    const sys_setrlimit = (
      resource: number,
      soft: bigint,
      hard: bigint,
    ): number => {
      const req = new Uint8Array(20);
      const v = new DataView(req.buffer);
      v.setUint32(0, resource >>> 0, true);
      v.setBigUint64(4, soft, true);
      v.setBigUint64(12, hard, true);
      return Number(this.kernel.syscall(METHOD.SYS_SETRLIMIT, pid, req, 0).rc);
    };

    const wasiShim = buildWasiShim(pid, this.kernel, argv, userMemoryRef);

    const userModule = new WebAssembly.Module(
      userWasmBytes as unknown as BufferSource,
    );
    const userInstance = new WebAssembly.Instance(userModule, {
      env: { ...sysImports, sys_setrlimit },
      wasi_snapshot_preview1: wasiShim,
    });
    const userMemory = userInstance.exports.memory as
      | WebAssembly.Memory
      | undefined;
    userMemoryRef.memory = userMemory ??
      new WebAssembly.Memory({ initial: 0 });
    return new UserProcess(
      pid,
      userInstance,
      userMemoryRef.memory,
      this.kernel,
    );
  }

  spawnUserProcessWithArgsAndStdin(
    userWasmBytes: Uint8Array,
    argv: Uint8Array[],
    stdin: Uint8Array,
    eof: boolean,
  ): UserProcess {
    const user = this.spawnUserProcessWithArgs(userWasmBytes, argv);
    if (stdin.byteLength > 0) user.feedStdin(stdin);
    if (eof) user.closeStdin();
    return user;
  }
}

/** Encode a string as UTF-8 byte-string for argv. */
export function s(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
