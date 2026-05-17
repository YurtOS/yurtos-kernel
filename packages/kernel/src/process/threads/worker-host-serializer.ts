/**
 * Promise-chain mutex that serializes worker-host dispatcher bodies.
 *
 * The worker-host dispatcher (see `worker-host-proxy.ts`) used to be
 * synchronous: the JS event loop alone serialized one worker's
 * `host-call` message handler to completion before the next. Once a
 * body may `await` mid-flight (the post-bind ZMQ reactor flow — a
 * spawned pthread parked on a host round-trip that itself needs the
 * event loop), that guarantee is gone: while body A awaits, the loop
 * is free and a peer worker's handler could interleave and observe
 * half-mutated kernel state.
 *
 * `WorkerHostSerializer.run` chains invocations so exactly one body is
 * in flight at a time (FIFO), while still yielding to the event loop
 * whenever the in-flight body awaits — so blocking host calls suspend
 * instead of freezing main, without sacrificing kernel-state
 * exclusivity. One serializer is shared across all worker pthreads of
 * a process (created in `defaultSpawnThread`); see Task 10 in
 * `host-imports/worker-bodies.ts`.
 */
export class WorkerHostSerializer {
  // Tail of the chain. Always a settled-or-pending promise that never
  // rejects (rejections are isolated below) so one failing body can't
  // wedge every subsequent body.
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Queue `fn` behind any previously queued work. Resolves/rejects with
   * `fn`'s own outcome; a rejection here does not break the chain for
   * later `run` callers.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
