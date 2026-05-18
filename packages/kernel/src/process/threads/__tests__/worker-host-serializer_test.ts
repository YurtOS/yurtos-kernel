import { assertEquals } from "@std/assert";
import { WorkerHostSerializer } from "../worker-host-serializer.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

Deno.test("WorkerHostSerializer: a slow call delays the next; order preserved", async () => {
  const s = new WorkerHostSerializer();
  const gate = deferred<void>();
  const order: string[] = [];

  const first = s.run(async () => {
    order.push("first:start");
    await gate.promise;
    order.push("first:end");
    return 1;
  });
  const second = s.run(() => {
    order.push("second:start");
    return 2;
  });

  // The second call must NOT have started while `first` is parked on
  // the gate — even though `first` is awaiting (event loop free).
  await Promise.resolve();
  assertEquals(order, ["first:start"]);

  gate.resolve();
  assertEquals(await first, 1);
  assertEquals(await second, 2);
  assertEquals(order, ["first:start", "first:end", "second:start"]);
});

Deno.test("WorkerHostSerializer: a rejected call does not break the chain", async () => {
  const s = new WorkerHostSerializer();
  let ran = false;

  const bad = s.run(() => Promise.reject(new Error("boom")));
  const good = s.run(() => {
    ran = true;
    return "ok";
  });

  await bad.then(() => {}, () => {});
  assertEquals(await good, "ok");
  assertEquals(ran, true);
});

Deno.test("WorkerHostSerializer: event loop stays live while a call awaits", async () => {
  const s = new WorkerHostSerializer();
  const gate = deferred<void>();
  let timerFired = false;

  const call = s.run(async () => {
    setTimeout(() => {
      timerFired = true;
      gate.resolve();
    }, 0);
    await gate.promise; // a macrotask must be able to run here
    return "done";
  });

  assertEquals(await call, "done");
  assertEquals(timerFired, true);
});

// ---------------------------------------------------------------------------
// #124: watchdog/timeout so a hung body fails its OWN round-trip instead of
// wedging every pthread of the process (process-global head-of-line block).
// ---------------------------------------------------------------------------

import { assertRejects } from "@std/assert";
import {
  WorkerHostSerializer as _WHS,
  WorkerHostTimeoutError,
} from "../worker-host-serializer.ts";

Deno.test("WorkerHostSerializer: a hung body times out and the chain advances", async () => {
  const s = new _WHS();
  // A body that never settles must NOT wedge the next body forever.
  const hung = s.run(() => new Promise<never>(() => {}), { timeoutMs: 30 });
  const next = s.run(() => "after-hang");

  await assertRejects(() => hung, WorkerHostTimeoutError);
  // The follow-up body must have run despite the previous hang. Guard
  // with a test-level deadline so a regression FAILS (not hangs); the
  // timer is cleared so it does not leak past the test.
  let guardTimer: number | undefined;
  const guard = new Promise<string>((r) => {
    guardTimer = setTimeout(() => r("WEDGED"), 1500);
  });
  try {
    assertEquals(await Promise.race([next, guard]), "after-hang");
  } finally {
    clearTimeout(guardTimer);
  }
});

Deno.test("WorkerHostSerializer: default (no timeout) never times out a slow body", async () => {
  const s = new _WHS();
  const slow = s.run(async () => {
    await new Promise((r) => setTimeout(r, 60));
    return "slow-ok";
  });
  assertEquals(await slow, "slow-ok");
});

Deno.test("WorkerHostSerializer: a body that settles before the timeout is unaffected", async () => {
  const s = new _WHS(1000);
  assertEquals(await s.run(() => "fast"), "fast");
});
