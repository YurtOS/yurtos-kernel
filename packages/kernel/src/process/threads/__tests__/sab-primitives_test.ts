import { assertEquals, assertThrows } from "@std/assert";
import { SabMutex } from "../sab-primitives.ts";

Deno.test("SabMutex: uncontended lock takes ownership and unlock releases it", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);

  assertEquals(m.tryLock(1), true);
  assertEquals(m.owner(), 1);
  m.unlock(1);
  assertEquals(m.owner(), 0);
});

Deno.test("SabMutex: tryLock fails when held by another tid", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);
  m.tryLock(1);
  assertEquals(m.tryLock(2), false);
});

Deno.test("SabMutex: unlock by non-owner throws", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);
  m.tryLock(1);
  assertThrows(() => m.unlock(2), Error, "not the owner");
});
