import { assertEquals } from "@std/assert";

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
