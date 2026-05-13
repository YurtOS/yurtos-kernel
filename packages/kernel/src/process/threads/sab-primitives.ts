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

  /**
   * Acquire the mutex, blocking the current thread until it can.
   *
   * Uses a CAS-and-wait loop: attempt the CAS; on failure, `Atomics.wait`
   * until the cell is observed to change, then retry. Spurious wakes are
   * handled by the retry loop. Safe to call from any thread that shares
   * the SAB; the call site MUST be running where `Atomics.wait` is allowed
   * (Web Workers / Node worker_threads / Deno workers — NOT the main
   * window thread on the web, where Atomics.wait throws TypeError).
   */
  lock(tid: number): void {
    if (!Number.isInteger(tid) || tid <= 0) {
      throw new Error(
        `SabMutex.lock: tid must be a positive integer (got ${tid})`,
      );
    }
    while (true) {
      const prev = Atomics.compareExchange(this.view, 0, 0, tid);
      if (prev === 0) return;
      Atomics.wait(this.view, 0, prev);
    }
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

/**
 * SAB-backed condition variable, paired with a SabMutex.
 *
 * Cell layout: one i32 (4 bytes) at `byteOffset` — a sequence counter
 * that signal()/broadcast() bump atomically. wait() snapshots the seq
 * with the mutex held, releases the mutex, Atomics.wait()s for the seq
 * to change away from the snapshot, and re-acquires the mutex.
 *
 * Lost-wakeup safety: because the snapshot is taken while the mutex is
 * still held, any signal racing with the wait either (a) ran before the
 * snapshot — in which case its notify is irrelevant and the waiter sees
 * the new state when it re-locks, or (b) ran after the snapshot — in
 * which case Atomics.wait observes the seq change and returns "not-
 * equal" without sleeping. Spurious wakes are handled by callers via
 * the conventional while(predicate) wait pattern.
 *
 * Must be called from a context where Atomics.wait is allowed
 * (Worker / worker_threads / Deno worker; NOT main browser thread).
 */
export class SabCondvar {
  static readonly BYTES = 4;
  private readonly view: Int32Array;

  constructor(sab: SharedArrayBuffer, byteOffset: number) {
    this.view = new Int32Array(sab, byteOffset, 1);
  }

  /**
   * Atomically: unlock the paired mutex, wait for a signal, re-lock.
   * `tid` must match the lock owner; callers MUST hold the mutex on entry.
   */
  wait(m: SabMutex, tid: number): void {
    const seq = Atomics.load(this.view, 0);
    m.unlock(tid);
    Atomics.wait(this.view, 0, seq);
    m.lock(tid);
  }

  /** Wake at most one waiter. Safe to call without holding the mutex. */
  signal(): void {
    Atomics.add(this.view, 0, 1);
    Atomics.notify(this.view, 0, 1);
  }

  /** Wake every waiter. Safe to call without holding the mutex. */
  broadcast(): void {
    Atomics.add(this.view, 0, 1);
    Atomics.notify(this.view, 0, Number.MAX_SAFE_INTEGER);
  }

  /** Current seq counter — exposed for tests. */
  seq(): number {
    return Atomics.load(this.view, 0);
  }
}
