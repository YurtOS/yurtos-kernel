/**
 * SAB-backed mutex primitive used by WorkerSabThreadsBackend.
 *
 * Cell layout: one i32 (4 bytes) at `byteOffset`. Value 0 = unlocked;
 * value > 0 = locked, value is the owning tid. Tid 0 is reserved for
 * "unlocked"; callers must never pass tid 0 to tryLock/lock/unlock.
 *
 * This file holds pure SAB+Atomics primitives. It is intentionally
 * dependency-free so it can be imported from a Worker host script
 * without dragging the rest of the kernel into the worker bundle.
 */
export class SabMutex {
  static readonly BYTES = 4;
  private readonly view: Int32Array;

  constructor(sab: SharedArrayBuffer, byteOffset: number) {
    this.view = new Int32Array(sab, byteOffset, 1);
  }

  tryLock(tid: number): boolean {
    if (!Number.isInteger(tid) || tid <= 0) {
      throw new Error(
        `SabMutex.tryLock: tid must be a positive integer (got ${tid})`,
      );
    }
    return Atomics.compareExchange(this.view, 0, 0, tid) === 0;
  }

  unlock(tid: number): void {
    if (!Number.isInteger(tid) || tid <= 0) {
      throw new Error(
        `SabMutex.unlock: tid must be a positive integer (got ${tid})`,
      );
    }
    const prev = Atomics.compareExchange(this.view, 0, tid, 0);
    if (prev !== tid) {
      throw new Error(
        `SabMutex.unlock: tid ${tid} is not the owner (owner=${prev})`,
      );
    }
    Atomics.notify(this.view, 0, 1);
  }

  owner(): number {
    return Atomics.load(this.view, 0);
  }
}
