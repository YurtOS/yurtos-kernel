import { WASI_EBUSY } from "../../wasi/types.js";
import type { ThreadsBackend } from "./backend.js";
import type { IndirectCallTable } from "./indirect-call-table.js";
import { SabCondvar, SabMutex } from "./sab-primitives.js";
import { ThreadIdScope } from "./thread-id-scope.js";
import {
  attachWorkerHostDispatcher,
  REQUEST_SAB_BYTES,
  type WorkerHostDispatcherBodies,
} from "./worker-host-proxy.js";

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

/**
 * Worker/SAB threads backend.
 *
 * Two tid namespaces coexist here, intentionally:
 *
 *   1. Guest-visible `host_thread_self()` — the tid the WASM module
 *      sees when it calls the import. Main thread returns 0; spawned
 *      threads return the tid captured into their worker's closure
 *      (see worker-host-proxy.ts:createWorkerYurtImports).
 *
 *   2. Kernel-internal `tidForLockOps()` — the tid used as the
 *      SabMutex/SabCondvar owner field. Main thread maps to 1
 *      (reserved slot[1]); spawned threads use their spawn-allocated
 *      tid (>= 2). This keeps main and spawned tids disjoint so
 *      SabMutex.owner uniquely identifies the holder across the
 *      main/worker boundary.
 *
 * Why the asymmetry: pthread_self() and pthread_mutex_t.owner are
 * different concepts. The guest's pthread_self() returns 0 on main
 * (POSIX-shaped); the mutex owner field is a wire-level token that
 * must be non-zero and unique across all threads. Trying to unify
 * these would either break POSIX semantics (main can't be tid 0
 * in pthread_self) or break SabMutex's tid-0-means-unlocked invariant.
 */
export class WorkerSabThreadsBackend implements ThreadsBackend {
  readonly kind = "worker-sab" as const;

  private slots: SpawnSlot[] = [
    // slot[0]: tid 0 — "unset" sentinel for guest-visible host_thread_self.
    {
      result: Promise.resolve(0),
      reaped: true,
      detached: false,
      finished: true,
    },
    // slot[1]: tid 1 — reserved for main thread's kernel-side SabMutex
    // owner tag. Main never has a real SpawnSlot, but this entry keeps
    // spawn-allocated tids >= 2 so main and spawned threads have disjoint
    // SabMutex owner identities. See tidForLockOps() doc-comment.
    {
      result: Promise.resolve(0),
      reaped: true,
      detached: false,
      finished: true,
    },
  ];
  private tids = new ThreadIdScope();
  private readonly memory: WebAssembly.Memory;

  constructor(
    private readonly options: WorkerSabThreadsBackendOptions,
    memory: WebAssembly.Memory,
  ) {
    if (!(memory.buffer instanceof SharedArrayBuffer)) {
      throw new Error(
        "WorkerSabThreadsBackend requires a WebAssembly.Memory backed by SharedArrayBuffer",
      );
    }
    this.memory = memory;
  }

  /**
   * Re-read `memory.buffer` on every access. With wasm32-wasip1-threads
   * the guest grows linear memory at runtime (e.g. pthread stack alloc
   * during CPython startup). On V8 each `memory.grow()` returns a NEW
   * SharedArrayBuffer with the larger byteLength; the previously
   * observed SAB stays at its old size. Caching `memory.buffer` once in
   * the constructor (or anywhere outside the per-call path) leaves
   * SabMutex/SabCondvar constructing `new Int32Array(staleSAB, ptr, 1)`
   * with `ptr` past the stale byteLength once the guest moves a
   * mutex/condvar into the grown region, raising
   * "RangeError: Invalid typed array length: 1".
   */
  private get sab(): SharedArrayBuffer {
    // Constructor verified `memory.buffer instanceof SharedArrayBuffer`.
    // The `as unknown as` bounce satisfies TS5.7+'s stricter view that
    // `ArrayBuffer` and `SharedArrayBuffer` no longer share an interface.
    return this.memory.buffer as unknown as SharedArrayBuffer;
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
    // Use the async variant: a blocking `Atomics.wait` here freezes
    // main's event loop and prevents the worker-host dispatcher from
    // draining incoming "host-call" messages — the canonical worker-
    // SAB deadlock observed by libzmq-reactor-spawn_reproducer_test.ts.
    await m.lockAsync(this.tidForLockOps());
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
    // Async variant — see mutexLock for the event-loop-freeze rationale.
    await cv.waitAsync(m, this.tidForLockOps());
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
   * Resolve the tid used as the SabMutex/SabCondvar owner field.
   *
   * Main thread: returns 1 (reserved slot[1]). Spawned threads: returns
   * their spawn-allocated tid (>= 2). This keeps main and spawned tids
   * disjoint so SabMutex.owner correctly identifies the holder across
   * the main/worker boundary.
   *
   * Worker-side `host_thread_self` (when wired in Task 9) will report
   * the start-message tid directly via closure — the guest sees its
   * own tid >= 2 there. Main-side `host_thread_self` will report 0
   * (per revised plan). The mapping here is kernel-internal, only for
   * the SabMutex owner field.
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
 *
 * Task 9: when `bodies` is supplied, each spawned worker gets a
 * per-thread request SAB and the main-side dispatcher is attached
 * before the start message is posted. The SAB is forwarded to the
 * worker as `requestSab` (a bare SharedArrayBuffer; the worker builds
 * its own `WorkerHostImportProxy` locally because the `postHostCall`
 * closure cannot be structured-cloned). When `bodies` is undefined the
 * worker still receives the SAB if we wanted, but here we simply skip
 * the dispatcher and the SAB so the worker instantiates with `yurt:{}`
 * (Task 4 behavior). Task 10 wires real kernel-imports bodies through.
 */
export function defaultSpawnThread(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  bodies?: WorkerHostDispatcherBodies,
): WorkerSabThreadsBackendOptions["spawnThread"] {
  const hostUrl = new URL("./worker-thread-host.ts", import.meta.url).href;
  return ({ tid, fnPtr, arg }) =>
    new Promise<number>((resolve) => {
      const worker = new Worker(hostUrl, { type: "module" });
      let requestSab: SharedArrayBuffer | undefined;
      if (bodies) {
        requestSab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
        attachWorkerHostDispatcher(worker, requestSab, bodies);
      }
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
        requestSab,
      });
    });
}
