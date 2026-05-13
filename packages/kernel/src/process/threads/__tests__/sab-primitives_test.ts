import { assertEquals } from "@std/assert";
import { SabCondvar, SabMutex } from "../sab-primitives.ts";

Deno.test("SabMutex: uncontended lock takes ownership and unlock releases it", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const mutex = new SabMutex(sab, 0);

  assertEquals(mutex.tryLock(1), true);
  assertEquals(mutex.owner(), 1);
  mutex.unlock(1);
  assertEquals(mutex.owner(), 0);
});

Deno.test("SabMutex: tryLock fails when held by another tid", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const mutex = new SabMutex(sab, 0);

  mutex.tryLock(1);
  assertEquals(mutex.tryLock(2), false);
});

Deno.test("SabMutex: lock() from a Worker blocks until main unlocks", async () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const mutex = new SabMutex(sab, 0);
  mutex.tryLock(1);

  const worker = new Worker(
    new URL("./_fixtures/lock-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  worker.postMessage({ sab });

  await new Promise((resolve) => setTimeout(resolve, 50));
  mutex.unlock(1);

  const got = await new Promise<string>((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
  });
  assertEquals(got, "locked");
  assertEquals(mutex.owner(), 2);
  worker.terminate();
});

Deno.test("SabCondvar: broadcast wakes all waiters", async () => {
  const mutexOffset = 0;
  const condOffset = SabMutex.BYTES;
  const readyOffset = SabMutex.BYTES + SabCondvar.BYTES;
  const sab = new SharedArrayBuffer(readyOffset + 4);
  const mutex = new SabMutex(sab, mutexOffset);
  const condvar = new SabCondvar(sab, condOffset);
  const ready = new Int32Array(sab, readyOffset, 1);
  const makeWorker = (tid: number) => {
    const worker = new Worker(
      new URL("./_fixtures/condvar-worker.ts", import.meta.url).href,
      { type: "module" },
    );
    const done = new Promise<number>((resolve) => {
      worker.onmessage = (event) => resolve(event.data);
    });
    worker.postMessage({ sab, tid, mutexOffset, condOffset, readyOffset });
    return { worker, done };
  };

  const worker2 = makeWorker(2);
  const worker3 = makeWorker(3);
  while (Atomics.load(ready, 0) < 2) {
    Atomics.wait(ready, 0, Atomics.load(ready, 0), 100);
  }

  mutex.lock(1);
  condvar.broadcast();
  mutex.unlock(1);

  assertEquals((await Promise.all([worker2.done, worker3.done])).sort(), [
    2,
    3,
  ]);
  worker2.worker.terminate();
  worker3.worker.terminate();
});
