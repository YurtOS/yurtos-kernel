/**
 * Worker entry point that hosts a single spawned pthread.
 *
 * Receives a `start` message with the WebAssembly.Module, the
 * SharedArrayBuffer-backed Memory, the indirect-table index of the
 * thread's start function, and the i32 argument. Instantiates the
 * same module against the shared memory, calls the indexed function,
 * and posts back `{type:"done", tid, retval}`.
 *
 * Task 9: if the start message includes `requestSab`, the worker
 * constructs a `WorkerHostImportProxy` and builds the yurt-namespace
 * host imports via `createWorkerYurtImports`. The proxy's
 * `postHostCall` is built locally (functions don't structured-clone),
 * and just calls `self.postMessage({type:"host-call"})` so the
 * main-side dispatcher runs.
 */

import {
  createWorkerYurtImports,
  type WorkerHostImportProxy,
  WorkerHostOp,
  WorkerThreadExit,
} from "./worker-host-proxy.ts";

interface StartMessage {
  type: "start";
  tid: number;
  fnPtr: number;
  arg: number;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  /**
   * Optional per-thread request SAB. When present, the worker wires
   * yurt-namespace host imports through the SAB; main attaches a
   * dispatcher to handle the requests. When absent, the worker
   * instantiates with `yurt: {}` (Task 4 behavior).
   */
  requestSab?: SharedArrayBuffer;
}

interface DoneMessage {
  type: "done";
  tid: number;
  retval: number;
}

const workerSelf = self as unknown as {
  onmessage:
    | ((event: MessageEvent<StartMessage>) => void | Promise<void>)
    | null;
  postMessage(message: unknown): void;
};

workerSelf.onmessage = async (e: MessageEvent<StartMessage>) => {
  if (e.data?.type !== "start") return;
  const { tid, fnPtr, arg, module, memory, requestSab } = e.data;

  let yurtImports: WebAssembly.ModuleImports = {};
  if (requestSab) {
    const proxy: WorkerHostImportProxy = {
      requestSab,
      postHostCall: (_op: WorkerHostOp) =>
        workerSelf.postMessage({ type: "host-call" }),
    };
    yurtImports = createWorkerYurtImports(tid, memory, proxy);
  }

  // Minimum WASI surface the pthread needs to reach common stop points
  // (clock_time_get / random_get on bootstrap, sched_yield in cooperative
  // loops, proc_exit on unrecoverable error, fd_write for libc abort
  // messages on stderr). Anything else still falls through to the trap
  // stub below so unhandled imports remain observable.
  const { imports: wasiImports, flushStdio } = createPthreadWasiImports(
    memory,
  );

  // The wasm module imports more functions than the worker actively
  // provides (the parent instance wires all of them on main). Build a
  // fully-populated imports object by enumerating the module's imports
  // and supplying a trap stub for anything missing. Stubs trap when
  // called so a stray host-import use on the worker side is observable;
  // they're never called for the canary worker function (which uses
  // only mutex/TLS/cond ops already provided by `createWorkerYurtImports`).
  const imports: WebAssembly.Imports = {
    env: { memory },
    yurt: yurtImports,
    wasi_snapshot_preview1: wasiImports,
  };
  for (const imp of WebAssembly.Module.imports(module)) {
    const ns = (imports[imp.module] ?? {}) as WebAssembly.ModuleImports;
    imports[imp.module] = ns;
    if (imp.name in ns) continue;
    if (imp.kind === "function") {
      const importName = `${imp.module}.${imp.name}`;
      ns[imp.name] = () => {
        throw new Error(
          `worker pthread called unprovided import ${importName} (tid=${tid})`,
        );
      };
    } else if (imp.kind === "memory") {
      ns[imp.name] = memory;
    } else if (imp.kind === "global") {
      // Mutable globals can't be safely shared between instances; provide
      // a zero immutable i32 stub. If the module truly imports a mutable
      // shared global, instantiation will trap and surface a clear error.
      ns[imp.name] = new WebAssembly.Global(
        { value: "i32", mutable: false },
        0,
      );
    } else if (imp.kind === "table") {
      ns[imp.name] = new WebAssembly.Table({
        initial: 0,
        element: "anyfunc",
      });
    }
  }

  let retval: number;
  try {
    const instance = await WebAssembly.instantiate(module, imports);

    // wasm thread-local-storage bootstrap. wasm-ld emits `__thread`
    // variables (cpython's `_Py_tss_tstate`, libzmq locals, …) at
    // offsets from a per-instance `__tls_base` global, and a paired
    // `__wasm_init_tls(addr)` export copies the linker-prepared TLS
    // template into the per-thread region. Without doing this on
    // each pthread Worker, every instance's `__tls_base` keeps its
    // default value (typically 0) and every "thread-local" variable
    // collides at the same shared-memory address — heartbeat /
    // iostream threads then race on `_Py_tss_tstate` and trip
    // `_PyThreadState_Attach: non-NULL old thread state` fatal.
    //
    // The three exports are emitted conditionally by wasm-ld (yurt-cc
    // marks them `--export-if-defined` since single-threaded binaries
    // don't have TLS variables). Skip the dance for those binaries —
    // the canary tests, file-conformance fixture etc. don't need TLS.
    const tlsSizeGlobal = instance.exports.__tls_size as
      | WebAssembly.Global
      | undefined;
    const tlsBaseGlobal = instance.exports.__tls_base as
      | WebAssembly.Global
      | undefined;
    const initTls = instance.exports.__wasm_init_tls as
      | ((tlsBase: number) => void)
      | undefined;
    const alloc = instance.exports.__alloc as
      | ((size: number) => number)
      | undefined;
    if (
      tlsSizeGlobal !== undefined &&
      tlsBaseGlobal !== undefined &&
      typeof initTls === "function" &&
      typeof alloc === "function"
    ) {
      const tlsSize = tlsSizeGlobal.value | 0;
      if (tlsSize > 0) {
        // wasi-libc malloc is mutex-protected and doesn't itself read
        // TLS at allocation time, so this bootstrap call is safe even
        // though `__wasi_init_tp` hasn't run yet.
        const tlsBase = alloc(tlsSize) | 0;
        tlsBaseGlobal.value = tlsBase;
        initTls(tlsBase);
      }
    }

    // wasi-libc thread-pointer initialiser. Runs AFTER `__tls_base` is
    // valid because wasi-libc's pthread struct lives inside the TLS
    // region we just wired up.
    const initTp = instance.exports.__wasi_init_tp;
    if (typeof initTp === "function") {
      (initTp as () => void)();
    }
    const table = instance.exports.__indirect_function_table;
    if (!(table instanceof WebAssembly.Table)) {
      retval = -1;
    } else {
      const fn = table.get(fnPtr) as ((arg: number) => number) | null;
      if (typeof fn !== "function") {
        retval = -1;
      } else {
        try {
          retval = fn(arg) | 0;
        } catch (e) {
          if (e instanceof WorkerThreadExit) {
            retval = e.retval | 0;
          } else {
            retval = -1;
          }
        }
      }
    }
  } catch {
    // Instantiation failure or trap: report -1 and let the joining
    // side handle it. We don't propagate the error object across the
    // postMessage boundary; structured-clone of WebAssembly errors is
    // fiddly and not needed for the scaffold.
    retval = -1;
  }

  // Drain any partial stdio line still sitting in the per-fd buffers
  // before terminating. Python tracebacks (e.g. ipykernel's Heartbeat
  // thread) often end without a trailing newline; without this flush
  // they'd be lost when the Worker is terminated by the joining side.
  flushStdio();

  const msg: DoneMessage = { type: "done", tid, retval };
  workerSelf.postMessage(msg);
};

const WASI_ESUCCESS = 0;
const WASI_ENOSYS = 52;
const WASI_FILETYPE_SOCKET_STREAM = 6;
const WASI_RIGHTS_ALL = 0x1fffffffn;

function createPthreadWasiImports(
  memory: WebAssembly.Memory,
): { imports: WebAssembly.ModuleImports; flushStdio: () => void } {
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);

  // Line-buffered per-fd stderr/stdout sinks. cpython often writes one
  // byte at a time; without buffering each byte would land on its own
  // line with a `[pthread]` prefix, fragmenting tracebacks. Buffer
  // until a newline, then emit with a single prefix. Use synchronous
  // Deno.stderr/stdout write when available so chunks don't get
  // dropped when the Worker terminates before console.error flushes.
  const lineBuffers = new Map<number, string>();
  const denoStream = (fd: number):
    | { writeSync(buf: Uint8Array): number }
    | null => {
    try {
      const d = (globalThis as {
        Deno?: {
          stdout: { writeSync(b: Uint8Array): number };
          stderr: { writeSync(b: Uint8Array): number };
        };
      }).Deno;
      if (!d) return null;
      return fd === 1 ? d.stdout : d.stderr;
    } catch {
      return null;
    }
  };
  const encoder = new TextEncoder();
  const flushPthreadLine = (fd: number, line: string): void => {
    const out = `[pthread] ${line}\n`;
    const stream = denoStream(fd);
    if (stream) {
      stream.writeSync(encoder.encode(out));
      return;
    }
    const sink = fd === 2 ? console.error : console.log;
    sink(`[pthread] ${line}`);
  };
  const appendPthreadStdio = (fd: number, text: string): void => {
    const prev = lineBuffers.get(fd) ?? "";
    const combined = prev + text;
    let cursor = 0;
    while (true) {
      const nl = combined.indexOf("\n", cursor);
      if (nl < 0) break;
      flushPthreadLine(fd, combined.slice(cursor, nl));
      cursor = nl + 1;
    }
    lineBuffers.set(fd, combined.slice(cursor));
  };

  const flushStdio = (): void => {
    for (const [fd, remainder] of lineBuffers) {
      if (remainder.length > 0) flushPthreadLine(fd, remainder);
    }
    lineBuffers.clear();
  };

  const imports: WebAssembly.ModuleImports = {
    // Optimistic stub: report every fd as a stream socket with no
    // flags so libzmq's signaler can read O_NONBLOCK state and then
    // set it via fd_fdstat_set_flags. cpython's threading paths that
    // need real metadata still go through the main-thread WASI host
    // and never hit this table.
    fd_fdstat_get: (_fd: number, bufPtr: number): number => {
      const v = view();
      v.setUint8(bufPtr, WASI_FILETYPE_SOCKET_STREAM);
      v.setUint8(bufPtr + 1, 0);
      v.setUint16(bufPtr + 2, 0, true);
      v.setUint32(bufPtr + 4, 0, true);
      v.setBigUint64(bufPtr + 8, WASI_RIGHTS_ALL, true);
      v.setBigUint64(bufPtr + 16, WASI_RIGHTS_ALL, true);
      return WASI_ESUCCESS;
    },
    fd_fdstat_set_flags: (_fd: number, _flags: number): number => WASI_ESUCCESS,
    clock_time_get: (
      _clockId: number,
      _precision: bigint,
      timePtr: number,
    ): number => {
      const nsec = BigInt(Date.now()) * 1_000_000n;
      view().setBigUint64(timePtr, nsec, true);
      return WASI_ESUCCESS;
    },
    clock_res_get: (_clockId: number, resPtr: number): number => {
      // 1ms resolution — matches what Date.now provides.
      view().setBigUint64(resPtr, 1_000_000n, true);
      return WASI_ESUCCESS;
    },
    random_get: (bufPtr: number, bufLen: number): number => {
      const dst = bytes().subarray(bufPtr, bufPtr + bufLen);
      crypto.getRandomValues(dst);
      return WASI_ESUCCESS;
    },
    sched_yield: (): number => WASI_ESUCCESS,
    proc_exit: (code: number): void => {
      throw new WorkerThreadExit(code | 0);
    },
    // libc's abort path writes to stderr through fd_write before it
    // aborts; surface those bytes on the worker console so the failure
    // is observable rather than silent.
    fd_write: (
      fd: number,
      iovsPtr: number,
      iovsLen: number,
      nwrittenPtr: number,
    ): number => {
      if (fd !== 1 && fd !== 2) return WASI_ENOSYS;
      const v = view();
      const buf = bytes();
      let total = 0;
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const ptr = v.getUint32(base, true);
        const len = v.getUint32(base + 4, true);
        if (len > 0) {
          chunks.push(buf.slice(ptr, ptr + len));
          total += len;
        }
      }
      if (total > 0) {
        const text = new TextDecoder().decode(
          chunks.length === 1 ? chunks[0] : (() => {
            const joined = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              joined.set(c, off);
              off += c.byteLength;
            }
            return joined;
          })(),
        );
        appendPthreadStdio(fd, text);
      }
      v.setUint32(nwrittenPtr, total, true);
      return WASI_ESUCCESS;
    },
  };

  return { imports, flushStdio };
}
