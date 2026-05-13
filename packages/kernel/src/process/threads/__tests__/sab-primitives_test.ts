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
