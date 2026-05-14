import { assertEquals, assertThrows } from "@std/assert";
import { SabCondvar, SabMutex } from "../sab-primitives.ts";

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

Deno.test("SabMutex: lock() acquires when uncontended", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);
  m.lock(1);
  assertEquals(m.owner(), 1);
  m.unlock(1);
});

Deno.test("SabMutex: lock(0) throws (reserved for unlocked)", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);
  assertThrows(() => m.lock(0), Error, "must be a positive integer");
});

Deno.test({
  name: "SabMutex: lock() from a Worker blocks until main unlocks",
  // Allow the Worker to do dynamic imports.
  permissions: { read: true, net: true },
  fn: async () => {
    const sab = new SharedArrayBuffer(SabMutex.BYTES);
    const m = new SabMutex(sab, 0);
    m.tryLock(1); // main holds it as tid 1

    const worker = new Worker(
      new URL("./_fixtures/lock-worker.ts", import.meta.url).href,
      { type: "module" },
    );
    const acquired = new Promise<{ tid: number }>((resolve) => {
      worker.onmessage = (e: MessageEvent) =>
        resolve(e.data as { tid: number });
    });
    worker.postMessage({ sab, tid: 2 });

    // Worker is now blocked in Atomics.wait. Give the event loop a tick
    // to make sure the worker reached the wait call before we unlock.
    await new Promise((r) => setTimeout(r, 50));

    m.unlock(1);

    const got = await acquired;
    assertEquals(got.tid, 2);
    assertEquals(m.owner(), 2);
    worker.terminate();
  },
});

// TODO(Task 4): The tests above run on a single isolate and would pass
// even against a non-atomic plain-load/store implementation of SabMutex.
// Real CAS contention testing requires a Worker spawn, which lands in
// Task 4 (worker-thread-host.ts). The atomicity invariant is exercised
// implicitly there when libzmq's signaler hits the SAB cell from two
// threads at once.

Deno.test("SabCondvar: signal() increments seq and is a no-op without waiters", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES + SabCondvar.BYTES);
  const cv = new SabCondvar(sab, SabMutex.BYTES);
  const before = cv.seq();
  cv.signal();
  assertEquals(cv.seq(), before + 1);
});

Deno.test("SabCondvar: broadcast() increments seq and is a no-op without waiters", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES + SabCondvar.BYTES);
  const cv = new SabCondvar(sab, SabMutex.BYTES);
  cv.broadcast();
  cv.broadcast();
  assertEquals(cv.seq(), 2);
});

Deno.test({
  name: "SabCondvar: broadcast wakes multiple Worker waiters",
  permissions: { read: true, net: true },
  fn: async () => {
    const sab = new SharedArrayBuffer(SabMutex.BYTES + SabCondvar.BYTES);
    const cv = new SabCondvar(sab, SabMutex.BYTES);

    const workers = [2, 3, 4].map((tid) => {
      const w = new Worker(
        new URL("./_fixtures/cv-waiter-worker.ts", import.meta.url).href,
        { type: "module" },
      );
      w.postMessage({
        sab,
        tid,
        mutexOffset: 0,
        condvarOffset: SabMutex.BYTES,
      });
      return { tid, worker: w };
    });

    // Wait for all 3 workers to enter cv.wait (they each post "ready"
    // BEFORE calling wait, but cv.wait happens immediately after, so
    // by the time we've received 3 "ready" messages all 3 are either
    // waiting or about to). Give one tick for them to reach Atomics.wait.
    const ready = workers.map(({ worker }) =>
      new Promise<{ tid: number }>((resolve) => {
        worker.addEventListener("message", function once(e) {
          const data = (e as MessageEvent).data;
          if (data.type === "ready") {
            worker.removeEventListener("message", once as EventListener);
            resolve(data);
          }
        });
      })
    );
    await Promise.all(ready);
    await new Promise((r) => setTimeout(r, 50));

    cv.broadcast();

    const woke = await Promise.all(
      workers.map(({ worker }) =>
        new Promise<{ tid: number }>((resolve) => {
          worker.addEventListener("message", function once(e) {
            const data = (e as MessageEvent).data;
            if (data.type === "woke") {
              worker.removeEventListener("message", once as EventListener);
              resolve(data);
            }
          });
        })
      ),
    );
    const tids = woke.map((w) => w.tid).sort();
    assertEquals(tids, [2, 3, 4]);

    for (const { worker } of workers) worker.terminate();
  },
});
