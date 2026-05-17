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
 *
 * Known limitations (see PR #119 review):
 *
 * - **No timeout / cancellation / backpressure.** A single body that
 *   never resolves wedges the whole per-process chain: every other
 *   pthread of that process blocks forever. Pre-async the sync bodies
 *   could not stall; the bodies that now `await` (`socketListen`,
 *   `socketRecv`, the ZMQ reactor flow) are exactly the hang-prone
 *   ones. A watchdog/timeout is tracked in issue #124, not implemented
 *   here — acceptable for the single-process libzmq target workload.
 * - **No re-entrancy.** A body that synchronously `await`s another
 *   `run()` on the same serializer self-deadlocks: the inner `run`
 *   chains behind a `tail` that only settles when the outer body
 *   completes. Safe today — `threadSpawn` only *attaches* a dispatcher
 *   listener, it does not synchronously re-enter `run`. Do not call
 *   `run` from inside a body on the same serializer.
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
