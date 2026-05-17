import { assertEquals, assertInstanceOf } from "@std/assert";
import {
  createWorkerYurtImports,
  REQUEST_SAB_BYTES,
  WorkerThreadExit,
} from "../worker-host-proxy.ts";

Deno.test({
  name: "worker-thread-host: instantiates module + calls fnPtr + posts retval",
  permissions: { read: true, net: true },
  fn: async () => {
    const wasmBytes = await Deno.readFile(
      new URL("./_fixtures/echo-thread.wasm", import.meta.url),
    );
    const module = await WebAssembly.compile(wasmBytes);
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });

    const worker = new Worker(
      new URL("../worker-thread-host.ts", import.meta.url).href,
      { type: "module" },
    );
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
        });
      },
    );
    assertEquals(result.tid, 2);
    assertEquals(result.retval, 42);
    worker.terminate();
  },
});

Deno.test({
  name: "worker-thread-host: invalid fnPtr returns -1",
  permissions: { read: true, net: true },
  fn: async () => {
    const wasmBytes = await Deno.readFile(
      new URL("./_fixtures/echo-thread.wasm", import.meta.url),
    );
    const module = await WebAssembly.compile(wasmBytes);
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });

    const worker = new Worker(
      new URL("../worker-thread-host.ts", import.meta.url).href,
      { type: "module" },
    );
    const result = await new Promise<{ retval: number }>((resolve) => {
      worker.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "done") resolve(e.data);
      };
      worker.postMessage({
        type: "start",
        tid: 3,
        fnPtr: 9999,
        arg: 0,
        module,
        memory,
      });
    });
    assertEquals(result.retval, -1);
    worker.terminate();
  },
});

Deno.test({
  name: "worker-thread-host: host_thread_self returns worker tid",
  permissions: { read: true, net: true },
  fn: async () => {
    const wasmBytes = await Deno.readFile(
      new URL("./_fixtures/thread-self.wasm", import.meta.url),
    );
    const module = await WebAssembly.compile(wasmBytes);
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const requestSab = new SharedArrayBuffer(8 + 4096);

    const worker = new Worker(
      new URL("../worker-thread-host.ts", import.meta.url).href,
      { type: "module" },
    );
    const result = await new Promise<{ retval: number }>((resolve) => {
      worker.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "done") resolve(e.data);
      };
      worker.postMessage({
        type: "start",
        tid: 9,
        fnPtr: 0,
        arg: 0,
        module,
        memory,
        requestSab,
      });
    });

    assertEquals(result.retval, 9);
    worker.terminate();
  },
});

Deno.test({
  name: "worker-thread-host: mutex imports use shared memory cells",
  permissions: { read: true, net: true },
  fn: async () => {
    const wasmBytes = await Deno.readFile(
      new URL("./_fixtures/thread-mutex.wasm", import.meta.url),
    );
    const module = await WebAssembly.compile(wasmBytes);
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const requestSab = new SharedArrayBuffer(8 + 4096);

    const worker = new Worker(
      new URL("../worker-thread-host.ts", import.meta.url).href,
      { type: "module" },
    );
    const result = await new Promise<{ retval: number }>((resolve) => {
      worker.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "done") resolve(e.data);
      };
      worker.postMessage({
        type: "start",
        tid: 6,
        fnPtr: 0,
        arg: 128,
        module,
        memory,
        requestSab,
      });
    });

    assertEquals(result.retval, 6);
    assertEquals(Atomics.load(new Int32Array(memory.buffer, 128, 1), 0), 0);
    worker.terminate();
  },
});

Deno.test({
  name: "worker-host-proxy: host_thread_exit throws WorkerThreadExit sentinel",
  fn: () => {
    // Unit test for the host_thread_exit path's sentinel. The canary
    // exercises this end-to-end (pthread_exit worker subcase), but
    // worker-side wasm trap propagation is engine-specific. Test the
    // JS-level contract directly:
    //
    //   1. createWorkerYurtImports exposes host_thread_exit
    //   2. Calling it throws an instance of WorkerThreadExit
    //   3. The thrown error carries the retval
    //
    // worker-thread-host.ts:122-128 catches this exception by
    // `e instanceof WorkerThreadExit` and propagates `e.retval` back
    // through the done message. A generic Error would have hit the
    // else branch and produced retval=-1, masking real exit codes.
    //
    // host_thread_exit FIRST round-trips through the dispatcher (so
    // main can mark the thread as exited), then throws. The fake
    // postHostCall below writes STATUS_RESPONSE_READY directly so the
    // worker's Atomics.wait returns immediately and we reach the throw.
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const requestSab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
    const header = new Int32Array(requestSab, 0, 2);
    const imports = createWorkerYurtImports(7, memory, {
      requestSab,
      postHostCall: () => {
        // Simulate main's dispatcher: ack the request synchronously.
        Atomics.store(header, 1, 0); // result
        Atomics.store(header, 0, 2); // STATUS_RESPONSE_READY
        Atomics.notify(header, 0, 1);
      },
    });
    const hostThreadExit = imports.host_thread_exit as (n: number) => never;

    try {
      hostThreadExit(42);
      throw new Error("host_thread_exit returned instead of throwing");
    } catch (e) {
      assertInstanceOf(e, WorkerThreadExit);
      assertEquals(e.retval, 42);
    }
  },
});

Deno.test(
  "worker-host-proxy: host_socket_bind decodes sockaddr_in to host string + port",
  () => {
    // Regression: yurt-libc calls host_socket_bind(fd, addrPtr, addrLen)
    // with a raw sockaddr_in. An earlier worker-side stub interpreted the
    // sockaddr bytes as a host string and lost the port, which broke
    // libzmq's ROUTER bind on the heartbeat pthread (EAFNOSUPPORT).
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const requestSab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
    const header = new Int32Array(requestSab, 0, 2);
    const payload = new Int32Array(requestSab, 8, 1024);
    const payloadBytes = new Uint8Array(requestSab, 8, 4096);
    const ARGS_WORD = 2;

    // Write sockaddr_in into wasm memory at offset 256:
    //   family=2 (AF_INET, LE u16), port=49213 (BE u16),
    //   addr=127.0.0.1, 8 bytes pad.
    const ADDR_PTR = 256;
    const mem = new Uint8Array(memory.buffer);
    const addrView = new DataView(memory.buffer, ADDR_PTR, 16);
    addrView.setUint16(0, 2, true);
    addrView.setUint16(2, 49213, false);
    mem[ADDR_PTR + 4] = 127;
    mem[ADDR_PTR + 5] = 0;
    mem[ADDR_PTR + 6] = 0;
    mem[ADDR_PTR + 7] = 1;

    const imports = createWorkerYurtImports(7, memory, {
      requestSab,
      postHostCall: () => {
        // Simulate main acknowledging the call with success.
        Atomics.store(header, 1, 0);
        Atomics.store(header, 0, 2);
        Atomics.notify(header, 0, 1);
      },
    });
    const bind = imports.host_socket_bind as (
      fd: number,
      addrPtr: number,
      addrLen: number,
    ) => number;
    const rc = bind(5, ADDR_PTR, 16);
    assertEquals(rc, 0);

    // The proxy should have written {fd=5, hostLen=9, port=49213}
    // followed by the bytes "127.0.0.1" into the payload — not the raw
    // sockaddr_in.
    assertEquals(payload[ARGS_WORD + 0], 5);
    assertEquals(payload[ARGS_WORD + 1], 9);
    assertEquals(payload[ARGS_WORD + 2], 49213);
    const hostStart = (ARGS_WORD + 3) * 4;
    const hostStr = new TextDecoder().decode(
      payloadBytes.subarray(hostStart, hostStart + 9),
    );
    assertEquals(hostStr, "127.0.0.1");
  },
);

Deno.test(
  "worker-host-proxy: host_socket_bind rejects non-AF_INET family",
  () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    const requestSab = new SharedArrayBuffer(REQUEST_SAB_BYTES);
    const imports = createWorkerYurtImports(7, memory, {
      requestSab,
      postHostCall: () => {
        // Should never be called — proxy must reject before dispatching.
        throw new Error("postHostCall should not run for bad family");
      },
    });
    const ADDR_PTR = 256;
    new DataView(memory.buffer, ADDR_PTR, 16).setUint16(0, 10, true); // AF_INET6
    const bind = imports.host_socket_bind as (
      fd: number,
      addrPtr: number,
      addrLen: number,
    ) => number;
    assertEquals(bind(5, ADDR_PTR, 16), -97); // -EAFNOSUPPORT
  },
);
