export class SabMutex {
  static readonly BYTES = 4;

  private readonly view: Int32Array;

  constructor(sab: SharedArrayBuffer, byteOffset: number) {
    this.view = new Int32Array(sab, byteOffset, 1);
  }

  tryLock(tid: number): boolean {
    return Atomics.compareExchange(this.view, 0, 0, tid) === 0;
  }

  lock(tid: number): void {
    while (true) {
      const previous = Atomics.compareExchange(this.view, 0, 0, tid);
      if (previous === 0) return;
      Atomics.wait(this.view, 0, previous);
    }
  }

  unlock(tid: number): void {
    if (Atomics.compareExchange(this.view, 0, tid, 0) !== tid) {
      throw new Error("SabMutex.unlock: not the owner");
    }
    Atomics.notify(this.view, 0, 1);
  }

  owner(): number {
    return Atomics.load(this.view, 0);
  }
}

export class SabCondvar {
  static readonly BYTES = 4;

  private readonly view: Int32Array;

  constructor(sab: SharedArrayBuffer, byteOffset: number) {
    this.view = new Int32Array(sab, byteOffset, 1);
  }

  wait(mutex: SabMutex, tid: number): void {
    const sequence = Atomics.load(this.view, 0);
    mutex.unlock(tid);
    Atomics.wait(this.view, 0, sequence);
    mutex.lock(tid);
  }

  signal(): void {
    Atomics.add(this.view, 0, 1);
    Atomics.notify(this.view, 0, 1);
  }

  broadcast(): void {
    Atomics.add(this.view, 0, 1);
    Atomics.notify(this.view, 0);
  }
}
