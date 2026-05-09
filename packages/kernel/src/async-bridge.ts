/// <reference path="./jspi.d.ts" />
/**
 * AsyncBridge — abstracts the calling convention between async JS host
 * functions and the synchronous-from-WASM import/export boundary.
 *
 * Three modes (selected at process start, or overridden in tests):
 *
 *  jspi      — WebAssembly.Suspending / WebAssembly.promising (JSPI proposal).
 *              WASM suspends on the JS stack when an import returns a Promise.
 *              Available: Deno 1.40+, Node 25+ (unflagged), Chrome 137+.
 *              WASM binary: standard build.
 *
 *  asyncify  — Binaryen Asyncify transform. Unwinds/rewinds the WASM stack on
 *              the JS side without JSPI. Binary is larger (~40%) but runs
 *              everywhere (Safari, Bun, older browsers).
 *              WASM binary: compiled with Asyncify ('-asyncify' suffix).
 *              TODO: needs -asyncify.wasm build artifacts and unwind/rewind
 *              driver in wrapExport().
 *
 *  threads   — WASM threads (wasi-threads proposal). WASM runs on a Worker
 *              thread; imports block synchronously via Atomics.wait on a
 *              SharedArrayBuffer; the main thread dispatches async host work.
 *              True parallelism — no JSPI or Asyncify needed.
 *              WASM binary: compiled with atomics + threads ('-threads' suffix).
 *              TODO: needs -threads.wasm build artifacts, Worker execution, and
 *              SAB-based request/response protocol.
 */

export type AsyncBridgeType = 'jspi' | 'asyncify' | 'threads';

export interface AsyncBridge {
  readonly type: AsyncBridgeType;

  /**
   * File suffix appended to the WASM binary name for this mode.
   * '' for JSPI (standard binary), '-asyncify', or '-threads'.
   */
  readonly binarySuffix: string;

  /**
   * Whether WASM memory must be SharedArrayBuffer-backed.
   * true only for 'threads' (required for Atomics operations).
   */
  readonly sharedMemory: boolean;

  /**
   * Wrap an async host function into a value suitable as a WASM import.
   *
   * jspi:     returns new WebAssembly.Suspending(fn) — WASM suspends when the
   *           import is called and resumes when the Promise resolves.
   * asyncify: returns a sync wrapper; the async result is stored in a pending
   *           slot and the Asyncify unwind/rewind loop (driven by wrapExport)
   *           re-enters WASM after the Promise resolves.
   * threads:  returns a sync-blocking function; blocks the Worker thread via
   *           Atomics.wait on a SharedArrayBuffer until the main thread has
   *           completed the async work and written the result.
   */
  wrapImport(fn: (...args: number[]) => Promise<number>): unknown;

  /**
   * Wrap a synchronous WASM export so the host can await its completion.
   *
   * jspi:     returns WebAssembly.promising(fn) — returns a Promise that
   *           resolves when WASM returns (possibly after multiple suspensions).
   * asyncify: returns a driver that calls fn(), detects asyncify unwinding,
   *           awaits the pending import Promise, then rewinds and re-enters.
   * threads:  returns a driver that posts the call to a Worker and returns a
   *           Promise that resolves when the Worker thread finishes.
   */
  wrapExport(fn: (...args: number[]) => number): (...args: number[]) => Promise<number>;
}

export interface AsyncifyForkSnapshot {
  memoryBytes: Uint8Array;
  memoryPages: number;
  stackPointer: number | null;
  dataAddr: number;
  dataSize: number;
  jmpBufStates: Array<
    [number, { savedHigh: number; savedData: Uint8Array; stackPointer: number | null }]
  >;
}

export interface AsyncifyForkController {
  forkFromContinuation(snapshot: AsyncifyForkSnapshot): number;
}

// ── JSPI ──────────────────────────────────────────────────────────────────────

class JspiAsyncBridge implements AsyncBridge {
  readonly type = 'jspi' as const;
  readonly binarySuffix = '';
  readonly sharedMemory = false;

  wrapImport(fn: (...args: number[]) => Promise<number>): unknown {
    return new WebAssembly.Suspending(fn);
  }

  wrapExport(fn: (...args: number[]) => number): (...args: number[]) => Promise<number> {
    return (WebAssembly as { promising?: (f: unknown) => unknown }).promising!(fn) as (
      ...args: number[]
    ) => Promise<number>;
  }
}

// ── Asyncify ──────────────────────────────────────────────────────────────────

/**
 * Asyncify bridge — Binaryen Asyncify transform.
 *
 * The WASM binary is built with:
 *   wasm-opt --asyncify --pass-arg=asyncify-imports@<list> -O1
 *
 * The binary exports asyncify_start_unwind / asyncify_stop_unwind /
 * asyncify_start_rewind / asyncify_stop_rewind / asyncify_get_state.
 *
 * Protocol (per import call that hits an async host function):
 *   1. WASM calls the import synchronously.
 *   2. wrapImport sees state=0, starts the async work, calls
 *      asyncify_start_unwind(dataAddr), returns 0 (ignored).
 *   3. WASM unwinds its call stack and returns to JS with state=1.
 *   4. wrapExport loop: stopUnwind → await promise → startRewind → re-enter.
 *   5. WASM rewinds back to the import call site; wrapImport sees state=2,
 *      calls stopRewind, returns the awaited result.
 *   6. WASM continues normally.
 *
 * Call initFromInstance() after WebAssembly.instantiate() to wire up the
 * asyncify exports and allocate the data buffer.
 */
class AsyncifyAsyncBridge implements AsyncBridge {
  readonly type = 'asyncify' as const;
  readonly binarySuffix = '-asyncify';
  readonly sharedMemory = false;

  // Set by initFromInstance() after the WASM instance is created.
  private exports: {
    startUnwind: (ptr: number) => void;
    stopUnwind: () => void;
    startRewind: (ptr: number) => void;
    stopRewind: () => void;
    getState: () => number;
    dataAddr: number;
    dataSize: number;
    stackPointer: WebAssembly.Global | null;
  } | null = null;

  // The guest's linear memory — needed to read/write the asyncify
  // save-state buffer when implementing setjmp's capture and
  // longjmp's restore.  Stored alongside the asyncify exports.
  private memory: WebAssembly.Memory | null = null;

  // Single pending slot — only one async import can be in-flight at a time
  // (WASM is single-threaded; imports don't interleave).
  private pendingPromise: Promise<void> | null = null;
  private pendingResult: number = 0;

  // setjmp/longjmp state.  pendingSetjmp holds the env pointer of an
  // in-flight setjmp save (cleared after wrapExport copies the
  // unwound buffer into jmpBufStates).  pendingLongjmp holds the
  // env+val of an in-flight longjmp; cleared by hostSetjmp on rewind
  // after it returns the longjmp value.  jmpBufStates is the lookup
  // table from env pointer to the saved buffer contents.
  private pendingSetjmp: number | null = null;
  private pendingLongjmp: { envPtr: number; val: number } | null = null;
  private pendingFork = false;
  private pendingForkReturn: number | null = null;
  private pendingForkMemoryBytes: Uint8Array | null = null;
  private pendingForkStackPointer: number | null = null;
  private jmpBufStates: Map<
    number,
    { savedHigh: number; savedData: Uint8Array; stackPointer: number | null }
  > = new Map();
  private forkController: AsyncifyForkController | null = null;

  private resetBufferHeader(): void {
    if (!this.exports || !this.memory || this.exports.dataSize < 8) return;
    const view = new DataView(this.memory.buffer);
    view.setUint32(this.exports.dataAddr, this.exports.dataAddr + 8, true);
    view.setUint32(
      this.exports.dataAddr + 4,
      this.exports.dataAddr + this.exports.dataSize,
      true,
    );
  }

  /**
   * Call once after instantiation.
   *
   * @param instance  The WebAssembly.Instance with asyncify exports.
   * @param dataAddr  Address of the pre-allocated asyncify data buffer (≥16 bytes
   *                  header + stack-save area).  The caller must have already
   *                  written the [start, end] header into WASM memory.
   */
  initFromInstance(instance: WebAssembly.Instance, dataAddr: number, dataSize = 0): void {
    const exp = instance.exports;
    this.exports = {
      startUnwind: exp.asyncify_start_unwind as (ptr: number) => void,
      stopUnwind:  exp.asyncify_stop_unwind  as () => void,
      startRewind: exp.asyncify_start_rewind as (ptr: number) => void,
      stopRewind:  exp.asyncify_stop_rewind  as () => void,
      getState:    exp.asyncify_get_state    as () => number,
      dataAddr,
      dataSize,
      stackPointer: exp.__stack_pointer instanceof WebAssembly.Global
        ? exp.__stack_pointer
        : null,
    };
    this.memory = exp.memory as WebAssembly.Memory;
  }

  setForkController(controller: AsyncifyForkController | null): void {
    this.forkController = controller;
  }

  /**
   * host_setjmp(envPtr) — POSIX setjmp implemented over Asyncify.
   *
   * First call (state=NORMAL): record the env pointer and trigger an
   * unwind so the asyncify buffer is populated with the current C
   * call stack.  wrapExport's driver loop copies the unwound buffer
   * into jmpBufStates[envPtr] then immediately rewinds — when the
   * rewind reaches this very call site, host_setjmp is re-entered
   * with state=REWINDING and returns 0 (the standard setjmp first
   * return).
   *
   * Rewind under longjmp (state=REWINDING + pendingLongjmp set):
   * stopRewind, return the longjmp value, clear pendingLongjmp.
   * The wasm side sees setjmp return val.
   */
  hostSetjmp = (envPtr: number): number => {
    if (!this.exports) {
      // Bridge not yet initialized (setjmp called during early init).
      // Best-effort: return 0 — caller gets "first-call zero return"
      // semantics but won't be able to longjmp back.
      return 0;
    }
    const exps = this.exports;
    if (exps.getState() === 2 /* REWINDING */) {
      exps.stopRewind();
      this.resetBufferHeader();
      if (this.pendingLongjmp) {
        const val = this.pendingLongjmp.val;
        this.pendingLongjmp = null;
        return val;
      }
      // First-time rewind (post-setjmp-capture): the standard
      // setjmp return value is 0.
      return 0;
    }
    // Normal first call: record env, trigger unwind.  wrapExport
    // sees the unwind, captures the buffer into jmpBufStates, and
    // rewinds back here.
    this.pendingSetjmp = envPtr;
    this.resetBufferHeader();
    exps.startUnwind(exps.dataAddr);
    return 0;  // ignored during unwind
  };

  /**
   * host_longjmp(envPtr, val) — POSIX longjmp over Asyncify.
   *
   * Trigger an unwind; wrapExport's driver loop will detect
   * pendingLongjmp, replace the asyncify buffer with the saved
   * snapshot (taken at setjmp time), and rewind.  The rewind walks
   * back into setjmp's import call, which returns val.
   *
   * From the C program's perspective the call doesn't return —
   * yurt_setjmp.c follows the host_longjmp invocation with
   * __builtin_unreachable, and asyncify intercepts before that
   * instruction is ever reached.
   */
  hostLongjmp = (envPtr: number, val: number): void => {
    if (!this.exports) {
      throw new Error('longjmp: bridge not initialized (no matching setjmp)');
    }
    if (!this.jmpBufStates.has(envPtr)) {
      throw new Error(`longjmp: unknown jmp_buf @0x${envPtr.toString(16)}`);
    }
    this.pendingLongjmp = { envPtr, val };
    this.resetBufferHeader();
    this.exports.startUnwind(this.exports.dataAddr);
  };

  hostFork = (): number => {
    if (!this.exports) return -38; // ENOSYS
    const exps = this.exports;
    if (exps.getState() === 2 /* REWINDING */) {
      exps.stopRewind();
      this.resetBufferHeader();
      const value = this.pendingForkReturn ?? -11; // EAGAIN if the controller failed.
      this.pendingForkReturn = null;
      return value;
    }
    this.pendingFork = true;
    this.pendingForkMemoryBytes = this.memory
      ? new Uint8Array(this.memory.buffer).slice()
      : null;
    this.pendingForkStackPointer = (exps.stackPointer?.value as number | undefined) ?? null;
    this.resetBufferHeader();
    exps.startUnwind(exps.dataAddr);
    return 0; // ignored during unwind
  };

  restoreForkSnapshot(snapshot: AsyncifyForkSnapshot, forkReturn: number): void {
    this.jmpBufStates = new Map(
      snapshot.jmpBufStates.map(([ptr, state]) => [
        ptr,
        {
          savedHigh: state.savedHigh,
          savedData: state.savedData.slice(),
          stackPointer: state.stackPointer,
        },
      ]),
    );
    this.pendingForkReturn = forkReturn;
    if (snapshot.stackPointer !== null && this.exports?.stackPointer) {
      this.exports.stackPointer.value = snapshot.stackPointer;
    }
  }

  startForkRewind(): void {
    if (!this.exports) throw new Error('fork: bridge not initialized');
    this.exports.startRewind(this.exports.dataAddr);
  }

  /** Drop a recorded setjmp save-state.  Optional cleanup hook for
   *  callers that know a jmp_buf has gone out of scope. */
  forgetJmpBuf(envPtr: number): void {
    this.jmpBufStates.delete(envPtr);
  }

  /** Read [dataAddr+0]..[start_offset] of the asyncify buffer into
   *  jmpBufStates[envPtr].  Called by the driver loop after a
   *  setjmp-triggered unwind has populated the buffer. */
  private captureBuffer(envPtr: number): void {
    if (!this.exports || !this.memory) return;
    const view = new DataView(this.memory.buffer);
    const high = view.getUint32(this.exports.dataAddr, true);
    const bufStart = this.exports.dataAddr + 8;
    const dataLen = high - bufStart;
    const savedData = new Uint8Array(this.memory.buffer, bufStart, dataLen).slice();
    const stackPointer =
      (this.exports.stackPointer?.value as number | undefined) ?? null;
    this.jmpBufStates.set(envPtr, { savedHigh: high, savedData, stackPointer });
  }

  /** Write jmpBufStates[envPtr]'s saved bytes back into the asyncify
   *  buffer and reset the start offset to the saved high-water mark.
   *  Called before triggering a longjmp rewind. */
  private restoreBuffer(envPtr: number): void {
    if (!this.exports || !this.memory) return;
    const state = this.jmpBufStates.get(envPtr);
    if (!state) return;
    const view = new DataView(this.memory.buffer);
    new Uint8Array(this.memory.buffer, this.exports.dataAddr + 8, state.savedData.length)
      .set(state.savedData);
    view.setUint32(this.exports.dataAddr, state.savedHigh, true);
    if (state.stackPointer !== null && this.exports.stackPointer) {
      this.exports.stackPointer.value = state.stackPointer;
    }
  }

  private snapshotForkContinuation(): AsyncifyForkSnapshot {
    if (!this.exports || !this.memory) {
      throw new Error('fork: bridge not initialized');
    }
    const memoryBytes = this.pendingForkMemoryBytes?.slice() ??
      new Uint8Array(this.memory.buffer).slice();
    if (this.pendingForkMemoryBytes && this.exports.dataSize > 0) {
      memoryBytes.set(
        new Uint8Array(this.memory.buffer, this.exports.dataAddr, this.exports.dataSize),
        this.exports.dataAddr,
      );
    }
    return {
      memoryBytes,
      memoryPages: memoryBytes.byteLength / 65536,
      stackPointer: this.pendingForkStackPointer,
      dataAddr: this.exports.dataAddr,
      dataSize: this.exports.dataSize,
      jmpBufStates: Array.from(this.jmpBufStates.entries()).map(([ptr, state]) => [
        ptr,
        {
          savedHigh: state.savedHigh,
          savedData: state.savedData.slice(),
          stackPointer: state.stackPointer,
        },
      ]),
    };
  }

  /**
   * Wrap an import function.  The returned sync function is used as a WASM
   * import.  It returns immediately if the underlying fn is synchronous.
   * If fn returns a Promise the wrapper starts an asyncify unwind so WASM
   * suspends until the Promise resolves.
   */
  wrapImport(fn: (...args: number[]) => Promise<number> | number): unknown {
    return (...args: number[]): number => {
      // Before initFromInstance (called during _start), forward calls synchronously.
      if (!this.exports) {
        const ret = fn(...args);
        if (ret instanceof Promise) return 0; // can't suspend yet — ignore async result
        return ret as number;
      }
      const exps = this.exports;
      // Rewinding: WASM is replaying the call — return the stored result.
      if (exps.getState() === 2) {
        exps.stopRewind();
        this.resetBufferHeader();
        return this.pendingResult;
      }
      // Normal execution: call the actual host function.
      const ret = fn(...args);
      if (ret instanceof Promise) {
        // Async: save the promise and start unwinding the WASM stack.
        this.pendingPromise = ret.then(r => { this.pendingResult = r; });
        this.resetBufferHeader();
        exps.startUnwind(exps.dataAddr);
        return 0; // ignored during unwind
      }
      // Synchronous: pass through directly, no unwind needed.
      return ret as number;
    };
  }

  /**
   * Wrap a WASM export so the host can drive the unwind/rewind loop.
   *
   * This is the asyncify-scheduler variant: async imports also use
   * Asyncify (via wrapImport, which suspends on Promise returns by
   * triggering an unwind), so the loop has to handle three reasons
   * for unwinding:
   *   - pendingSetjmp     : host_setjmp was called; capture the
   *                         unwound buffer into jmpBufStates and
   *                         rewind back to the setjmp call site.
   *   - pendingLongjmp    : host_longjmp was called; restore the
   *                         buffer saved at setjmp time and rewind
   *                         (the rewind walks back into host_setjmp,
   *                         which returns the longjmp value).
   *   - pendingPromise    : an async host import returned a Promise;
   *                         await it, then rewind so the import sees
   *                         state=REWINDING and returns the result.
   *
   * Used when JSPI (the preferred scheduler) is unavailable on the
   * host — see wrapExportJspi for the JSPI-scheduler variant.
   */
  wrapExport(fn: (...args: number[]) => number): (...args: number[]) => Promise<number> {
    return async (...args: number[]): Promise<number> => {
      const exps = this.exports!;
      let result = fn(...args);
      while (exps.getState() === 1) {
        exps.stopUnwind();
        if (this.pendingFork) {
          this.pendingFork = false;
          const childPid = this.forkController
            ? this.forkController.forkFromContinuation(this.snapshotForkContinuation())
            : -38; // ENOSYS
          this.pendingForkMemoryBytes = null;
          this.pendingForkStackPointer = null;
          this.pendingForkReturn = childPid;
          exps.startRewind(exps.dataAddr);
          result = fn(...args);
        } else if (this.pendingSetjmp !== null) {
          const envPtr = this.pendingSetjmp;
          this.pendingSetjmp = null;
          this.captureBuffer(envPtr);
          exps.startRewind(exps.dataAddr);
          result = fn(...args);
        } else if (this.pendingLongjmp !== null) {
          this.restoreBuffer(this.pendingLongjmp.envPtr);
          exps.startRewind(exps.dataAddr);
          result = fn(...args);
          // pendingLongjmp is consumed inside hostSetjmp on rewind.
        } else {
          // Async-import unwind — the original asyncify use case.
          await this.pendingPromise!;
          exps.startRewind(exps.dataAddr);
          result = fn(...args);
          // asyncify_stop_rewind happens inside wrapImport when state===2.
        }
      }
      return result;
    };
  }

  wrapExportSync(fn: (...args: number[]) => number): (...args: number[]) => number {
    return (...args: number[]): number => fn(...args);
  }

  /**
   * JSPI-scheduler variant of wrapExport.  fn is the WebAssembly
   * .promising-wrapped export, so async-import suspends propagate
   * naturally as Promise resolutions through fn's return.  We only
   * have to catch Asyncify unwinds (setjmp/longjmp) — pendingPromise
   * is never set in this path because async imports don't go through
   * bridge.wrapImport when JSPI handles them.
   */
  wrapExportJspi(fn: (...args: number[]) => Promise<number>): (...args: number[]) => Promise<number> {
    return async (...args: number[]): Promise<number> => {
      const exps = this.exports!;
      let result = await fn(...args);
      while (exps.getState() === 1) {
        exps.stopUnwind();
        if (this.pendingSetjmp !== null) {
          const envPtr = this.pendingSetjmp;
          this.pendingSetjmp = null;
          this.captureBuffer(envPtr);
        } else if (this.pendingLongjmp !== null) {
          this.restoreBuffer(this.pendingLongjmp.envPtr);
          // pendingLongjmp is consumed inside hostSetjmp on rewind.
        } else {
          throw new Error(
            'asyncify unwound without a setjmp/longjmp pending; ' +
            'async-import suspensions should go through JSPI on this path'
          );
        }
        exps.startRewind(exps.dataAddr);
        result = await fn(...args);
      }
      return result;
    };
  }
}

// ── Threads ───────────────────────────────────────────────────────────────────

/**
 * Threads bridge — not yet implemented.
 *
 * Requirements:
 * - WASM binary compiled with atomics + wasi-threads support.
 *   Build target: yurt-shell-exec-threads.wasm
 * - SharedArrayBuffer must be available (requires COOP/COEP headers in browsers,
 *   or Node/Deno with --experimental-sharedarraybuffer or equivalent).
 * - wrapImport: allocate a SAB slot; return a sync function that writes the
 *   request to shared memory, Atomics.notify(requestBuf, slot), then
 *   Atomics.wait(responseBuf, slot, 0) until the main thread completes and
 *   Atomics.notify(responseBuf, slot).
 * - wrapExport: spawn a Worker that receives the WASM module + SAB, runs the
 *   export on the thread, and postMessages the result back.
 * - Host dispatcher: a loop on the main thread (or dedicated thread) that
 *   Atomics.waitAsync(requestBuf, slot) and dispatches to the async host fns.
 */
class ThreadsAsyncBridge implements AsyncBridge {
  readonly type = 'threads' as const;
  readonly binarySuffix = '-threads';
  readonly sharedMemory = true;

  wrapImport(_fn: (...args: number[]) => Promise<number>): unknown {
    throw new Error(
      'ThreadsAsyncBridge is not yet implemented. ' +
        'Build yurt-shell-exec-threads.wasm with atomics + wasi-threads first.',
    );
  }

  wrapExport(_fn: (...args: number[]) => number): (...args: number[]) => Promise<number> {
    throw new Error(
      'ThreadsAsyncBridge is not yet implemented. ' +
        'Build yurt-shell-exec-threads.wasm with atomics + wasi-threads first.',
    );
  }
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Detect and return the best available AsyncBridge for this runtime.
 *
 * Priority:
 * 1. JSPI (WebAssembly.Suspending available) — Deno, Node 25+, Chrome 137+
 * 2. Threads (SharedArrayBuffer + Atomics + wasi-threads binary) — future
 * 3. Asyncify (fallback for Safari, Bun, older environments) — future
 *
 * Currently only JSPI is fully implemented. The others exist as typed stubs
 * so the interface is forward-compatible.
 */
export function detectAsyncBridge(): AsyncBridge {
  if (typeof WebAssembly.Suspending === 'function') {
    return new JspiAsyncBridge();
  }
  // TODO: check for threads when binary is available:
  //   typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined'
  // Asyncify fallback: works everywhere (Safari, Bun, older browsers).
  // Requires yurt-shell-exec-asyncify.wasm (built with wasm-opt --asyncify).
  return new AsyncifyAsyncBridge();
}

// Export implementations for tests and explicit construction.
export { JspiAsyncBridge, AsyncifyAsyncBridge, ThreadsAsyncBridge };
