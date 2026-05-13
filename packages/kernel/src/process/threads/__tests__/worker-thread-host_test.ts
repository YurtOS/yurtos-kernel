import { assertEquals } from "@std/assert";

Deno.test("worker-thread-host: instantiates module and calls fnPtr", async () => {
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
  const result = await new Promise<number>((resolve) => {
    worker.onmessage = (event) => resolve(event.data.retval);
    worker.postMessage({
      type: "start",
      tid: 2,
      fnPtr: 0,
      arg: 41,
      module,
      memory,
    });
  });

  assertEquals(result, 42);
  worker.terminate();
});

Deno.test("worker-thread-host: host_thread_self returns worker tid", async () => {
  const wasmBytes = await Deno.readFile(
    new URL("./_fixtures/thread-self.wasm", import.meta.url),
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
  const result = await new Promise<number>((resolve) => {
    worker.onmessage = (event) => resolve(event.data.retval);
    worker.postMessage({
      type: "start",
      tid: 9,
      fnPtr: 0,
      arg: 0,
      module,
      memory,
    });
  });

  assertEquals(result, 9);
  worker.terminate();
});
