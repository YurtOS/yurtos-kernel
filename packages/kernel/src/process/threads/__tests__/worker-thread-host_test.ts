import { assertEquals } from "@std/assert";
import { SabCondvar } from "../sab-primitives.ts";

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

Deno.test("worker-thread-host: mutex imports use shared memory cells", async () => {
  const wasmBytes = await Deno.readFile(
    new URL("./_fixtures/thread-mutex.wasm", import.meta.url),
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
      tid: 6,
      fnPtr: 0,
      arg: 128,
      module,
      memory,
    });
  });

  assertEquals(result, 6);
  assertEquals(Atomics.load(new Int32Array(memory.buffer, 128, 1), 0), 0);
  worker.terminate();
});

Deno.test("worker-thread-host: condvar wait uses shared memory cells", async () => {
  const wasmBytes = await Deno.readFile(
    new URL("./_fixtures/thread-condvar.wasm", import.meta.url),
  );
  const module = await WebAssembly.compile(wasmBytes);
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const base = 128;
  const mutex = new Int32Array(memory.buffer, base, 1);
  const ready = new Int32Array(memory.buffer, base + 8, 1);
  const condvar = new SabCondvar(memory.buffer as SharedArrayBuffer, base + 4);

  const worker = new Worker(
    new URL("../worker-thread-host.ts", import.meta.url).href,
    { type: "module" },
  );
  const result = new Promise<number>((resolve) => {
    worker.onmessage = (event) => resolve(event.data.retval);
    worker.postMessage({
      type: "start",
      tid: 7,
      fnPtr: 0,
      arg: base,
      module,
      memory,
    });
  });

  while (Atomics.load(ready, 0) !== 1 || Atomics.load(mutex, 0) !== 0) {
    Atomics.wait(ready, 0, Atomics.load(ready, 0), 100);
  }

  condvar.signal();

  assertEquals(await result, 7);
  assertEquals(Atomics.load(mutex, 0), 0);
  worker.terminate();
});
