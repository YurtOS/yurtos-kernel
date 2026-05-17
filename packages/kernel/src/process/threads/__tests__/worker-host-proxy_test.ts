import { assertEquals } from "@std/assert";
import {
  attachWorkerHostDispatcher,
  createWorkerYurtImports,
  type DispatcherTarget,
  REQUEST_SAB_BYTES,
  type WorkerHostDispatcherBodies,
  WorkerHostOp,
} from "../worker-host-proxy.ts";
import { WorkerHostSerializer } from "../worker-host-serializer.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Header layout: word 0 = status, word 1 = result. Payload: word 0 =
// op, word 1 = argc, words 2.. = i32 args, then byte payload after.
// These tests exercise the codec by encoding a request directly into
// the SAB and invoking the dispatcher's message handler manually.

const HEADER_WORDS = 2;
const PAYLOAD_OFFSET_BYTES = HEADER_WORDS * 4;
const PAYLOAD_WORDS = 1024;
const PAYLOAD_BYTES = 4096;
const OP_WORD = 0;
const ARGC_WORD = 1;
const ARGS_WORD = 2;

const STATUS_REQUEST_READY = 1;
const STATUS_RESPONSE_READY = 2;

function noopBodies(): WorkerHostDispatcherBodies {
  return {
    threadYield: () => 0,
    threadExit: () => {},
    writeFd: () => 0,
    readFd: () => ({ result: 0 }),
    socketOpen: () => 0,
    socketClose: () => 0,
    socketRecv: () => ({ result: 0 }),
    socketSend: () => 0,
    poll: () => ({ result: 0 }),
    getPid: () => 1,
    socketSendUnix: () => 0,
    socketPair: () => ({ result: 0 }),
    socketRecvUnix: () => ({ result: 0 }),
    setFdDescriptorFlags: () => 0,
    threadSpawn: () => 2,
    socketBind: () => 0,
    socketListen: () => 0,
    socketIsDgram: () => 0,
  };
}

// The dispatcher handler is async (Task 10): `invoke()` returns the
// handler's processing promise so tests `await` it before asserting on
// the SAB. Real `Worker` ignores the return value.
function captureHandler(): {
  target: DispatcherTarget;
  invoke: () => unknown;
} {
  let handler: ((e: MessageEvent) => unknown) | null = null;
  const target: DispatcherTarget = {
    addEventListener: (_type, h) => {
      handler = h as (e: MessageEvent) => unknown;
    },
  };
  return {
    target,
    invoke: () => {
      if (!handler) throw new Error("dispatcher didn't register a handler");
      return handler(
        new MessageEvent("message", { data: { type: "host-call" } }),
      );
    },
  };
}

function writeSockaddrIn(
  memory: WebAssembly.Memory,
  ptr: number,
  host: [number, number, number, number],
  port: number,
  family = 2,
): number {
  const bytes = new Uint8Array(memory.buffer, ptr, 16);
  bytes.fill(0);
  const view = new DataView(memory.buffer, ptr, 16);
  view.setUint16(0, family, true);
  view.setUint16(2, port, false);
  bytes.set(host, 4);
  return 16;
}

Deno.test("worker-host-proxy: WriteFd request decoded; bytes match", async () => {
  const sab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);
  const payloadBytes = new Uint8Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_BYTES);

  let wroteFd = -1;
  let wroteData = "";
  const bodies: WorkerHostDispatcherBodies = {
    ...noopBodies(),
    writeFd: (fd, data) => {
      wroteFd = fd;
      wroteData = new TextDecoder().decode(data);
      return data.byteLength;
    },
  };

  const { target, invoke } = captureHandler();
  attachWorkerHostDispatcher(target, sab, bodies);

  // Encode WriteFd(fd=1, len=5, "hello")
  payload[OP_WORD] = WorkerHostOp.WriteFd;
  payload[ARGC_WORD] = 2;
  payload[ARGS_WORD + 0] = 1; // fd
  payload[ARGS_WORD + 1] = 5; // len
  payloadBytes.set(new TextEncoder().encode("hello"), (ARGS_WORD + 2) * 4);
  Atomics.store(header, 0, STATUS_REQUEST_READY);

  await invoke();

  assertEquals(Atomics.load(header, 0), STATUS_RESPONSE_READY);
  assertEquals(Atomics.load(header, 1), 5);
  assertEquals(wroteFd, 1);
  assertEquals(wroteData, "hello");
});

Deno.test("worker-host-proxy: ThreadSpawn receives dispatcher caller tid", async () => {
  const sab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);

  let seenTid = -1;
  const bodies: WorkerHostDispatcherBodies = {
    ...noopBodies(),
    threadSpawn: (_fnPtr, _arg, callerTid) => {
      seenTid = callerTid ?? -1;
      return 22;
    },
  };

  const { target, invoke } = captureHandler();
  attachWorkerHostDispatcher(target, sab, bodies, { callerTid: 9 });

  payload[OP_WORD] = WorkerHostOp.ThreadSpawn;
  payload[ARGC_WORD] = 2;
  payload[ARGS_WORD + 0] = 123;
  payload[ARGS_WORD + 1] = 456;
  Atomics.store(header, 0, STATUS_REQUEST_READY);

  await invoke();

  assertEquals(Atomics.load(header, 0), STATUS_RESPONSE_READY);
  assertEquals(Atomics.load(header, 1), 22);
  assertEquals(seenTid, 9);
});

Deno.test("worker-host-proxy: ReadFd writes returned bytes back into payload", async () => {
  const sab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);
  const payloadBytes = new Uint8Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_BYTES);

  const bodies: WorkerHostDispatcherBodies = {
    ...noopBodies(),
    readFd: (_fd, _cap) => ({
      result: 3,
      bytes: new TextEncoder().encode("abc"),
    }),
  };

  const { target, invoke } = captureHandler();
  attachWorkerHostDispatcher(target, sab, bodies);

  payload[OP_WORD] = WorkerHostOp.ReadFd;
  payload[ARGC_WORD] = 2;
  payload[ARGS_WORD + 0] = 5; // fd
  payload[ARGS_WORD + 1] = 16; // cap
  Atomics.store(header, 0, STATUS_REQUEST_READY);

  await invoke();

  assertEquals(Atomics.load(header, 0), STATUS_RESPONSE_READY);
  assertEquals(Atomics.load(header, 1), 3);
  const byteStart = (ARGS_WORD + 1) * 4;
  assertEquals(
    new TextDecoder().decode(payloadBytes.subarray(byteStart, byteStart + 3)),
    "abc",
  );
});

Deno.test("worker-host-proxy: SocketOpen passes three i32 args through", async () => {
  const sab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);

  let seenDomain = -1, seenType = -1, seenProtocol = -1;
  const bodies: WorkerHostDispatcherBodies = {
    ...noopBodies(),
    socketOpen: (domain, type, protocol) => {
      seenDomain = domain;
      seenType = type;
      seenProtocol = protocol;
      return 42;
    },
  };

  const { target, invoke } = captureHandler();
  attachWorkerHostDispatcher(target, sab, bodies);

  payload[OP_WORD] = WorkerHostOp.SocketOpen;
  payload[ARGC_WORD] = 3;
  payload[ARGS_WORD + 0] = 2; // AF_INET
  payload[ARGS_WORD + 1] = 1; // SOCK_STREAM
  payload[ARGS_WORD + 2] = 6; // IPPROTO_TCP
  Atomics.store(header, 0, STATUS_REQUEST_READY);

  await invoke();

  assertEquals(Atomics.load(header, 1), 42);
  assertEquals(seenDomain, 2);
  assertEquals(seenType, 1);
  assertEquals(seenProtocol, 6);
});

Deno.test("worker-host-proxy: SocketSend dispatches with payload bytes", async () => {
  const sab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);
  const payloadBytes = new Uint8Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_BYTES);

  let seenFd = -1;
  let seenData = new Uint8Array();
  const bodies: WorkerHostDispatcherBodies = {
    ...noopBodies(),
    socketSend: (fd, data) => {
      seenFd = fd;
      seenData = new Uint8Array(data); // copy out before payload reused
      return data.byteLength;
    },
  };

  const { target, invoke } = captureHandler();
  attachWorkerHostDispatcher(target, sab, bodies);

  payload[OP_WORD] = WorkerHostOp.SocketSend;
  payload[ARGC_WORD] = 2;
  payload[ARGS_WORD + 0] = 9; // fd
  payload[ARGS_WORD + 1] = 4; // len
  payloadBytes.set([1, 2, 3, 4], (ARGS_WORD + 2) * 4);
  Atomics.store(header, 0, STATUS_REQUEST_READY);

  await invoke();

  assertEquals(Atomics.load(header, 1), 4);
  assertEquals(seenFd, 9);
  assertEquals(Array.from(seenData), [1, 2, 3, 4]);
});

// Rebase note (#119 onto post-`0939cf1` main): the host-side
// `host_socket_bind` flow on main is sync — `call()` writes the
// request, fires `postHostCall`, then `Atomics.wait`s for the
// response. Under Task 10's async dispatcher (this branch),
// `attachWorkerHostDispatcher` defers the body run to a microtask via
// `serializer.run(async () => …)`, so the SAB is not mutated before
// `Atomics.wait` runs and the wait blocks on the main thread (Deno
// disallows that by default). The sockaddr_in decode test is rewritten
// to drive the dispatcher directly with the await pattern used by the
// rest of this file's tests — the wasm-import-shim integration is now
// covered by `malformed SocketBind sockaddr…` (which short-circuits at
// the guest-side decode and never hits dispatch).
Deno.test("worker-host-proxy: SocketBind dispatch receives decoded host + port", async () => {
  const sab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);
  const payloadBytes = new Uint8Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_BYTES);

  let seenFd = -1;
  let seenHost = "";
  let seenPort = -1;
  const bodies: WorkerHostDispatcherBodies = {
    ...noopBodies(),
    socketBind: (fd, host, port) => {
      seenFd = fd;
      seenHost = new TextDecoder().decode(host);
      seenPort = port;
      return 0;
    },
  };

  const { target, invoke } = captureHandler();
  attachWorkerHostDispatcher(target, sab, bodies);

  // Encode SocketBind(fd=9, hostLen=9, port=18081) with "127.0.0.1"
  // immediately after the args slots.
  const host = new TextEncoder().encode("127.0.0.1");
  payload[OP_WORD] = WorkerHostOp.SocketBind;
  payload[ARGC_WORD] = 3;
  payload[ARGS_WORD + 0] = 9;
  payload[ARGS_WORD + 1] = host.byteLength;
  payload[ARGS_WORD + 2] = 18081;
  payloadBytes.set(host, (ARGS_WORD + 3) * 4);
  Atomics.store(header, 0, STATUS_REQUEST_READY);

  await invoke();

  assertEquals(Atomics.load(header, 0), STATUS_RESPONSE_READY);
  assertEquals(Atomics.load(header, 1), 0);
  assertEquals(seenFd, 9);
  assertEquals(seenHost, "127.0.0.1");
  assertEquals(seenPort, 18081);
});

Deno.test("worker-host-proxy: malformed SocketBind sockaddr returns EINVAL before dispatch", () => {
  // Pure guest-side validation: host_socket_bind early-returns -22
  // when decodeSockaddrIn fails, never calling postHostCall. Safe to
  // stay sync under the async dispatcher — no Atomics.wait is reached.
  const memory = new WebAssembly.Memory({ initial: 1 });
  const cases = [
    { ptr: 0, len: 16 },
    { ptr: 16, len: 8 },
    { ptr: memory.buffer.byteLength - 8, len: 16 },
  ];
  writeSockaddrIn(memory, 32, [0, 0, 0, 0], 0, 10);
  cases.push({ ptr: 32, len: 16 });

  for (const { ptr, len } of cases) {
    const imports = createWorkerYurtImports(2, memory, {
      requestSab: new SharedArrayBuffer(REQUEST_SAB_BYTES),
      postHostCall: () => {
        throw new Error("malformed sockaddr must not dispatch");
      },
    });

    assertEquals(
      (imports.host_socket_bind as (...args: number[]) => number)(9, ptr, len),
      -22,
    );
  }
});

Deno.test("worker-host-proxy: body throw produces STATUS_ERROR + result=-1", async () => {
  const sab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);

  const bodies: WorkerHostDispatcherBodies = {
    ...noopBodies(),
    writeFd: () => {
      throw new Error("simulated failure");
    },
  };

  const { target, invoke } = captureHandler();
  attachWorkerHostDispatcher(target, sab, bodies);

  payload[OP_WORD] = WorkerHostOp.WriteFd;
  payload[ARGC_WORD] = 2;
  payload[ARGS_WORD + 0] = 1;
  payload[ARGS_WORD + 1] = 0;
  Atomics.store(header, 0, STATUS_REQUEST_READY);

  await invoke();

  assertEquals(Atomics.load(header, 0), -1); // STATUS_ERROR
  assertEquals(Atomics.load(header, 1), -1);
});

Deno.test(
  "worker-host-proxy: a throw in response write-back still notifies " +
    "(no lost-notify pthread deadlock — review item 4)",
  async () => {
    // A buggy body returning oversized bytes makes the response
    // `payloadBytes.set(...)` throw. That throw is outside the body
    // call, so if the dispatcher only guards the body it never
    // notifies and the parked pthread deadlocks forever. The whole
    // critical section must be guarded: any throw ⇒ STATUS_ERROR +
    // notify.
    const sab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
    const header = new Int32Array(sab, 0, HEADER_WORDS);
    const payload = new Int32Array(sab, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);

    const bodies: WorkerHostDispatcherBodies = {
      ...noopBodies(),
      // Far larger than the 4096-byte payload region → set() RangeError.
      readFd: () => ({ result: 5000, bytes: new Uint8Array(5000) }),
    };

    const { target, invoke } = captureHandler();
    attachWorkerHostDispatcher(target, sab, bodies);

    payload[OP_WORD] = WorkerHostOp.ReadFd;
    payload[ARGC_WORD] = 2;
    payload[ARGS_WORD + 0] = 5;
    payload[ARGS_WORD + 1] = 5000;
    Atomics.store(header, 0, STATUS_REQUEST_READY);

    await Promise.resolve(invoke()).catch(() => {});

    // Must NOT still be REQUEST_READY (1) — the pthread would hang.
    assertEquals(Atomics.load(header, 0), -1); // STATUS_ERROR
    assertEquals(Atomics.load(header, 1), -1);
  },
);

Deno.test("worker-host-proxy: ignores non-host-call messages", () => {
  const sab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
  const header = new Int32Array(sab, 0, HEADER_WORDS);

  let called = 0;
  const bodies: WorkerHostDispatcherBodies = {
    ...noopBodies(),
    threadYield: () => {
      called++;
      return 0;
    },
  };

  let handler: ((e: MessageEvent) => void) | null = null;
  const target: DispatcherTarget = {
    addEventListener: (_type, h) => {
      handler = h;
    },
  };
  attachWorkerHostDispatcher(target, sab, bodies);

  // Send a message of an unrelated type
  handler!(new MessageEvent("message", { data: { type: "other" } }));
  // status remains untouched
  assertEquals(Atomics.load(header, 0), 0);
  assertEquals(called, 0);
});

Deno.test({
  name: "worker-host-proxy: real Worker round-trips host_write_fd via SAB",
  permissions: { read: true, net: true },
  fn: async () => {
    // End-to-end smoke: a Worker spawned with the worker-thread-host
    // module + a no-op WASM (the same echo-thread fixture used by
    // worker-thread-host_test) does NOT actually call host_write_fd
    // because the fixture's function body just returns arg+1. But the
    // start handshake exercises the requestSab plumbing and verifies
    // the dispatcher is wired without exploding. Real host_write_fd
    // verification happens in Task 10 once kernel-imports bodies are
    // wired in.
    const wasmBytes = await Deno.readFile(
      new URL("./_fixtures/echo-thread.wasm", import.meta.url),
    );
    const module = await WebAssembly.compile(wasmBytes);
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const requestSab = new SharedArrayBuffer(REQUEST_SAB_BYTES);

    const worker = new Worker(
      new URL("../worker-thread-host.ts", import.meta.url).href,
      { type: "module" },
    );

    let dispatcherSawHostCall = 0;
    attachWorkerHostDispatcher(worker, requestSab, {
      ...noopBodies(),
      writeFd: (_fd, data) => {
        dispatcherSawHostCall++;
        return data.byteLength;
      },
    });

    const result = await new Promise<{ tid: number; retval: number }>(
      (resolve) => {
        worker.onmessage = (e: MessageEvent) => {
          if (e.data?.type === "done") resolve(e.data);
        };
        worker.postMessage({
          type: "start",
          tid: 2,
          fnPtr: 0,
          arg: 41,
          module,
          memory,
          requestSab,
        });
      },
    );

    assertEquals(result.tid, 2);
    assertEquals(result.retval, 42);
    // Fixture doesn't call host_write_fd, so the dispatcher's writeFd
    // body should never have fired. This is the canary: the SAB +
    // dispatcher hookup didn't perturb the Task 4 behavior.
    assertEquals(dispatcherSawHostCall, 0);
    worker.terminate();
  },
});

Deno.test(
  "worker-host-proxy: dispatcher awaits a body and serializes peers " +
    "without freezing the event loop (Task 10 reentrance invariant)",
  async () => {
    // Reproduces the post-bind ZMQ reactor stall in miniature: worker A
    // makes a host-call whose body must `await` mid-flight (the libzmq
    // I/O reactor waiting on a round-trip). Worker B — a peer pthread of
    // the same process, sharing one serializer — posts its own host-call
    // meanwhile. The fix must (a) NOT run B's body while A is suspended
    // (kernel-state exclusivity), (b) still deliver A's awaited result
    // and then drain B (liveness — the sync dispatcher deadlocked here),
    // and (c) keep the event loop live so A's await can be satisfied.
    const sabA = new SharedArrayBuffer(REQUEST_SAB_BYTES);
    const sabB = new SharedArrayBuffer(REQUEST_SAB_BYTES);
    const headerA = new Int32Array(sabA, 0, HEADER_WORDS);
    const headerB = new Int32Array(sabB, 0, HEADER_WORDS);
    const payloadA = new Int32Array(sabA, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);
    const payloadB = new Int32Array(sabB, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);

    const gateA = deferred<void>();
    const order: string[] = [];

    const bodies: WorkerHostDispatcherBodies = {
      ...noopBodies(),
      // A's op. Suspends until the gate opens, then yields 7.
      writeFd: async (_fd, _data) => {
        order.push("A:start");
        await gateA.promise;
        order.push("A:end");
        return 7;
      },
      // B's op. Synchronous; must not run until A's body has finished.
      socketOpen: () => {
        order.push("B:run");
        return 42;
      },
    };

    const serializer = new WorkerHostSerializer();
    const a = captureHandler();
    const b = captureHandler();
    attachWorkerHostDispatcher(a.target, sabA, bodies, { serializer });
    attachWorkerHostDispatcher(b.target, sabB, bodies, { serializer });

    // Worker A: WriteFd(fd=1, len=0)
    payloadA[OP_WORD] = WorkerHostOp.WriteFd;
    payloadA[ARGC_WORD] = 2;
    payloadA[ARGS_WORD + 0] = 1;
    payloadA[ARGS_WORD + 1] = 0;
    Atomics.store(headerA, 0, STATUS_REQUEST_READY);

    // Worker B: SocketOpen(1, 6, 0)
    payloadB[OP_WORD] = WorkerHostOp.SocketOpen;
    payloadB[ARGC_WORD] = 3;
    payloadB[ARGS_WORD + 0] = 1;
    payloadB[ARGS_WORD + 1] = 6;
    payloadB[ARGS_WORD + 2] = 0;
    Atomics.store(headerB, 0, STATUS_REQUEST_READY);

    const pA = a.invoke();
    const pB = b.invoke();

    // While A is parked on the gate, a freshly scheduled macrotask must
    // still run — proves the dispatcher didn't freeze the event loop.
    let loopTicked = false;
    await new Promise<void>((r) =>
      setTimeout(() => {
        loopTicked = true;
        r();
      }, 0)
    );

    assertEquals(loopTicked, true);
    // B must NOT have run; A's response must NOT be published yet.
    assertEquals(order, ["A:start"]);
    assertEquals(Atomics.load(headerA, 0), STATUS_REQUEST_READY);

    gateA.resolve();
    await pA;
    await pB;

    assertEquals(order, ["A:start", "A:end", "B:run"]);
    assertEquals(Atomics.load(headerA, 0), STATUS_RESPONSE_READY);
    assertEquals(Atomics.load(headerA, 1), 7);
    assertEquals(Atomics.load(headerB, 0), STATUS_RESPONSE_READY);
    assertEquals(Atomics.load(headerB, 1), 42);
  },
);

Deno.test(
  "worker-host-proxy: dispatchers sharing one bodies object are " +
    "serialized per-process without an explicit serializer (Task 10 pt3)",
  async () => {
    // makeWorkerDispatcherBodies returns one bodies object per process;
    // every worker pthread of that process attaches its own dispatcher
    // with the SAME bodies object. Cross-worker kernel-state mutations
    // must stay FIFO even when no serializer is threaded through the
    // context — the per-process lock is keyed off the bodies identity.
    const sabA = new SharedArrayBuffer(REQUEST_SAB_BYTES);
    const sabB = new SharedArrayBuffer(REQUEST_SAB_BYTES);
    const headerA = new Int32Array(sabA, 0, HEADER_WORDS);
    const headerB = new Int32Array(sabB, 0, HEADER_WORDS);
    const payloadA = new Int32Array(sabA, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);
    const payloadB = new Int32Array(sabB, PAYLOAD_OFFSET_BYTES, PAYLOAD_WORDS);

    const gateA = deferred<void>();
    const order: string[] = [];
    const bodies: WorkerHostDispatcherBodies = {
      ...noopBodies(),
      writeFd: async () => {
        order.push("A:start");
        await gateA.promise;
        order.push("A:end");
        return 0;
      },
      socketOpen: () => {
        order.push("B:run");
        return 1;
      },
    };

    const a = captureHandler();
    const b = captureHandler();
    // No `serializer` in context — the per-process default must still
    // serialize because both share `bodies`.
    attachWorkerHostDispatcher(a.target, sabA, bodies);
    attachWorkerHostDispatcher(b.target, sabB, bodies);

    payloadA[OP_WORD] = WorkerHostOp.WriteFd;
    payloadA[ARGC_WORD] = 2;
    payloadA[ARGS_WORD + 0] = 1;
    payloadA[ARGS_WORD + 1] = 0;
    Atomics.store(headerA, 0, STATUS_REQUEST_READY);
    payloadB[OP_WORD] = WorkerHostOp.SocketOpen;
    payloadB[ARGC_WORD] = 3;
    Atomics.store(headerB, 0, STATUS_REQUEST_READY);

    const pA = a.invoke();
    const pB = b.invoke();
    await new Promise<void>((r) => setTimeout(r, 0));

    assertEquals(order, ["A:start"]); // B held behind A

    gateA.resolve();
    await pA;
    await pB;
    assertEquals(order, ["A:start", "A:end", "B:run"]);
  },
);
