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
 * - **Watchdog/timeout (#124, opt-in).** A single body that never
 *   resolves would wedge the whole per-process chain: every other
 *   pthread of that process blocks forever. Pre-async the sync bodies
 *   could not stall; the bodies that now `await` (`socketListen`,
 *   `socketRecv`, the ZMQ reactor flow) are exactly the hang-prone
 *   ones. An optional per-call / per-serializer `timeoutMs` makes a
 *   hung body fail *its own* round-trip (rejecting with
 *   `WorkerHostTimeoutError`) and lets the chain advance so the rest
 *   of the process keeps running. It is **off by default**: the
 *   single-process libzmq target relies on legitimately long parks, so
 *   forcing a timeout there would regress it — enabling a process-wide
 *   default is a separate policy decision (see #124).
 *
 *   A timed-out body's underlying promise keeps running (JS has no
 *   cancellation); its own parked pthread stays parked ("fails its own
 *   round-trip"), but every *other* pthread is freed — strictly better
 *   than the previous process-global wedge.
 * - **No re-entrancy.** A body that synchronously `await`s another
 *   `run()` on the same serializer self-deadlocks: the inner `run`
 *   chains behind a `tail` that only settles when the outer body
 *   completes. Safe today — `threadSpawn` only *attaches* a dispatcher
 *   listener, it does not synchronously re-enter `run`. Do not call
 *   `run` from inside a body on the same serializer.
 */
/**
 * Rejection raised when a body exceeds the watchdog timeout (#124).
 * Distinguishable so callers/tests can tell a hung-body timeout from a
 * body's own error.
 */
export class WorkerHostTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`worker-host body exceeded the ${timeoutMs}ms watchdog timeout`);
    this.name = "WorkerHostTimeoutError";
  }
}

export class WorkerHostSerializer {
  // Tail of the chain. Always a settled-or-pending promise that never
  // rejects (rejections are isolated below) so one failing body can't
  // wedge every subsequent body.
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Optional process-wide watchdog. `undefined` ⇒ unlimited (today's
   * default; libzmq-safe). A per-call `timeoutMs` overrides it.
   */
  private readonly defaultTimeoutMs?: number;

  constructor(defaultTimeoutMs?: number) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Queue `fn` behind any previously queued work. Resolves/rejects with
   * `fn`'s own outcome; a rejection here does not break the chain for
   * later `run` callers.
   *
   * If a positive finite `timeoutMs` is in effect (per-call override or
   * the serializer default) and `fn` has not settled within it, the
   * returned promise rejects with `WorkerHostTimeoutError` and the
   * chain advances so queued bodies are not wedged by the hang.
   */
  run<T>(fn: () => T | Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const watchdog = typeof timeoutMs === "number" && timeoutMs > 0 &&
      Number.isFinite(timeoutMs);
    // No-timeout path is byte-identical to the original chaining so its
    // microtask timing / kernel-state exclusivity is unchanged.
    const result = watchdog
      ? this.tail.then(() => withTimeout(fn(), timeoutMs as number))
      : this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Race `work` against a `timeoutMs` timer. The timer is always cleared
 * when `work` settles first (no leaked handle). On timeout the original
 * `work` keeps running but its eventual settle is swallowed so it never
 * surfaces as an unhandled rejection.
 */
function withTimeout<T>(work: T | Promise<T>, timeoutMs: number): Promise<T> {
  const w = Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      w.then(() => {}, () => {});
      reject(new WorkerHostTimeoutError(timeoutMs));
    }, timeoutMs);
    w.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
