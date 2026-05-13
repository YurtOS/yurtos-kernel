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

Deno.test("SabMutex: tryLock(0) throws (reserved for unlocked)", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);
  assertThrows(() => m.tryLock(0), Error, "must be a positive integer");
});

Deno.test("SabMutex: unlock(0) throws (reserved for unlocked)", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);
  assertThrows(() => m.unlock(0), Error, "must be a positive integer");
});

// TODO(Task 4): The tests above run on a single isolate and would pass
// even against a non-atomic plain-load/store implementation of SabMutex.
// Real CAS contention testing requires a Worker spawn, which lands in
// Task 4 (worker-thread-host.ts). The atomicity invariant is exercised
// implicitly there when libzmq's signaler hits the SAB cell from two
// threads at once.
