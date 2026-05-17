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
