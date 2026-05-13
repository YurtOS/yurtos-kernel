import { WASI_EBUSY } from "../../wasi/types.js";
import type { ThreadsBackend } from "./backend.js";
import type { IndirectCallTable } from "./indirect-call-table.js";
import { SabCondvar, SabMutex } from "./sab-primitives.ts";
import { ThreadIdScope } from "./thread-id-scope.js";
import type {
  WorkerHostImportProxy,
  WorkerHostOp,
} from "./worker-host-proxy.ts";

export interface WorkerSabThreadStart {
  tid: number;
  fnPtr: number;
  arg: number;
}

export interface WorkerSabThreadsBackendOptions {
  memory?: WebAssembly.Memory;
  spawnThread(start: WorkerSabThreadStart): Promise<number>;
}

export interface DefaultSpawnThreadOptions {
  createImportProxy?(tid: number): WorkerHostImportProxy;
  handleHostCall?(
    call: { tid: number; op: WorkerHostOp },
    proxy: WorkerHostImportProxy,
  ): void;
}

export function defaultSpawnThread(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  options: DefaultSpawnThreadOptions = {},
): WorkerSabThreadsBackendOptions["spawnThread"] {
  const hostUrl = new URL("./worker-thread-host.ts", import.meta.url).href;
  return ({ tid, fnPtr, arg }) =>
    new Promise<number>((resolve) => {
      const worker = new Worker(hostUrl, { type: "module" });
      const importProxy = options.createImportProxy?.(tid);
      worker.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "host-call") {
          if (importProxy && options.handleHostCall) {
            options.handleHostCall(
              {
                tid: event.data.tid as number,
                op: event.data.op as WorkerHostOp,
              },
              importProxy,
            );
          }
          return;
        }
        if (event.data?.type !== "done") return;
        resolve(event.data.retval as number);
        worker.terminate();
      };
      worker.onerror = () => {
        resolve(-1);
        worker.terminate();
      };
      worker.postMessage({
        type: "start",
        tid,
        fnPtr,
        arg,
        module,
        memory,
        importProxy,
      });
    });
}

interface SpawnSlot {
  result: Promise<number>;
  reaped: boolean;
  detached: boolean;
  finished: boolean;
}

interface MutexState {
  owner: number | null;
  waiters: Waiter[];
}

interface CondvarState {
  waiters: Waiter[];
}

interface Waiter {
  tid: number;
  wake: () => void;
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
  private mutexes = new Map<number, MutexState>();
  private condvars = new Map<number, CondvarState>();

  constructor(private readonly options: WorkerSabThreadsBackendOptions) {}

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
    const tid = this.self();
    const mutex = this.sabMutex(mutexPtr);
    if (mutex) {
      if (mutex.owner() === tid) return -1;
      mutex.lock(tid);
      return 0;
    }
    const state = this.mutexState(mutexPtr);
    while (true) {
      if (state.owner === null) {
        state.owner = tid;
        return 0;
      }
      if (state.owner === tid) return -1;
      await new Promise<void>((resolve) =>
        state.waiters.push({
          tid,
          wake: resolve,
        })
      );
    }
  }

  mutexUnlock(mutexPtr: number): number {
    const tid = this.self();
    const mutex = this.sabMutex(mutexPtr);
    if (mutex) {
      try {
        mutex.unlock(tid);
        return 0;
      } catch {
        return -1;
      }
    }
    const state = this.mutexes.get(mutexPtr);
    if (!state || state.owner === null) return -1;
    state.owner = null;
    this.wake(state.waiters.shift());
    return 0;
  }

  mutexTryLock(mutexPtr: number): number {
    const mutex = this.sabMutex(mutexPtr);
    if (mutex) return mutex.tryLock(this.self()) ? 0 : WASI_EBUSY;
    const state = this.mutexState(mutexPtr);
    if (state.owner !== null) return WASI_EBUSY;
    state.owner = this.self();
    return 0;
  }

  async condWait(condPtr: number, mutexPtr: number): Promise<number> {
    const condvar = this.sabCondvar(condPtr);
    const mutex = this.sabMutex(mutexPtr);
    if (condvar && mutex) {
      try {
        condvar.wait(mutex, this.self());
        return 0;
      } catch {
        return -1;
      }
    }
    const state = this.condvarState(condPtr);
    const tid = this.self();
    const wait = new Promise<void>((resolve) =>
      state.waiters.push({
        tid,
        wake: resolve,
      })
    );
    const unlock = this.mutexUnlock(mutexPtr);
    if (unlock !== 0) return unlock;
    await wait;
    return await this.mutexLock(mutexPtr);
  }

  condSignal(condPtr: number): number {
    const condvar = this.sabCondvar(condPtr);
    if (condvar) {
      condvar.signal();
      return 0;
    }
    this.wake(this.condvars.get(condPtr)?.waiters.shift());
    return 0;
  }

  condBroadcast(condPtr: number): number {
    const condvar = this.sabCondvar(condPtr);
    if (condvar) {
      condvar.broadcast();
      return 0;
    }
    const state = this.condvars.get(condPtr);
    if (state) {
      const waiters = state.waiters.splice(0);
      for (const waiter of waiters) this.wake(waiter);
    }
    return 0;
  }

  private mutexState(ptr: number): MutexState {
    let state = this.mutexes.get(ptr);
    if (!state) {
      state = { owner: null, waiters: [] };
      this.mutexes.set(ptr, state);
    }
    return state;
  }

  private condvarState(ptr: number): CondvarState {
    let state = this.condvars.get(ptr);
    if (!state) {
      state = { waiters: [] };
      this.condvars.set(ptr, state);
    }
    return state;
  }

  private wake(waiter: Waiter | undefined): void {
    if (!waiter) return;
    this.tids.run(waiter.tid, waiter.wake);
  }

  private sharedBuffer(): SharedArrayBuffer | null {
    const buffer = this.options.memory?.buffer;
    return buffer instanceof SharedArrayBuffer ? buffer : null;
  }

  private sabMutex(ptr: number): SabMutex | null {
    const buffer = this.sharedBuffer();
    if (!buffer) return null;
    return new SabMutex(buffer, ptr);
  }

  private sabCondvar(ptr: number): SabCondvar | null {
    const buffer = this.sharedBuffer();
    if (!buffer) return null;
    return new SabCondvar(buffer, ptr);
  }
}
