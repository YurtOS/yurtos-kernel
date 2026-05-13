import { assertEquals } from "@std/assert";
import { SabMutex } from "../sab-primitives.ts";

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
