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
import type {
  SocketBackend,
  SocketBackendResult,
} from "../network/socket-backend.js";
import {
  allocInetStreamSocket,
  allocUnixSocketPair,
  netLog,
  POLLFD_SIZE,
  POLLNVAL,
  pollReventsForTarget,
  recvUnixSocketNonblocking,
  sendUnixSocket,
} from "./kernel-imports.js";

/**
 * The worker-host dispatcher is sync (see worker-host-proxy.ts:249).
 * After the bridge async-fication, `target.send/recv/close` may return
 * Promises when the underlying SocketBackend is the network bridge.
 * Workers only ever hit this path for inherited sockets that already
 * resolved through the loopback registry (sync), so a Promise here
 * means the dispatcher is being asked to do work it can't satisfy
 * synchronously. Report an I/O error rather than corrupting the
 * worker's view of kernel state.
 */
function requireSyncSocketResult(
  v: SocketBackendResult | Promise<SocketBackendResult>,
): SocketBackendResult {
  if (typeof (v as Promise<SocketBackendResult>).then === "function") {
    return {
      ok: false,
      error: "worker dispatcher cannot await async socket backend",
    };
  }
  return v as SocketBackendResult;
}

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
  /**
   * Socket backend reachable from the dispatcher. Required for the
   * AF_UNIX socketpair / send_unix bodies that libzmq's signaler
   * pthread calls on bootstrap; null disables those ops (they'll
   * return -1 instead of trapping).
   */
  socketBackend?: SocketBackend | null;
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
    socketOpen: (domain, type, _protocol) => {
      // wasi-sdk-30 / yurt-cc abi/include/sys/socket.h numbering:
      //   AF_INET = 1, AF_UNIX = 3, SOCK_STREAM = 6, SOCK_DGRAM = 5.
      //   SOCK_NONBLOCK=0x4000 / SOCK_CLOEXEC=0x2000 are OR'd into
      //   `type`. ipykernel's heartbeat pthread asks for
      //   AF_INET SOCK_STREAM here (the heartbeat channel binds its
      //   own ROUTER socket); without this branch libzmq's underlying
      //   socket() returns -1 and the bind throws "No file
      //   descriptors available". AF_UNIX paths still go through
      //   socketpair / socket_open on main today.
      const AF_INET = 1;
      const SOCK_STREAM = 6;
      const SOCK_NONBLOCK = 0x4000;
      const baseType = type & ~SOCK_NONBLOCK & ~0x2000; // also strip CLOEXEC
      if (domain === AF_INET && baseType === SOCK_STREAM) {
        const fd = allocInetStreamSocket(
          kernel,
          opts.socketBackend ?? null,
          getPid(),
          (type & SOCK_NONBLOCK) !== 0,
        );
        netLog("pthread.socket_open", {
          domain,
          type,
          fd,
          result: "ok",
        });
        return fd;
      }
      netLog("pthread.socket_open", {
        domain,
        type,
        result: "ENOTSUP (worker)",
      });
      return -1;
    },
    socketClose: (fd) => {
      const target = kernel.getFdTarget(getPid(), fd);
      if (!target || target.type !== "socket") return -9;
      if (target.socket !== null) {
        const socket = target.socket;
        target.socket = null;
        // Loopback close is sync; bridge close returns a Promise that
        // the worker dispatcher can't await. Fire it and ignore — the
        // bridge worker still tears down its side asynchronously.
        void target.close(socket);
      }
      return kernel.closeFd(getPid(), fd) ? 0 : -9;
    },
    socketSend: (fd, data) => {
      const target = kernel.getFdTarget(getPid(), fd);
      if (!target || target.type !== "socket" || target.socket === null) {
        netLog("pthread.send", { fd, result: "EBADF" });
        return -1;
      }
      const copy = new Uint8Array(data); // copy out of SAB before send
      const result = requireSyncSocketResult(
        target.send(target.socket, copy),
      );
      if (!result.ok) {
        netLog("pthread.send", { fd, len: data.byteLength, result: "EIO" });
        return -1;
      }
      return typeof result.bytes_sent === "number" ? result.bytes_sent : -1;
    },
    socketRecv: (fd, cap) => {
      const target = kernel.getFdTarget(getPid(), fd);
      if (!target || target.type !== "socket" || target.socket === null) {
        netLog("pthread.recv", { fd, result: "EBADF" });
        return { result: -1 };
      }
      // Synchronous best-effort: peek/nonblocking via target.recv.
      // Worker-side blocking semantics fall back to repeated calls
      // (the worker can spin via Atomics.wait on its own state). A
      // future task can extend the dispatcher to await recvAsync;
      // see the file header for the lock work that must accompany
      // that change.
      const probe = requireSyncSocketResult(
        target.recv(target.socket, cap, { nonblocking: true }),
      );
      if (!probe.ok) {
        if (probe.error !== "EAGAIN") {
          netLog("pthread.recv", { fd, cap, result: "EIO" });
        }
        return { result: probe.error === "EAGAIN" ? -11 : -1 };
      }
      const bytes = probe.data ?? new Uint8Array(0);
      return { result: bytes.byteLength, bytes };
    },
    getPid: () => kernel.getVisiblePid(getPid()),
    socketSendUnix: (fd, data) => {
      if (!opts.socketBackend) {
        netLog("pthread.send_unix", {
          fd,
          result: "EIO",
          reason: "no backend",
        });
        return -1;
      }
      const copy = new Uint8Array(data);
      const r = sendUnixSocket(
        kernel,
        opts.socketBackend,
        getPid(),
        fd,
        copy,
      );
      if (r < 0) {
        netLog("pthread.send_unix", {
          fd,
          len: data.byteLength,
          result: r === -2 ? "EAFNOSUPPORT" : "EIO",
        });
      }
      return r;
    },
    socketPair: (_family, sockType) => {
      if (!opts.socketBackend) {
        netLog("pthread.socketpair", { result: "EIO", reason: "no backend" });
        return { result: -1 };
      }
      const pair = allocUnixSocketPair(
        kernel,
        opts.socketBackend,
        getPid(),
        sockType,
      );
      if (!pair) {
        netLog("pthread.socketpair", { sockType, result: "EIO" });
        return { result: -1 };
      }
      netLog("pthread.socketpair", {
        sockType,
        fdA: pair.fdA,
        fdB: pair.fdB,
        result: "ok",
      });
      const out = new Uint8Array(8);
      new DataView(out.buffer).setInt32(0, pair.fdA, true);
      new DataView(out.buffer).setInt32(4, pair.fdB, true);
      return { result: 0, bytes: out };
    },
    socketRecvUnix: (fd, cap, peek) => {
      if (!opts.socketBackend) {
        netLog("pthread.recv_unix", {
          fd,
          result: "EIO",
          reason: "no backend",
        });
        return { result: -1 };
      }
      const r = recvUnixSocketNonblocking(
        kernel,
        opts.socketBackend,
        getPid(),
        fd,
        cap,
        peek !== 0,
      );
      if (r.result < 0 && r.result !== -2) {
        netLog("pthread.recv_unix", { fd, cap, result: r.result });
      }
      return r;
    },
    setFdDescriptorFlags: (fd, flags) => {
      if (!kernel.getFdTarget(getPid(), fd)) return -1;
      kernel.setFdDescriptorFlags(getPid(), fd, flags);
      return 0;
    },
    socketBind: (fd, host, port) => {
      const target = kernel.getFdTarget(getPid(), fd);
      if (!target || target.type !== "socket") {
        netLog("pthread.bind", { fd, result: "EBADF" });
        return -9;
      }
      const hostStr = new TextDecoder().decode(host);
      if (
        hostStr !== "127.0.0.1" && hostStr !== "localhost" &&
        hostStr !== "0.0.0.0"
      ) {
        netLog("pthread.bind", {
          fd,
          host: hostStr,
          port,
          result: "EAFNOSUPPORT",
        });
        return -95;
      }
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        netLog("pthread.bind", { fd, host: hostStr, port, result: "EINVAL" });
        return -22;
      }
      target.boundHost = hostStr as "127.0.0.1" | "localhost" | "0.0.0.0";
      target.boundPort = port;
      target.localHost = hostStr === "0.0.0.0" ? "10.0.2.15" : hostStr;
      target.localPort = port;
      netLog("pthread.bind", { fd, host: hostStr, port, result: "ok" });
      return 0;
    },
    socketListen: (fd, backlogArg) => {
      const target = kernel.getFdTarget(getPid(), fd);
      if (!target || target.type !== "socket") {
        netLog("pthread.listen", { fd, result: "EBADF" });
        return -9;
      }
      if (!opts.socketBackend?.listen) {
        netLog("pthread.listen", { fd, result: "ENOTSUP" });
        return -95;
      }
      const host = target.boundHost ?? "127.0.0.1";
      const port = target.boundPort ?? 0;
      const backlog = backlogArg > 0 ? backlogArg : 128;
      const listenResult = opts.socketBackend.listen({ host, port, backlog });
      if (typeof (listenResult as Promise<unknown>).then === "function") {
        // Network-bridge backends return a Promise here; the worker
        // dispatcher can't await mid-flight. The loopback registry is
        // sync, so as long as the sandbox uses it (serverSockets.
        // allowLoopback) this branch never fires. Surface a clear
        // failure rather than blocking — the heartbeat thread will
        // retry via its own bind/listen loop.
        netLog("pthread.listen", { fd, result: "EAGAIN (async backend)" });
        return -5;
      }
      const r = listenResult as Awaited<
        ReturnType<NonNullable<typeof opts.socketBackend.listen>>
      >;
      if (!r.ok) {
        netLog("pthread.listen", {
          fd,
          host,
          port,
          result: "EIO",
          reason: r.error,
        });
        return -5;
      }
      target.listener = r.listener;
      target.boundHost = host;
      target.boundPort = port;
      target.localHost = r.host;
      target.localPort = r.port;
      target.closeListener = (listener) => {
        void opts.socketBackend?.closeListener?.(listener);
      };
      netLog("pthread.listen", {
        fd,
        host,
        port,
        assignedHost: r.host,
        assignedPort: r.port,
        result: "ok",
      });
      return 0;
    },
    socketIsDgram: (fd) => {
      const target = kernel.getFdTarget(getPid(), fd);
      if (!target || target.type !== "socket") return -1;
      return target.isDgram ? 1 : 0;
    },
    threadSpawn: (fnPtr, arg) => {
      const tb = threadsBackend() as
        | (ThreadsBackend & { spawnSync?: (fp: number, a: number) => number })
        | null;
      if (!tb || typeof tb.spawnSync !== "function") {
        netLog("pthread.spawn", { result: "ENOTSUP" });
        return -1;
      }
      try {
        const tid = tb.spawnSync(fnPtr, arg);
        netLog("pthread.spawn", { fnPtr, tid });
        return tid;
      } catch (e) {
        netLog("pthread.spawn", {
          fnPtr,
          result: "EIO",
          reason: e instanceof Error ? e.message : String(e),
        });
        return -1;
      }
    },
    poll: (nfds, fds) => {
      netLog("pthread.poll.req", { nfds, byteLen: fds.byteLength });
      // Single-shot readiness probe — the worker-side `host_poll`
      // import owns the retry/timeout loop. Each pollfd is 8 bytes:
      // i32 fd, i16 events, i16 revents (revents zeroed on input,
      // written here, returned to the worker which copies back into
      // wasm memory). Unknown fds report as not-ready rather than
      // POLLNVAL: libzmq's poll.cpp asserts `!(revents & POLLNVAL)`
      // and aborts the whole pthread on a transient lookup miss, so
      // surfacing the POSIX error here trades a recoverable spin for
      // an unrecoverable trap. Real "fd never existed" still surfaces
      // via the syscalls that opened it.
      const totalBytes = nfds * POLLFD_SIZE;
      if (fds.byteLength < totalBytes) return { result: -1 };
      const out = new Uint8Array(totalBytes);
      out.set(fds.subarray(0, totalBytes));
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      let ready = 0;
      void POLLNVAL;
      const fdSummary: number[] = [];
      const reventsSummary: number[] = [];
      for (let i = 0; i < nfds; i++) {
        const base = i * POLLFD_SIZE;
        const fd = view.getInt32(base, true);
        const events = view.getInt16(base + 4, true);
        let revents = 0;
        if (fd >= 0) {
          const target = kernel.getFdTarget(getPid(), fd);
          revents = target ? pollReventsForTarget(target, events) : 0;
        }
        view.setInt16(base + 6, revents, true);
        fdSummary.push(fd);
        reventsSummary.push(revents);
        if (revents !== 0) ready++;
      }
      netLog("pthread.poll.resp", {
        fds: fdSummary,
        revents: reventsSummary,
        ready,
      });
      return { result: ready, bytes: out };
    },
  };
}
