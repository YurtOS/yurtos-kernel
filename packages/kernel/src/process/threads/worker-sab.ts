import { WASI_EBUSY } from "../../wasi/types.js";
import type { ThreadsBackend } from "./backend.js";
import type { IndirectCallTable } from "./indirect-call-table.js";
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
    const state = this.mutexes.get(mutexPtr);
    if (!state || state.owner === null) return -1;
    state.owner = null;
    this.wake(state.waiters.shift());
    return 0;
  }

  mutexTryLock(mutexPtr: number): number {
    const state = this.mutexState(mutexPtr);
    if (state.owner !== null) return WASI_EBUSY;
    state.owner = this.self();
    return 0;
  }

  async condWait(condPtr: number, mutexPtr: number): Promise<number> {
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
    this.wake(this.condvars.get(condPtr)?.waiters.shift());
    return 0;
  }

  condBroadcast(condPtr: number): number {
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
}
