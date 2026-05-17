/**
 * Worker-host proxy: typed binary host-import bridge between a Worker
 * pthread and the main JS thread. No JSON anywhere - fixed-layout SAB
 * cells with op codes and i32 args.
 *
 * Architecture: each Worker spawned by WorkerSabThreadsBackend gets its
 * own per-thread request SAB (8-byte header + 4096-byte payload). The
 * worker encodes a host-import call into the SAB, postMessages
 * "host-call" to main, then Atomics.waits on the status header. Main's
 * `attachWorkerHostDispatcher` receives the message, decodes the op,
 * dispatches to a caller-provided body, encodes the response into the
 * SAB, and Atomics.notifies the worker.
 *
 * Worker-side `host_thread_self` is special-cased: implemented directly
 * in the worker-side import closure (no postMessage needed) because the
 * worker already knows its own tid from the start message.
 *
 * Task 10 will wrap the dispatcher bodies in a main-thread mutex so
 * concurrent worker calls into kernel state are serialized. Task 9
 * leaves the dispatcher unlocked - correct as long as no two workers
 * call host imports concurrently (e.g. libzmq's single signaler).
 */

import { WASI_EBUSY } from "../../wasi/types.js";
import { decodeSockaddrIn } from "../../host-imports/common.js";
import { SabCondvar, SabMutex } from "./sab-primitives.js";
import { WorkerHostSerializer } from "./worker-host-serializer.js";

/** A value that may be returned synchronously or via a Promise. */
type Awaitable<T> = T | Promise<T>;

/**
 * Sentinel thrown by the worker-side `host_thread_exit` import to unwind
 * the wasm call frame while carrying the supplied retval. The worker
 * host entry point recognises this and reports the retval back to the
 * joining thread.
 */
export class WorkerThreadExit extends Error {
  constructor(readonly retval: number) {
    super("pthread_exit");
    this.name = "WorkerThreadExit";
  }
}

// Op codes. i32 wire format.
export const enum WorkerHostOp {
  ThreadSelf = 1,
  ThreadYield = 2,
  ThreadExit = 3,
  WriteFd = 10,
  ReadFd = 11,
  SocketOpen = 20,
  SocketClose = 21,
  SocketRecv = 22,
  SocketSend = 23,
  Poll = 30,
  GetPid = 40,
  SocketSendUnix = 41,
  SocketPair = 42,
  SocketRecvUnix = 43,
  SetFdDescriptorFlags = 44,
  ThreadSpawn = 45,
  SocketBind = 46,
  SocketListen = 47,
  SocketIsDgram = 48,
}

// pollfd struct on the wasm side: { fd: i32, events: i16, revents: i16 } — 8 bytes.
const POLLFD_BYTES = 8;

/**
 * Caller-provided handle for a worker's per-thread request SAB. The
 * worker uses this to dispatch host calls back to main.
 *
 * NOTE: `postHostCall` is a closure, so this object cannot be passed
 * through `postMessage` (functions don't structured-clone). Producers
 * on main pass `requestSab` across the postMessage boundary as a bare
 * SharedArrayBuffer; the worker reconstructs its own `postHostCall`
 * using `self.postMessage`.
 */
export interface WorkerHostImportProxy {
  /** SharedArrayBuffer for the per-thread request/response channel. */
  requestSab: SharedArrayBuffer;
  /**
   * Hook the worker invokes after writing a request, before
   * Atomics.wait. The worker implementation sends a "host-call"
   * message to main so the dispatcher runs.
   */
  postHostCall: (op: WorkerHostOp) => void;
}

// Header layout (Int32 indices into header view).
const STATUS_OFFSET = 0;
const RESULT_OFFSET = 1;
const HEADER_WORDS = 2;
const HEADER_BYTES = HEADER_WORDS * 4;

// Status values.
const STATUS_IDLE = 0;
const STATUS_REQUEST_READY = 1;
const STATUS_RESPONSE_READY = 2;
const STATUS_ERROR = -1;

// Payload layout (Int32 indices into payload view).
const PAYLOAD_OFFSET_BYTES = HEADER_BYTES;
const PAYLOAD_OP_WORD = 0;
const PAYLOAD_ARGC_WORD = 1;
const PAYLOAD_ARGS_WORD = 2;

const PAYLOAD_BYTES = 4096;
const PAYLOAD_WORDS = PAYLOAD_BYTES / 4;
const ERR_INVALID = -22;

/** Total SAB size required for one per-thread request channel. */
export const REQUEST_SAB_BYTES = HEADER_BYTES + PAYLOAD_BYTES;

/**
 * Build a yurt-namespace imports object for the worker side. Used at
 * `WebAssembly.instantiate(module, { env: { memory }, yurt: createWorkerYurtImports(tid, memory, proxy) })`
 * inside the worker.
 *
 * `tid` is the worker's own tid (captured from the start message);
 * `host_thread_self` returns it without proxying. Other imports encode
 * their args into the SAB, signal main via `proxy.postHostCall`, then
 * `Atomics.wait` on the status header for the response.
 *
 * Return convention: each import returns a single i32. For ops that
 * yield bytes (ReadFd, SocketRecv), the byte count is the return value
 * and the bytes are copied out of the payload into the wasm linear
 * memory at the caller-supplied output pointer.
 */
export function createWorkerYurtImports(
  tid: number,
  memory: WebAssembly.Memory,
  proxy: WorkerHostImportProxy,
): WebAssembly.ModuleImports {
  const sab = proxy.requestSab;
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);
  const payloadBytes = new Uint8Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_BYTES);
  const memoryBytes = () => new Uint8Array(memory.buffer);
  const sharedBuffer = memory.buffer instanceof SharedArrayBuffer
    ? memory.buffer
    : null;
  const mutex = (ptr: number) =>
    sharedBuffer ? new SabMutex(sharedBuffer, ptr) : null;
  const condvar = (ptr: number) =>
    sharedBuffer ? new SabCondvar(sharedBuffer, ptr) : null;

  function call(
    op: WorkerHostOp,
    args: number[],
    extraBytes?: Uint8Array,
  ): number {
    payload[PAYLOAD_OP_WORD] = op;
    payload[PAYLOAD_ARGC_WORD] = args.length;
    for (let i = 0; i < args.length; i++) {
      payload[PAYLOAD_ARGS_WORD + i] = args[i] | 0;
    }
    if (extraBytes && extraBytes.byteLength > 0) {
      const byteStart = (PAYLOAD_ARGS_WORD + args.length) * 4;
      payloadBytes.set(extraBytes, byteStart);
    }
    Atomics.store(header, STATUS_OFFSET, STATUS_REQUEST_READY);
    proxy.postHostCall(op);
    Atomics.wait(header, STATUS_OFFSET, STATUS_REQUEST_READY);
    const status = Atomics.load(header, STATUS_OFFSET);
    const result = Atomics.load(header, RESULT_OFFSET);
    Atomics.store(header, STATUS_OFFSET, STATUS_IDLE);
    if (status === STATUS_ERROR) return -1;
    return result;
  }

  function copyOutBytes(outPtr: number, n: number): void {
    if (n <= 0) return;
    // ReadFd / SocketRecv place returned bytes immediately after the
    // single i32 arg slot consumed by the response layout.
    const byteStart = (PAYLOAD_ARGS_WORD + 1) * 4;
    memoryBytes().set(
      payloadBytes.subarray(byteStart, byteStart + n),
      outPtr,
    );
  }

  return {
    host_thread_self: () => tid,
    host_thread_yield: () => call(WorkerHostOp.ThreadYield, []),
    host_thread_exit: (retval: number) => {
      call(WorkerHostOp.ThreadExit, [retval]);
      // ThreadExit doesn't return from main; throw a tagged sentinel so
      // worker-thread-host.ts can surface the supplied retval back to
      // the joining thread instead of treating the unwind as failure.
      throw new WorkerThreadExit(retval);
    },
    host_write_fd: (fd: number, ptr: number, len: number) => {
      const data = memoryBytes().subarray(ptr, ptr + len);
      return call(WorkerHostOp.WriteFd, [fd, len], data);
    },
    host_read_fd: (fd: number, outPtr: number, outCap: number) => {
      const n = call(WorkerHostOp.ReadFd, [fd, outCap]);
      copyOutBytes(outPtr, n);
      return n;
    },
    host_socket_open: (domain: number, type: number, protocol: number) =>
      call(WorkerHostOp.SocketOpen, [domain, type, protocol]),
    host_socket_close: (fd: number) => call(WorkerHostOp.SocketClose, [fd]),
    host_socket_recv: (fd: number, outPtr: number, outCap: number) => {
      const n = call(WorkerHostOp.SocketRecv, [fd, outCap]);
      copyOutBytes(outPtr, n);
      return n;
    },
    host_socket_send: (fd: number, ptr: number, len: number) => {
      const data = memoryBytes().subarray(ptr, ptr + len);
      return call(WorkerHostOp.SocketSend, [fd, len], data);
    },
    host_getpid: () => call(WorkerHostOp.GetPid, []),
    host_socket_send_unix: (fd: number, ptr: number, len: number) => {
      const data = memoryBytes().subarray(ptr, ptr + len);
      return call(WorkerHostOp.SocketSendUnix, [fd, len], data);
    },
    host_socket_socketpair: (
      family: number,
      sockType: number,
      svPtr: number,
    ) => {
      const r = call(WorkerHostOp.SocketPair, [family, sockType]);
      if (r === 0) {
        const byteStart = (PAYLOAD_ARGS_WORD + 1) * 4;
        // Response payload: 2 × i32 (fdA, fdB) starting at byteStart.
        memoryBytes().set(
          payloadBytes.subarray(byteStart, byteStart + 8),
          svPtr,
        );
      }
      return r;
    },
    host_socket_recv_unix: (
      fd: number,
      bufPtr: number,
      bufCap: number,
      peek: number,
    ) => {
      // Body is a single nonblocking probe; if the caller wanted a
      // blocking recv we'd loop, but libzmq's signaler always opens
      // its mailbox fd as nonblocking and polls externally, so a
      // single shot matches the call site. EAGAIN (-2) and peek (-3)
      // returns flow straight through.
      const n = call(WorkerHostOp.SocketRecvUnix, [fd, bufCap, peek | 0]);
      if (n > 0) {
        const byteStart = (PAYLOAD_ARGS_WORD + 1) * 4;
        memoryBytes().set(
          payloadBytes.subarray(byteStart, byteStart + n),
          bufPtr,
        );
      }
      return n;
    },
    host_set_fd_descriptor_flags: (fd: number, flags: number) =>
      call(WorkerHostOp.SetFdDescriptorFlags, [fd, flags]),
    host_thread_spawn: (fnPtr: number, arg: number) =>
      call(WorkerHostOp.ThreadSpawn, [fnPtr, arg]),
    host_socket_bind: (
      fd: number,
      addrPtr: number,
      addrLen: number,
    ) => {
      const addr = decodeSockaddrIn(memory, addrPtr, addrLen);
      if (addr === null) return ERR_INVALID;
      const host = new TextEncoder().encode(addr.host);
      return call(
        WorkerHostOp.SocketBind,
        [fd, host.byteLength, addr.port],
        host,
      );
    },
    host_socket_listen: (fd: number, backlog: number) =>
      call(WorkerHostOp.SocketListen, [fd, backlog]),
    host_socket_is_dgram: (fd: number) =>
      call(WorkerHostOp.SocketIsDgram, [fd]),
    host_poll: (fdsPtr: number, nfds: number, timeoutMs: number) => {
      // The dispatcher body is sync (one evaluate per round-trip). We
      // implement the blocking semantics on the worker side: probe via
      // a host-call, sleep briefly between rounds using Atomics.wait on
      // a private cell (workers may block synchronously), and write the
      // returned revents back into wasm memory each round so callers
      // observe ready bits as they appear.
      const totalBytes = nfds * POLLFD_BYTES;
      if (nfds <= 0 || totalBytes > PAYLOAD_BYTES) return -1;
      const sleepCell = new Int32Array(new SharedArrayBuffer(4));
      const start = Date.now();
      while (true) {
        const input = memoryBytes().subarray(fdsPtr, fdsPtr + totalBytes);
        const ready = call(WorkerHostOp.Poll, [nfds], input);
        const byteStart = (PAYLOAD_ARGS_WORD + 1) * 4;
        memoryBytes().set(
          payloadBytes.subarray(byteStart, byteStart + totalBytes),
          fdsPtr,
        );
        if (ready < 0) return ready;
        if (ready > 0) return ready;
        if (timeoutMs === 0) return 0;
        if (timeoutMs > 0) {
          const elapsed = Date.now() - start;
          if (elapsed >= timeoutMs) return 0;
          Atomics.wait(sleepCell, 0, 0, Math.min(10, timeoutMs - elapsed));
        } else {
          Atomics.wait(sleepCell, 0, 0, 10);
        }
      }
    },
    host_mutex_lock: (ptr: number) => {
      const m = mutex(ptr);
      if (!m || m.owner() === tid) return -1;
      m.lock(tid);
      return 0;
    },
    host_mutex_unlock: (ptr: number) => {
      try {
        const m = mutex(ptr);
        if (!m) return -1;
        m.unlock(tid);
        return 0;
      } catch {
        return -1;
      }
    },
    host_mutex_trylock: (ptr: number) => {
      const m = mutex(ptr);
      if (!m) return -1;
      return m.tryLock(tid) ? 0 : WASI_EBUSY;
    },
    host_cond_wait: (condPtr: number, mutexPtr: number) => {
      try {
        const cv = condvar(condPtr);
        const m = mutex(mutexPtr);
        if (!cv || !m) return -1;
        cv.wait(m, tid);
        return 0;
      } catch {
        return -1;
      }
    },
    host_cond_signal: (ptr: number) => {
      const cv = condvar(ptr);
      if (!cv) return -1;
      cv.signal();
      return 0;
    },
    host_cond_broadcast: (ptr: number) => {
      const cv = condvar(ptr);
      if (!cv) return -1;
      cv.broadcast();
      return 0;
    },
  };
}

/**
 * Main-side dispatcher body handlers. Each handler returns a number
 * (result/errno). Read-ish ops (ReadFd, SocketRecv) also return the
 * bytes to copy into the response payload.
 *
 * **Awaitable contract (Task 10).** Every method may return its value
 * synchronously OR as a `Promise`. `attachWorkerHostDispatcher` always
 * `await`s the result, and runs every body inside a per-process
 * `WorkerHostSerializer` so that even when a body suspends mid-flight
 * (e.g. a blocking socket recv, or the libzmq I/O reactor waiting on a
 * round-trip) no peer worker's body interleaves and observes a
 * partially-mutated kernel state. A body that stays synchronous keeps
 * the previous fast path — it just resolves on the microtask the
 * serializer already awaits.
 */
export interface WorkerHostDispatcherBodies {
  threadYield(callerTid?: number): Awaitable<number>;
  threadExit(retval: number, callerTid?: number): Awaitable<void>;
  writeFd(fd: number, data: Uint8Array): Awaitable<number>;
  readFd(
    fd: number,
    cap: number,
  ): Awaitable<{ result: number; bytes?: Uint8Array }>;
  socketOpen(
    domain: number,
    type: number,
    protocol: number,
  ): Awaitable<number>;
  socketClose(fd: number): Awaitable<number>;
  socketRecv(
    fd: number,
    cap: number,
  ): Awaitable<{ result: number; bytes?: Uint8Array }>;
  socketSend(fd: number, data: Uint8Array): Awaitable<number>;
  /**
   * One evaluation of a pollfd array. The worker-side `host_poll`
   * import drives its own retry/sleep loop and re-invokes this body
   * each round until it returns >0 or the timeout fires.
   */
  poll(
    nfds: number,
    fds: Uint8Array,
  ): Awaitable<{ result: number; bytes?: Uint8Array }>;
  getPid(): Awaitable<number>;
  socketSendUnix(fd: number, data: Uint8Array): Awaitable<number>;
  /**
   * AF_UNIX socketpair() for the pthread worker. Returns 0 on success
   * with two consecutive i32 fd numbers in `bytes`; -1 on error.
   */
  socketPair(
    family: number,
    sockType: number,
  ): Awaitable<{ result: number; bytes?: Uint8Array }>;
  /**
   * Nonblocking AF_UNIX recv for libzmq signaler / mailbox fds.
   * Returns >0 with bytes on data, -2 on EAGAIN, -1 on error,
   * -3 on wrong family.
   */
  socketRecvUnix(
    fd: number,
    cap: number,
    peek: number,
  ): Awaitable<{ result: number; bytes?: Uint8Array }>;
  setFdDescriptorFlags(fd: number, flags: number): Awaitable<number>;
  /**
   * Pthread spawn for nested `host_thread_spawn` calls from a pthread
   * worker. Returns the new tid; the spawn itself runs asynchronously
   * in the background.
   */
  threadSpawn(
    fnPtr: number,
    arg: number,
    callerTid?: number,
  ): Awaitable<number>;
  /**
   * Record the bind address for an AF_INET socket fd from a pthread
   * worker. Loopback only; rejects anything that isn't 127.0.0.1 /
   * localhost / 0.0.0.0.
   */
  socketBind(fd: number, host: Uint8Array, port: number): Awaitable<number>;
  /**
   * Start listening on a previously-bound AF_INET socket fd from a
   * pthread worker. May await the backend's listen() now that the
   * dispatcher is async + serialized.
   */
  socketListen(fd: number, backlog: number): Awaitable<number>;
  /**
   * Returns 1 for SOCK_DGRAM sockets, 0 for SOCK_STREAM, -1 for
   * non-socket fds. libzmq's tcp/inproc setup checks this on every
   * socket() return to decide which mailbox transport to wire up.
   */
  socketIsDgram(fd: number): Awaitable<number>;
}

/**
 * Minimal worker-shaped interface used by the dispatcher. Compatible
 * with `Worker` and with test doubles that only expose
 * `addEventListener("message", ...)`.
 */
export interface DispatcherTarget {
  addEventListener(
    type: "message",
    handler: (e: MessageEvent) => unknown,
  ): void;
}

export interface WorkerHostDispatcherContext {
  callerTid?: number;
  /**
   * Explicit per-process serializer. Normally omitted: the dispatcher
   * defaults to one serializer per `bodies` object (see
   * `serializerForBodies`), which is exactly the per-process scope —
   * `makeWorkerDispatcherBodies` returns one `bodies` per process and
   * every worker pthread of that process attaches with it. Pass this
   * only to override that default (e.g. a custom spawner).
   */
  serializer?: WorkerHostSerializer;
}

/**
 * One serializer per `bodies` object. `makeWorkerDispatcherBodies`
 * returns a fresh closure per process, so keying the lock off the
 * bodies identity gives "one lock per process, shared across all of
 * that process's spawned worker threads" (Task 10) without threading
 * the serializer through every spawn call. A `WeakMap` so a finished
 * process's bodies (and its serializer) are collectable.
 */
const serializersByBodies = new WeakMap<
  WorkerHostDispatcherBodies,
  WorkerHostSerializer
>();

function serializerForBodies(
  bodies: WorkerHostDispatcherBodies,
): WorkerHostSerializer {
  let s = serializersByBodies.get(bodies);
  if (!s) {
    s = new WorkerHostSerializer();
    serializersByBodies.set(bodies, s);
  }
  return s;
}

/**
 * Main-side dispatcher: attaches a `message` listener to the worker
 * that decodes a "host-call" request from the SAB, `await`s the
 * corresponding body, writes the response back, and `Atomics.notify`s
 * the worker.
 *
 * Bodies run inside a per-process `WorkerHostSerializer` (Task 10): the
 * handler stays async so a body may suspend mid-flight (e.g. libzmq's
 * I/O reactor waiting on a round-trip) without freezing main's event
 * loop, while the serializer keeps kernel-state mutations FIFO across
 * every worker pthread of the process. The handler returns the
 * serializer promise; real `Worker` ignores it, test doubles `await`
 * it.
 */
export function attachWorkerHostDispatcher(
  worker: DispatcherTarget,
  sab: SharedArrayBuffer,
  bodies: WorkerHostDispatcherBodies,
  context: WorkerHostDispatcherContext = {},
): void {
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);
  const payloadBytes = new Uint8Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_BYTES);
  const serializer = context.serializer ?? serializerForBodies(bodies);

  worker.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object" || msg.type !== "host-call") return;

    // The worker is parked in `Atomics.wait` from before it posted this
    // message until we notify, so its request SAB is stable across the
    // serializer queue wait and any in-body `await`.
    return serializer.run(async () => {
      const op = payload[PAYLOAD_OP_WORD] as WorkerHostOp;

      let result = -1;
      let outBytes: Uint8Array | undefined;
      try {
        switch (op) {
          case WorkerHostOp.ThreadYield:
            result = await bodies.threadYield(context.callerTid);
            break;
          case WorkerHostOp.ThreadExit:
            await bodies.threadExit(
              payload[PAYLOAD_ARGS_WORD + 0],
              context.callerTid,
            );
            result = 0;
            break;
          case WorkerHostOp.WriteFd: {
            const fd = payload[PAYLOAD_ARGS_WORD + 0];
            const len = payload[PAYLOAD_ARGS_WORD + 1];
            const byteStart = (PAYLOAD_ARGS_WORD + 2) * 4;
            const data = payloadBytes.subarray(byteStart, byteStart + len);
            result = await bodies.writeFd(fd, data);
            break;
          }
          case WorkerHostOp.ReadFd: {
            const fd = payload[PAYLOAD_ARGS_WORD + 0];
            const cap = payload[PAYLOAD_ARGS_WORD + 1];
            const r = await bodies.readFd(fd, cap);
            result = r.result;
            outBytes = r.bytes;
            break;
          }
          case WorkerHostOp.SocketOpen:
            result = await bodies.socketOpen(
              payload[PAYLOAD_ARGS_WORD + 0],
              payload[PAYLOAD_ARGS_WORD + 1],
              payload[PAYLOAD_ARGS_WORD + 2],
            );
            break;
          case WorkerHostOp.SocketClose:
            result = await bodies.socketClose(payload[PAYLOAD_ARGS_WORD + 0]);
            break;
          case WorkerHostOp.SocketRecv: {
            const fd = payload[PAYLOAD_ARGS_WORD + 0];
            const cap = payload[PAYLOAD_ARGS_WORD + 1];
            const r = await bodies.socketRecv(fd, cap);
            result = r.result;
            outBytes = r.bytes;
            break;
          }
          case WorkerHostOp.SocketSend: {
            const fd = payload[PAYLOAD_ARGS_WORD + 0];
            const len = payload[PAYLOAD_ARGS_WORD + 1];
            const byteStart = (PAYLOAD_ARGS_WORD + 2) * 4;
            const data = payloadBytes.subarray(byteStart, byteStart + len);
            result = await bodies.socketSend(fd, data);
            break;
          }
          case WorkerHostOp.Poll: {
            const nfds = payload[PAYLOAD_ARGS_WORD + 0];
            const byteStart = (PAYLOAD_ARGS_WORD + 1) * 4;
            const totalBytes = nfds * POLLFD_BYTES;
            const data = payloadBytes.slice(byteStart, byteStart + totalBytes);
            const r = await bodies.poll(nfds, data);
            result = r.result;
            outBytes = r.bytes;
            break;
          }
          case WorkerHostOp.GetPid:
            result = await bodies.getPid();
            break;
          case WorkerHostOp.SocketSendUnix: {
            const fd = payload[PAYLOAD_ARGS_WORD + 0];
            const len = payload[PAYLOAD_ARGS_WORD + 1];
            const byteStart = (PAYLOAD_ARGS_WORD + 2) * 4;
            const data = payloadBytes.subarray(byteStart, byteStart + len);
            result = await bodies.socketSendUnix(fd, data);
            break;
          }
          case WorkerHostOp.SocketPair: {
            const family = payload[PAYLOAD_ARGS_WORD + 0];
            const sockType = payload[PAYLOAD_ARGS_WORD + 1];
            const r = await bodies.socketPair(family, sockType);
            result = r.result;
            outBytes = r.bytes;
            break;
          }
          case WorkerHostOp.SocketRecvUnix: {
            const fd = payload[PAYLOAD_ARGS_WORD + 0];
            const cap = payload[PAYLOAD_ARGS_WORD + 1];
            const peek = payload[PAYLOAD_ARGS_WORD + 2];
            const r = await bodies.socketRecvUnix(fd, cap, peek);
            result = r.result;
            outBytes = r.bytes;
            break;
          }
          case WorkerHostOp.SetFdDescriptorFlags:
            result = await bodies.setFdDescriptorFlags(
              payload[PAYLOAD_ARGS_WORD + 0],
              payload[PAYLOAD_ARGS_WORD + 1],
            );
            break;
          case WorkerHostOp.ThreadSpawn:
            result = await bodies.threadSpawn(
              payload[PAYLOAD_ARGS_WORD + 0],
              payload[PAYLOAD_ARGS_WORD + 1],
              context.callerTid,
            );
            break;
          case WorkerHostOp.SocketBind: {
            const fd = payload[PAYLOAD_ARGS_WORD + 0];
            const hostLen = payload[PAYLOAD_ARGS_WORD + 1];
            const port = payload[PAYLOAD_ARGS_WORD + 2];
            const byteStart = (PAYLOAD_ARGS_WORD + 3) * 4;
            const host = payloadBytes.slice(byteStart, byteStart + hostLen);
            result = await bodies.socketBind(fd, host, port);
            break;
          }
          case WorkerHostOp.SocketListen:
            result = await bodies.socketListen(
              payload[PAYLOAD_ARGS_WORD + 0],
              payload[PAYLOAD_ARGS_WORD + 1],
            );
            break;
          case WorkerHostOp.SocketIsDgram:
            result = await bodies.socketIsDgram(
              payload[PAYLOAD_ARGS_WORD + 0],
            );
            break;
          default:
            result = -1;
        }
      } catch {
        Atomics.store(header, RESULT_OFFSET, -1);
        Atomics.store(header, STATUS_OFFSET, STATUS_ERROR);
        Atomics.notify(header, STATUS_OFFSET, 1);
        return;
      }

      if (outBytes && outBytes.byteLength > 0) {
        const byteStart = (PAYLOAD_ARGS_WORD + 1) * 4;
        payloadBytes.set(outBytes, byteStart);
      }
      Atomics.store(header, RESULT_OFFSET, result | 0);
      Atomics.store(header, STATUS_OFFSET, STATUS_RESPONSE_READY);
      Atomics.notify(header, STATUS_OFFSET, 1);
    });
  });
}
