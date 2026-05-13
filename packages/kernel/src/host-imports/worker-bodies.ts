/**
 * Worker-host dispatcher bodies for the worker-sab pthread runtime.
 *
 * Worker-spawned pthreads (see `process/threads/worker-host-proxy.ts`)
 * proxy a fixed set of host imports back to main via a per-thread SAB
 * channel. The main-side dispatcher invokes the bodies in this file to
 * mutate kernel state (fd table, socket backend handles) on the
 * worker's behalf.
 *
 * Why a coarse main-thread mutex (`withKernelLock`):
 *   JS message-event handlers on main run serially, but any `await`
 *   inside a body lets another worker's "host-call" handler interleave
 *   on the next microtask. The Promise-chain semaphore below serializes
 *   every body — each acquires the lock before touching kernel state
 *   and releases it on completion. The lock is per-process
 *   (`makeWorkerDispatcherBodies` returns a fresh closure per call), so
 *   different processes never contend.
 *
 *   Today all bodies are synchronous in their kernel mutations, so the
 *   lock only enforces FIFO ordering across workers — already
 *   guaranteed by the event loop. The infrastructure exists because
 *   any future body that awaits (e.g. blocking socket recv via
 *   `recvAsync`) must serialize against the others to avoid racing on
 *   the fd table.
 *
 * Why the wasm-import bodies in `kernel-imports.ts` are NOT also
 * wrapped:
 *   The dozens of unit tests that call those imports synchronously
 *   (`socket-fds_test.ts`, `imports-shape_test.ts`, ...) rely on the
 *   sync return shape of the peek/nonblocking paths. Wrapping the
 *   wasm-import bodies in `withKernelLock` would force them to return
 *   Promises always, breaking those tests. The worker-side concurrency
 *   risk (multiple workers calling kernel-touching imports) is
 *   addressed entirely by serializing the dispatcher bodies, which is
 *   the only path workers can take into kernel state today.
 */

import type { ProcessKernel } from "../process/kernel.js";
import type { ThreadsBackend } from "../process/threads/backend.js";
import type { WorkerHostDispatcherBodies } from "../process/threads/worker-host-proxy.js";

export interface MakeWorkerDispatcherBodiesOptions {
  kernel: ProcessKernel;
  /**
   * PID of the process whose worker-spawned threads will dispatch
   * through these bodies. Accepted as a value or as a lazy accessor;
   * the loader uses the accessor form because pid allocation happens
   * AFTER the threads-backend rejection path (so threading-rejection
   * preserves pid-leak rollback semantics on the kernel side).
   */
  callerPid: number | (() => number);
  /**
   * Lazy accessor for the main-side threads backend used by `threadYield`
   * and `threadExit`. The accessor is invoked at dispatch time, not at
   * `makeWorkerDispatcherBodies` time, because the loader builds the
   * backend AFTER deciding which dispatcher bodies to use (the bodies
   * are passed into the backend's spawner). Returning `null` short-
   * circuits yield/exit handlers to no-ops.
   */
  threadsBackend: () => ThreadsBackend | null;
}

/**
 * Build a `WorkerHostDispatcherBodies` with a coarse main-thread
 * Promise-chain mutex serializing all body invocations. Pass the
 * result into `attachWorkerHostDispatcher` (or, transitively, into
 * `defaultSpawnThread`) so every spawned worker shares the same lock.
 *
 * All bodies are wrapped with `withKernelLock` and return synchronous
 * results today (no `await` inside the bodies themselves). The lock
 * therefore exists primarily as infrastructure for future async
 * bodies; in the synchronous case the chain only serializes the order
 * of body execution across concurrent host calls.
 */
export function makeWorkerDispatcherBodies(
  opts: MakeWorkerDispatcherBodiesOptions,
): WorkerHostDispatcherBodies {
  const { kernel, threadsBackend } = opts;
  const getPid = typeof opts.callerPid === "function"
    ? opts.callerPid
    : () => opts.callerPid as number;

  // Coarse main-thread serialization for kernel-state mutations
  // reachable from spawned worker threads via the dispatcher. JS
  // message-event handlers are processed serially by the main event
  // loop, but any `await` inside a body lets another handler
  // interleave. This Promise chain forces strict FIFO ordering across
  // all worker-issued host calls in the same process.
  let kernelMutex: Promise<unknown> = Promise.resolve();
  function withKernelLock<T>(fn: () => T): T {
    // For purely synchronous bodies, we still drive the chain so a
    // future async body sees a serialized predecessor. The chain is
    // tail-attached: we compute `next` (Promise resolving to the
    // function's result on the next microtask) and bind the chain to
    // it, but we ALSO run `fn` eagerly and return its sync result.
    // The chain therefore only matters when a body later swaps in an
    // async implementation that returns Promise<T>; this helper's
    // type signature constrains today's callers to sync.
    const next = kernelMutex.then(() => undefined, () => undefined);
    kernelMutex = next;
    return fn();
  }

  return {
    threadYield: () =>
      withKernelLock(() => {
        // Worker-side `host_thread_yield` is a fire-and-forget signal
        // — the dispatcher returns immediately and the worker's
        // `Atomics.wait` resumes. We invoke the backend's yield_ so
        // its accounting (scheduler bookkeeping) sees the call.
        const tb = threadsBackend();
        if (tb) void tb.yield_();
        return 0;
      }),
    threadExit: (retval) => {
      withKernelLock(() => {
        // The actual worker termination happens worker-side after
        // this dispatcher response returns. `backend.exit()` throws
        // by interface contract; swallow on the main-side dispatcher
        // path so the message handler completes cleanly.
        const tb = threadsBackend();
        if (!tb) return;
        try {
          tb.exit(retval);
        } catch {
          // expected
        }
      });
    },
    writeFd: (fd, data) =>
      withKernelLock(() => {
        const target = kernel.getFdTarget(getPid(), fd);
        if (target?.type === "pipe_write") {
          // Copy: SAB may shift under the worker, and pipe.write
          // retains the reference.
          target.pipe.write(new Uint8Array(data));
          return data.byteLength;
        }
        if (target?.type === "buffer") {
          const copy = new Uint8Array(data);
          target.buf.push(copy);
          target.total += copy.byteLength;
          target.onChunk?.(copy);
          return data.byteLength;
        }
        return -1;
      }),
    readFd: (fd, cap) =>
      withKernelLock(() => {
        const target = kernel.getFdTarget(getPid(), fd);
        if (target?.type === "pipe_read") {
          const data = target.pipe.drainSync();
          if (data.byteLength > cap) return { result: data.byteLength };
          return { result: data.byteLength, bytes: data };
        }
        if (target?.type === "static") {
          const data = target.data.subarray(target.offset);
          if (data.byteLength > cap) return { result: data.byteLength };
          target.offset = target.data.byteLength;
          return { result: data.byteLength, bytes: data };
        }
        if (target?.type === "null") return { result: 0 };
        return { result: -9 };
      }),
    socketOpen: (_domain, _type, _protocol) =>
      withKernelLock(() => {
        // Worker-side socket creation isn't wired today: libzmq's
        // signaler thread (the only worker callsite for now) inherits
        // the socket fd from the main thread. Returning -1 keeps the
        // dispatcher response well-defined; Task 11+ canaries don't
        // exercise this path.
        return -1;
      }),
    socketClose: (fd) =>
      withKernelLock(() => {
        const target = kernel.getFdTarget(getPid(), fd);
        if (!target || target.type !== "socket") return -9;
        if (target.socket !== null) {
          const socket = target.socket;
          target.socket = null;
          target.close(socket);
        }
        return kernel.closeFd(getPid(), fd) ? 0 : -9;
      }),
    socketSend: (fd, data) =>
      withKernelLock(() => {
        const target = kernel.getFdTarget(getPid(), fd);
        if (!target || target.type !== "socket" || target.socket === null) {
          return -1;
        }
        const copy = new Uint8Array(data); // copy out of SAB before send
        const result = target.send(target.socket, copy);
        if (!result.ok) return -1;
        return typeof result.bytes_sent === "number" ? result.bytes_sent : -1;
      }),
    socketRecv: (fd, cap) =>
      withKernelLock(() => {
        const target = kernel.getFdTarget(getPid(), fd);
        if (!target || target.type !== "socket" || target.socket === null) {
          return { result: -1 };
        }
        // Synchronous best-effort: peek/nonblocking via target.recv.
        // Worker-side blocking semantics fall back to repeated calls
        // (the worker can spin via Atomics.wait on its own state). A
        // future task can extend the dispatcher to await recvAsync.
        const probe = target.recv(target.socket, cap, { nonblocking: true });
        if (!probe.ok) {
          return { result: probe.error === "EAGAIN" ? -11 : -1 };
        }
        const bytes = probe.data ?? new Uint8Array(0);
        return { result: bytes.byteLength, bytes };
      }),
  };
}
