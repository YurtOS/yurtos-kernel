import { assertEquals } from "@std/assert";
import {
  attachWorkerHostDispatcher,
  type DispatcherTarget,
  REQUEST_SAB_BYTES,
  type WorkerHostDispatcherBodies,
  WorkerHostOp,
} from "../worker-host-proxy.ts";

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
  };
}

function captureHandler(): {
  target: DispatcherTarget;
  invoke: () => void;
} {
  let handler: ((e: MessageEvent) => void) | null = null;
  const target: DispatcherTarget = {
    addEventListener: (_type, h) => {
      handler = h;
    },
  };
  return {
    target,
    invoke: () => {
      if (!handler) throw new Error("dispatcher didn't register a handler");
      handler(new MessageEvent("message", { data: { type: "host-call" } }));
    },
  };
}

Deno.test("worker-host-proxy: WriteFd request decoded; bytes match", () => {
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

  invoke();

  assertEquals(Atomics.load(header, 0), STATUS_RESPONSE_READY);
  assertEquals(Atomics.load(header, 1), 5);
  assertEquals(wroteFd, 1);
  assertEquals(wroteData, "hello");
});

Deno.test("worker-host-proxy: ReadFd writes returned bytes back into payload", () => {
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

  invoke();

  assertEquals(Atomics.load(header, 0), STATUS_RESPONSE_READY);
  assertEquals(Atomics.load(header, 1), 3);
  const byteStart = (ARGS_WORD + 1) * 4;
  assertEquals(
    new TextDecoder().decode(payloadBytes.subarray(byteStart, byteStart + 3)),
    "abc",
  );
});

Deno.test("worker-host-proxy: SocketOpen passes three i32 args through", () => {
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

  invoke();

  assertEquals(Atomics.load(header, 1), 42);
  assertEquals(seenDomain, 2);
  assertEquals(seenType, 1);
  assertEquals(seenProtocol, 6);
});

Deno.test("worker-host-proxy: SocketSend dispatches with payload bytes", () => {
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

  invoke();

  assertEquals(Atomics.load(header, 1), 4);
  assertEquals(seenFd, 9);
  assertEquals(Array.from(seenData), [1, 2, 3, 4]);
});

Deno.test("worker-host-proxy: body throw produces STATUS_ERROR + result=-1", () => {
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

  invoke();

  assertEquals(Atomics.load(header, 0), -1); // STATUS_ERROR
  assertEquals(Atomics.load(header, 1), -1);
});

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
