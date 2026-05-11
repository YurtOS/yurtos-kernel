import type { ThreadsBackend } from './backend.js';
import type { IndirectCallTable } from './indirect-call-table.js';
import { NULL_INDIRECT_CALL_TABLE } from './indirect-call-table.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { WASI_EBUSY } from '../../wasi/types.js';

interface SpawnSlot {
  result: Promise<number>;
  reaped: boolean;
  detached: boolean;
  finished: boolean;
  stackPointer: number | null;
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

export class CooperativeSerialBackend implements ThreadsBackend {
  readonly kind = 'cooperative-serial' as const;

  // FIXME: This backend is only a compatibility bridge for one spawned thread at a
  // time. Real Rayon/std::thread parallelism requires a shared-memory + atomics
  // backend such as wasi-threads, worker-SAB, WASIp2 threads, or WASIX.
  private readonly maxLiveSpawnedThreads = 1;
  private slots: SpawnSlot[] = [];
  private indirectTable: IndirectCallTable = NULL_INDIRECT_CALL_TABLE;
  private tids = new AsyncLocalStorage<number>();
  private mutexes = new Map<number, MutexState>();
  private condvars = new Map<number, CondvarState>();
  private memory: WebAssembly.Memory | null = null;
  private stackPointer: WebAssembly.Global | null = null;
  private activeTid = 0;
  private readonly stackPagesPerThread = 16;

  setIndirectCallTable(table: IndirectCallTable): void {
    this.indirectTable = table;
    this.ensureMainSlot();
  }

  bindLinearStack(
    memory: WebAssembly.Memory,
    stackPointer: WebAssembly.Global,
  ): void {
    this.memory = memory;
    this.stackPointer = stackPointer;
    this.ensureMainSlot();
    this.slots[0].stackPointer = stackPointer.value as number;
  }

  suspendCurrentLinearStack(): number {
    const tid = this.self();
    this.saveStackPointer(tid);
    return tid;
  }

  restoreLinearStack(tid: number): void {
    this.saveStackPointer(this.activeTid);
    this.restoreStackPointer(tid);
    this.activeTid = tid;
  }

  async spawn(fnPtr: number, arg: number): Promise<number> {
    this.ensureMainSlot();
    if (this.liveSpawnedThreads() >= this.maxLiveSpawnedThreads) return -1;
    const tid = this.slots.length;
    const slot: SpawnSlot = {
      result: Promise.resolve(-1),
      reaped: false,
      detached: false,
      finished: false,
      stackPointer: this.allocateThreadStackTop(),
    };
    this.slots.push(slot);
    slot.result = Promise.resolve()
      .then(() =>
        this.tids.run(tid, async () => {
          this.restoreLinearStack(tid);
          try {
            return await this.indirectTable.call(fnPtr, arg);
          } finally {
            this.saveStackPointer(tid);
            this.restoreLinearStack(0);
          }
        })
      )
      .catch(() => -1)
      .finally(() => {
        slot.finished = true;
      });
    return tid;
  }

  async join(tid: number): Promise<number> {
    const slot = this.slots[tid];
    if (!slot || slot.reaped || slot.detached) return -1;
    slot.reaped = true;
    return await slot.result;
  }

  async detach(tid: number): Promise<number> {
    const slot = this.slots[tid];
    if (!slot || slot.reaped) return -1;
    slot.detached = true;
    slot.reaped = true;
    return 0;
  }

  self(): number {
    return this.tids.getStore() ?? 0;
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
      await new Promise<void>((resolve) => state.waiters.push({
        tid,
        wake: resolve,
      }));
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
    const wait = new Promise<void>((resolve) => state.waiters.push({
      tid,
      wake: resolve,
    }));
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

  private ensureMainSlot(): void {
    if (this.slots.length !== 0) return;
    this.slots.push({
      result: Promise.resolve(0),
      reaped: true,
      detached: false,
      finished: true,
      stackPointer: this.stackPointer?.value as number | undefined ?? null,
    });
  }

  private allocateThreadStackTop(): number | null {
    if (!this.memory) return null;
    const oldPages = this.memory.grow(this.stackPagesPerThread);
    return (oldPages + this.stackPagesPerThread) * 65536;
  }

  private saveStackPointer(tid: number): void {
    if (!this.stackPointer) return;
    const slot = this.slots[tid];
    if (!slot) return;
    slot.stackPointer = this.stackPointer.value as number;
  }

  private restoreStackPointer(tid: number): void {
    if (!this.stackPointer) return;
    const slot = this.slots[tid];
    if (!slot || slot.stackPointer === null) return;
    this.stackPointer.value = slot.stackPointer;
  }

  private liveSpawnedThreads(): number {
    return this.slots.filter((slot, tid) => tid !== 0 && !slot.finished).length;
  }
}
