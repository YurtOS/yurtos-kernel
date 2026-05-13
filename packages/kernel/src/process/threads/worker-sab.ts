import { WASI_EBUSY } from "../../wasi/types.js";
import type { ThreadsBackend } from "./backend.js";
import type { IndirectCallTable } from "./indirect-call-table.js";
import { SabCondvar, SabMutex } from "./sab-primitives.js";
import { ThreadIdScope } from "./thread-id-scope.js";

export interface WorkerSabThreadStart {
  tid: number;
  fnPtr: number;
  arg: number;
}

export interface WorkerSabThreadsBackendOptions {
  spawnThread(start: WorkerSabThreadStart): Promise<number>;
}

interface SpawnSlot {
  result: Promise<number>;
  reaped: boolean;
  detached: boolean;
  finished: boolean;
}

class ThreadExit {
  constructor(readonly retval: number) {}
}

export class WorkerSabThreadsBackend implements ThreadsBackend {
  readonly kind = "worker-sab" as const;

  private slots: SpawnSlot[] = [{
    result: Promise.resolve(0),
    reaped: true,
    detached: false,
    finished: true,
  }];
  private tids = new ThreadIdScope();
  private readonly sab: SharedArrayBuffer;

  constructor(
    private readonly options: WorkerSabThreadsBackendOptions,
    memory: WebAssembly.Memory,
  ) {
    if (!(memory.buffer instanceof SharedArrayBuffer)) {
      throw new Error(
        "WorkerSabThreadsBackend requires a WebAssembly.Memory backed by SharedArrayBuffer",
      );
    }
    this.sab = memory.buffer;
  }

  setIndirectCallTable(_table: IndirectCallTable): void {
    // Worker/SAB pthreads instantiate worker-side modules with shared memory.
    // The main instance's table is not callable across Workers.
  }

  spawn(fnPtr: number, arg: number): Promise<number> {
    const tid = this.slots.length;
    const slot: SpawnSlot = {
      result: Promise.resolve(-1),
      reaped: false,
      detached: false,
      finished: false,
    };
    this.slots.push(slot);
    slot.result = this.options.spawnThread({ tid, fnPtr, arg })
      .catch((err) => err instanceof ThreadExit ? err.retval : -1)
      .finally(() => {
        slot.finished = true;
      });
    return Promise.resolve(tid);
  }

  async join(tid: number): Promise<number> {
    const slot = this.slots[tid];
    if (!slot || slot.reaped || slot.detached) return -1;
    slot.reaped = true;
    return await slot.result;
  }

  detach(tid: number): Promise<number> {
    const slot = this.slots[tid];
    if (!slot || slot.reaped) return Promise.resolve(-1);
    slot.detached = true;
    slot.reaped = true;
    return Promise.resolve(0);
  }

  exit(retval: number): never {
    throw new ThreadExit(retval);
  }

  self(): number {
    return this.tids.getStore() ?? 0;
  }

  runAsThread<T>(tid: number, fn: () => T): T {
    return this.tids.run(tid, fn);
  }

  async yield_(): Promise<number> {
    await Promise.resolve();
    return 0;
  }

  async mutexLock(mutexPtr: number): Promise<number> {
    const m = new SabMutex(this.sab, mutexPtr);
    m.lock(this.tidForLockOps());
    return 0;
  }

  mutexUnlock(mutexPtr: number): number {
    const m = new SabMutex(this.sab, mutexPtr);
    try {
      m.unlock(this.tidForLockOps());
      return 0;
    } catch {
      return -1;
    }
  }

  mutexTryLock(mutexPtr: number): number {
    const m = new SabMutex(this.sab, mutexPtr);
    return m.tryLock(this.tidForLockOps()) ? 0 : WASI_EBUSY;
  }

  async condWait(condPtr: number, mutexPtr: number): Promise<number> {
    const m = new SabMutex(this.sab, mutexPtr);
    const cv = new SabCondvar(this.sab, condPtr);
    cv.wait(m, this.tidForLockOps());
    return 0;
  }

  condSignal(condPtr: number): number {
    new SabCondvar(this.sab, condPtr).signal();
    return 0;
  }

  condBroadcast(condPtr: number): number {
    new SabCondvar(this.sab, condPtr).broadcast();
    return 0;
  }

  /**
   * Resolve the current logical tid for SabMutex/SabCondvar calls.
   *
   * SabMutex disallows tid 0 (reserved for "unlocked"). The current
   * `ThreadIdScope`-based `self()` returns 0 for the main thread when no
   * scope is active, which would trip SabMutex's guard. Map 0 -> 1 here
   * as a temporary hack; Task 8 introduces a SAB-backed tid table that
   * resolves this cleanly.
   */
  private tidForLockOps(): number {
    return Math.max(this.self(), 1);
  }
}

/**
 * Default `spawnThread` implementation: constructs a Worker hosting the
 * cloned WASM instance (via worker-thread-host.ts), posts the start
 * message, awaits the done message. The caller-provided `spawnThread`
 * option in WorkerSabThreadsBackendOptions overrides this default.
 *
 * `module` and `memory` are the SAME objects passed to the main-thread
 * instance; structured-clone passes them as references when the memory's
 * buffer is a SharedArrayBuffer.
 */
export function defaultSpawnThread(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
): WorkerSabThreadsBackendOptions["spawnThread"] {
  const hostUrl = new URL("./worker-thread-host.ts", import.meta.url).href;
  return ({ tid, fnPtr, arg }) =>
    new Promise<number>((resolve) => {
      const worker = new Worker(hostUrl, { type: "module" });
      worker.onmessage = (e: MessageEvent) => {
        if (
          e.data && typeof e.data === "object" && e.data.type === "done"
        ) {
          resolve((e.data.retval as number) | 0);
          worker.terminate();
        }
      };
      worker.postMessage({
        type: "start",
        tid,
        fnPtr,
        arg,
        module,
        memory,
      });
    });
}
