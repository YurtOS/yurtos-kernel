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
