/**
 * Worker-host dispatcher bodies for the worker-sab pthread runtime.
 *
 * Worker-spawned pthreads (see `process/threads/worker-host-proxy.ts`)
 * proxy a fixed set of host imports back to main via a per-thread SAB
 * channel. The main-side dispatcher invokes the bodies in this file to
 * mutate kernel state (fd table, socket backend handles) on the
 * worker's behalf.
 *
 * Concurrency contract — current state:
 *   The dispatcher is the ONLY path workers use to reach kernel state
 *   today; workers do not share JS object graphs with main and cannot
 *   touch the kernel except through this surface.
 *
 *   The main JS event loop serializes message-handler invocations: a
 *   "host-call" request from one worker runs the dispatcher's
 *   `message` handler to completion before another worker's request
 *   can be dispatched. Every body in this file is synchronous in its
 *   kernel mutations — no `await` between message decode and response
 *   encode — so the event loop alone is sufficient for FIFO ordering
 *   across workers in the same process.
 *
 *   Therefore NO explicit kernel-state lock is required today, and we
 *   deliberately do not ship one. A previous iteration shipped a
 *   `withKernelLock` helper whose `fn()` ran eagerly outside its
 *   Promise chain — it performed zero serialization and was removed.
 *
 * When to reintroduce a lock:
 *   The moment any body needs to `await` mid-flight (e.g. real
 *   blocking-socket recv via `recvAsync`, or any other suspension
 *   that lets the event loop run another worker's handler), the
 *   following must be done together:
 *     1. Promote `WorkerHostDispatcherBodies` methods to return
 *        Promises, and have `attachWorkerHostDispatcher` `await` the
 *        body result before writing the response SAB.
 *     2. Reintroduce a real serialization primitive on the main side
 *        — either a Promise-chain mutex whose `.then` actually
 *        encloses the body call (so the body runs INSIDE the
 *        chained continuation, not outside it), or an Atomics-based
 *        main-side lock that worker dispatchers acquire before
 *        touching kernel state.
 *     3. Keep the per-process scoping: `makeWorkerDispatcherBodies`
 *        returns a fresh closure per call, so the lock must live in
 *        that closure (one lock per process, shared across all of
 *        that process's spawned worker threads).
 *
 * Why the wasm-import bodies in `kernel-imports.ts` are also not
 * locked:
 *   The dozens of unit tests that call those imports synchronously
 *   (`socket-fds_test.ts`, `imports-shape_test.ts`, ...) rely on the
 *   sync return shape of the peek/nonblocking paths. The worker-side
 *   concurrency surface is restricted to these dispatcher bodies; the
 *   wasm-import path is single-threaded by construction (only the
 *   main-thread wasm instance calls it).
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
 * Build a `WorkerHostDispatcherBodies` whose methods mutate kernel
 * state on behalf of worker-spawned threads. Pass the result into
 * `attachWorkerHostDispatcher` (or, transitively, into
 * `defaultSpawnThread`) so every spawned worker in this process
 * shares the same kernel/threads-backend references.
 *
 * All bodies are synchronous; see the file header for the
 * concurrency contract and the conditions under which a real lock
 * must be reintroduced.
 */
export function makeWorkerDispatcherBodies(
  opts: MakeWorkerDispatcherBodiesOptions,
): WorkerHostDispatcherBodies {
  const { kernel, threadsBackend } = opts;
  const getPid = typeof opts.callerPid === "function"
    ? opts.callerPid
    : () => opts.callerPid as number;

  return {
    threadYield: () => {
      // Worker-side `host_thread_yield` is a fire-and-forget signal
      // — the dispatcher returns immediately and the worker's
      // `Atomics.wait` resumes. We invoke the backend's yield_ so
      // its accounting (scheduler bookkeeping) sees the call.
      const tb = threadsBackend();
      if (tb) void tb.yield_();
      return 0;
    },
    threadExit: (retval) => {
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
    },
    writeFd: (fd, data) => {
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
    },
    readFd: (fd, cap) => {
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
    },
    socketOpen: (_domain, _type, _protocol) => {
      // Worker-side socket creation isn't wired today: libzmq's
      // signaler thread (the only worker callsite for now) inherits
      // the socket fd from the main thread. Returning -1 keeps the
      // dispatcher response well-defined; Task 11+ canaries don't
      // exercise this path.
      return -1;
    },
    socketClose: (fd) => {
      const target = kernel.getFdTarget(getPid(), fd);
      if (!target || target.type !== "socket") return -9;
      if (target.socket !== null) {
        const socket = target.socket;
        target.socket = null;
        target.close(socket);
      }
      return kernel.closeFd(getPid(), fd) ? 0 : -9;
    },
    socketSend: (fd, data) => {
      const target = kernel.getFdTarget(getPid(), fd);
      if (!target || target.type !== "socket" || target.socket === null) {
        return -1;
      }
      const copy = new Uint8Array(data); // copy out of SAB before send
      const result = target.send(target.socket, copy);
      if (!result.ok) return -1;
      return typeof result.bytes_sent === "number" ? result.bytes_sent : -1;
    },
    socketRecv: (fd, cap) => {
      const target = kernel.getFdTarget(getPid(), fd);
      if (!target || target.type !== "socket" || target.socket === null) {
        return { result: -1 };
      }
      // Synchronous best-effort: peek/nonblocking via target.recv.
      // Worker-side blocking semantics fall back to repeated calls
      // (the worker can spin via Atomics.wait on its own state). A
      // future task can extend the dispatcher to await recvAsync;
      // see the file header for the lock work that must accompany
      // that change.
      const probe = target.recv(target.socket, cap, { nonblocking: true });
      if (!probe.ok) {
        return { result: probe.error === "EAGAIN" ? -11 : -1 };
      }
      const bytes = probe.data ?? new Uint8Array(0);
      return { result: bytes.byteLength, bytes };
    },
  };
}
